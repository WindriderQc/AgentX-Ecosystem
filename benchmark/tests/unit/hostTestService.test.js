'use strict';

jest.mock('../../models/HostPerformanceSnapshot', () => ({
  create: jest.fn()
}));

jest.mock('../../src/services/ollamaVramService', () => ({
  getHostVram: jest.fn()
}));

jest.mock('../../src/helpers/httpAgent', () => ({
  getFetchOptions: jest.fn(() => ({}))
}));

jest.mock('../../src/helpers/ollamaModelIdentity', () => ({
  isSameOllamaModel: jest.fn(() => false)
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => []),
  normalizeHostUrl: jest.fn((url) => url)
}));

jest.mock('../../src/services/modelContextResolver', () => ({
  resolveModelNumCtxDetails: jest.fn(),
  normalizeModelName: jest.fn((name) => String(name || '').replace(/:latest$/i, ''))
}));

jest.mock('../../src/helpers/circuitBreaker', () => ({
  canRequest: jest.fn(() => ({ allowed: true })),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn()
}));

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const { getConfig, buildProbePlan, buildWarmupRequest } = require('../../src/services/hostTestService');

describe('hostTestService config helpers', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    process.env.HOST_TEST_TIMEOUT_MS = '60000';
    process.env.HOST_TEST_NUM_PREDICT = '64';
    process.env.HOST_TEST_CONTEXT_FILL_PCT = '25';
    process.env.HOST_TEST_MAX_PROMPT_TOKENS = '2048';
    process.env.HOST_TEST_WARMUP = 'true';
  });

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it('merges per-run overrides over env defaults', () => {
    const cfg = getConfig({
      timeoutMs: 120000,
      numPredict: 128,
      contextFillPct: 50,
      maxPromptTokens: 4096,
      warmup: false,
      promptWorkloadMode: 'scaled'
    });

    expect(cfg).toEqual({
      timeoutMs: 120000,
      numPredict: 128,
      contextFillPct: 50,
      maxPromptTokens: 4096,
      warmup: false,
      promptWorkloadMode: 'scaled'
    });
  });

  it('uses fixed prompt workloads by default and clips to active context when needed', () => {
    const plan = buildProbePlan(1024, {
      maxPromptTokens: 2048,
      contextFillPct: 25,
      promptWorkloadMode: 'fixed'
    });

    expect(plan).toEqual({
      promptWorkloadMode: 'fixed_fallback_to_ctx',
      requestedPromptTokens: 2048,
      targetPromptTokens: 1024
    });
  });

  it('supports scaled prompt workloads for context curve probes', () => {
    const plan = buildProbePlan(8192, {
      maxPromptTokens: 2048,
      contextFillPct: 25,
      promptWorkloadMode: 'scaled'
    });

    expect(plan).toEqual({
      promptWorkloadMode: 'scaled',
      requestedPromptTokens: 2048,
      targetPromptTokens: 2048
    });
  });

  it('preloads cold large models directly with a ten-minute timeout', () => {
    const request = buildWarmupRequest(
      'http://192.0.2.199:11434',
      'ax/qwen3-coder:30b',
      false,
      65536
    );
    expect(request).toEqual(expect.objectContaining({
      phase: 'cold_preload',
      url: 'http://192.0.2.199:11434/api/generate',
      timeoutMs: 600000
    }));
    expect(request.body).toEqual(expect.objectContaining({
      model: 'ax/qwen3-coder:30b',
      keep_alive: '10m',
      options: expect.objectContaining({ num_ctx: 65536, num_predict: 1 })
    }));
  });

  it('routes the loaded prime pass through Core for telemetry', () => {
    const request = buildWarmupRequest(
      'http://192.0.2.199:11434',
      'ax/qwen3-coder:30b',
      true,
      65536
    );
    expect(request).toEqual(expect.objectContaining({
      phase: 'loaded_prime',
      timeoutMs: 90000
    }));
    expect(request.url).toMatch(/\/api\/inference\/generate$/);
    expect(request.body).toEqual(expect.objectContaining({
      callerDetail: 'benchmark-host-test-warmup',
      host: 'http://192.0.2.199:11434'
    }));
  });
});
