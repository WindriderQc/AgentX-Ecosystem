'use strict';

const request = require('supertest');
const app = require('../../server');

describe('Benchmark API mutation boundary', () => {
  test('blocks a cross-site form before a destructive retention handler can run', async () => {
    const response = await request(app)
      .post('/api/benchmark/retention/reset-all')
      .set('Host', '127.0.0.1:3081')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .type('form')
      .send({ confirm: 'RESET' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN');
  });

  test('applies the same mutation boundary to Express case-insensitive API paths', async () => {
    const response = await request(app)
      .post('/API/Benchmark/Retention/Reset-All')
      .set('Host', '127.0.0.1:3081')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .type('form')
      .send({ confirm: 'RESET' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN');
  });

  test('guards the model-catalog proxy before its route handler', async () => {
    const response = await request(app)
      .get('/api/models/all')
      .set('Host', 'attacker.example:3081');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('UNTRUSTED_HOST');
  });
});
