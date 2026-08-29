const { getPortalStatus } = require('../../src/services/portalStatusService');

describe('portalStatusService', () => {
  const originalFetch = global.fetch;
  const originalBuildRevision = process.env.AGENTX_BUILD_REVISION;

  function identity(service, overrides = {}) {
    return {
      service,
      version: '0.1.1',
      profile: process.env.AGENTX_PROFILE || 'demo',
      revision: 'test-revision',
      ts: '2026-08-28T12:00:00.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENTX_BUILD_REVISION = 'test-revision';
    global.fetch = jest.fn(async (url) => {
      const service = String(url).includes('3081') ? 'agentx-benchmark' : 'agentx-rag';
      return {
        status: 200,
        json: jest.fn().mockResolvedValue({ ok: true, status: 'ok', ...identity(service) })
      };
    });
  });

  afterAll(() => {
    global.fetch = originalFetch;
    if (originalBuildRevision === undefined) delete process.env.AGENTX_BUILD_REVISION;
    else process.env.AGENTX_BUILD_REVISION = originalBuildRevision;
  });

  it('degrades RAG when its canonical health response is not ready', async () => {
    global.fetch = jest.fn(async (url) => {
      if (String(url).endsWith('/health') && String(url).includes('3082')) {
        return {
          status: 503,
          json: jest.fn().mockResolvedValue({
            ok: false,
            status: 'degraded',
            ...identity('agentx-rag'),
            db: 'connected',
            vectorStore: { healthy: false, error: 'connection failed' }
          })
        };
      }
      return {
        status: 200,
        json: jest.fn().mockResolvedValue({
          ok: true,
          status: 'ok',
          ...identity('agentx-benchmark')
        })
      };
    });

    const status = await getPortalStatus({
      mongodb: { status: 'connected' },
      ollama: { status: 'connected' }
    });

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/health'),
      expect.any(Object)
    );
    expect(status.services.find((service) => service.id === 'rag')).toMatchObject({
      status: 'degraded',
      identity: identity('agentx-rag')
    });
    expect(status.summary).toMatchObject({
      status: 'degraded',
      healthy: 2,
      degraded: 1,
      down: 0
    });
  });

  it('keeps Core healthy while reporting optional Ollama as unavailable', async () => {
    const status = await getPortalStatus({
      mongodb: { status: 'connected' },
      ollama: { status: 'error' }
    });

    expect(status.services.find((service) => service.id === 'core')).toMatchObject({
      status: 'ok',
      issues: [],
      capabilities: { ollama: { status: 'error', optional: true } }
    });
    expect(status.summary.status).toBe('ok');
    expect(status.summary.identityStatus).toBe('ok');
  });

  it('degrades a mixed-version deployment even when every service is reachable', async () => {
    global.fetch = jest.fn(async (url) => {
      const isBenchmark = String(url).includes('3081');
      const service = isBenchmark ? 'agentx-benchmark' : 'agentx-rag';
      return {
        status: 200,
        json: jest.fn().mockResolvedValue({
          ok: true,
          status: 'ok',
          ...identity(service, { version: isBenchmark ? '0.1.0' : '0.1.1' })
        })
      };
    });

    const status = await getPortalStatus({
      mongodb: { status: 'connected' },
      ollama: { status: 'error' }
    });

    expect(status.summary).toMatchObject({ status: 'degraded', identityStatus: 'degraded' });
    expect(status.consistency.issues).toContain('Mixed product versions: 0.1.1, 0.1.0');
  });

  it('rejects a reachable endpoint that reports the wrong service identity', async () => {
    global.fetch = jest.fn(async () => {
      return {
        status: 200,
        json: jest.fn().mockResolvedValue({
          ok: true,
          status: 'ok',
          ...identity('agentx-rag')
        })
      };
    });

    const status = await getPortalStatus({
      mongodb: { status: 'connected' },
      ollama: { status: 'error' }
    });

    expect(status.services.find((service) => service.id === 'benchmark')).toMatchObject({
      status: 'degraded',
      identity: null,
      issues: ['identity: unexpected service']
    });
    expect(status.summary.status).toBe('degraded');
    expect(status.consistency.missing).toEqual(['benchmark']);
  });

  it('maps transport failures to fixed public reasons without exposing topology', async () => {
    global.fetch = jest.fn(async () => {
      const error = new Error('connect ECONNREFUSED 10.0.0.99:11434 at C:\\Users\\private\\socket');
      error.code = 'ECONNREFUSED 10.0.0.99:11434';
      throw error;
    });

    const status = await getPortalStatus({
      mongodb: { status: 'connected' },
      ollama: { status: 'error' }
    });
    const serialized = JSON.stringify(status);

    expect(status.services.filter((service) => service.id !== 'core')).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'down', issues: ['unreachable'], detail: { reason: 'unreachable' } })
    ]));
    expect(serialized).not.toMatch(/10\.0\.0\.99|Users|ECONNREFUSED/);
  });
});
