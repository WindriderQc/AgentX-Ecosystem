'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/memoryReview/memoryReviewService', () => ({
  openRun: jest.fn(),
  listRuns: jest.fn(),
  buildDigest: jest.fn(),
  getRunDetail: jest.fn(),
  getRunOrThrow: jest.fn(),
  submitObservations: jest.fn(),
  finalizeCollection: jest.fn(),
  buildSynthesisInput: jest.fn(),
  submitCandidates: jest.fn(),
  failRun: jest.fn(),
  reviewCandidate: jest.fn(),
  authorizeApplyRun: jest.fn(),
}));
jest.mock('../../src/services/memoryReview/insightsService', () => ({
  buildInsights: jest.fn(),
}));
jest.mock('../../src/services/memoryReview/applyService', () => ({
  applyCandidate: jest.fn(),
}));

const service = require('../../src/services/memoryReview/memoryReviewService');
const memoryReviewRoutes = require('../../routes/memory-review');
const { app: fullApp } = require('../../src/app');

const originalToken = process.env.AGENTX_MEMORY_REVIEW_TOKEN;
const originalOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
const originalAdminToken = process.env.AGENTX_ADMIN_TOKEN;
const originalInternalTrust = process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
const originalPublicHosts = process.env.AGENTX_PUBLIC_HOSTS;

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/api/memory-review', memoryReviewRoutes);

const ROUTES = [
  {
    label: 'run creation',
    path: '/api/memory-review/runs',
    body: { runKey: 'producer-run' },
    sideEffect: service.openRun,
  },
  {
    label: 'observation submission',
    path: '/api/memory-review/runs/producer-run/observations',
    body: { collector: {}, observations: [] },
    sideEffect: service.submitObservations,
  },
  {
    label: 'collection finalization',
    path: '/api/memory-review/runs/producer-run/finalize',
    sideEffect: service.finalizeCollection,
  },
  {
    label: 'synthesis input read',
    method: 'get',
    path: '/api/memory-review/runs/producer-run/synthesis-input',
    sideEffect: service.getRunOrThrow,
  },
  {
    label: 'candidate submission',
    path: '/api/memory-review/runs/producer-run/candidates',
    body: { candidates: [] },
    sideEffect: service.submitCandidates,
  },
  {
    label: 'run failure',
    path: '/api/memory-review/runs/producer-run/fail',
    body: { stage: 'collector', reason: 'test failure' },
    sideEffect: service.failRun,
  },
];

const OPERATOR_READS = [
  { label: 'config', path: '/api/memory-review/config' },
  { label: 'run list', path: '/api/memory-review/runs', sideEffect: service.listRuns },
  { label: 'run detail', path: '/api/memory-review/runs/producer-run', sideEffect: service.getRunDetail },
  { label: 'run audit', path: '/api/memory-review/runs/producer-run/audit', sideEffect: service.getRunOrThrow },
];

function remoteProducerRequest(routeCase, token) {
  let pending = request(app)[routeCase.method || 'post'](routeCase.path)
    .set('Host', 'producer.example.test')
    .set('X-Forwarded-For', '203.0.113.20');
  if (token !== undefined) {
    pending = pending.set('X-AgentX-Memory-Review-Token', token);
  }
  if (routeCase.body !== undefined) pending = pending.send(routeCase.body);
  return pending;
}

