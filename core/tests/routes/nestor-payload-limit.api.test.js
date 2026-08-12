'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('Nestor v1 transport boundary', () => {
  it('returns the canonical v1 envelope for malformed JSON', async () => {
    const response = await request(app)
      .post('/api/consumers/nestor/v1/inference')
      .set('Content-Type', 'application/json')
      .send('{bad')
      .expect(400);

    expect(response.body).toEqual({
      ok: false,
      status: 'error',
      error: 'Nestor v1 request body contains invalid JSON.',
      message: 'Nestor v1 request body contains invalid JSON.',
      code: 'NESTOR_INVALID_JSON',
    });
  });

  it('rejects oversized JSON before the global 50 MiB parser', async () => {
    const response = await request(app)
      .post('/api/consumers/nestor/v1/inference')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ padding: 'x'.repeat(1024 * 1024 + 1) }))
      .expect(413);

    expect(response.body).toEqual({
      ok: false,
      status: 'error',
      error: expect.stringContaining('1 MiB'),
      code: 'PAYLOAD_TOO_LARGE',
      message: expect.stringContaining('1 MiB'),
    });
  });

  it('rejects non-JSON entity bodies before the global URL-encoded parser', async () => {
    const response = await request(app)
      .post('/api/consumers/nestor/v1/inference')
      .type('form')
      .send({ value: 'non-json entity' })
      .expect(415);

    expect(response.body).toEqual({
      ok: false,
      status: 'error',
      error: 'Nestor v1 request bodies must use application/json.',
      message: 'Nestor v1 request bodies must use application/json.',
      code: 'NESTOR_UNSUPPORTED_MEDIA_TYPE',
    });
  });

  it('rejects entity-bearing GET requests before the global URL-encoded parser', async () => {
    const response = await request(app)
      .get('/api/consumers/nestor/v1/capabilities')
      .type('form')
      .send({ value: 'non-json entity' })
      .expect(415);

    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      status: 'error',
      code: 'NESTOR_UNSUPPORTED_MEDIA_TYPE',
    }));
  });
});
