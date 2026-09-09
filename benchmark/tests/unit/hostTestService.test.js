'use strict';

const mockHostRequest = jest.fn();
jest.mock('../../../shared/outboundHttpExecutor', () => ({
  ...jest.requireActual('../../../shared/outboundHttpExecutor'),
  createOutboundHttpExecutor: jest.fn(() => ({
    admitTarget: async (_operation, url) => ({ url }),
    request: (...args) => mockHostRequest(...args)
  })),
  readBoundedJson: async response => response.data
}));

jest.mock('../../models/HostPerformanceSnapshot', () => ({
  create: jest.fn(),
  deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  updateOne: jest.fn().mockResolvedValue({ matchedCount: 1 })
}));

const mockPrepareProfilerAuthorityWrite = jest.fn();
const mockCompleteProfilerAuthorityWrite = jest.fn();
jest.mock('../../src/services/benchmark/benchmarkAuthorityReconciliation', () => ({
  prepareProfilerAuthorityWrite: (...args) => mockPrepareProfilerAuthorityWrite(...args),
  completeProfilerAuthorityWrite: (...args) => mockCompleteProfilerAuthorityWrite(...args)
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

const HostPerformanceSnapshot = require('../../models/HostPerformanceSnapshot');
const {
  getConfig,
  testModelOnHost,
  buildProbePlan,
  buildWarmupRequest,
  _internal: { persistHostSnapshot }
} = require('../../src/services/hostTestService');

describe('hostTestService config helpers', () => {
  const ORIGINAL_ENV = { ...process.env };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.HOST_TEST_TIMEOUT_MS = '60000';
    process.env.HOST_TEST_NUM_PREDICT = '64';
    process.env.HOST_TEST_CONTEXT_FILL_PCT = '25';
    process.env.HOST_TEST_MAX_PROMPT_TOKENS = '2048';
    process.env.HOST_TEST_WARMUP = 'true';
    mockPrepareProfilerAuthorityWrite.mockReset().mockResolvedValue({
      _id: 'journal-snapshot-1',
      details: {
        snapshotId: 'snapshot-1',
        authorityWriteId: 'write-1'
      }
    });
    mockCompleteProfilerAuthorityWrite.mockReset().mockResolvedValue({ record: { state: 'resolved' } });
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
      think: false,
      options: expect.objectContaining({ num_ctx: 65536, num_predict: 1 })
    }));
  });

  it('measures visible first-token latency when the model thinks by default', async () => {
    require('../../src/services/modelContextResolver').resolveModelNumCtxDetails.mockResolvedValue({ num_ctx: 8192, source: 'test' });
    require('../../src/helpers/ollamaModelIdentity').isSameOllamaModel.mockReturnValue(true);
    require('../../src/services/ollamaVramService').getHostVram.mockResolvedValue({ ok: true, memoryUsedMiBTotal: 5000, memoryTotalMiBTotal: 16000 });
    HostPerformanceSnapshot.create.mockImplementation(async payload => payload);
    mockHostRequest.mockImplementation(async ({ url }, init) => {
      if (url.endsWith('/api/ps')) return { ok: true, data: { models: [{ name: 'thinking-model', context_length: 8192 }] } };
      const payload = JSON.parse(init.body);
      const token = payload.think === false ? { response: 'Answer' } : { thinking: 'Let me reason' };
      return { ok: true, stream: async function* () {
        yield Buffer.from(JSON.stringify({ ...token, done: false }) + '\n');
        yield Buffer.from(JSON.stringify({ done: true, eval_count: 64, eval_duration: 1e9, prompt_eval_count: 2048 }) + '\n');
      } };
    });
    const result = await testModelOnHost('thinking-model', 'http://192.0.2.12:11434', {
      _skipHostCheck: true, warmup: false, benchmarkClaim: { claimBatchId: 'test-visible-ttft' }
    });
    expect(result).toMatchObject({ status: 'pass', ttftMeasurement: 'streamed_wall_clock', timeToFirstTokenMs: expect.any(Number) });
    expect(HostPerformanceSnapshot.create).toHaveBeenLastCalledWith(
      [expect.objectContaining({ ttftMeasurement: 'streamed_wall_clock' })], undefined
    );
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

  it('journals an ambiguously committed host snapshot before save and retains recovery authority', async () => {
    const controller = new AbortController();
    HostPerformanceSnapshot.create.mockImplementationOnce(async ([payload]) => [payload]);
    let checkpointCount = 0;
    const lost = Object.assign(new Error('claim lost after write'), { code: 'BENCHMARK_CLAIM_LOST' });
    const checkpoint = jest.fn(() => {
      checkpointCount += 1;
      if (checkpointCount === 3) throw lost;
    });

    await expect(persistHostSnapshot('model-a', {
      hostUrl: 'http://host:11434',
      status: 'success'
    }, { signal: controller.signal, checkpoint, workloadId: 'profiler-host-test-1' })).rejects.toBe(lost);

    expect(mockPrepareProfilerAuthorityWrite.mock.invocationCallOrder[0])
      .toBeLessThan(HostPerformanceSnapshot.create.mock.invocationCallOrder[0]);
    expect(HostPerformanceSnapshot.create).toHaveBeenCalledWith(
      [expect.objectContaining({
        _id: expect.anything(),
        modelName: 'model-a',
        authorityState: 'pending_reconciliation',
        authorityWriteId: expect.any(String),
        authorityReconciliationId: 'journal-snapshot-1'
      })],
      { signal: controller.signal }
    );
    expect(mockCompleteProfilerAuthorityWrite).not.toHaveBeenCalled();
  });
});