describe('Memory Review producer identity on scoped machine routes', () => {
  beforeAll(() => {
    process.env.AGENTX_MEMORY_REVIEW_TOKEN = 'memory-review-secret';
    delete process.env.AGENTX_OPERATOR_TOKEN;
    delete process.env.AGENTX_ADMIN_TOKEN;
    delete process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.AGENTX_MEMORY_REVIEW_TOKEN;
    else process.env.AGENTX_MEMORY_REVIEW_TOKEN = originalToken;
    if (originalOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalOperatorToken;
    if (originalAdminToken === undefined) delete process.env.AGENTX_ADMIN_TOKEN;
    else process.env.AGENTX_ADMIN_TOKEN = originalAdminToken;
    if (originalInternalTrust === undefined) delete process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
    else process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = originalInternalTrust;
    if (originalPublicHosts === undefined) delete process.env.AGENTX_PUBLIC_HOSTS;
    else process.env.AGENTX_PUBLIC_HOSTS = originalPublicHosts;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENTX_MEMORY_REVIEW_TOKEN = 'memory-review-secret';
    service.openRun.mockResolvedValue({ runId: 'producer-run', status: 'collecting', mode: 'shadow' });
    service.submitObservations.mockResolvedValue({ runId: 'producer-run', accepted: 0 });
    service.finalizeCollection.mockResolvedValue({ runId: 'producer-run', status: 'synthesizing', summary: {} });
    service.getRunOrThrow.mockResolvedValue({ runId: 'producer-run', status: 'synthesizing' });
    service.buildSynthesisInput.mockReturnValue({ runId: 'producer-run', observations: [] });
    service.submitCandidates.mockResolvedValue({ runId: 'producer-run', status: 'ready_for_review' });
    service.failRun.mockResolvedValue({ runId: 'producer-run', status: 'failed', failure: { stage: 'collector' } });
  });

  test.each(ROUTES)('$label accepts the exact Memory Review producer token', async (routeCase) => {
    const response = await remoteProducerRequest(routeCase, 'memory-review-secret');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    expect(routeCase.sideEffect).toHaveBeenCalledTimes(1);
  });

  test.each(ROUTES)('$label rejects a missing token before side effects', async (routeCase) => {
    const response = await remoteProducerRequest(routeCase);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('MEMORY_REVIEW_PRODUCER_ACCESS_REQUIRED');
    expect(routeCase.sideEffect).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('$label rejects a wrong token before side effects', async (routeCase) => {
    const response = await remoteProducerRequest(routeCase, 'wrong-secret');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('MEMORY_REVIEW_PRODUCER_ACCESS_REQUIRED');
    expect(routeCase.sideEffect).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('$label fails closed when the environment token is unset', async (routeCase) => {
    delete process.env.AGENTX_MEMORY_REVIEW_TOKEN;

    const response = await remoteProducerRequest(routeCase, 'memory-review-secret');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('MEMORY_REVIEW_PRODUCER_ACCESS_REQUIRED');
    expect(routeCase.sideEffect).not.toHaveBeenCalled();
  });

  test('attributes scoped observation submissions to the producer token identity', async () => {
    const routeCase = ROUTES[1];

    await remoteProducerRequest(routeCase, 'memory-review-secret').expect(200);

    expect(service.submitObservations).toHaveBeenCalledWith(
      'producer-run',
      routeCase.body.collector,
      routeCase.body.observations,
      { submittedBy: 'memory-review-producer-token' }
    );
  });

  test.each(OPERATOR_READS)('does not grant the producer token access to $label', async (routeCase) => {
    const response = await request(app)
      .get(routeCase.path)
      .set('Host', 'producer.example.test')
      .set('X-Forwarded-For', '203.0.113.20')
      .set('X-AgentX-Memory-Review-Token', 'memory-review-secret');

    expect(response.status).toBe(403);
    if (routeCase.sideEffect) expect(routeCase.sideEffect).not.toHaveBeenCalled();
  });

  test('the full app admits the scoped workflow on a configured public host', async () => {
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';

    const opened = await request(fullApp)
      .post('/api/memory-review/runs')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Memory-Review-Token', 'memory-review-secret')
      .send({ runKey: 'producer-run' });
    const synthesisInput = await request(fullApp)
      .get('/api/memory-review/runs/producer-run/synthesis-input')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Memory-Review-Token', 'memory-review-secret');

    expect(opened.status).toBe(200);
    expect(opened.body.status).toBe('success');
    expect(synthesisInput.status).toBe(200);
    expect(synthesisInput.body.status).toBe('success');
    expect(service.openRun).toHaveBeenCalledTimes(1);
    expect(service.getRunOrThrow).toHaveBeenCalledTimes(1);
  });
});
