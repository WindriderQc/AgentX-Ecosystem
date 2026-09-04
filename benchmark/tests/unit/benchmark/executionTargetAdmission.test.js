'use strict';

jest.mock('../../../src/services/benchmark/http', () => ({
  benchmarkFetch: jest.fn()
}));
jest.mock('../../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => [])
}));
jest.mock('../../../models/BenchmarkPrompt', () => ({
  findOne: jest.fn()
}));
jest.mock('../../../models/BenchmarkResult', () => jest.fn());
jest.mock('../../../src/services/benchmark/modelDigestService', () => ({
  getModelDigest: jest.fn()
}));
jest.mock('../../../src/clients/coreApiClient', () => ({
  getBenchmarkClaimIdentity: jest.fn((_host, batchId) => ({
    claimBatchId: batchId,
    claimGeneration: 'generation-single-1'
  }))
}));
jest.mock('../../../src/services/benchmark/benchmarkClaimLifecycle', () => ({
  acquireBenchmarkClaims: jest.fn(async hosts => hosts),
  releaseBenchmarkClaims: jest.fn(async hosts => ({
    released: hosts.length,
    failed: 0,
    details: hosts.map(hostUrl => ({ hostUrl, released: true }))
  })),
  startBenchmarkClaimHeartbeat: jest.fn(() => {
    const stop = jest.fn();
    stop.ready = Promise.resolve();
    stop.assertActive = jest.fn(() => true);
    stop.getFailure = jest.fn(() => null);
    stop.drain = jest.fn(async () => stop());
    return stop;
  })
}));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

const { benchmarkFetch } = require('../../../src/services/benchmark/http');
const { getModelDigest } = require('../../../src/services/benchmark/modelDigestService');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const coreApiClient = require('../../../src/clients/coreApiClient');
const claimLifecycle = require('../../../src/services/benchmark/benchmarkClaimLifecycle');
const { validateExecutionHost } = require('../../../src/services/benchmark/executionHostValidator');
const { runTest } = require('../../../src/services/benchmark/testExecution');

function streamedResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    body: {
      async *[Symbol.asyncIterator]() {
        yield Buffer.from(JSON.stringify(payload));
      }
    }
  };
}

describe('benchmark execution target admission', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getModelDigest.mockResolvedValue('sha256:model-digest');
    BenchmarkResult.mockImplementation(data => ({
      ...data,
      save: jest.fn().mockResolvedValue(undefined)
    }));
  });

  test('batch execution preflight rejects metadata before fetch', async () => {
    await expect(validateExecutionHost('http://169.254.169.254:11434', ['qwen:7b']))
      .resolves.toMatchObject({ valid: false });
    expect(benchmarkFetch).not.toHaveBeenCalled();
  });

  test('batch execution preflight uses bounded, no-redirect inventory reads', async () => {
    benchmarkFetch.mockResolvedValue(streamedResponse(200, { models: [{ name: 'qwen:7b' }] }));

    await expect(validateExecutionHost('http://ollama:11434', ['qwen:7b']))
      .resolves.toMatchObject({ valid: true, host: 'http://ollama:11434' });
    expect(benchmarkFetch).toHaveBeenCalledWith(
      'http://ollama:11434/api/tags',
      expect.objectContaining({ redirect: 'manual' })
    );
  });

  test('single-test execution rejects metadata before chat or digest calls', async () => {
    await expect(runTest({
      model: 'qwen:7b',
      host: 'http://169.254.169.254:11434',
      prompt: 'hello'
    })).rejects.toMatchObject({ code: 'OLLAMA_TARGET_REJECTED', statusCode: 400 });

    expect(benchmarkFetch).not.toHaveBeenCalled();
    expect(getModelDigest).not.toHaveBeenCalled();
  });

  test('single-test execution sends the exact claim proof through Core and restores before returning', async () => {
    benchmarkFetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        message: { content: 'answer' },
        eval_count: 2,
        prompt_eval_duration: 2_000_000
      })
    });

    await expect(runTest({
      model: 'qwen:7b',
      host: 'http://ollama:11434',
      prompt: 'hello'
    })).resolves.toMatchObject({ success: true });

    const [target, init] = benchmarkFetch.mock.calls[0];
    expect(target).toBe('http://localhost:3080/api/inference/generate');
    expect(JSON.parse(init.body)).toMatchObject({
      model: 'qwen:7b',
      host: 'http://ollama:11434',
      claimBatchId: expect.stringMatching(/^benchmark-single-/),
      claimGeneration: 'generation-single-1'
    });
    expect(coreApiClient.getBenchmarkClaimIdentity).toHaveBeenCalledWith(
      'http://ollama:11434',
      expect.stringMatching(/^benchmark-single-/)
    );
    expect(claimLifecycle.releaseBenchmarkClaims).toHaveBeenCalledTimes(1);
  });

  test('single-test execution fails when Core rejects a stale generation', async () => {
    benchmarkFetch.mockResolvedValue({
      ok: false,
      status: 409,
      statusText: 'stale benchmark claim'
    });

    await expect(runTest({
      model: 'qwen:7b',
      host: 'http://ollama:11434',
      prompt: 'hello'
    })).rejects.toThrow('HTTP 409: stale benchmark claim');
    expect(claimLifecycle.releaseBenchmarkClaims).toHaveBeenCalledTimes(1);
    expect(BenchmarkResult).toHaveBeenCalledWith(expect.objectContaining({
      success: false,
      error: 'HTTP 409: stale benchmark claim'
    }));
  });
});
