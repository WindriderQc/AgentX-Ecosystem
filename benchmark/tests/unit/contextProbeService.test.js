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
  generateFillPrompt: jest.fn((estimatedTokens) => ({ prompt: 'fill prompt', estimatedTokens }))
}));
jest.mock('../../src/services/modelContextProfileService', () => ({
  updateFromProbeSnapshot: jest.fn().mockResolvedValue({ recommendationStatus: 'verified' }),
  invalidateIfSnapshot: jest.fn().mockResolvedValue({ modifiedCount: 1 })
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
  normalizeHostUrl: jest.fn((hostUrl) => hostUrl),
  getConfiguredHosts: jest.fn(() => [])
}));
jest.mock('../../src/services/modelContextResolver', () => ({
  normalizeModelName: jest.fn((name) => String(name || '').replace(/:latest$/i, '')),
  resolveModelNumCtxDetails: jest.fn().mockResolvedValue({ num_ctx: 8192, source: 'modelfile' })
}));
jest.mock('../../models/ModelProfile', () => ({
  findOne: jest.fn()
}));
jest.mock('../../models/ModelContextProbeSnapshot', () => ({
  create: jest.fn(),
  deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 }),
  updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 })
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
    modelContextProfileService.updateFromProbeSnapshot.mockResolvedValue({ recommendationStatus: 'verified' });
    ModelContextProbeSnapshot.create.mockImplementation(async (data) => {
      const value = Array.isArray(data) ? data[0] : data;
      const doc = buildSnapshotDoc(value);
      return Array.isArray(data) ? [doc] : doc;
    });
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

  test('rejects an explicit metadata host before any Ollama context probe call', async () => {
    await expect(contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://169.254.169.254:11434',
      acknowledgeMaintenance: true
    })).rejects.toMatchObject({ code: 'OLLAMA_TARGET_REJECTED', statusCode: 400 });

    expect(ollamaClient.showModel).not.toHaveBeenCalled();
    expect(ollamaClient.generate).not.toHaveBeenCalled();
    expect(ollamaClient.listRunning).not.toHaveBeenCalled();
  });

  it('allows a seven-minute client budget for full-window context probes', () => {
    const previousTimeout = process.env.CONTEXT_PROBE_TIMEOUT_MS;
    delete process.env.CONTEXT_PROBE_TIMEOUT_MS;
    try {
      expect(contextProbeService.getConfig().timeoutMs).toBe(420000);
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.CONTEXT_PROBE_TIMEOUT_MS;
      } else {
        process.env.CONTEXT_PROBE_TIMEOUT_MS = previousTimeout;
      }
    }
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
    const callOrder = [];
    ollamaClient.generate.mockImplementation(async (_hostUrl, payload) => {
      const numCtx = payload.options.num_ctx;
      callOrder.push(numCtx);
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
      }),
      expect.objectContaining({ assertAuthorityActive: expect.any(Function) })
    );
    expect(result.modelTheoreticalMax).toBe(262144);
    expect(result.steps.map((step) => step.numCtx)).toEqual(expect.arrayContaining([
      131072,
      262144
    ]));
    const maximumStep = result.steps.find((step) => step.numCtx === 262144);
    expect(maximumStep).toMatchObject({
      repetitionCount: 2,
      tokensPerSecStdDev: expect.any(Number),
      tokensPerSecCvPct: expect.any(Number),
      samples: [
        expect.objectContaining({ promptCoveragePct: expect.any(Number), ollamaContextLength: 262144 }),
        expect.objectContaining({ promptCoveragePct: expect.any(Number), ollamaContextLength: 262144 })
      ]
    });
    expect(result.authorityStatus).toBe('committed');
    expect(callOrder[0]).toBe(262144);
    expect(callOrder[1]).toBe(2048);
    expect(callOrder.filter(numCtx => numCtx === 262144)).toHaveLength(2);
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
      expect.objectContaining({ testedNumCtx: 2048, status: 'completed' }),
      expect.objectContaining({ assertAuthorityActive: expect.any(Function) })
    );
  });

  it('persists the last good rung when a higher candidate reports zero throughput', async () => {
    ollamaClient.showModel.mockResolvedValue({
      model_info: {
        'general.context_length': 4096
      }
    });
    ollamaClient.generate.mockImplementation(async (_hostUrl, payload) => {
      if (payload.options.num_ctx === 2048) {
        return { eval_count: 64, eval_duration: 1e9, prompt_eval_count: 1600 };
      }
      return { eval_count: 0, eval_duration: 0, prompt_eval_count: 0 };
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
      requestSucceeded: true,
      tokensPerSec: 0,
      passed: false,
      reason: 'Context ceiling: 0 tok/s'
    });
    expect(modelContextProfileService.updateFromProbeSnapshot).toHaveBeenCalledWith(
      expect.objectContaining({ testedNumCtx: 2048, status: 'completed' }),
      expect.objectContaining({ assertAuthorityActive: expect.any(Function) })
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
    expect(ollamaClient.generate.mock.calls.length).toBeGreaterThanOrEqual(4);
    for (const [, payload] of ollamaClient.generate.mock.calls) {
      expect(payload.options).toMatchObject({ temperature: 0, seed: 7 });
    }
  });

  it('keeps the raw snapshot diagnostic but fails the run when context authority persistence fails', async () => {
    ollamaClient.showModel.mockResolvedValue({ model_info: { 'general.context_length': 2048 } });
    ollamaClient.listRunning.mockResolvedValue({
      models: [{ name: 'gemma4:26b', size: 100, size_vram: 100, context_length: 2048 }]
    });
    ollamaClient.generate.mockResolvedValue({
      eval_count: 64,
      eval_duration: 1e9,
      prompt_eval_count: 1600
    });
    modelContextProfileService.updateFromProbeSnapshot.mockRejectedValueOnce(new Error('mongo unavailable'));

    await expect(contextProbeService.probeModelContext('gemma4:26b', {
      hostUrl: 'http://192.0.2.66:11434',
      artifactIdentity: ARTIFACT,
      acknowledgeMaintenance: true,
      maxCtx: 2048
    })).rejects.toThrow('mongo unavailable');
    expect(ModelContextProbeSnapshot.create).toHaveBeenCalledWith(
      [expect.objectContaining({ status: 'completed' })],
      undefined
    );
  });

  it('tombstones an ambiguously committed snapshot when authority is lost after the write', async () => {
    const controller = new AbortController();
    let checkpointCount = 0;
    const lost = Object.assign(new Error('claim heartbeat rejected'), { code: 'BENCHMARK_CLAIM_LOST' });
    const checkpoint = jest.fn(() => {
      checkpointCount += 1;
      if (checkpointCount === 2) throw lost;
    });

    await expect(contextProbeService._internal.persistProbeSnapshot({
      modelName: 'gemma4:26b',
      hostUrl: ARTIFACT.hostUrl,
      status: 'completed'
    }, { signal: controller.signal, checkpoint })).rejects.toBe(lost);

    expect(ModelContextProbeSnapshot.create).toHaveBeenCalledWith(
      [expect.objectContaining({ _id: expect.anything(), status: 'completed' })],
      { signal: controller.signal }
    );
    expect(ModelContextProbeSnapshot.updateOne).toHaveBeenCalledWith(
      { _id: expect.anything() },
      expect.objectContaining({
        $set: expect.objectContaining({ authorityStatus: 'rejected' })
      }),
      { upsert: true }
    );
  });
});

