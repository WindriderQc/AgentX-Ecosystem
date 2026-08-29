'use strict';

const { assessEcosystemEvidence } = require('../../src/services/ecosystemEvidenceTrust');

function snapshot(overrides = {}) {
  const generatedAt = '2026-08-28T12:00:00.000Z';
  return {
    generatedAt,
    health: {
      status: 'ok',
      configuredHosts: 1,
      onlineHosts: 1,
      offlineHosts: 0,
      observedModels: 1,
    },
    serviceHealth: { status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0 },
    identityConsistency: { status: 'ok' },
    evidence: { servicesObservedAt: generatedAt },
    services: ['core', 'benchmark', 'rag'].map((id) => ({
      id,
      status: 'ok',
      identity: { ts: generatedAt },
    })),
    cluster: [{ hostKey: 'primary', status: 'online', models: ['model-a'], checkedAt: generatedAt }],
    alertSummary: { observedAt: generatedAt },
    ...overrides,
  };
}

describe('ecosystemEvidenceTrust', () => {
  it('verifies a complete, current, internally consistent snapshot', () => {
    expect(assessEcosystemEvidence(snapshot())).toEqual(expect.objectContaining({
      schemaVersion: 1,
      status: 'verified',
      operationalStatus: 'ok',
      contradictionBudget: expect.objectContaining({ allowed: 0, observed: 0, withinBudget: true }),
      freshness: expect.objectContaining({ status: 'current', stale: 0, unknown: 0 }),
      coverage: expect.objectContaining({ status: 'complete', expectedSources: 6, observedSources: 6 }),
    }));
  });

  it('separates honest operational degradation from evidence trust', () => {
    const degraded = snapshot({
      health: {
        status: 'degraded',
        configuredHosts: 1,
        onlineHosts: 0,
        offlineHosts: 1,
        observedModels: 0,
      },
      cluster: [{
        hostKey: 'primary',
        status: 'offline',
        models: [],
        checkedAt: '2026-08-28T12:00:00.000Z',
      }],
    });

    expect(assessEcosystemEvidence(degraded)).toEqual(expect.objectContaining({
      status: 'verified',
      operationalStatus: 'degraded',
    }));
  });

  it('fails the zero-contradiction budget when summary counts drift', () => {
    const result = assessEcosystemEvidence(snapshot({
      serviceHealth: { status: 'ok', total: 4, healthy: 3, degraded: 0, down: 0 },
    }));

    expect(result.status).toBe('contradictory');
    expect(result.contradictionBudget).toMatchObject({ allowed: 0, observed: 1, withinBudget: false });
    expect(result.contradictionBudget.contradictions[0]).toMatchObject({
      id: 'service-total',
      expected: 3,
      observed: 4,
    });
  });

  it('reports stale and missing sources without inventing freshness', () => {
    const stale = snapshot();
    stale.evidence.servicesObservedAt = '2026-08-28T11:50:00.000Z';
    stale.alertSummary.observedAt = null;

    const result = assessEcosystemEvidence(stale, { freshnessBudgetMs: 60_000 });

    expect(result.status).toBe('stale');
    expect(result.freshness).toMatchObject({ status: 'stale', stale: 1, unknown: 1 });
    expect(result.coverage).toMatchObject({ status: 'partial', missing: ['alerts'] });
  });

  it('reports mixed runtime identity independently from arithmetic contradictions', () => {
    const result = assessEcosystemEvidence(snapshot({
      identityConsistency: { status: 'degraded', issues: ['Mixed product versions'] },
    }));

    expect(result.status).toBe('inconsistent');
    expect(result.contradictionBudget.observed).toBe(0);
    expect(result.checks.find((check) => check.id === 'runtime-identity').status).toBe('fail');
  });

  it('treats a materially future observation as a contradiction', () => {
    const future = snapshot();
    future.cluster[0].checkedAt = '2026-08-28T12:01:00.000Z';

    const result = assessEcosystemEvidence(future);

    expect(result.status).toBe('contradictory');
    expect(result.contradictionBudget.contradictions[0].id).toBe('future-timestamp:host:primary');
  });
});
