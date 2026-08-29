'use strict';

const request = require('supertest');
const app = require('../../server');

describe('GET /health', () => {
  test('returns the canonical identity envelope when readiness is degraded', async () => {
    const response = await request(app).get('/health');

    expect(response.status).toBe(503);
    expect(response.body).toEqual(expect.objectContaining({
      ok: false,
      status: 'degraded',
      service: 'agentx-benchmark',
      version: expect.any(String),
      profile: expect.stringMatching(/^(demo|full)$/),
      revision: expect.any(String),
      ts: expect.any(String),
      db: 'disconnected',
    }));
    expect(new Date(response.body.ts).toISOString()).toBe(response.body.ts);
  });
});
