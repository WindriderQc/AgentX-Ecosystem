const request = require('supertest');
const { app } = require('../../src/app');

// Mock global fetch so /react doesn't actually call Ollama (avoids 10s timeout per request)
const originalFetch = global.fetch;
beforeAll(() => {
  global.fetch = jest.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ message: { content: 'mocked reaction' } }),
  });
});
afterAll(() => {
  global.fetch = originalFetch;
});

describe('Buddy rate limiting', () => {
  const clientId = 'buddy-rate-test-' + Date.now();

  it('allows normal buddy event requests', async () => {
    const res = await request(app)
      .post('/api/buddy/event')
      .set('x-test-client', clientId + '-normal')
      .send({ seed: 'test', eventType: 'idle' });
    expect(res.status).not.toBe(429);
  });

  it('returns 429 after exceeding buddy react limit (10/min)', async () => {
    const id = clientId + '-react';
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post('/api/buddy/react')
        .set('x-test-client', id)
        .send({ context: 'test', personality: 'test' });
    }
    const res = await request(app)
      .post('/api/buddy/react')
      .set('x-test-client', id)
      .send({ context: 'test', personality: 'test' });
    expect(res.status).toBe(429);
    expect(res.body.error).toBe('rate_limited');
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
  });

  it('returns 429 after exceeding general buddy limit (30/min)', async () => {
    const id = clientId + '-general';
    for (let i = 0; i < 30; i++) {
      await request(app)
        .get('/api/buddy/hosts')
        .set('x-test-client', id);
    }
    const res = await request(app)
      .get('/api/buddy/hosts')
      .set('x-test-client', id);
    expect(res.status).toBe(429);
  });
});
