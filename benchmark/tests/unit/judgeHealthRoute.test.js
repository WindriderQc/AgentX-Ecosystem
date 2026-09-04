'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/benchmark/workloadAdmissionLifecycle', () => ({
  withManagedWorkloadRoute: (_kind, _resolveOptions, handler) => handler
}));

jest.mock('../../src/services/judgeValidation', () => ({
  runHealthCheck: jest.fn(async () => ({ healthy: true })),
}));
jest.mock('../../src/services/benchmark/judgeReadiness', () => ({
  resolveReadyJudgeTarget: jest.fn(async () => ({
    ready: true,
    target: { host: 'http://localhost:11434', model: 'judge:7b' },
  })),
  judgeUnavailablePayload: jest.fn(),
}));

const judgeValidation = require('../../src/services/judgeValidation');
const router = require('../../routes/benchmark/diagnostics');

const app = express();
app.use(express.json());
app.use('/api/benchmark', router);

describe('Judge health action semantics', () => {
  beforeEach(() => jest.clearAllMocks());

  test('GET cannot start the inference-backed health workload', async () => {
    await request(app).get('/api/benchmark/judge/health').expect(404);
    expect(judgeValidation.runHealthCheck).not.toHaveBeenCalled();
  });

  test('POST owns the explicit health workload', async () => {
    const response = await request(app).post('/api/benchmark/judge/health');
    expect(response.status).toBe(200);
    expect(response.body.data).toEqual({ healthy: true });
    expect(judgeValidation.runHealthCheck).toHaveBeenCalledTimes(1);
  });
});
