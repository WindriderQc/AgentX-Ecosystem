const express = require('express');
const request = require('supertest');
const {
  DEFAULT_PUBLIC_HOSTS,
  configuredPublicHosts,
  publicExposureGuard
} = require('../../src/middleware/publicExposureGuard');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', {
      value: app.locals.forcedIp || '127.0.0.1',
      configurable: true
    });
    next();
  });
  app.use(publicExposureGuard);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/nerve-center/status', (_req, res) => res.json({ status: 'success' }));
  app.post('/api/chat', (_req, res) => res.json({ status: 'success' }));
  app.post('/mcp', (_req, res) => res.json({ jsonrpc: '2.0', result: {} }));
  return app;
}

describe('publicExposureGuard', () => {
  const savedOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
  const savedAdminToken = process.env.AGENTX_ADMIN_TOKEN;
  const savedPublicHosts = process.env.AGENTX_PUBLIC_HOSTS;
  const savedAgentxPublicUrl = process.env.AGENTX_PUBLIC_URL;

  let app;

  beforeEach(() => {
    delete process.env.AGENTX_OPERATOR_TOKEN;
    delete process.env.AGENTX_ADMIN_TOKEN;
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    delete process.env.AGENTX_PUBLIC_URL;
    app = buildApp();
  });

  afterAll(() => {
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;
    if (savedAdminToken === undefined) delete process.env.AGENTX_ADMIN_TOKEN;
    else process.env.AGENTX_ADMIN_TOKEN = savedAdminToken;
    if (savedPublicHosts === undefined) delete process.env.AGENTX_PUBLIC_HOSTS;
    else process.env.AGENTX_PUBLIC_HOSTS = savedPublicHosts;
    if (savedAgentxPublicUrl === undefined) delete process.env.AGENTX_PUBLIC_URL;
    else process.env.AGENTX_PUBLIC_URL = savedAgentxPublicUrl;
  });

  it('blocks public-host API requests without an operator token even from loopback', async () => {
    const res = await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'agentx.example.test')
      .expect(403);

    expect(res.body).toEqual(expect.objectContaining({
      ok: false,
      code: 'PUBLIC_EXPOSURE_GUARD'
    }));
  });

  it('allows public-host API requests with a valid operator token', async () => {
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';

    await request(app)
      .post('/api/chat')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer operator-token')
      .send({ message: 'hello' })
      .expect(200);
  });

  it('does not block private-host API requests', async () => {
    await request(app)
      .post('/api/chat')
      .set('Host', '192.0.2.99:3080')
      .send({ message: 'hello' })
      .expect(200);
  });

  it('protects the MCP endpoint on public hosts', async () => {
    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(403);
  });

  it('leaves non-API health checks open on public hosts', async () => {
    await request(app)
      .get('/health')
      .set('Host', 'agentx.example.test')
      .expect(200);
  });

  it('honors additional public hosts from AGENTX_PUBLIC_HOSTS', async () => {
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';

    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'agentx.example.test')
      .expect(403);
  });

  it('has no maintainer-specific public host default', () => {
    delete process.env.AGENTX_PUBLIC_HOSTS;
    expect(DEFAULT_PUBLIC_HOSTS).toEqual([]);
    expect(configuredPublicHosts()).toEqual(new Set());
  });

  it('does not classify LAN CORE_PUBLIC_URL as public exposure', async () => {
    process.env.CORE_PUBLIC_URL = 'http://192.0.2.99:3080';

    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', '192.0.2.99:3080')
      .expect(200);
  });
});
