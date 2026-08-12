const mockComputeHostCapacity = jest.fn();
const mockIsCapacityHostCritical = jest.fn();
const mockGetConfiguredHosts = jest.fn();

jest.mock('../../src/services/hostCapacityService', () => ({
  computeHostCapacity: mockComputeHostCapacity,
  isCapacityHostCritical: mockIsCapacityHostCritical
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: mockGetConfiguredHosts
}));

const { getPortalStatus } = require('../../src/services/portalStatusService');

describe('portalStatusService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    mockIsCapacityHostCritical.mockReturnValue(false);
    mockGetConfiguredHosts.mockReturnValue([
      { id: 'primary' },
      { id: 'secondary' }
    ]);
    global.fetch = jest.fn(async () => ({
      status: 200,
      json: jest.fn().mockResolvedValue({ status: 'ok' })
    }));
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('degrades the portal summary when a configured host has stale offline telemetry', async () => {
    mockComputeHostCapacity.mockImplementation(async (hostId) => {
      if (hostId === 'secondary') {
        return {
          input: 'secondary',
          host: {
            hostId: 'host-beta',
            hostname: 'Host Beta',
            online: true,
            hostAgentOnline: false,
            ollamaReachable: true,
            telemetryStale: true,
            hostStatus: 'offline'
          }
        };
      }

      return {
        input: hostId,
        host: {
          hostId: 'host-alpha',
          hostname: 'Host Alpha',
          online: true,
          hostAgentOnline: true,
          ollamaReachable: true,
          telemetryStale: false,
          hostStatus: 'online'
        }
      };
    });

    const status = await getPortalStatus({
      mongodb: { status: 'connected' },
      ollama: { status: 'connected' }
    });

    expect(status.summary).toEqual(expect.objectContaining({
      status: 'degraded',
      total: 4,
      healthy: 4,
      degraded: 0,
      down: 0
    }));
    expect(status.summary.ecosystem).toEqual(expect.objectContaining({
      status: 'degraded',
      source: 'host-capacity',
      summary: expect.objectContaining({
        total: 2,
        healthy: 1,
        degraded: 1,
        down: 0
      }),
      issues: ['Host Beta host telemetry stale; Ollama reachable']
    }));
  });

  it('degrades RAG when its canonical response succeeds but a dependency is not ready', async () => {
    mockComputeHostCapacity.mockImplementation(async (hostId) => ({
      input: hostId,
      host: {
        hostId,
        hostname: hostId,
        online: true,
        hostAgentOnline: true,
        ollamaReachable: true,
        telemetryStale: false,
        hostStatus: 'online'
      }
    }));
    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/api/rag/status')) {
        return {
          status: 200,
          json: jest.fn().mockResolvedValue({
            ok: true,
            data: {
              healthy: false,
              dependencies: {
                mongodb: { healthy: true },
                embedding: { healthy: false, error: 'connection failed' },
                qdrant: { healthy: true }
              }
            }
          })
        };
      }
      return { status: 200, json: jest.fn().mockResolvedValue({ status: 'ok' }) };
    });

    const status = await getPortalStatus({
      mongodb: { status: 'connected' },
      ollama: { status: 'connected' }
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/rag/status'),
      expect.any(Object)
    );
    expect(status.services.find((service) => service.id === 'rag')).toMatchObject({
      status: 'degraded',
      issues: ['embedding: connection failed']
    });
    expect(status.summary).toMatchObject({
      status: 'degraded',
      healthy: 3,
      degraded: 1,
      down: 0
    });
  });

  it('degrades Core when Ollama is unavailable even if MongoDB is connected', async () => {
    mockComputeHostCapacity.mockImplementation(async (hostId) => ({
      input: hostId,
      host: {
        hostId,
        online: true,
        hostAgentOnline: true,
        ollamaReachable: true,
        telemetryStale: false,
        hostStatus: 'online'
      }
    }));

    const status = await getPortalStatus({
      mongodb: { status: 'connected' },
      ollama: { status: 'error' }
    });

    expect(status.services.find((service) => service.id === 'core')).toMatchObject({
      status: 'degraded',
      issues: ['ollama: error']
    });
    expect(status.summary.status).toBe('degraded');
  });
});
