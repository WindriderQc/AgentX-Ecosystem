'use strict';

jest.mock('../../src/services/ollamaVramService', () => ({
  getHostVram: jest.fn().mockResolvedValue({
    ok: true,
    memoryUsedMiBTotal: 12000,
    memoryTotalMiBTotal: 24576
  })
}));
jest.mock('../../src/clients/ollamaClient', () => ({
  showModel: jest.fn(),
  generate: jest.fn(),
  listRunning: jest.fn()
}));
jest.mock('../../src/services/contextProbePayload', () => ({
  generateFillPrompt: jest.fn().mockReturnValue({ prompt: 'fill prompt' })
}));
jest.mock('../../src/services/modelContextProfileService', () => ({
  updateFromProbeSnapshot: jest.fn().mockResolvedValue(null)
}));
jest.mock('../../src/helpers/ollamaModelIdentity', () => ({
  isSameOllamaModel: jest.fn((left, right) => left === right)
}));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  normalizeHostUrl: jest.fn((hostUrl) => hostUrl)
}));
jest.mock('../../src/services/modelContextResolver', () => ({
  normalizeModelName: jest.fn((name) => String(name || '').replace(/:latest$/i, '')),
  resolveModelNumCtxDetails: jest.fn().mockResolvedValue({ num_ctx: 8192, source: 'modelfile' })
}));
jest.mock('../../models/ModelProfile', () => ({
  findOne: jest.fn()
}));
jest.mock('../../models/ModelContextProbeSnapshot', () => ({
  create: jest.fn()
}));
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
const ollamaClient = require('../../src/clients/ollamaClient');
const modelContextProfileService = require('../../src/services/modelContextProfileService');
const contextProbeService = require('../../src/services/contextProbeService');

function buildSnapshotDoc(data) {
  return {
    ...data,
    toObject() {
      return { ...data };
    }
  };
}

describe('contextProbeService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    ModelContextProbeSnapshot.create.mockImplementation(async (data) => buildSnapshotDoc(data));
    ollamaClient.showModel.mockResolvedValue({
      model_info: {
        'general.context_length': 262144
      }
    });
    ollamaClient.listRunning.mockImplementation(async (_hostUrl) => ({
      models: [{
        name: 'gemma4:26b',
        model: 'gemma4:26b',
        size: 100,
        size_vram: 100,
        context_length: 262144
      }]
    }));
  });

  it('builds coarse candidates up to 256k and preserves a non-power upper bound', () => {
    expect(contextProbeService._internal.buildCoarseCandidates(2048, 262144)).toEqual([
      2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144
    ]);
    expect(contextProbeService._internal.buildCoarseCandidates(2048, 200000)).toEqual([
      2048, 4096, 8192, 16384, 32768, 65536, 131072, 200000
    ]);
  });

  it('builds staged refinement increments from the coarse bracket', () => {
    expect(contextProbeService._internal.buildRefinementStages(131072, 262144, 2048)).toEqual([
      32768, 16384, 8192, 4096, 2048
    ]);
  });

  it('refines inside the 128k to 256k bracket and returns the highest passing context', async () => {
    ollamaClient.generate.mockImplementation(async (_hostUrl, payload) => {
      const numCtx = payload.options.num_ctx;
      const evalCount = numCtx <= 196608 ? 35 : 25;
      if (numCtx === 2048) {
        return { eval_count: 60, eval_duration: 1e9, prompt_eval_count: 1600 };
      }
      return { eval_count: evalCount, eval_duration: 1e9, prompt_eval_count: 1600 };
    });

    const result = await contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      acknowledgeMaintenance: true
    });

    expect(result.testedNumCtx).toBe(196608);
    expect(modelContextProfileService.updateFromProbeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'gemma4:26b',
        hostUrl: 'http://192.0.2.66:11434',
        testedNumCtx: 196608,
        status: 'completed'
      })
    );
    expect(result.modelTheoreticalMax).toBe(262144);
    expect(result.steps.map((step) => step.numCtx)).toEqual(expect.arrayContaining([
      131072,
      163840,
      196608,
      262144
    ]));
  });

  it('refines within the 16k to 32k bracket to find values like 24k and 30k', async () => {
    ollamaClient.showModel.mockResolvedValue({
      model_info: {
        'general.context_length': 32768
      }
    });
    ollamaClient.listRunning.mockImplementation(async (_hostUrl) => ({
      models: [{
        name: 'gemma4:26b',
        model: 'gemma4:26b',
        size: 100,
        size_vram: 100,
        context_length: 32768
      }]
    }));
    ollamaClient.generate.mockImplementation(async (_hostUrl, payload) => {
      const numCtx = payload.options.num_ctx;
      if (numCtx === 2048) {
        return { eval_count: 60, eval_duration: 1e9, prompt_eval_count: 1600 };
      }

      const evalCount = numCtx <= 30720 ? 35 : 25;
      return { eval_count: evalCount, eval_duration: 1e9, prompt_eval_count: 1600 };
    });

    const result = await contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      acknowledgeMaintenance: true
    });

    expect(result.testedNumCtx).toBe(30720);
    expect(result.steps.map((step) => step.numCtx)).toEqual(expect.arrayContaining([
      16384,
      20480,
      24576,
      28672,
      30720,
      32768
    ]));
  });

  it('rejects a candidate that returns too few completion tokens', async () => {
    ollamaClient.showModel.mockResolvedValue({
      model_info: {
        'general.context_length': 4096
      }
    });
    ollamaClient.generate.mockImplementation(async (_hostUrl, payload) => {
      const numCtx = payload.options.num_ctx;
      if (numCtx === 2048) {
        return { eval_count: 64, eval_duration: 1e9, prompt_eval_count: 1600 };
      }
      return { eval_count: 2, eval_duration: 1e9, prompt_eval_count: 3200 };
    });

    const result = await contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      acknowledgeMaintenance: true,
      maxCtx: 4096
    });

    expect(result.testedNumCtx).toBe(2048);
    const failedStep = result.steps.find((step) => step.numCtx === 4096);
    expect(failedStep).toMatchObject({
      completionTokens: 2,
      passed: false,
      requestedCompletionTokens: 64
    });
    expect(failedStep.reason).toMatch(/Short completion/);
  });

  it('fails the probe when any candidate returns implausible throughput', async () => {
    ollamaClient.showModel.mockResolvedValue({
      model_info: {
        'general.context_length': 4096
      }
    });
    ollamaClient.generate.mockImplementation(async (_hostUrl, payload) => {
      const numCtx = payload.options.num_ctx;
      if (numCtx === 2048) {
        return { eval_count: 64, eval_duration: 1e9, prompt_eval_count: 1600 };
      }
      return { eval_count: 64, eval_duration: 64000, prompt_eval_count: 3200 };
    });

    await expect(contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      acknowledgeMaintenance: true,
      maxCtx: 4096
    })).rejects.toThrow(/Implausible throughput at num_ctx=4096/);

    expect(ModelContextProbeSnapshot.create).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      error: expect.stringMatching(/Implausible throughput at num_ctx=4096/),
      steps: expect.arrayContaining([
        expect.objectContaining({
          numCtx: 4096,
          tokensPerSec: 1000000,
          passed: false,
          reason: expect.stringMatching(/Implausible throughput/)
        })
      ])
    }));
  });
});

