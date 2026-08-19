'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('external consumer app mount', () => {
  const savedConsumerToken = process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
  const savedPublicHosts = process.env.AGENTX_PUBLIC_HOSTS;

  beforeEach(() => {
    process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = 'consumer-token';
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
  });

  afterAll(() => {
    if (savedConsumerToken === undefined) delete process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
    else process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = savedConsumerToken;
    if (savedPublicHosts === undefined) delete process.env.AGENTX_PUBLIC_HOSTS;
    else process.env.AGENTX_PUBLIC_HOSTS = savedPublicHosts;
  });

  test('serves authenticated contract discovery on the real Core app', async () => {
    const response = await request(app)
      .get('/api/consumers/v1/capabilities')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer consumer-token')
      .expect(200);

    expect(response.body.data).toMatchObject({
      contract: { name: 'agentx.external-consumer', version: '1.0.0' },
      inference: { stateless: true, persistence: false },
    });
  });

  test('does not let that token authorize another public Core API', async () => {
    await request(app)
      .get('/api/config')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer consumer-token')
      .expect(403);
  });

  test('enforces the versioned JSON transport envelope before broad parsing', async () => {
    const malformed = await request(app)
      .post('/api/consumers/v1/inference')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer consumer-token')
      .set('Content-Type', 'application/json')
      .send('{broken')
      .expect(400);
    expect(malformed.body.code).toBe('EXTERNAL_CONSUMER_INVALID_JSON');

    const wrongType = await request(app)
      .post('/api/consumers/v1/inference')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer consumer-token')
      .set('Content-Type', 'text/plain')
      .send('hello')
      .expect(415);
    expect(wrongType.body.code).toBe('EXTERNAL_CONSUMER_UNSUPPORTED_MEDIA_TYPE');
  });
});
