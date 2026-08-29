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
jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

const { benchmarkFetch } = require('../../../src/services/benchmark/http');
const { getModelDigest } = require('../../../src/services/benchmark/modelDigestService');
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
  beforeEach(() => jest.clearAllMocks());

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
});
