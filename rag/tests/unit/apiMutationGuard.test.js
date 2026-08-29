'use strict';

const request = require('supertest');
const app = require('../../app');

describe('RAG API mutation boundary', () => {
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
});
