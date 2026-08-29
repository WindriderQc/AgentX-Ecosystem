'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('operator access app boundary', () => {
  const savedOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;

  afterEach(() => {
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;
  });

  it('blocks a cross-site browser from using loopback operator access', async () => {
    delete process.env.AGENTX_OPERATOR_TOKEN;
    const response = await request(app)
      .get('/api/memory-review/config')
      .set('Host', '127.0.0.1:3080')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .expect(403);

    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      code: 'PUBLIC_EXPOSURE_GUARD'
    }));
  });

  it('allows the same loopback surface from its exact UI origin', async () => {
    delete process.env.AGENTX_OPERATOR_TOKEN;
    await request(app)
      .get('/api/memory-review/config')
      .set('Host', '127.0.0.1:3080')
      .set('Origin', 'http://127.0.0.1:3080')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(200);
  });

  it('keeps explicit operator tokens valid for cross-site API clients', async () => {
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    await request(app)
      .get('/api/memory-review/config')
      .set('Host', '127.0.0.1:3080')
      .set('Origin', 'https://client.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .set('Authorization', 'Bearer operator-token')
      .expect(200);
  });
});
