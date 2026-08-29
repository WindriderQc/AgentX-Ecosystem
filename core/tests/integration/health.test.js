jest.mock('../../src/services/ollamaHealthProbe', () => ({
  refreshOllamaHealth: jest.fn(),
}));

const request = require('supertest');
const { app } = require('../../src/app');
const systemHealth = require('../../src/systemHealth');
const { refreshOllamaHealth } = require('../../src/services/ollamaHealthProbe');

describe('Health Check API', () => {
  beforeEach(() => {
    systemHealth.mongodb = { status: 'connected', lastCheck: null, error: null };
    systemHealth.ollama = { status: 'error', lastCheck: 'boot', error: 'boot failure' };
    refreshOllamaHealth.mockImplementation(async (state) => {
      const next = { status: 'connected', lastCheck: 'live', error: null };
      state.ollama = next;
      return next;
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('refreshes Ollama before returning the basic health response', async () => {
    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
    expect(refreshOllamaHealth).toHaveBeenCalledTimes(1);
    expect(refreshOllamaHealth).toHaveBeenCalledWith(systemHealth);
    // Canonical envelope: release, profile, and observation identity are
    // additive so older health consumers remain compatible.
    expect(res.body).toEqual(expect.objectContaining({
      ok: true,
      service: 'agentx-core',
      version: expect.any(String),
      profile: expect.stringMatching(/^(demo|full)$/),
      revision: expect.any(String),
      ts: expect.any(String),
    }));
    expect(new Date(res.body.ts).toISOString()).toBe(res.body.ts);
    // Legacy fields retained for backward compatibility.
    expect(res.body).toEqual(expect.objectContaining({
      status: 'ok',
      details: {
        mongodb: 'connected',
        ollama: 'connected',
      },
    }));
  });

  it('reports ok:false in the canonical envelope when mongodb is down', async () => {
    systemHealth.mongodb = { status: 'error', lastCheck: 'live', error: 'connection lost' };

    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.status).toBe('degraded');
    expect(res.body.service).toBe('agentx-core');
  });

  it('does not return a stale connected Ollama state after a failed live probe', async () => {
    systemHealth.ollama = { status: 'connected', lastCheck: 'boot', error: null };
    refreshOllamaHealth.mockImplementationOnce(async (state) => {
      const next = { status: 'error', lastCheck: 'live', error: 'connect refused' };
      state.ollama = next;
      return next;
    });

    const res = await request(app).get('/health');

    expect(res.statusCode).toBe(200);
    expect(res.body.details.ollama).toBe('error');
  });

  it('should return config at /api/config', async () => {
    const res = await request(app).get('/api/config');
    expect(res.statusCode).toBe(200);
    expect(res.body).toHaveProperty('ollama');
    expect(res.body.ollama).toHaveProperty('host');
  });
});
