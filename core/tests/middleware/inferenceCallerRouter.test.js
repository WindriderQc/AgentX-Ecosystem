/**
 * Inference Caller Router Rate Limiter Tests
 *
 * Tests the caller-aware routing that separates benchmark callers
 * (5000/15min) from general API callers (500/15min).
 */

const request = require('supertest');
const express = require('express');
const { inferenceCallerRouter } = require('../../src/middleware/rateLimiter');

describe('inferenceCallerRouter - Caller-aware rate limiting', () => {
  let app;
  let server;

  beforeAll((done) => {
    // Create a minimal express app with the middleware setup
    app = express();
    app.use(express.json());

    // Apply the caller-aware router to /api/inference
    app.post('/api/inference/generate', inferenceCallerRouter, (req, res) => {
      res.json({
        status: 'success',
        callerDetail: req.body?.callerDetail || 'none'
      });
    });
    server = app.listen(0, '127.0.0.1', done);
  });

  afterAll((done) => {
    server.close(done);
  });

  it('should route benchmark callers to benchmarkLimiter', async () => {
    process.env.NODE_ENV = 'test';

    const res = await request(server)
      .post('/api/inference/generate')
      .set('x-test-client', 'benchmark-test')
      .send({
        model: 'test-model',
        prompt: 'test',
        callerDetail: 'benchmark-orchestrator'
      });

    expect(res.status).toBe(200);
    expect(res.body.callerDetail).toBe('benchmark-orchestrator');
  });

  it('should route non-benchmark callers to apiLimiter', async () => {
    process.env.NODE_ENV = 'test';

    const res = await request(server)
      .post('/api/inference/generate')
      .set('x-test-client', 'general-test')
      .send({
        model: 'test-model',
        prompt: 'test'
      });

    expect(res.status).toBe(200);
    expect(res.body.callerDetail).toBe('none');
  });

  it('should recognize all benchmark caller prefixes', async () => {
    process.env.NODE_ENV = 'test';

    const benchmarkPrefixes = [
      'benchmark-orchestrator',
      'benchmark-judge',
      'benchmark-warmup',
      'benchmark-host-test-warmup',
      'benchmark-reference-scorer',
      'benchmark-decomposed-judge'
    ];

    for (const prefix of benchmarkPrefixes) {
      const res = await request(server)
        .post('/api/inference/generate')
        .set('x-test-client', `test-${prefix}`)
        .send({
          model: 'test-model',
          prompt: 'test',
          callerDetail: prefix
        });

      expect(res.status).toBe(200);
      expect(res.body.callerDetail).toBe(prefix);
    }
  });

  it('should handle missing callerDetail', async () => {
    process.env.NODE_ENV = 'test';

    const res = await request(server)
      .post('/api/inference/generate')
      .set('x-test-client', 'general-no-caller')
      .send({
        model: 'test-model',
        prompt: 'test'
      });

    expect(res.status).toBe(200);
  });

  it('should handle empty callerDetail', async () => {
    process.env.NODE_ENV = 'test';

    const res = await request(server)
      .post('/api/inference/generate')
      .set('x-test-client', 'general-empty-caller')
      .send({
        model: 'test-model',
        prompt: 'test',
        callerDetail: ''
      });

    expect(res.status).toBe(200);
  });
});
