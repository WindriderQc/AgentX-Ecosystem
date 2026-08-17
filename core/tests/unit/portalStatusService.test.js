const { getPortalStatus } = require('../../src/services/portalStatusService');

describe('portalStatusService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn(async () => ({
      status: 200,
      json: jest.fn().mockResolvedValue({ status: 'ok' })
    }));
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('degrades RAG when its canonical response succeeds but a dependency is not ready', async () => {
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
      healthy: 2,
      degraded: 1,
      down: 0
    });
  });

  it('degrades Core when Ollama is unavailable even if MongoDB is connected', async () => {
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
