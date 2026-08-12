const request = require('supertest');
const { app } = require('../../src/app');

describe('public exposure guard app mount', () => {
  const savedOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
  const savedAdminToken = process.env.AGENTX_ADMIN_TOKEN;
  const savedPublicHosts = process.env.AGENTX_PUBLIC_HOSTS;

  beforeEach(() => {
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    delete process.env.AGENTX_ADMIN_TOKEN;
    delete process.env.AGENTX_PUBLIC_HOSTS;
  });

  afterAll(() => {
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;

    if (savedAdminToken === undefined) delete process.env.AGENTX_ADMIN_TOKEN;
    else process.env.AGENTX_ADMIN_TOKEN = savedAdminToken;

    if (savedPublicHosts === undefined) delete process.env.AGENTX_PUBLIC_HOSTS;
    else process.env.AGENTX_PUBLIC_HOSTS = savedPublicHosts;
  });

  it('blocks public-host API traffic before app routes handle it', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Host', 'agentx.specialblend.icu')
      .expect(403);

    expect(res.body).toEqual(expect.objectContaining({
      ok: false,
      code: 'PUBLIC_EXPOSURE_GUARD'
    }));
  });

  it('allows public-host API traffic with a valid operator token', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Host', 'agentx.specialblend.icu')
      .set('Authorization', 'Bearer operator-token')
      .expect(200);

    expect(res.body).toHaveProperty('ollama');
  });

  it('does not gate private-host API traffic', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Host', '192.0.2.99:3080')
      .expect(200);

    expect(res.body).toHaveProperty('ollama');
  });

  it('leaves public-host health checks available', async () => {
    const res = await request(app)
      .get('/health')
      .set('Host', 'agentx.specialblend.icu');

    expect([200, 503]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(403);
  });
});
