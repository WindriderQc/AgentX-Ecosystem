const request = require('supertest');
const app = require('../../app');
const api = request.agent(app);
const originalCoreUrl = process.env.CORE_URL;
const originalCoreOutboundClient = app.locals.coreOutboundClient;

afterAll((done) => {
  if (api.app.listening) return api.app.close(done);
  return done();
});

afterEach(() => {
  app.locals.coreOutboundClient = originalCoreOutboundClient;
  if (originalCoreUrl === undefined) delete process.env.CORE_URL;
  else process.env.CORE_URL = originalCoreUrl;
});

function catalogResponse() {
  const headers = {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-require-profiled-models': 'true',
  };
  return {
    status: 200,
    headers: { get: (name) => headers[name.toLowerCase()] || null },
    body: Buffer.from(JSON.stringify({ ok: true, data: { models: [] } })),
  };
}

describe('GET /health', () => {
  it('returns 503 with degraded when DB is not connected', async () => {
    const res = await api.get('/health');
    expect(res.status).toBe(503);
    expect(res.body).toEqual(expect.objectContaining({
      ok: false,
      service: 'agentx-rag',
      version: expect.any(String),
      profile: expect.stringMatching(/^(demo|full)$/),
      revision: expect.any(String),
      ts: expect.any(String),
    }));
    expect(new Date(res.body.ts).toISOString()).toBe(res.body.ts);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('disconnected');
    expect(res.body.vectorStore.healthy).toBe(false);
    expect(JSON.stringify(res.body)).not.toMatch(/https?:\/\//);
  });

  it('checks the configured in-memory vector store without an external call', async () => {
    const previousType = process.env.VECTOR_STORE_TYPE;
    process.env.VECTOR_STORE_TYPE = 'memory';
    try {
      await expect(app.checkVectorStoreHealth()).resolves.toEqual({ healthy: true, type: 'memory' });
    } finally {
      if (previousType === undefined) delete process.env.VECTOR_STORE_TYPE;
      else process.env.VECTOR_STORE_TYPE = previousType;
    }
  });
});

describe('RAG API observation receipts', () => {
  it('adds a fresh observedAt timestamp to success and degraded API envelopes', async () => {
    const res = await api.post('/api/rag/search').send({}).expect(400);
    expect(res.body.meta.durationMs).toEqual(expect.any(Number));
    expect(new Date(res.body.meta.observedAt).toISOString()).toBe(res.body.meta.observedAt);
  });
});

describe('GET /favicon.ico', () => {
  it('serves the shared favicon asset', async () => {
    const res = await api.get('/favicon.ico');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
  });
});

describe('GET /public/js/utils/polling-controller.js', () => {
  it('serves the non-Buddy utility required by shared-utils', async () => {
    const res = await api.get('/public/js/utils/polling-controller.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('class PollingController');
  });

  it('does not expose unrelated Core public pages', async () => {
    await api.get('/portal/index.html').expect(404);
    await api.get('/host-agent/agent.js').expect(404);
  });
});

describe('demo navigation', () => {
  it('shows only product links and points back to Core', async () => {
    const res = await api.get('/');
    expect(res.status).toBe(200);
    expect(res.text).toContain('data-agentx-profile="demo"');
    expect(res.text).toContain('Product');
    expect(res.text).toContain('Knowledge');
    expect(res.text).toContain('Evaluation');
    expect(res.text).toContain('http://localhost:3080/demo');
    expect(res.text).not.toContain('Nerve Center');
    expect(res.text).not.toContain('OpenClaw');
  });
});

describe('GET /api/models/all', () => {
  it('proxies model-catalog filters and readiness headers without restoring Buddy routes', async () => {
    const getModelCatalog = jest.fn().mockResolvedValue(catalogResponse());
    app.locals.coreOutboundClient = { getModelCatalog };

    const response = await api
      .get('/api/models/all?host=primary&status=available')
      .expect(200);

    expect(getModelCatalog).toHaveBeenCalledWith(expect.objectContaining({
      accept: 'application/json',
      query: '?host=primary&status=available',
    }));
    expect(response.headers['x-require-profiled-models']).toBe('true');
    expect(response.body).toEqual({ ok: true, data: { models: [] } });
  });
});
