'use strict';

const { createReq } = require('../helpers/runMiddleware');
const { DEFAULT_POLICY } = require('../../src/services/routing/callerPolicy');
const {
  benchmarkTokenAllowed,
  resolveInferenceRequestCaller
} = require('../../src/services/routing/inferenceCallerAccess');

describe('inference caller access', () => {
  const originalBenchmarkToken = process.env.AGENTX_BENCHMARK_TOKEN;
  const originalOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;

  beforeEach(() => {
    delete process.env.AGENTX_BENCHMARK_TOKEN;
    delete process.env.AGENTX_OPERATOR_TOKEN;
  });

  afterAll(() => {
    if (originalBenchmarkToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = originalBenchmarkToken;
    if (originalOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalOperatorToken;
  });

  test('an unset or invalid Benchmark token never authenticates', () => {
    const req = createReq({
      method: 'POST',
      headers: { 'x-agentx-benchmark-token': 'caller-controlled' },
      body: { callerDetail: 'benchmark-batch-123' }
    });

    expect(benchmarkTokenAllowed(req)).toBe(false);
    expect(resolveInferenceRequestCaller(req)).toMatchObject({
      principal: 'anonymous',
      requestedPolicy: { lane: 'direct', rateBucket: 'benchmark' },
      effectivePolicy: DEFAULT_POLICY
    });
  });

  test('the scoped token promotes only Benchmark policy families', () => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'scoped-benchmark-token';
    const benchmarkReq = createReq({
      method: 'POST',
      headers: { 'x-agentx-benchmark-token': 'scoped-benchmark-token' },
      body: { callerDetail: 'benchmark-batch-123' }
    });
    const interactiveReq = createReq({
      method: 'POST',
      headers: { 'x-agentx-benchmark-token': 'scoped-benchmark-token' },
      body: { callerDetail: 'chat-playground' }
    });

    expect(resolveInferenceRequestCaller(benchmarkReq)).toMatchObject({
      principal: 'benchmark-service',
      effectivePolicy: { lane: 'direct', rateBucket: 'benchmark' }
    });
    expect(resolveInferenceRequestCaller(interactiveReq)).toMatchObject({
      principal: 'benchmark-service',
      effectivePolicy: DEFAULT_POLICY
    });
  });

  test('same-origin UI proof promotes interactive families but not Benchmark', () => {
    const headers = {
      host: 'localhost:3180',
      origin: 'http://localhost:3180',
      'sec-fetch-site': 'same-origin'
    };
    const interactiveReq = createReq({
      method: 'POST',
      headers,
      body: { callerDetail: 'chat-playground' }
    });
    const benchmarkReq = createReq({
      method: 'POST',
      headers,
      body: { callerDetail: 'profiler-context-probe' }
    });

    expect(resolveInferenceRequestCaller(interactiveReq)).toMatchObject({
      principal: 'same-origin-ui',
      effectivePolicy: { lane: 'interactive', rateBucket: 'internal' }
    });
    expect(resolveInferenceRequestCaller(benchmarkReq).effectivePolicy).toBe(DEFAULT_POLICY);
  });

  test('the existing operator token can promote internal but not Benchmark families', () => {
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    const headers = { authorization: 'Bearer operator-token' };
    const interactiveReq = createReq({
      method: 'POST',
      headers,
      body: { callerDetail: 'buddy/react' }
    });
    const benchmarkReq = createReq({
      method: 'POST',
      headers,
      body: { callerDetail: 'benchmark-warmup' }
    });

    expect(resolveInferenceRequestCaller(interactiveReq)).toMatchObject({
      principal: 'operator-token',
      effectivePolicy: { lane: 'interactive', rateBucket: 'internal' }
    });
    expect(resolveInferenceRequestCaller(benchmarkReq).effectivePolicy).toBe(DEFAULT_POLICY);
  });
});
