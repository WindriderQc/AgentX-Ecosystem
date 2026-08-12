'use strict';

jest.mock('../../src/services/nestorConsumerRuntimeService', () => ({
  getRouterSnapshot: jest.fn().mockResolvedValue({ available: true, routes: {} }),
}));
jest.mock('../../src/services/nestorConsumerMemoryService', () => ({
  getMemoryStatus: jest.fn().mockResolvedValue({
    sources: { agentx: { available: true }, rag: { available: true } },
    warnings: [],
  }),
}));
jest.mock('../../src/services/nestorConsumerPersonalityService', () => ({
  getPersonalitySources: jest.fn().mockResolvedValue({
    sources: { agentx: { available: true }, hermes: { available: true }, openclaw: { available: true } },
  }),
}));
jest.mock('../../src/services/voixClientService', () => ({
  health: jest.fn().mockResolvedValue({ status: 'ok' }),
}));

const runtimeService = require('../../src/services/nestorConsumerRuntimeService');
const { getCapabilities } = require('../../src/services/nestorConsumerCapabilitiesService');

describe('Nestor consumer capability discovery', () => {
  it('reports the version, providers, replay limits, VoiX proxies, and legacy compatibility gate', async () => {
    const result = await getCapabilities({ systemHealth: { status: 'ok' } });
    expect(result.contract).toEqual({
      name: 'agentx.nestor.consumer',
      version: '1.1.0',
      basePath: '/api/consumers/nestor/v1',
    });
    expect(result.router).toEqual(expect.objectContaining({
      available: true,
      modelCatalog: 'embedded-in-routes',
      modelCatalogEndpoint: '/api/models/all',
      operations: ['chat', 'react', 'analyze'],
    }));
    expect(result.memory.sources).toEqual(['agentx', 'rag', 'hermes', 'openclaw']);
    expect(result.voix.proxy.synthesize).toBe('/api/voix/synthesize');
    expect(result.events).toEqual(expect.objectContaining({
      ingressEndpoint: '/api/platform-events',
      stableIds: true,
      cursorReplay: true,
      durableReplay: false,
      replayLimit: 200,
    }));
    expect(result.limits).toEqual(expect.objectContaining({
      messageCount: 50,
      totalMessageCharacters: 32000,
      memoryResultsPerSource: 20,
      rawNotesCharacters: 65536,
      migrationNotesChunkBytes: 1048576,
      migrationNotesMaxBytes: 268435456,
      migrationHistoryItems: 1000,
    }));
    expect(result.migration).toEqual(expect.objectContaining({
      profileSchemaVersion: 2,
      profileSchemaNegotiation: 'query:schemaVersion=2',
      defaultProfileSchemaVersion: 1,
      factProjectionSha256: true,
      snapshotDomain: 'agentx.nestor.migration-snapshot.v2',
      snapshotValidated: true,
      notesEncoding: 'base64',
      notesChunkBytes: 1048576,
      notesMaxBytes: 268435456,
      snapshotLeaseSeconds: 600,
      notesArchiveEndpoint: '/api/consumers/nestor/v1/migration/notes',
      preservesRawMongo: true,
      access: 'loopback-or-operator-token',
    }));
    expect(result.legacyBuddy).toEqual(expect.objectContaining({
      apiSupported: true,
      uiSupported: false,
      compatibilityBaseline: 'Nestor v0.2.7',
    }));
  });

  it('bounds an unavailable provider probe and returns a warning', async () => {
    runtimeService.getRouterSnapshot.mockImplementationOnce(() => new Promise(() => {}));

    const startedAt = Date.now();
    const result = await getCapabilities({ probeTimeoutMs: 10 });

    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(result.router.available).toBe(false);
    expect(result.warnings).toContain('router: timed out after 10ms');
  });
});
