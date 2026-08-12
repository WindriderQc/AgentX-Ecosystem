'use strict';

jest.mock('../../../src/services/hostTestService');
jest.mock('../../../src/services/contextProbeService');
jest.mock('../../../src/services/profiler/modelProfileService');
jest.mock('../../../src/services/profiler/adaptationService');
jest.mock('../../../src/services/profiler/hostProfileService');
jest.mock('../../../src/services/profiler/settingsService');
jest.mock('../../../src/services/profiler/namingConvention');
jest.mock('../../../models/ModelAdaptation');
jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const hostTestService = require('../../../src/services/hostTestService');
const orchestrator = require('../../../src/services/profiler/profilerOrchestrator');

const HOST_URL = 'http://192.0.2.66:11434';
const MODEL_NAME = 'llama3:8b';

const DEFAULT_SETTINGS = {
  degradationThreshold: 30,
  contextFillPct: 25,
  maxPromptTokens: 2048,
  numPredict: 64,
  warmup: true,
  testTimeoutSec: 60,
  baselineModel: 'qwen2.5:3b'
};

// ---------------------------------------------------------------------------
// _runThroughputCurve()
// ---------------------------------------------------------------------------
describe('_runThroughputCurve()', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    hostTestService.testModelOnHost.mockResolvedValue({
      status: 'pass',
      tokensPerSec: 40,
      vramUsedMiB: 5000
    });
    // Mock fetch for _detectSpill (called after each throughput test)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: MODEL_NAME, size: 4_000_000_000, size_vram: 4_000_000_000 }]
      })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('tests at 5 context fill percentages', async () => {
    const maxCtx = 8192;
    const results = await orchestrator._runThroughputCurve(HOST_URL, MODEL_NAME, maxCtx, DEFAULT_SETTINGS);

    expect(results).toHaveLength(5);
    expect(hostTestService.testModelOnHost).toHaveBeenCalledTimes(5);

    const expectedPcts = [10, 25, 50, 75, 90];
    results.forEach((r, i) => {
      expect(r.contextFillPct).toBe(expectedPcts[i]);
      expect(r.numCtx).toBe(Math.max(512, Math.round(maxCtx * expectedPcts[i] / 100)));
      expect(r.tokensPerSec).toBe(40);
      expect(r.vramUsedMiB).toBe(5000);
      expect(r.gpuOffloaded).toBe(false);
    });
  });

  it('marks gpuOffloaded when spill detected', async () => {
    // Override fetch to return spill (size_vram < size)
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: MODEL_NAME, size: 4_000_000_000, size_vram: 3_000_000_000 }]
      })
    });

    const results = await orchestrator._runThroughputCurve(HOST_URL, MODEL_NAME, 8192, DEFAULT_SETTINGS);

    expect(results).toHaveLength(5);
    results.forEach(r => {
      expect(r.gpuOffloaded).toBe(true);
    });
  });

  it('handles errors gracefully with zeroed values', async () => {
    hostTestService.testModelOnHost.mockRejectedValue(new Error('timeout'));

    const results = await orchestrator._runThroughputCurve(HOST_URL, MODEL_NAME, 8192, DEFAULT_SETTINGS);

    expect(results).toHaveLength(5);
    results.forEach(r => {
      expect(r.tokensPerSec).toBe(0);
      expect(r.vramUsedMiB).toBeNull();
      expect(r.gpuOffloaded).toBe(false);
    });
  });

  it('enforces minimum numCtx of 512', async () => {
    const smallMaxCtx = 1000;
    await orchestrator._runThroughputCurve(HOST_URL, MODEL_NAME, smallMaxCtx, DEFAULT_SETTINGS);

    // 10% of 1000 = 100, but should be clamped to 512
    const firstCall = hostTestService.testModelOnHost.mock.calls[0];
    expect(firstCall[2].numCtx).toBe(512);
    expect(firstCall[2].promptWorkloadMode).toBe('scaled');
  });
});

// ---------------------------------------------------------------------------
// _runGenerationStability()
// ---------------------------------------------------------------------------
describe('_runGenerationStability()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostTestService.testModelOnHost.mockResolvedValue({
      status: 'pass',
      tokensPerSec: 35,
      totalLatencyMs: 1800
    });
  });

  it('tests at 3 output lengths (64, 256, 512)', async () => {
    const results = await orchestrator._runGenerationStability(HOST_URL, MODEL_NAME, 8192, DEFAULT_SETTINGS);

    expect(results).toHaveLength(3);
    expect(hostTestService.testModelOnHost).toHaveBeenCalledTimes(3);

    const expectedTargets = [64, 256, 512];
    results.forEach((r, i) => {
      expect(r.numPredict).toBe(expectedTargets[i]);
      expect(r.tokensPerSec).toBe(35);
      expect(r.totalLatencyMs).toBe(1800);
    });

    // Verify each call passed the correct numPredict
    expectedTargets.forEach((target, i) => {
      expect(hostTestService.testModelOnHost.mock.calls[i][2]).toMatchObject({
        maxPromptTokens: 2048,
        numPredict: target,
        numCtx: 8192,
        promptWorkloadMode: 'fixed',
        timeoutMs: 60000
      });
    });
  });

  it('handles errors gracefully with zeroed values', async () => {
    hostTestService.testModelOnHost.mockRejectedValue(new Error('OOM'));

    const results = await orchestrator._runGenerationStability(HOST_URL, MODEL_NAME, 8192, DEFAULT_SETTINGS);

    expect(results).toHaveLength(3);
    results.forEach(r => {
      expect(r.tokensPerSec).toBe(0);
      expect(r.totalLatencyMs).toBe(0);
    });
  });
});

// ---------------------------------------------------------------------------
// _runLoadTiming()
// ---------------------------------------------------------------------------
describe('_runLoadTiming()', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.useRealTimers();
  });

  it('measures cold and hot load times', async () => {
    // Mock Date.now to control timing
    let callCount = 0;
    const mockNow = jest.spyOn(Date, 'now');
    // Unload completes, then:
    // coldStart = 1000, after cold fetch = 4500 (3500ms cold)
    // hotStart  = 4500, after hot fetch  = 4700 (200ms hot)
    mockNow
      .mockReturnValueOnce(1000)   // cold start timestamp
      .mockReturnValueOnce(4500)   // cold end timestamp
      .mockReturnValueOnce(4500)   // hot start timestamp
      .mockReturnValueOnce(4700);  // hot end timestamp

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ response: '' })
    });

    // Run the async function, advancing timers for the 2s setTimeout
    const promise = orchestrator._runLoadTiming(HOST_URL, MODEL_NAME);
    // Advance past the 2-second wait
    await jest.advanceTimersByTimeAsync(2000);
    const result = await promise;

    expect(result.coldLoadMs).toBe(3500);
    expect(result.hotLoadMs).toBe(200);
    expect(global.fetch).toHaveBeenCalledTimes(3); // unload + cold + hot

    // Verify unload call
    const unloadCall = global.fetch.mock.calls[0];
    expect(unloadCall[0]).toBe(`${HOST_URL}/api/generate`);
    const unloadBody = JSON.parse(unloadCall[1].body);
    expect(unloadBody.keep_alive).toBe(0);

    mockNow.mockRestore();
  });

  it('returns null values on fetch failure', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('Connection refused'));

    const promise = orchestrator._runLoadTiming(HOST_URL, MODEL_NAME);
    const result = await promise;

    expect(result.coldLoadMs).toBeNull();
    expect(result.hotLoadMs).toBeNull();
  });
});
