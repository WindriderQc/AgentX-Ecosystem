'use strict';

const { analyzeStaleness, formatStalenessLedgerEntry, _internal } = require('../../../src/services/benchmark/stalenessCrawler');

describe('analyzeStaleness', () => {
  it('flags context-profile staleness and suggests a re-profile', () => {
    const report = analyzeStaleness({
      contextProfiles: [
        { modelName: 'ax/qwen3-coder:30b', hostId: 'primary', hostUrl: 'http://192.0.2.10:11434', stale: true, staleReason: 'drift' }
      ]
    });
    expect(report.totals.staleModels).toBe(1);
    expect(report.hosts.primary.stale[0].reasons).toContain('context_profile_stale');
    expect(report.suggestedProfileQueues).toEqual([
      { hostId: 'primary', skipRecentDays: 0, modelNames: ['ax/qwen3-coder:30b'] }
    ]);
  });

  it('flags implausible throughput above the flat cap', () => {
    const report = analyzeStaleness({
      contextProfiles: [
        { modelName: 'ax/qwopus:27b-q5_K_M', hostId: 'primary', hostUrl: 'http://192.0.2.10:11434', stale: false, latestEvidence: { tokensPerSec: 1000000 } }
      ]
    });
    expect(report.totals.byReason.implausible_throughput).toBe(1);
    expect(report.hosts.primary.stale[0].evidence.throughput).toMatch(/sane cap/);
  });

  it('flags sub-cap throughput via the B1 physical ceiling (known host + quant)', () => {
    // 30B Q4 on a reference GPU: physical ceiling ≈55 tok/s, ×2 ≈110. 5000 is impossible.
    const report = analyzeStaleness({
      adaptations: [
        {
          modelName: 'ax/huge:30b-instruct-q4_K_M',
          hostId: 'primary',
          hostUrl: 'http://192.0.2.10:11434',
          hostBandwidthGBs: 936,
          profile: { tokensPerSec: 5000 }
        }
      ]
    });
    expect(report.hosts.primary.stale[0].reasons).toContain('implausible_throughput');
    expect(report.hosts.primary.stale[0].evidence.throughput).toMatch(/physical ceiling/);
  });

  it('does NOT flag a realistic sub-cap throughput', () => {
    const report = analyzeStaleness({
      adaptations: [
        { modelName: 'ax/huge:30b-instruct-q4_K_M', hostId: 'primary', hostUrl: 'http://192.0.2.10:11434', profile: { tokensPerSec: 45 } }
      ]
    });
    expect(report.totals.staleModels).toBe(0);
  });

  it('flags profile readiness staleness per host (map or object)', () => {
    const report = analyzeStaleness({
      profiles: [
        { name: 'gemma4:e4b', readiness: { secondary: { stale: true, stage: 'adapted' }, primary: { stale: false } } }
      ]
    });
    expect(report.hosts.secondary.stale[0].reasons).toContain('profile_readiness_stale');
    expect(report.hosts.primary).toBeUndefined();
  });

  it('flags adaptation staleness', () => {
    const report = analyzeStaleness({
      adaptations: [
        { modelName: 'ax/m', hostId: 'tertiary', staleness: { stale: true }, deployment: { status: 'deployed' } }
      ]
    });
    expect(report.hosts.tertiary.stale[0].reasons).toContain('adaptation_stale');
  });

  it('flags a routed model with no deployed adaptation (missing_deployment) and does NOT suggest re-profile for it', () => {
    const report = analyzeStaleness({
      adaptations: [
        { modelName: 'other', hostId: 'secondary', deployment: { status: 'deployed' } }
      ],
      routedModelsByHost: { secondary: ['ax/gemma4:e4b'] }
    });
    expect(report.hosts.secondary.stale[0].reasons).toEqual(['missing_deployment']);
    // missing_deployment needs adapt/deploy, not a profile run:
    expect(report.suggestedProfileQueues).toEqual([]);
  });

  it('does not flag a routed model that has a deployed adaptation', () => {
    const report = analyzeStaleness({
      adaptations: [
        { modelName: 'ax/gemma4:e4b', hostId: 'secondary', deployment: { status: 'deployed' } }
      ],
      routedModelsByHost: { secondary: ['gemma4:e4b'] } // ax/ + bare normalize equal
    });
    expect(report.totals.staleModels).toBe(0);
  });

  it('merges multiple reasons for the same model', () => {
    const report = analyzeStaleness({
      contextProfiles: [
        { modelName: 'ax/m', hostId: 'primary', hostUrl: 'http://192.0.2.10:11434', stale: true, latestEvidence: { tokensPerSec: 1000000 } }
      ],
      adaptations: [
        { modelName: 'ax/m', hostId: 'primary', staleness: { stale: true } }
      ]
    });
    const reasons = report.hosts.primary.stale[0].reasons;
    expect(reasons).toEqual(expect.arrayContaining(['context_profile_stale', 'implausible_throughput', 'adaptation_stale']));
    expect(report.totals.staleModels).toBe(1); // same model, one entry
  });

  it('honors a hostFilter', () => {
    const report = analyzeStaleness({
      contextProfiles: [
        { modelName: 'a', hostId: 'primary', stale: true },
        { modelName: 'b', hostId: 'secondary', stale: true }
      ],
      hostFilter: 'secondary'
    });
    expect(report.hosts.primary).toBeUndefined();
    expect(report.hosts.secondary.count).toBe(1);
  });
});

describe('formatStalenessLedgerEntry', () => {
  it('renders a maintenance entry with findings and proposed re-profiles', () => {
    const report = analyzeStaleness({
      contextProfiles: [
        { modelName: 'ax/qwopus:27b-q5_K_M', hostId: 'primary', hostUrl: 'http://192.0.2.10:11434', stale: true, latestEvidence: { tokensPerSec: 1000000 } }
      ]
    });
    const entry = formatStalenessLedgerEntry(report, { date: '2026-06-19' });
    expect(entry).toMatch(/^## 2026-06-19 — Staleness crawl: 1 model\(s\) flagged/);
    expect(entry).toMatch(/Category:.*Maintenance/);
    expect(entry).toMatch(/`primary` · `ax\/qwopus:27b-q5_K_M`/);
    expect(entry).toMatch(/Proposed:.*re-profile 1 model\(s\) on `primary`/);
    expect(entry).toMatch(/NOT auto-run/);
  });

  it('renders a clean entry when nothing is stale', () => {
    const entry = formatStalenessLedgerEntry(analyzeStaleness({}), { date: '2026-06-19' });
    expect(entry).toMatch(/0 model\(s\) flagged/);
    expect(entry).toMatch(/no stale evidence found/);
    expect(entry).toMatch(/Proposed:\*\* none/);
  });
});

describe('stalenessCrawler internals', () => {
  it('throughputReason returns null for healthy / missing readings', () => {
    expect(_internal.throughputReason(null, 'm', 'h')).toBeNull();
    expect(_internal.throughputReason(50, 'ax/x:30b-q4_K_M', 'http://192.0.2.10:11434')).toBeNull();
  });
});
