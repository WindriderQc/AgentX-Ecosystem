'use strict';

const fs = require('node:fs');
const path = require('node:path');
const expressApp = require('../../server');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const originalFetch = global.fetch;
const originalCoreUrl = process.env.CORE_URL;

let httpHarness;
let api;

beforeAll(async () => {
  httpHarness = await startTestHttpHarness(expressApp);
  api = httpHarness.request;
});

afterAll(async () => {
  await httpHarness?.close();
});

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
    const response = await api.get('/public/js/utils/polling-controller.js');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('class PollingController');
  });

  it('packages and serves the typed-confirmation control required by the shared footer', async () => {
    const dockerfilePath = path.resolve(__dirname, '..', '..', '..', 'docker', 'benchmark.Dockerfile');
    const dockerfile = fs.readFileSync(dockerfilePath, 'utf8');
    expect(dockerfile).toContain(
      'COPY core/public/js/utils/typed-confirmation.js /core/public/js/utils/typed-confirmation.js'
    );

    const response = await api.get('/js/utils/typed-confirmation.js');
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/javascript/);
    expect(response.text).toContain('root.AgentXTypedConfirmation = api;');
  });

  it('does not expose unrelated Core public pages', async () => {
    await api.get('/portal/index.html').expect(404);
    await api.get('/host-agent/agent.js').expect(404);
  });

  it('renders product-only navigation in the demo profile', async () => {
    const response = await api.get('/leaderboard').expect(200);
    expect(response.text).toContain('data-agentx-profile="demo"');
    expect(response.text).toContain('Product');
    expect(response.text).toContain('Knowledge');
    expect(response.text).toContain('Evaluation');
    expect(response.text).not.toContain('Nerve Center');
    expect(response.text).not.toContain('OpenClaw');
  });

  it('proxies model-catalog filters and readiness headers without restoring Buddy routes', async () => {
    process.env.CORE_URL = 'http://core.test:3080/';
    global.fetch = jest.fn().mockResolvedValue(catalogResponse());

    const response = await api
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
