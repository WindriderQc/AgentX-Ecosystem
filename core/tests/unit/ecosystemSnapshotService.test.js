'use strict';

const {
  buildEcosystemSnapshot,
  summarizeCluster
} = require('../../src/services/ecosystemSnapshotService');

describe('ecosystemSnapshotService', () => {
  const intelligence = {
    cluster: [
      { hostKey: 'primary', status: 'online', models: ['model-a', { name: 'model-b' }], checkedAt: '2026-08-20T03:00:00.000Z' },
      { hostKey: 'secondary', status: 'online', models: ['model-a'], checkedAt: '2026-08-20T03:00:00.000Z' }
    ],
    routing: { authority: 'inference_log', currentHost: 'primary' },
    hostPreferences: [],
    alerts: [],
    alertSummary: {
      activeCount: 0,
      basis: { activePredicate: { status: 'active' } },
      observedAt: '2026-08-20T03:00:00.000Z'
    },
    recentRouting: []
  };
  const routingConfig = {
    taskModels: { quick_chat: { model: 'model-a', host: 'primary' } },
    hosts: { primary: 'http://primary:11434' },
    taskConfigState: { quick_chat: { isOverride: false } }
  };
  const serviceStatus = {
    generatedAt: '2026-08-20T03:00:00.000Z',
    summary: { status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0 },
    consistency: {
      status: 'ok',
      profiles: ['full'],
      versions: ['0.1.1'],
      revisions: ['abc123'],
      missing: [],
      issues: []
    },
    services: [
      { id: 'core', status: 'ok', identity: { ts: '2026-08-20T03:00:00.000Z' } },
      { id: 'benchmark', status: 'ok', identity: { ts: '2026-08-20T03:00:00.000Z' } },
      { id: 'rag', status: 'ok', identity: { ts: '2026-08-20T03:00:00.000Z' } }
    ]
  };

  it('builds one deterministic product contract from authoritative collectors', async () => {
    const snapshot = await buildEcosystemSnapshot({
      buildIntelligence: async () => intelligence,
      buildRoutingConfig: async () => routingConfig,
      buildServiceStatus: async () => serviceStatus,
      now: () => new Date('2026-08-20T03:00:00.000Z')
    });

    expect(snapshot).toEqual(expect.objectContaining({
      schemaVersion: 2,
      generatedAt: '2026-08-20T03:00:00.000Z',
      authority: 'agentx-product',
      readOnly: true,
      health: {
        status: 'ok',
        configuredHosts: 2,
        onlineHosts: 2,
        offlineHosts: 0,
        observedModels: 2
      },
      cluster: intelligence.cluster,
      routing: intelligence.routing,
      routingConfig,
      alertSummary: intelligence.alertSummary,
      serviceHealth: serviceStatus.summary,
      services: serviceStatus.services,
      identityConsistency: serviceStatus.consistency,
      evidence: {
        snapshotObservedAt: '2026-08-20T03:00:00.000Z',
        servicesObservedAt: '2026-08-20T03:00:00.000Z'
      },
      evidenceTrust: expect.objectContaining({
        schemaVersion: 1,
        status: 'verified',
        operationalStatus: 'ok',
        contradictionBudget: expect.objectContaining({ allowed: 0, observed: 0, withinBudget: true })
      })
    }));
  });

  it('reports observed degradation without replacing missing hosts or models', () => {
    expect(summarizeCluster([
      { hostKey: 'primary', status: 'online', models: ['model-a'] },
      { hostKey: 'secondary', status: 'offline', models: [] }
    ])).toEqual({
      status: 'degraded',
      configuredHosts: 2,
      onlineHosts: 1,
      offlineHosts: 1,
      observedModels: 1
    });
  });

  it('marks the unified health summary degraded when a product service is degraded', async () => {
    const snapshot = await buildEcosystemSnapshot({
      buildIntelligence: async () => intelligence,
      buildRoutingConfig: async () => routingConfig,
      buildServiceStatus: async () => ({
        ...serviceStatus,
        summary: { ...serviceStatus.summary, status: 'degraded', degraded: 1, healthy: 2 }
      })
    });

    expect(snapshot.health.status).toBe('degraded');
    expect(snapshot.serviceHealth).toEqual(expect.objectContaining({ status: 'degraded' }));
  });

  it('rejects malformed collector output instead of manufacturing defaults', async () => {
    await expect(buildEcosystemSnapshot({
      buildIntelligence: async () => ({ cluster: [] }),
      buildRoutingConfig: async () => routingConfig,
      buildServiceStatus: async () => serviceStatus
    })).rejects.toThrow('Nerve Center intelligence field hostPreferences must be an array');
  });

  it('rejects a snapshot without the active-alert count authority', async () => {
    const { alertSummary, ...missingAlertSummary } = intelligence;
    await expect(buildEcosystemSnapshot({
      buildIntelligence: async () => missingAlertSummary,
      buildRoutingConfig: async () => routingConfig,
      buildServiceStatus: async () => serviceStatus
    })).rejects.toThrow('Nerve Center intelligence field alertSummary must be an object');
  });

  it('rejects an invalid timestamp instead of emitting ambiguous freshness', async () => {
    await expect(buildEcosystemSnapshot({
      buildIntelligence: async () => intelligence,
      buildRoutingConfig: async () => routingConfig,
      buildServiceStatus: async () => serviceStatus,
      now: () => 'not-a-date'
    })).rejects.toThrow('Ecosystem snapshot timestamp is invalid');
  });

  it('fails closed within the configured deadline when a collector hangs', async () => {
    await expect(buildEcosystemSnapshot({
      buildIntelligence: () => new Promise(() => {}),
      buildRoutingConfig: async () => routingConfig,
      buildServiceStatus: async () => serviceStatus,
      timeoutMs: 5
    })).rejects.toMatchObject({
      code: 'ECOSYSTEM_SNAPSHOT_TIMEOUT',
      message: 'Ecosystem snapshot collection timed out after 5ms'
    });
  });
});
