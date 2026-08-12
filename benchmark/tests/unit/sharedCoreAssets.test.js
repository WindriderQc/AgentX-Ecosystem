'use strict';

const request = require('supertest');
const app = require('../../server');
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

describe('shared Core assets', () => {
  it('serves the non-Buddy polling controller required by shared-utils', async () => {
    const response = await request(app).get('/public/js/utils/polling-controller.js');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('class PollingController');
  });

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
