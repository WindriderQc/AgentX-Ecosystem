'use strict';

const express = require('express');
const request = require('supertest');
const { createApiHostGuard } = require('../../../shared/apiHostGuard');

function appFor(env = {}, forcedIp = '127.0.0.1') {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: forcedIp, configurable: true });
    next();
  });
  app.use(createApiHostGuard({
    serviceHosts: ['benchmark'],
    publicUrlEnv: ['BENCHMARK_PUBLIC_URL'],
    protectMutations: true,
    env,
  }));
  app.get('/health', (_req, res) => res.json({ ok: true }));
  app.post('/api/mutate', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('shared service API Host guard', () => {
  test('allows loopback and internal product hosts', async () => {
    const app = appFor();
    await request(app).post('/api/mutate').set('Host', '127.0.0.1:3081').expect(200);
    await request(app).post('/api/mutate').set('Host', 'benchmark:3081').expect(200);
  });

  test('blocks a DNS-rebinding hostname but leaves health discovery available', async () => {
    const app = appFor();
    await request(app).post('/api/mutate').set('Host', 'attacker.example:3081').expect(403)
      .expect(({ body }) => expect(body.code).toBe('UNTRUSTED_HOST'));
    await request(app).get('/health').set('Host', 'attacker.example:3081').expect(200);
  });

  test('allows an explicit UI hostname or exact operator token', async () => {
    const env = {
      BENCHMARK_PUBLIC_URL: 'https://bench.example.test',
      AGENTX_OPERATOR_TOKEN: 'operator-token',
    };
    const app = appFor(env);
    await request(app).post('/api/mutate')
      .set('Host', 'bench.example.test')
      .set('Origin', 'https://bench.example.test')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(200);
    await request(app).post('/api/mutate')
      .set('Host', 'other.example.test')
      .set('Authorization', 'Bearer operator-token')
      .expect(200);
    await request(app).post('/api/mutate')
      .set('Host', 'other.example.test')
      .set('Authorization', 'Bearer wrong-token')
      .expect(403);
  });

  test('blocks cross-site form mutations even when their target Host is loopback', async () => {
    const app = appFor();
    await request(app).post('/api/mutate')
      .set('Host', '127.0.0.1:3081')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .type('form')
      .send({ confirm: 'RESET' })
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN'));
  });

  test('requires a token for remote headerless mutations on a public UI host', async () => {
    const env = {
      BENCHMARK_PUBLIC_URL: 'https://bench.example.test',
      AGENTX_OPERATOR_TOKEN: 'operator-token',
    };
    const app = appFor(env, '192.0.2.10');
    await request(app).post('/api/mutate')
      .set('Host', 'bench.example.test')
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('MUTATION_AUTH_REQUIRED'));
    await request(app).post('/api/mutate')
      .set('Host', 'bench.example.test')
      .set('X-AgentX-Operator-Token', 'operator-token')
      .expect(200);
  });

  test('retains bounded headerless service-to-service mutations on the internal hostname', async () => {
    const app = appFor({ AGENTX_TRUST_INTERNAL_SERVICE_HOSTS: 'true' }, '172.20.0.12');
    await request(app).post('/api/mutate')
      .set('Host', 'benchmark:3081')
      .set('Sec-Fetch-Mode', 'cors')
      .expect(200);
  });

  test('admits native-fetch tooling only through the explicit loopback-published contract', async () => {
    const app = appFor({ AGENTX_TRUST_LOOPBACK_PROXY_UI: 'true' }, '172.20.0.1');
    await request(app).post('/api/mutate')
      .set('Host', '127.0.0.1:3181')
      .set('Sec-Fetch-Mode', 'cors')
      .expect(200);
    await request(app).post('/api/mutate')
      .set('Host', 'attacker.example:3181')
      .set('Sec-Fetch-Mode', 'cors')
      .expect(403);
  });

  test('does not trust a forged internal hostname outside the explicit container contract', async () => {
    const app = appFor({}, '192.0.2.10');
    await request(app).post('/api/mutate')
      .set('Host', 'benchmark:3081')
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('MUTATION_AUTH_REQUIRED'));
  });

  test('does not treat forged same-origin headers as remote operator identity', async () => {
    const env = { BENCHMARK_PUBLIC_URL: 'https://bench.example.test' };
    const app = appFor(env, '192.0.2.10');
    await request(app).post('/api/mutate')
      .set('Host', 'bench.example.test')
      .set('Origin', 'https://bench.example.test')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN'));
  });

  test('rejects a remote caller that forges the localhost Host and Origin', async () => {
    const app = appFor({}, '198.51.100.7');
    await request(app).post('/api/mutate')
      .set('Host', 'localhost:3081')
      .set('Origin', 'http://localhost:3081')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(403)
      .expect(({ body }) => expect(body.code).toBe('CROSS_SITE_MUTATION_FORBIDDEN'));
  });

  test('allows the same loopback URL only through the explicit Compose proxy contract', async () => {
    const app = appFor({ AGENTX_TRUST_LOOPBACK_PROXY_UI: 'true' }, '172.20.0.1');
    await request(app).post('/api/mutate')
      .set('Host', 'localhost:3181')
      .set('Origin', 'http://localhost:3181')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(200);
  });
});
