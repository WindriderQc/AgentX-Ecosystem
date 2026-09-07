'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('external consumer app mount', () => {
  test('serves contract discovery on the real Core app', async () => {
    const response = await request(app)
      .get('/api/consumers/v1/capabilities')
      .expect(200);

    expect(response.body.data).toMatchObject({
      contract: { name: 'agentx.external-consumer', version: '1.0.0' },
      inference: { stateless: true, persistence: false },
    });
  });

  test('enforces the versioned JSON transport envelope before broad parsing', async () => {
    const malformed = await request(app)
      .post('/api/consumers/v1/inference')
      .set('Content-Type', 'application/json')
      .send('{broken')
      .expect(400);
    expect(malformed.body.code).toBe('EXTERNAL_CONSUMER_INVALID_JSON');

    const wrongType = await request(app)
      .post('/api/consumers/v1/inference')
      .set('Content-Type', 'text/plain')
      .send('hello')
      .expect(415);
    expect(wrongType.body.code).toBe('EXTERNAL_CONSUMER_UNSUPPORTED_MEDIA_TYPE');
  });
});
