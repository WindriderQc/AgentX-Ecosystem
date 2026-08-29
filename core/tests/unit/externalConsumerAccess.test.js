'use strict';

const express = require('express');
const request = require('supertest');
const {
  externalConsumerTokenAllowed,
  isExternalConsumerPath,
  requireExternalConsumerAccess,
} = require('../../src/middleware/externalConsumerAccess');
const {
  operatorTokenAllowed,
  requireOperatorAccess,
} = require('../../src/middleware/operatorAccess');

function buildRequest(headers = {}) {
  return { get: (name) => headers[String(name).toLowerCase()] || '' };
}

function buildApp() {
  const app = express();
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', {
      value: '192.0.2.20',
      configurable: true,
    });
    next();
  });
  app.get('/consumer', requireExternalConsumerAccess, (_req, res) => res.json({ ok: true }));
  app.get('/operator', requireOperatorAccess, (_req, res) => res.json({ ok: true }));
  return app;
}

describe('external consumer access', () => {
  const originalConsumerToken = process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
  const originalOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;

  beforeEach(() => {
    process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = 'scoped-consumer-token';
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
  });

  afterAll(() => {
    if (originalConsumerToken === undefined) delete process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
    else process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = originalConsumerToken;
    if (originalOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalOperatorToken;
  });

  test('accepts the scoped token from either supported header using exact comparison', () => {
    expect(externalConsumerTokenAllowed(buildRequest({ authorization: 'Bearer scoped-consumer-token' }))).toBe(true);
    expect(externalConsumerTokenAllowed(buildRequest({ 'x-agentx-consumer-token': 'scoped-consumer-token' }))).toBe(true);
    expect(externalConsumerTokenAllowed(buildRequest({ authorization: 'Bearer scoped-consumer-tokeN' }))).toBe(false);
  });

  test('scopes its path matcher to both documented versioned consumer APIs', () => {
    expect(isExternalConsumerPath('/api/consumers/v1/inference')).toBe(true);
    expect(isExternalConsumerPath('/api/consumers/nestor/v1/inference')).toBe(true);
    expect(isExternalConsumerPath('/api/consumers/nestor/v1/memory/search?source=agentx')).toBe(true);
    expect(isExternalConsumerPath('/api/consumers/nestorish/v1/inference')).toBe(false);
    expect(isExternalConsumerPath('/api/config')).toBe(false);
  });

  test('the scoped token cannot authorize unrelated operator routes', async () => {
    const app = buildApp();
    await request(app)
      .get('/consumer')
      .set('Authorization', 'Bearer scoped-consumer-token')
      .expect(200);
    await request(app)
      .get('/operator')
      .set('Authorization', 'Bearer scoped-consumer-token')
      .expect(403);

    expect(operatorTokenAllowed(buildRequest({ authorization: 'Bearer scoped-consumer-token' }))).toBe(false);
  });

  test('fails closed for non-loopback callers when the scoped token is unset', async () => {
    delete process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
    delete process.env.AGENTX_OPERATOR_TOKEN;
    await request(buildApp()).get('/consumer').expect(403);
  });
});
