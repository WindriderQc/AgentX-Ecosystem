'use strict';

const {
  buildEcosystemSnapshot,
  summarizeCluster
} = require('../../src/services/ecosystemSnapshotService');

describe('ecosystemSnapshotService', () => {
  const intelligence = {
    cluster: [
      { hostKey: 'primary', status: 'online', models: ['model-a', { name: 'model-b' }] },
      { hostKey: 'secondary', status: 'online', models: ['model-a'] }
    ],
    routing: { authority: 'inference_log', currentHost: 'primary' },
    hostPreferences: [],
    alerts: [],
    recentRouting: []
  };
  const routingConfig = {
    taskModels: { quick_chat: { model: 'model-a', host: 'primary' } },
    hosts: { primary: 'http://primary:11434' },
    taskConfigState: { quick_chat: { isOverride: false } }
  };

  it('builds one deterministic product contract from authoritative collectors', async () => {
    const snapshot = await buildEcosystemSnapshot({
      buildIntelligence: async () => intelligence,
      buildRoutingConfig: async () => routingConfig,
      now: () => new Date('2026-08-20T03:00:00.000Z')
    });

    expect(snapshot).toEqual(expect.objectContaining({
      schemaVersion: 1,
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
      routingConfig
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

  it('rejects malformed collector output instead of manufacturing defaults', async () => {
    await expect(buildEcosystemSnapshot({
      buildIntelligence: async () => ({ cluster: [] }),
      buildRoutingConfig: async () => routingConfig
    })).rejects.toThrow('Nerve Center intelligence field hostPreferences must be an array');
  });

  it('rejects an invalid timestamp instead of emitting ambiguous freshness', async () => {
    await expect(buildEcosystemSnapshot({
      buildIntelligence: async () => intelligence,
      buildRoutingConfig: async () => routingConfig,
      now: () => 'not-a-date'
    })).rejects.toThrow('Ecosystem snapshot timestamp is invalid');
  });

  it('fails closed within the configured deadline when a collector hangs', async () => {
    await expect(buildEcosystemSnapshot({
      buildIntelligence: () => new Promise(() => {}),
      buildRoutingConfig: async () => routingConfig,
      timeoutMs: 5
    })).rejects.toMatchObject({
      code: 'ECOSYSTEM_SNAPSHOT_TIMEOUT',
      message: 'Ecosystem snapshot collection timed out after 5ms'
    });
  });
});
