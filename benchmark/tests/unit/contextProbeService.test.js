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
jest.mock('../../src/services/profiler/artifactIdentityService', () => ({
  identitiesMatch: jest.fn((left, right) => (
    left?.digest === right?.digest && left?.runtimeFingerprint === right?.runtimeFingerprint
  )),
  resolveArtifactIdentity: jest.fn()
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
  error: jest.fn(),
  debug: jest.fn()
}));

const ModelContextProbeSnapshot = require('../../models/ModelContextProbeSnapshot');
const ollamaClient = require('../../src/clients/ollamaClient');
const modelContextProfileService = require('../../src/services/modelContextProfileService');
const artifactIdentityService = require('../../src/services/profiler/artifactIdentityService');
const contextProbeService = require('../../src/services/contextProbeService');

const ARTIFACT = {
  model: 'gemma4:26b',
  hostId: 'host-gamma',
  hostUrl: 'http://192.0.2.66:11434',
  digest: 'sha256:exact',
  runtimeFingerprint: 'runtime-a',
  registryQualified: true
};

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
    artifactIdentityService.resolveArtifactIdentity.mockResolvedValue(ARTIFACT);
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

  it('keeps slower long-context decode as performance evidence and verifies the full window', async () => {
    ollamaClient.generate.mockImplementation(async (_hostUrl, payload) => {
      const numCtx = payload.options.num_ctx;
      if (numCtx === 2048) {
        return { eval_count: 60, eval_duration: 1e9, prompt_eval_count: 1600 };
      }
      return {
        eval_count: 64,
        eval_duration: numCtx <= 196608 ? 2e9 : 4e9,
        prompt_eval_count: Math.floor(numCtx * 0.8)
      };
    });

    const result = await contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      artifactIdentity: ARTIFACT,
      acknowledgeMaintenance: true
    });

    expect(result.testedNumCtx).toBe(262144);
    expect(modelContextProfileService.updateFromProbeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'gemma4:26b',
        hostUrl: 'http://192.0.2.66:11434',
        testedNumCtx: 262144,
        status: 'completed'
      })
    );
    expect(result.modelTheoreticalMax).toBe(262144);
    expect(result.steps.map((step) => step.numCtx)).toEqual(expect.arrayContaining([
      131072,
      262144
    ]));
  });

  it('does not manufacture a smaller window from a throughput threshold', async () => {
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

      return {
        eval_count: 64,
        eval_duration: numCtx < 32768 ? 2e9 : 4e9,
        prompt_eval_count: Math.floor(numCtx * 0.8)
      };
    });

    const result = await contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      artifactIdentity: ARTIFACT,
      acknowledgeMaintenance: true
    });

    expect(result.testedNumCtx).toBe(32768);
    expect(result.steps.map((step) => step.numCtx)).toEqual(expect.arrayContaining([
      16384,
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
      artifactIdentity: ARTIFACT,
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

  it('keeps a timed-out candidate as the measured context boundary', async () => {
    ollamaClient.showModel.mockResolvedValue({
      model_info: {
        'general.context_length': 4096
      }
    });
    ollamaClient.generate.mockImplementation(async (_hostUrl, payload) => {
      if (payload.options.num_ctx === 2048) {
        return { eval_count: 64, eval_duration: 1e9, prompt_eval_count: 1600 };
      }
      throw new Error('Ollama POST /api/generate timed out after 120000ms');
    });

    const result = await contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      artifactIdentity: ARTIFACT,
      acknowledgeMaintenance: true,
      maxCtx: 4096
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'completed',
      testedNumCtx: 2048
    }));
    expect(result.steps.find((step) => step.numCtx === 4096)).toMatchObject({
      requestSucceeded: false,
      tokensPerSec: 0,
      passed: false,
      reason: 'Ollama POST /api/generate timed out after 120000ms'
    });
    expect(modelContextProfileService.updateFromProbeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ testedNumCtx: 2048, status: 'completed' })
    );
  });

  it('does not reject a positive measurement using an arbitrary throughput ceiling', async () => {
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

    const result = await contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      artifactIdentity: ARTIFACT,
      acknowledgeMaintenance: true,
      maxCtx: 4096
    });

    expect(result).toEqual(expect.objectContaining({
      status: 'completed',
      testedNumCtx: 4096,
      atLimitTokensPerSec: 1000000
    }));
  });
});

describe('validateThroughput', () => {
  const assess = contextProbeService._internal.validateThroughput;

  it('accepts any positive finite measurement', () => {
    const r = assess(1_000_000, { modelName: 'gemma4:26b', hostUrl: 'http://192.0.2.66:11434' });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });

  it('does not reject measured throughput using guessed hardware or quantization', () => {
    const r = assess(5000, { modelName: 'ax/qwen3-coder:30b-instruct-q4_K_M', hostUrl: 'http://192.0.2.99:11434' });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });

  it('does NOT false-flag a *-qat MoE model (ambiguous quant → ceiling skipped)', () => {
    // gemma4:26b-a4b-it-qat has no parseable quant → B1 skipped, flat backstop only.
    const r = assess(5000, { modelName: 'ax/gemma4:26b-a4b-it-qat', hostUrl: 'http://192.0.2.99:11434' });
    expect(r.plausible).toBe(true);
  });

  it('does NOT apply the ceiling on an unknown host (no bandwidth → flat only)', () => {
    const r = assess(5000, { modelName: 'ax/qwen3-coder:30b-instruct-q4_K_M', hostUrl: 'http://192.0.2.66:11434' });
    expect(r.plausible).toBe(true);
  });

  it('accepts a realistic reading for an explicit-quant model on a known host', () => {
    // qwen3.6:27b q8 on .99: ceiling ≈ 35 tok/s, ×2 ≈ 70. 30 tok/s is fine.
    const r = assess(30, { modelName: 'ax/qwen3.6:27b-mtp-q8_0', hostUrl: 'http://192.0.2.99:11434' });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });

  it('does not quarantine a reading within one reported tenth of the ceiling', () => {
    const r = assess(69.4, { modelName: 'ax/qwen3.6:27b-mtp-q8_0', hostUrl: 'http://192.0.2.199:11434' });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });

  it('accepts an ordinary measured reading without a synthetic boundary', () => {
    const r = assess(69.5, { modelName: 'ax/qwen3.6:27b-mtp-q8_0', hostUrl: 'http://192.0.2.199:11434' });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });

  it('accepts Ornith/qwen35moe throughput even when the tag omits -a3b', () => {
    const r = assess(130.5, {
      modelName: 'ornith:35b-q4_K_M',
      hostUrl: 'http://192.0.2.199:11434',
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

describe('findInvalidThroughputStep', () => {
  const findInvalid = contextProbeService._internal.findInvalidThroughputStep;

  it('ignores the zero placeholder from a failed request', () => {
    expect(findInvalid([
      { numCtx: 65536, requestSucceeded: false, tokensPerSec: 0 }
    ])).toBeUndefined();
  });

  it('still rejects an invalid measurement returned by a successful request', () => {
    const step = { numCtx: 65536, requestSucceeded: true, tokensPerSec: 0 };
    expect(findInvalid([step])).toBe(step);
  });
});