describe('validateThroughput', () => {
  const assess = contextProbeService._internal.validateThroughput;

  it('accepts any positive finite measurement', () => {
    const r = assess(1_000_000, { modelName: 'gemma4:26b', hostUrl: 'http://192.0.2.66:11434' });
    expect(r.plausible).toBe(true);
    expect(r.detail).toBeNull();
  });

  it('treats zero as a measured context boundary but rejects corrupt values', () => {
    expect(assess(0)).toEqual({ plausible: true, detail: null });
    expect(assess(-1).plausible).toBe(false);
    expect(assess(Number.NaN).plausible).toBe(false);
    expect(assess(Number.POSITIVE_INFINITY).plausible).toBe(false);
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

describe('assessProbeStep', () => {
  const assess = contextProbeService._internal.assessProbeStep;

  it('rejects an Ollama context clamp and a short prompt evaluation', () => {
    const clamped = assess({
      passed: true,
      numCtx: 8192,
      tokensPerSec: 40,
      gpuPercent: 100,
      ollamaContextLength: 4096,
      promptCoveragePct: 80,
      minimumPromptCoveragePct: 70
    }, 50);
    expect(clamped).toMatchObject({ passed: false });
    expect(clamped.reason).toContain('below requested 8192');

    const shortPrompt = assess({
      passed: true,
      numCtx: 8192,
      tokensPerSec: 40,
      gpuPercent: 100,
      ollamaContextLength: 8192,
      promptCoveragePct: 40,
      minimumPromptCoveragePct: 70
    }, 50);
    expect(shortPrompt).toMatchObject({ passed: false });
    expect(shortPrompt.reason).toContain('below required 70%');
  });

  it('treats missing GPU residency evidence as unknown, never no-spill', () => {
    const result = assess({
      passed: true,
      numCtx: 8192,
      tokensPerSec: 40,
      gpuPercent: null,
      ollamaContextLength: 8192,
      promptCoveragePct: 80,
      minimumPromptCoveragePct: 70
    }, 50);
    expect(result).toMatchObject({ passed: false });
    expect(result.reason).toContain('GPU residency unknown');
  });
});

describe('findInvalidThroughputStep', () => {
  const findInvalid = contextProbeService._internal.findInvalidThroughputStep;

  it('ignores the zero placeholder from a failed request', () => {
    expect(findInvalid([
      { numCtx: 65536, requestSucceeded: false, tokensPerSec: 0 }
    ])).toBeUndefined();
  });

  it('accepts zero from a successful request as a boundary', () => {
    expect(findInvalid([
      { numCtx: 65536, requestSucceeded: true, tokensPerSec: 0 }
    ])).toBeUndefined();
  });

  it('still rejects a corrupt measurement', () => {
    const step = { numCtx: 65536, requestSucceeded: true, tokensPerSec: -1 };
    expect(findInvalid([step])).toBe(step);
  });
});
