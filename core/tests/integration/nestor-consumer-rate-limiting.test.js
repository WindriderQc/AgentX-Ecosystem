'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('Nestor consumer migration transfer rate limiting', () => {
  let server;

  beforeAll((done) => {
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  it('does not interrupt exact operator-gated notes pages at the general API ceiling', async () => {
    for (let index = 0; index < 505; index += 1) {
      const response = await request(server)
        .get('/api/consumers/nestor/v1/migration/notes?snapshotId=invalid')
        .set('X-Test-Client', 'nestor-notes-transfer');
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('NESTOR_MIGRATION_INVALID_SNAPSHOT_ID');
    }
  });

  it('uses an independent budget and returns the canonical v1 error envelope', async () => {
    for (let index = 0; index < 120; index += 1) {
      await request(server)
        .get('/api/consumers/nestor/v1/not-a-route')
        .set('X-Test-Client', 'nestor-v1-budget')
        .expect(404);
    }
    const limited = await request(server)
      .get('/api/consumers/nestor/v1/not-a-route')
      .set('X-Test-Client', 'nestor-v1-budget')
      .expect(429);
    expect(limited.body).toEqual(expect.objectContaining({
      ok: false,
      status: 'error',
      error: 'Nestor v1 request rate limit exceeded. Please retry shortly.',
      message: 'Nestor v1 request rate limit exceeded. Please retry shortly.',
      code: 'NESTOR_RATE_LIMITED',
      retryAfterMs: expect.any(Number),
    }));
  });
});
