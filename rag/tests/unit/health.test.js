const request = require('supertest');
const app = require('../../app');
const originalFetch = global.fetch;
const originalCoreUrl = process.env.CORE_URL;

afterEach(() => {
  global.fetch = originalFetch;
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
    arrayBuffer: async () => Buffer.from(JSON.stringify({ ok: true, data: { models: [] } })),
  };
}

describe('GET /health', () => {
  it('returns 503 with degraded when DB is not connected', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(503);
    expect(res.body.status).toBe('degraded');
    expect(res.body.db).toBe('disconnected');
  });
});

describe('GET /favicon.ico', () => {
  it('serves the shared favicon asset', async () => {
    const res = await request(app).get('/favicon.ico');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('image/svg+xml');
    expect(Number(res.headers['content-length'])).toBeGreaterThan(0);
  });
});

describe('GET /public/js/utils/polling-controller.js', () => {
  it('serves the non-Buddy utility required by shared-utils', async () => {
    const res = await request(app).get('/public/js/utils/polling-controller.js');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/javascript/);
    expect(res.text).toContain('class PollingController');
  });
});

describe('GET /api/models/all', () => {
  it('proxies model-catalog filters and readiness headers without restoring Buddy routes', async () => {
    process.env.CORE_URL = 'http://core.test:3080/';
    global.fetch = jest.fn().mockResolvedValue(catalogResponse());

    const response = await request(app)
      .get('/api/models/all?host=primary&status=available')
      .expect(200);

    expect(global.fetch).toHaveBeenCalledWith(
      'http://core.test:3080/api/models/all?host=primary&status=available',
      expect.objectContaining({ headers: expect.objectContaining({ Accept: 'application/json' }) })
    );
    expect(response.headers['x-require-profiled-models']).toBe('true');
    expect(response.body).toEqual({ ok: true, data: { models: [] } });
  });
});
