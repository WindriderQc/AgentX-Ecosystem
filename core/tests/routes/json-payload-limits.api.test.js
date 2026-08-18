'use strict';

const request = require('supertest');
const { app } = require('../../src/app');

describe('Core JSON transport boundaries', () => {
  it('enforces the 1 MiB chat parser before the product default parser', async () => {
    const response = await request(app)
      .post('/api/chat')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ message: 'x'.repeat(1024 * 1024 + 1) }))
      .expect(413);

    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
    expect(response.body.message).toContain('configured route limit');
  });

  it('enforces the 5 MiB product default on routes without a local parser', async () => {
    const response = await request(app)
      .post('/api/not-a-real-route')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: 'x'.repeat(5 * 1024 * 1024 + 1) }))
      .expect(413);

    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });

  it('lets the Roundtable webhook keep its 64 KiB route-owned limit', async () => {
    const response = await request(app)
      .post('/api/roundtable/telegram/webhook')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ value: 'x'.repeat(64 * 1024 + 1) }))
      .expect(413);

    expect(response.body.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
