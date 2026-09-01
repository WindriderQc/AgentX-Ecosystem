'use strict';

const request = require('supertest');
const app = require('../../app');
const mutationRoutePolicy = require('../../../config/mutation-route-policy.json');

describe('RAG API mutation boundary', () => {
  test('declares only policy-classified action observations for remote same-origin UI access', () => {
    const policy = mutationRoutePolicy.routes['rag/routes/rag.js'];
    const declared = app.RAG_SAME_ORIGIN_ACTION_OBSERVATIONS
      .map(({ method, path }) => `${method} ${path.replace('/api/rag', '')}`);

    expect(declared).toEqual(['POST /status/refresh', 'POST /search']);
    for (const route of declared) expect(policy[route]).toBe('action-observation');
  });

  test('blocks cross-site simple POSTs before cache mutation handlers run', async () => {
    const response = await request(app)
      .post('/api/rag/cache/clear')
      .set('Host', '127.0.0.1:3082')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN');
  });

  test('does not allow case-variant API paths to bypass the boundary', async () => {
    const response = await request(app)
      .post('/API/Rag/Cache/Clear')
      .set('Host', '127.0.0.1:3082')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN');
  });

  test('protects the inference-backed status refresh action', async () => {
    const response = await request(app)
      .post('/api/rag/status/refresh')
      .set('Host', '127.0.0.1:3082')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN');
  });

  test('lets the supported exact same-origin search journey reach route validation', async () => {
    const previousTrustProxy = app.get('trust proxy');
    app.set('trust proxy', true);
    try {
      const response = await request(app)
        .post('/api/rag/search')
        .set('Host', '127.0.0.1:3082')
        .set('Origin', 'http://127.0.0.1:3082')
        .set('Sec-Fetch-Site', 'same-origin')
        .set('X-Forwarded-For', '192.0.2.10')
        .send({});

      expect(response.status).toBe(400);
      expect(response.body.code).not.toBe('CROSS_SITE_MUTATION_FORBIDDEN');
      expect(response.body.error).toMatch(/query is required/i);
    } finally {
      app.set('trust proxy', previousTrustProxy);
    }
  });

  test('lets the supported exact same-origin active readiness refresh reach its handler', async () => {
    const previousTrustProxy = app.get('trust proxy');
    app.set('trust proxy', true);
    try {
      const response = await request(app)
        .post('/api/rag/status/refresh')
        .set('Host', '127.0.0.1:3082')
        .set('Origin', 'http://127.0.0.1:3082')
        .set('Sec-Fetch-Site', 'same-origin')
        .set('X-Forwarded-For', '192.0.2.10');

      expect(response.status).not.toBe(403);
      expect(response.body.code).not.toBe('CROSS_SITE_MUTATION_FORBIDDEN');
    } finally {
      app.set('trust proxy', previousTrustProxy);
    }
  });

  test.each([
    ['cross-site search', '/api/rag/search', 'http://127.0.0.1:3082', 'cross-site'],
    ['wrong port', '/api/rag/search', 'http://127.0.0.1:3999', 'same-origin'],
    ['wrong protocol', '/api/rag/search', 'https://127.0.0.1:3082', 'same-origin'],
  ])('keeps %s outside the action-observation exception', async (_label, path, origin, fetchSite) => {
    const previousTrustProxy = app.get('trust proxy');
    app.set('trust proxy', true);
    try {
      const response = await request(app)
        .post(path)
        .set('Host', '127.0.0.1:3082')
        .set('Origin', origin)
        .set('Sec-Fetch-Site', fetchSite)
        .set('X-Forwarded-For', '192.0.2.10')
        .send({});

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN');
    } finally {
      app.set('trust proxy', previousTrustProxy);
    }
  });

  test('keeps an exact same-origin destructive mutation protected', async () => {
    const previousTrustProxy = app.get('trust proxy');
    app.set('trust proxy', true);
    try {
      const response = await request(app)
        .post('/api/rag/cache/clear')
        .set('Host', '127.0.0.1:3082')
        .set('Origin', 'http://127.0.0.1:3082')
        .set('Sec-Fetch-Site', 'same-origin')
        .set('X-Forwarded-For', '192.0.2.10');

      expect(response.status).toBe(403);
      expect(response.body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN');
    } finally {
      app.set('trust proxy', previousTrustProxy);
    }
  });
});
