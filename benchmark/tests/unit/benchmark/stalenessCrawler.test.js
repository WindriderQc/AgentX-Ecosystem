'use strict';

const { analyzeStaleness, formatStalenessLedgerEntry, _internal } = require('../../../src/services/benchmark/stalenessCrawler');

describe('analyzeStaleness', () => {
  it('flags context-profile staleness and suggests a re-profile', () => {
    const report = analyzeStaleness({
      contextProfiles: [
        { modelName: 'ax/qwen3-coder:30b', hostId: 'primary', hostUrl: 'http://192.0.2.99:11434', stale: true, staleReason: 'drift' }
      ]
    });
    expect(report.totals.staleModels).toBe(1);
    expect(report.hosts.primary.stale[0].reasons).toContain('context_profile_stale');
    expect(report.suggestedProfileQueues).toEqual([
      { hostId: 'primary', skipRecentDays: 0, modelNames: ['ax/qwen3-coder:30b'] }
    ]);
  });

  it('does not flag positive measured throughput using an arbitrary ceiling', () => {
    const report = analyzeStaleness({
      contextProfiles: [
        { modelName: 'ax/qwopus:27b-q5_K_M', hostId: 'primary', hostUrl: 'http://192.0.2.99:11434', stale: false, latestEvidence: { tokensPerSec: 1000000 } }
      ]
    });
    expect(report.totals.staleModels).toBe(0);
  });

  it('does not reject a real sub-cap measurement using guessed hardware', () => {
    const report = analyzeStaleness({
      performanceProfiles: [
        { modelName: 'ax/huge:30b-instruct-q4_K_M', hostId: 'primary', active: true, stale: false, artifact: { registryQualified: true }, profile: { tokensPerSec: 5000 } }
      ]
    });
    expect(report.totals.staleModels).toBe(0);
  });

  it('does NOT flag a realistic sub-cap throughput', () => {
    const report = analyzeStaleness({
      performanceProfiles: [
        { modelName: 'ax/huge:30b-instruct-q4_K_M', hostId: 'primary', active: true, stale: false, artifact: { registryQualified: true }, profile: { tokensPerSec: 45 } }
      ]
    });
    expect(report.totals.staleModels).toBe(0);
  });

  it('flags profile readiness staleness per host (map or object)', () => {
    const report = analyzeStaleness({
      profiles: [
        { name: 'gemma4:e4b', readiness: { secondary: { stale: true, stage: 'profiled' }, primary: { stale: false } } }
      ]
    });
    expect(report.hosts.secondary.stale[0].reasons).toContain('profile_readiness_stale');
    expect(report.hosts.primary).toBeUndefined();
  });

  it('flags exact-artifact performance evidence staleness', () => {
    const report = analyzeStaleness({
      performanceProfiles: [
        { modelName: 'ax/m', hostId: 'tertiary', active: false, stale: true, artifact: { registryQualified: true }, profile: {} }
      ]
    });
    expect(report.hosts.tertiary.stale[0].reasons).toContain('performance_profile_stale');
  });

  it('flags and queues a routed model with no exact performance evidence', () => {
    const report = analyzeStaleness({
      performanceProfiles: [
        { modelName: 'other', hostId: 'secondary', active: true, stale: false, artifact: { registryQualified: true }, profile: {} }
      ],
      routedModelsByHost: { secondary: ['ax/gemma4:e4b'] }
    });
    expect(report.hosts.secondary.stale[0].reasons).toEqual(['missing_profile_evidence']);
    expect(report.suggestedProfileQueues).toEqual([
      { hostId: 'secondary', skipRecentDays: 0, modelNames: ['ax/gemma4:e4b'] }
    ]);
  });

  it('does not collapse a namespaced evidence record into a bare routed tag', () => {
    const report = analyzeStaleness({
      performanceProfiles: [
        { modelName: 'ax/gemma4:e4b', hostId: 'secondary', active: true, stale: false, artifact: { registryQualified: true }, profile: {} }
      ],
      routedModelsByHost: { secondary: ['gemma4:e4b'] }
    });
    expect(report.hosts.secondary.stale[0]).toMatchObject({
      model: 'gemma4:e4b',
      reasons: ['missing_profile_evidence']
    });
  });

  it('merges multiple reasons for the same model', () => {
    const report = analyzeStaleness({
      contextProfiles: [
        { modelName: 'ax/m', hostId: 'primary', hostUrl: 'http://192.0.2.99:11434', stale: true, latestEvidence: { tokensPerSec: 1000000 } }
      ],
      performanceProfiles: [
        { modelName: 'ax/m', hostId: 'primary', active: false, stale: true, artifact: { registryQualified: true }, profile: {} }
      ]
    });
    const reasons = report.hosts.primary.stale[0].reasons;
    expect(reasons).toEqual(expect.arrayContaining(['context_profile_stale', 'performance_profile_stale']));
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
        { modelName: 'ax/qwopus:27b-q5_K_M', hostId: 'primary', hostUrl: 'http://192.0.2.99:11434', stale: true, latestEvidence: { tokensPerSec: 1000000 } }
      ]
    });
    const entry = formatStalenessLedgerEntry(report, { date: '2026-06-19' });
    expect(entry).toMatch(/^## 2026-06-19 — Staleness crawl: 1 model\(s\) flagged/);
    expect(entry).toMatch(/Category:.*Maintenance/);
    expect(entry).toMatch(/- \*\*Actor:\*\* Operator/);
    expect(entry).not.toMatch(/Self-Tuning Lane|Claude Code/);
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
    expect(_internal.throughputReason(50, 'ax/x:30b-q4_K_M', 'http://192.0.2.99:11434')).toBeNull();
  });
});