describe('assessThroughputPlausibility (B1 physical ceiling layered on flat cap)', () => {
  const assess = contextProbeService._internal.assessThroughputPlausibility;

  it('flags readings above the flat sane cap regardless of model context', () => {
    const r = assess(1_000_000, { modelName: 'gemma4:26b', hostUrl: 'http://192.0.2.66:11434' });
    expect(r.plausible).toBe(false);
    expect(r.detail).toMatch(/exceeds sane cap/);
  });

  it('catches a sub-cap artifact via the physical ceiling (explicit-quant model, known host)', () => {
    // 30B Q4 on a reference GPU (936 GB/s): ceiling ≈ 55 tok/s, ×2 margin ≈ 110.
    // 5000 tok/s is well under the flat 10000 cap but physically impossible.
    const r = assess(5000, {
      modelName: 'ax/qwen3-coder:30b-instruct-q4_K_M',
      hostUrl: 'http://192.0.2.10:11434',
      hostBandwidthGBs: 936
    });
    expect(r.plausible).toBe(false);
    expect(r.detail).toMatch(/exceeds physical ceiling/);
  });

  it('does NOT false-flag a *-qat MoE model (ambiguous quant → ceiling skipped)', () => {
    // gemma4:26b-a4b-it-qat has no parseable quant → B1 skipped, flat backstop only.
    const r = assess(5000, { modelName: 'ax/gemma4:26b-a4b-it-qat', hostUrl: 'http://192.0.2.10:11434' });
    expect(r.plausible).toBe(true);
  });

  it('does NOT apply the ceiling on an unknown host (no bandwidth → flat only)', () => {
    const r = assess(5000, { modelName: 'ax/qwen3-coder:30b-instruct-q4_K_M', hostUrl: 'http://192.0.2.66:11434' });
    expect(r.plausible).toBe(true);
  });

  it('accepts a realistic reading for an explicit-quant model on a known host', () => {
    // qwen3.6:27b q8 on the example host: ceiling ≈ 35 tok/s, ×2 ≈ 70. 30 tok/s is fine.
    const r = assess(30, {
      modelName: 'ax/qwen3.6:27b-mtp-q8_0',
      hostUrl: 'http://192.0.2.10:11434',
      hostBandwidthGBs: 936
    });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });

  it('does not quarantine a reading within one reported tenth of the ceiling', () => {
    const r = assess(69.4, {
      modelName: 'ax/qwen3.6:27b-mtp-q8_0',
      hostUrl: 'http://192.0.2.199:11434',
      hostBandwidthGBs: 936
    });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });

  it('still rejects a reading beyond the narrow boundary tolerance', () => {
    const r = assess(69.5, {
      modelName: 'ax/qwen3.6:27b-mtp-q8_0',
      hostUrl: 'http://192.0.2.199:11434',
      hostBandwidthGBs: 936
    });
    expect(r.plausible).toBe(false);
    expect(r.detail).toMatch(/exceeds physical ceiling/);
  });

  it('accepts Ornith/qwen35moe throughput even when the tag omits -a3b', () => {
    const r = assess(130.5, {
      modelName: 'ornith:35b-q4_K_M',
      hostUrl: 'http://192.0.2.199:11434',
      hostBandwidthGBs: 936,
      architecture: 'qwen35moe',
      modelInfo: {
        'general.architecture': 'qwen35moe',
        'general.parameter_count': 34660610688
      }
    });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });
});
