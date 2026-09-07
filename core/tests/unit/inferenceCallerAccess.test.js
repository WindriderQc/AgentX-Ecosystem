'use strict';

const { createReq } = require('../helpers/runMiddleware');
const { DEFAULT_POLICY } = require('../../src/services/routing/callerPolicy');
const {
  inferenceCallerPrincipal,
  resolveInferenceRequestCaller
} = require('../../src/services/routing/inferenceCallerAccess');

describe('inference caller access', () => {
  test('defaults the principal to operator when no caller header is declared', () => {
    const req = createReq({
      method: 'POST',
      body: { callerDetail: 'chat-playground' }
    });

    expect(inferenceCallerPrincipal(req)).toBe('operator');
    expect(resolveInferenceRequestCaller(req)).toMatchObject({
      principal: 'operator',
      requestedPolicy: { lane: 'interactive', rateBucket: 'internal' },
      effectivePolicy: { lane: 'interactive', rateBucket: 'internal' }
    });
  });

  test('reads a known principal from the X-AgentX-Caller header and ignores unknown values', () => {
    const benchmarkReq = createReq({
      method: 'POST',
      headers: { 'x-agentx-caller': 'benchmark-service' },
      body: { callerDetail: 'benchmark-batch-123' }
    });
    const unknownReq = createReq({
      method: 'POST',
      headers: { 'x-agentx-caller': 'someone-else' },
      body: { callerDetail: 'benchmark-batch-123' }
    });

    expect(inferenceCallerPrincipal(benchmarkReq)).toBe('benchmark-service');
    expect(inferenceCallerPrincipal(unknownReq)).toBe('operator');
  });

  test('applies the requested policy as declared for every principal', () => {
    const benchmarkReq = createReq({
      method: 'POST',
      headers: { 'x-agentx-caller': 'benchmark-service' },
      body: { callerDetail: 'benchmark-batch-123' }
    });
    const operatorBenchmarkReq = createReq({
      method: 'POST',
      body: { callerDetail: 'benchmark-warmup' }
    });
    const unknownDetailReq = createReq({
      method: 'POST',
      body: { callerDetail: 'no-such-caller' }
    });

    const benchmark = resolveInferenceRequestCaller(benchmarkReq);
    expect(benchmark).toMatchObject({
      principal: 'benchmark-service',
      requestedPolicy: { lane: 'direct', rateBucket: 'benchmark' }
    });
    expect(benchmark.effectivePolicy).toBe(benchmark.requestedPolicy);

    const operatorBenchmark = resolveInferenceRequestCaller(operatorBenchmarkReq);
    expect(operatorBenchmark.principal).toBe('operator');
    expect(operatorBenchmark.effectivePolicy).toBe(operatorBenchmark.requestedPolicy);

    const unknownDetail = resolveInferenceRequestCaller(unknownDetailReq);
    expect(unknownDetail.requestedPolicy).toBe(DEFAULT_POLICY);
    expect(unknownDetail.effectivePolicy).toBe(DEFAULT_POLICY);
  });
});
