'use strict';

jest.mock('../../../models/BenchmarkConfig');

const BenchmarkConfig = require('../../../models/BenchmarkConfig');
const service = require('../../../src/services/profiler/settingsService');

const ENV_KEYS = {
  degradationThreshold: 'CONTEXT_PROBE_DEGRADATION_PCT',
  contextFillPct: 'HOST_TEST_CONTEXT_FILL_PCT',
  maxPromptTokens: 'HOST_TEST_MAX_PROMPT_TOKENS',
  numPredict: 'HOST_TEST_NUM_PREDICT',
  throughputSamples: 'PROFILER_THROUGHPUT_SAMPLES',
  thinkingProbeEnabled: 'PROFILER_THINKING_PROBE_ENABLED',
  warmup: 'HOST_TEST_WARMUP',
  testTimeoutSec: 'HOST_TEST_TIMEOUT_MS',
  baselineModel: 'HOST_BASELINE_MODEL',
};

beforeEach(() => {
  jest.clearAllMocks();
  // Clean env vars used by settings
  Object.values(ENV_KEYS).forEach(k => delete process.env[k]);
});

afterAll(() => {
  Object.values(ENV_KEYS).forEach(k => delete process.env[k]);
});

describe('settingsService', () => {
  describe('DEFAULTS', () => {
    it('exports expected default values', () => {
      expect(service.DEFAULTS).toEqual({
        degradationThreshold: 30,
        contextFillPct: 25,
        contextProbeFillPct: 80,
        maxPromptTokens: 2048,
        numPredict: 64,
        throughputSamples: 3,
        thinkingProbeEnabled: true,
        warmup: true,
        testTimeoutSec: 60,
        baselineModel: '',
        collectHardwareTelemetry: true,
        showHardwareDiagnostics: true,
      });
    });
  });

  describe('getAll()', () => {
    it('returns defaults when no DB entries and no env vars', async () => {
      BenchmarkConfig.find.mockResolvedValue([]);

      const result = await service.getAll();

      expect(result).toEqual(service.DEFAULTS);
    });

    it('overrides defaults with DB values', async () => {
      BenchmarkConfig.find.mockResolvedValue([
        { key: 'profiler.degradationThreshold', value: 50 },
        { key: 'profiler.warmup', value: false },
      ]);

      const result = await service.getAll();

      expect(result.degradationThreshold).toBe(50);
      expect(result.warmup).toBe(false);
      // Others stay at defaults
      expect(result.contextFillPct).toBe(25);
      expect(result.maxPromptTokens).toBe(2048);
      expect(result.numPredict).toBe(64);
      expect(result.throughputSamples).toBe(3);
      expect(result.testTimeoutSec).toBe(60);
      expect(result.baselineModel).toBe('');
    });

    it('reads the legacy host baseline key only when the unified key is absent', async () => {
      BenchmarkConfig.find.mockResolvedValue([
        { key: 'hostBaselineModel', value: 'legacy:3b' },
      ]);
      expect((await service.getAll()).baselineModel).toBe('legacy:3b');

      BenchmarkConfig.find.mockResolvedValue([
        { key: 'hostBaselineModel', value: 'legacy:3b' },
        { key: 'profiler.baselineModel', value: 'unified:3b' },
      ]);
      expect((await service.getAll()).baselineModel).toBe('unified:3b');
    });

    it('overrides defaults with env vars when no DB entry', async () => {
      BenchmarkConfig.find.mockResolvedValue([]);
      process.env.CONTEXT_PROBE_DEGRADATION_PCT = '45';
      process.env.HOST_TEST_WARMUP = 'false';
      process.env.HOST_TEST_TIMEOUT_MS = '120000';
      process.env.HOST_BASELINE_MODEL = 'llama3.1:8b';

      const result = await service.getAll();

      expect(result.degradationThreshold).toBe(45);
      expect(result.warmup).toBe(false);
      expect(result.testTimeoutSec).toBe(120); // ms -> sec
      expect(result.baselineModel).toBe('llama3.1:8b');
      // Untouched defaults
      expect(result.contextFillPct).toBe(25);
      expect(result.maxPromptTokens).toBe(2048);
      expect(result.numPredict).toBe(64);
      expect(result.throughputSamples).toBe(3);
    });

    it('DB values take priority over env vars', async () => {
      BenchmarkConfig.find.mockResolvedValue([
        { key: 'profiler.numPredict', value: 128 },
      ]);
      process.env.HOST_TEST_NUM_PREDICT = '256';

      const result = await service.getAll();

      expect(result.numPredict).toBe(128);
    });

    it('coerces boolean env var strings', async () => {
      BenchmarkConfig.find.mockResolvedValue([]);
      process.env.HOST_TEST_WARMUP = 'true';

      const result = await service.getAll();
      expect(result.warmup).toBe(true);

      process.env.HOST_TEST_WARMUP = 'false';
      const result2 = await service.getAll();
      expect(result2.warmup).toBe(false);
    });

    it('coerces numeric env var strings', async () => {
      BenchmarkConfig.find.mockResolvedValue([]);
      process.env.HOST_TEST_CONTEXT_FILL_PCT = '75';

      const result = await service.getAll();
      expect(result.contextFillPct).toBe(75);
    });

    it('coerces max prompt tokens from env', async () => {
      BenchmarkConfig.find.mockResolvedValue([]);
      process.env.HOST_TEST_MAX_PROMPT_TOKENS = '4096';

      const result = await service.getAll();
      expect(result.maxPromptTokens).toBe(4096);
    });

    it('coerces throughput sample count from env', async () => {
      BenchmarkConfig.find.mockResolvedValue([]);
      process.env.PROFILER_THROUGHPUT_SAMPLES = '4';

      const result = await service.getAll();
      expect(result.throughputSamples).toBe(4);
    });
  });

  describe('save()', () => {
    it('upserts each key with profiler. prefix', async () => {
      BenchmarkConfig.findOneAndUpdate.mockResolvedValue({});

      await service.save({ degradationThreshold: 40, numPredict: 128 });

      expect(BenchmarkConfig.findOneAndUpdate).toHaveBeenCalledTimes(2);
      expect(BenchmarkConfig.findOneAndUpdate).toHaveBeenCalledWith(
        { key: 'profiler.degradationThreshold' },
        { key: 'profiler.degradationThreshold', value: 40 },
        { upsert: true, new: true }
      );
      expect(BenchmarkConfig.findOneAndUpdate).toHaveBeenCalledWith(
        { key: 'profiler.numPredict' },
        { key: 'profiler.numPredict', value: 128 },
        { upsert: true, new: true }
      );
    });

    it('only saves keys that exist in DEFAULTS', async () => {
      BenchmarkConfig.findOneAndUpdate.mockResolvedValue({});

      await service.save({ degradationThreshold: 40, unknownKey: 'bad' });

      expect(BenchmarkConfig.findOneAndUpdate).toHaveBeenCalledTimes(1);
      expect(BenchmarkConfig.findOneAndUpdate).toHaveBeenCalledWith(
        { key: 'profiler.degradationThreshold' },
        { key: 'profiler.degradationThreshold', value: 40 },
        { upsert: true, new: true }
      );
    });

    it('returns the resolved settings after save', async () => {
      BenchmarkConfig.findOneAndUpdate.mockResolvedValue({});
      BenchmarkConfig.find.mockResolvedValue([
        { key: 'profiler.degradationThreshold', value: 40 },
      ]);

      const result = await service.save({ degradationThreshold: 40 });

      expect(result.degradationThreshold).toBe(40);
    });
  });
});
