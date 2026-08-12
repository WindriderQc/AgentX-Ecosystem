'use strict';

jest.mock('../../../src/services/hostTestService');
jest.mock('../../../src/services/contextProbeService');
jest.mock('../../../src/services/profiler/modelProfileService');
jest.mock('../../../src/services/profiler/adaptationService');
jest.mock('../../../src/services/profiler/hostProfileService');
jest.mock('../../../src/services/profiler/settingsService', () => ({
  getAll: jest.fn().mockResolvedValue({
    degradationThreshold: 30, contextFillPct: 25, maxPromptTokens: 2048, numPredict: 64,
    warmup: true, testTimeoutSec: 60, baselineModel: 'qwen2.5:3b', throughputSamples: 1,
    thinkingProbeEnabled: true, collectHardwareTelemetry: false
  })
}));
jest.mock('../../../src/services/profiler/thinkingProfileService', () => ({
  profileThinkingBehavior: jest.fn()
}));
jest.mock('../../../src/services/profiler/namingConvention');
jest.mock('../../../src/clients/ollamaClient', () => ({
  listRunning: jest.fn(),
  generate: jest.fn(),
  showModel: jest.fn()
}));
jest.mock('../../../src/services/modelContextResolver', () => ({
  resolveModelNumCtxDetails: jest.fn().mockResolvedValue({ num_ctx: 8192, source: 'fallback' }),
  normalizeModelName: jest.fn(n => String(n || '').replace(/:latest$/i, '')),
  modelNameCandidates: jest.fn((name) => {
    const normalized = String(name || '').replace(/:latest$/i, '');
    return normalized.startsWith('ax/') ? [normalized, normalized.slice(3)] : [normalized];
  })
}));
jest.mock('../../../models/ModelAdaptation');
jest.mock('../../../models/ModelProfile');
jest.mock('../../../config/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn() }));

const hostTestService = require('../../../src/services/hostTestService');
const contextProbeService = require('../../../src/services/contextProbeService');
const modelProfileService = require('../../../src/services/profiler/modelProfileService');
const adaptationService = require('../../../src/services/profiler/adaptationService');
const hostProfileService = require('../../../src/services/profiler/hostProfileService');
const { profileThinkingBehavior } = require('../../../src/services/profiler/thinkingProfileService');
const { buildAdaptedName } = require('../../../src/services/profiler/namingConvention');
const { listRunning, generate, showModel } = require('../../../src/clients/ollamaClient');
const ModelAdaptation = require('../../../models/ModelAdaptation');
const ModelProfile = require('../../../models/ModelProfile');

const orchestrator = require('../../../src/services/profiler/profilerOrchestrator');

// Default: every model is "profiled" on whatever hostId the test passes in.
// Tests that need an unprofiled model override via ModelProfile.findOne.mockReturnValueOnce.
function mockProfiled(hostId) {
  return {
    select: jest.fn().mockReturnValue({
      lean: jest.fn().mockResolvedValue({ readiness: { [hostId]: { stage: 'profiled', stale: false } } })
    })
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  buildAdaptedName.mockImplementation((m) => `ax/${m}`);
  // Default: profiled on host-delta (the slug used by most tests).
  ModelProfile.findOne.mockReturnValue(mockProfiled('host-delta'));
});

// ---------------------------------------------------------------------------
// scout()
// ---------------------------------------------------------------------------
describe('scout()', () => {
  const hosts = [
    { hostId: 'host-delta', hostUrl: 'http://192.0.2.66:11434' },
    { hostId: 'host-gamma', hostUrl: 'http://192.0.2.99:11434' }
  ];

  it('returns fit=true when testModelOnHost returns status pass', async () => {
    hostTestService.testModelOnHost.mockResolvedValue({
      status: 'pass',
      tokensPerSec: 42.5,
      error: null
    });

    const results = await orchestrator.scout('llama3.1:8b', hosts);

    expect(hostTestService.testModelOnHost).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(2);
    expect(results[0]).toMatchObject({ hostId: 'host-delta', fit: true, tokensPerSec: 42.5 });
    expect(results[1]).toMatchObject({ hostId: 'host-gamma', fit: true });
  });

  it('returns fit=false when testModelOnHost returns status fail', async () => {
    hostTestService.testModelOnHost.mockResolvedValue({
      status: 'fail',
      tokensPerSec: null,
      error: 'model not found'
    });

    const results = await orchestrator.scout('llama3.1:8b', hosts);

    expect(results[0]).toMatchObject({ hostId: 'host-delta', fit: false, error: 'model not found' });
  });

  it('returns fit=false on thrown error', async () => {
    hostTestService.testModelOnHost.mockRejectedValue(new Error('connection refused'));

    const results = await orchestrator.scout('llama3.1:8b', hosts);

    expect(results[0]).toMatchObject({ hostId: 'host-delta', fit: false, error: 'connection refused' });
    expect(results[1]).toMatchObject({ hostId: 'host-gamma', fit: false, error: 'connection refused' });
  });

  it('handles mixed pass/error results across hosts', async () => {
    hostTestService.testModelOnHost
      .mockResolvedValueOnce({ status: 'pass', tokensPerSec: 38.0, error: null })
      .mockRejectedValueOnce(new Error('timeout'));

    const results = await orchestrator.scout('llama3.1:8b', hosts);

    expect(results[0]).toMatchObject({ hostId: 'host-delta', fit: true });
    expect(results[1]).toMatchObject({ hostId: 'host-gamma', fit: false, error: 'timeout' });
  });
});

// ---------------------------------------------------------------------------
// profile()
// ---------------------------------------------------------------------------
describe('profile()', () => {
  const modelName = 'llama3.1:8b';
  const hostId = 'host-delta';
  const hostUrl = 'http://192.0.2.66:11434';
  const originalFetch = global.fetch;

  const testResult = {
    status: 'pass',
    tokensPerSec: 42.5,
    promptEvalTokensPerSec: 310.2,
    timeToFirstTokenMs: 185,
    vramUsedMiB: 5800,
    numCtx: 8192,
    error: null
  };

  const probeResult = {
    testedNumCtx: 8192,
    degradationPct: 3.2,
    steps: [
      { numCtx: 4096, tokensPerSec: 45.1, vramMiB: 5200 },
      { numCtx: 8192, tokensPerSec: 42.5, vramMiB: 5800 }
    ]
  };

  beforeEach(() => {
    hostTestService.testModelOnHost.mockResolvedValue(testResult);
    contextProbeService.probeModelContext.mockResolvedValue(probeResult);
    showModel.mockResolvedValue({ parameters: 'PARAMETER num_ctx 8192', model_info: {} });
    listRunning.mockResolvedValue({ models: [{ name: modelName, size: 4_000_000_000, size_vram: 4_000_000_000 }] });
    generate.mockResolvedValue({});
    profileThinkingBehavior.mockResolvedValue({
      profiledAt: new Date('2026-07-07T00:00:00Z'),
      apiMode: 'chat',
      supported: true,
      supportSignal: 'hidden_channel',
      channel: 'hidden',
      visibleFinalAnswerOk: true,
      finalAnswerContractOk: true,
      thinkingOnlyResponse: false,
      runawayRisk: false,
      tokenMultiplier: 2,
      latencyMultiplier: 2,
      recommendedPolicy: 'metered',
      recommendationReason: 'test profile'
    });
    adaptationService.saveAdaptation.mockResolvedValue({});
    adaptationService.populateLineage.mockReturnValue({ base: modelName });
    modelProfileService.updateReadiness.mockResolvedValue({});
    // Mocks for adapt() called during auto-deploy after profile
    adaptationService.getAdaptation.mockResolvedValue({ profile: testResult });
    adaptationService.generateConfig.mockReturnValue({ num_ctx: 8192 });
    adaptationService.generateModelfile.mockReturnValue('FROM llama3.1:8b\nPARAMETER num_ctx 8192');
    adaptationService.deployToHost.mockResolvedValue({ success: true });
    hostProfileService.getById.mockResolvedValue({ hostId, vramMiB: 24000 });
    // Mock fetch for _detectSpill calls within profile()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ models: [{ name: modelName, size: 4_000_000_000, size_vram: 4_000_000_000 }] })
    });
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('calls testModelOnHost and probeModelContext', async () => {
    await orchestrator.profile(modelName, hostId, hostUrl, 'standard');

    expect(hostTestService.testModelOnHost).toHaveBeenCalledWith(modelName, hostUrl, expect.objectContaining({
      maxPromptTokens: 2048, numPredict: 64, promptWorkloadMode: 'fixed', timeoutMs: 60000
    }));
    expect(contextProbeService.probeModelContext).toHaveBeenCalledWith(modelName, expect.objectContaining({ hostUrl, acknowledgeMaintenance: true }));
  });

  it('saves adaptation with profile data', async () => {
    await orchestrator.profile(modelName, hostId, hostUrl, 'standard');

    expect(adaptationService.saveAdaptation).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName,
        hostId,
        adaptedName: `ax/${modelName}`,
        profile: expect.objectContaining({
          tokensPerSec: 42.5,
          optimalNumCtx: 8192,
          profileDepth: 'standard',
          thinking: expect.objectContaining({
            supported: true,
            recommendedPolicy: 'metered'
          })
        })
      })
    );
  });

  it('updates readiness to "profiled"', async () => {
    await orchestrator.profile(modelName, hostId, hostUrl, 'standard');

    expect(modelProfileService.updateReadiness).toHaveBeenCalledWith(modelName, hostId, 'profiled');
    expect(modelProfileService.updateThinkingCapability).toHaveBeenCalledWith(
      modelName,
      hostId,
      expect.objectContaining({ recommendedPolicy: 'metered' })
    );
  });

  it('returns modelName, hostId, and profile', async () => {
    const result = await orchestrator.profile(modelName, hostId, hostUrl, 'standard');

    expect(result).toMatchObject({ modelName, hostId });
    expect(result.profile).toBeDefined();
    expect(result.profile.tokensPerSec).toBe(42.5);
  });

  it('throws when testModelOnHost returns non-pass status', async () => {
    hostTestService.testModelOnHost.mockResolvedValue({ status: 'fail', error: 'model load failed' });

    await expect(orchestrator.profile(modelName, hostId, hostUrl, 'standard'))
      .rejects.toThrow('Throughput test failed');
  });

  it('does not call probeModelContext when throughput test fails', async () => {
    hostTestService.testModelOnHost.mockResolvedValue({ status: 'fail', error: 'OOM' });

    await expect(orchestrator.profile(modelName, hostId, hostUrl)).rejects.toThrow();
    expect(contextProbeService.probeModelContext).not.toHaveBeenCalled();
  });

  it('throws when auto-deploy fails after profiling', async () => {
    adaptationService.deployToHost.mockResolvedValue({ success: false, error: 'create failed' });

    await expect(orchestrator.profile(modelName, hostId, hostUrl, 'standard'))
      .rejects.toThrow('Deploy failed');
  });

  it('stores throughput sample quality when repeat samples are enabled', async () => {
    const settingsService = require('../../../src/services/profiler/settingsService');
    settingsService.getAll.mockResolvedValueOnce({
      degradationThreshold: 30, contextFillPct: 25, maxPromptTokens: 2048, numPredict: 64,
      warmup: true, testTimeoutSec: 60, baselineModel: 'qwen2.5:3b', throughputSamples: 2,
      thinkingProbeEnabled: true, collectHardwareTelemetry: false
    });
    hostTestService.testModelOnHost
      .mockResolvedValueOnce(testResult)
      .mockResolvedValueOnce({ ...testResult, tokensPerSec: 40 });

    await orchestrator.profile(modelName, hostId, hostUrl, 'standard');

    expect(hostTestService.testModelOnHost).toHaveBeenCalledTimes(2);
    expect(adaptationService.saveAdaptation).toHaveBeenCalledWith(expect.objectContaining({
      profile: expect.objectContaining({
        throughputSamples: expect.arrayContaining([
          expect.objectContaining({ sample: 1, tokensPerSec: 42.5 }),
          expect.objectContaining({ sample: 2, tokensPerSec: 40 })
        ]),
        measurementQuality: expect.objectContaining({ sampleCount: 2 })
      })
    }));
  });
});

describe('summarizeThroughputSamples()', () => {
  it('classifies repeat-sample reliability', () => {
    const summary = orchestrator.summarizeThroughputSamples([
      { sample: 1, status: 'pass', tokensPerSec: 100 },
      { sample: 2, status: 'pass', tokensPerSec: 102 },
      { sample: 3, status: 'pass', tokensPerSec: 98 }
    ]);

    expect(summary).toMatchObject({
      sampleCount: 3,
      tokensPerSecMedian: 100,
      reliability: 'high'
    });
  });
});

// ---------------------------------------------------------------------------
// preflight()
// ---------------------------------------------------------------------------
describe('preflight()', () => {
  it('puts models with no profile record into profilesNeeded', async () => {
    // No profile at all → genuinely needs profiling.
    ModelProfile.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) })
    });
    ModelAdaptation.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    const batchConfig = {
      models: [
        { name: 'llama3.1:8b', host: 'host-delta' },
        { name: 'gemma3:12b', host: 'host-gamma' }
      ]
    };

    const result = await orchestrator.preflight(batchConfig);

    expect(result.profilesNeeded).toHaveLength(2);
    expect(result.ready).toHaveLength(0);
    expect(result.adaptsNeeded).toHaveLength(0);
  });

  it('puts profiled-but-unadapted models into adaptsNeeded (NOT profilesNeeded)', async () => {
    // Regression guard for the 2026-04-19 bug where already-profiled models
    // were re-profiled because preflight only checked ModelAdaptation.
    ModelProfile.findOne.mockReturnValue(mockProfiled('host-gamma'));
    ModelAdaptation.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(null) });

    const batchConfig = {
      models: [{ name: 'qwen2.5:7b-instruct-q4_K_M', host: 'host-gamma' }]
    };

    const result = await orchestrator.preflight(batchConfig);

    expect(result.profilesNeeded).toHaveLength(0);
    expect(result.adaptsNeeded).toHaveLength(1);
    expect(result.ready).toHaveLength(0);
  });

  it('looks up ax model profiles and adaptations by exact name before stripped fallback', async () => {
    ModelProfile.findOne.mockReturnValue(mockProfiled('host-beta'));
    ModelAdaptation.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        modelName: 'ax/qwen3.5:9b',
        hostId: 'host-beta',
        config: { num_ctx: 65536 },
        deployment: { status: 'deployed' },
        staleness: { stale: false }
      })
    });

    const result = await orchestrator.preflight({
      models: [{ name: 'ax/qwen3.5:9b', host: 'host-beta' }]
    });

    expect(result.ready).toHaveLength(1);
    expect(result.profilesNeeded).toHaveLength(0);
    expect(result.adaptsNeeded).toHaveLength(0);
    expect(ModelProfile.findOne).toHaveBeenCalledWith({
      name: { $in: ['ax/qwen3.5:9b', 'qwen3.5:9b'] }
    });
    expect(ModelAdaptation.findOne).toHaveBeenCalledWith({
      modelName: { $in: ['ax/qwen3.5:9b', 'qwen3.5:9b'] },
      hostId: 'host-beta'
    });
  });

  it('resolves hostUrl → hostId when caller passes a URL instead of a slug', async () => {
    hostProfileService.getByUrl = jest.fn().mockResolvedValue({ hostId: 'host-gamma' });
    ModelProfile.findOne.mockReturnValue(mockProfiled('host-gamma'));
    ModelAdaptation.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        config: { num_ctx: 8192 },
        deployment: { status: 'deployed' }
      })
    });

    const batchConfig = {
      models: [{ name: 'qwen2.5:7b', host: 'http://192.0.2.99:11434', hostUrl: 'http://192.0.2.99:11434' }]
    };

    const result = await orchestrator.preflight(batchConfig);

    expect(hostProfileService.getByUrl).toHaveBeenCalledWith('http://192.0.2.99:11434');
    expect(result.ready).toHaveLength(1);
    expect(result.ready[0]).toMatchObject({ host: 'host-gamma', hostUrl: 'http://192.0.2.99:11434' });
    expect(result.profilesNeeded).toHaveLength(0);
    expect(result.adaptsNeeded).toHaveLength(0);
  });

  it('puts deployed models into ready', async () => {
    ModelAdaptation.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        modelName: 'llama3.1:8b',
        hostId: 'host-delta',
        config: { num_ctx: 8192 },
        deployment: { status: 'deployed' },
        staleness: { stale: false }
      })
    });

    const batchConfig = {
      models: [{ name: 'llama3.1:8b', host: 'host-delta' }]
    };

    const result = await orchestrator.preflight(batchConfig);

    expect(result.ready).toHaveLength(1);
    expect(result.profilesNeeded).toHaveLength(0);
    expect(result.adaptsNeeded).toHaveLength(0);
  });

  it('puts models with adaptation but no config into adaptsNeeded', async () => {
    ModelAdaptation.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        modelName: 'llama3.1:8b',
        hostId: 'host-delta',
        config: null,
        deployment: { status: 'pending' }
      })
    });

    const batchConfig = {
      models: [{ name: 'llama3.1:8b', host: 'host-delta' }]
    };

    const result = await orchestrator.preflight(batchConfig);

    expect(result.adaptsNeeded).toHaveLength(1);
    expect(result.ready).toHaveLength(0);
  });

  it('adds stale deployed models to warnings while keeping them in ready', async () => {
    ModelAdaptation.findOne.mockReturnValue({
      lean: jest.fn().mockResolvedValue({
        modelName: 'llama3.1:8b',
        hostId: 'host-delta',
        config: { num_ctx: 8192 },
        deployment: { status: 'deployed' },
        staleness: { stale: true, reason: 'age > 7 days' }
      })
    });

    const batchConfig = {
      models: [{ name: 'llama3.1:8b', host: 'host-delta' }]
    };

    const result = await orchestrator.preflight(batchConfig);

    expect(result.ready).toHaveLength(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toMatchObject({
      modelName: 'llama3.1:8b',
      hostId: 'host-delta',
      reason: 'age > 7 days'
    });
  });

  it('handles mixed model states correctly', async () => {
    // model-a: no profile → profilesNeeded
    // model-b: profiled but no deployed adaptation → adaptsNeeded
    // model-c: profiled and deployed adaptation → ready
    ModelProfile.findOne
      .mockReturnValueOnce({ select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue(null) }) })
      .mockReturnValueOnce(mockProfiled('host-delta'))
      .mockReturnValueOnce(mockProfiled('host-delta'));

    // ModelAdaptation is only queried for models that passed the profile check
    // (model-b and model-c). model-a short-circuits after the profile lookup.
    ModelAdaptation.findOne
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          config: null,
          deployment: { status: 'pending' }
        })
      })
      .mockReturnValueOnce({
        lean: jest.fn().mockResolvedValue({
          config: { num_ctx: 8192 },
          deployment: { status: 'deployed' },
          staleness: { stale: false }
        })
      });

    const batchConfig = {
      models: [
        { name: 'model-a', host: 'host-delta' },
        { name: 'model-b', host: 'host-delta' },
        { name: 'model-c', host: 'host-delta' }
      ]
    };

    const result = await orchestrator.preflight(batchConfig);

    expect(result.profilesNeeded).toHaveLength(1);
    expect(result.adaptsNeeded).toHaveLength(1);
    expect(result.ready).toHaveLength(1);
    expect(result.warnings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// runPreflight()
// ---------------------------------------------------------------------------
describe('runPreflight()', () => {
  beforeEach(() => {
    hostTestService.testModelOnHost.mockResolvedValue({
      status: 'pass', tokensPerSec: 42.5, promptEvalTokensPerSec: 310,
      timeToFirstTokenMs: 185, vramUsedMiB: 5800, numCtx: 8192, error: null
    });
    contextProbeService.probeModelContext.mockResolvedValue({
      testedNumCtx: 8192, degradationPct: 3, steps: []
    });
    adaptationService.saveAdaptation.mockResolvedValue({});
    adaptationService.getAdaptation.mockResolvedValue({ profile: { tokensPerSec: 42 } });
    adaptationService.generateConfig.mockReturnValue({ num_ctx: 8192 });
    adaptationService.generateModelfile.mockReturnValue('FROM test');
    adaptationService.populateLineage.mockReturnValue({});
    modelProfileService.updateReadiness.mockResolvedValue({});
    hostProfileService.getById.mockResolvedValue({ hostId: 'host-gamma', vramMiB: 12000 });
    showModel.mockResolvedValue({ parameters: 'PARAMETER num_ctx 8192', model_info: {} });
    listRunning.mockResolvedValue({ models: [] });
    generate.mockResolvedValue({});
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ models: [] }) });
  });
  afterEach(() => { delete global.fetch; });

  it('emits preflight_reprofile_start with reason no_profile for profilesNeeded', async () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    const preflightResult = {
      ready: [],
      profilesNeeded: [{ name: 'model-a', host: 'host-gamma', hostUrl: 'http://192.0.2.99:11434' }],
      adaptsNeeded: [],
      warnings: []
    };
    await orchestrator.runPreflight(preflightResult, {}, { onEvent });
    expect(onEvent).toHaveBeenCalledWith('preflight_reprofile_start', expect.objectContaining({
      model: 'model-a',
      details: expect.objectContaining({ reason: 'no_profile', hostId: 'host-gamma' })
    }));
  });

  it('emits preflight_reprofile_start with reason missing_adaptation for adaptsNeeded', async () => {
    const onEvent = jest.fn().mockResolvedValue(undefined);
    const preflightResult = {
      ready: [],
      profilesNeeded: [],
      adaptsNeeded: [{ name: 'model-b', host: 'host-gamma', hostUrl: 'http://192.0.2.99:11434' }],
      warnings: []
    };
    await orchestrator.runPreflight(preflightResult, {}, { onEvent });
    expect(onEvent).toHaveBeenCalledWith('preflight_reprofile_start', expect.objectContaining({
      model: 'model-b',
      details: expect.objectContaining({ reason: 'missing_adaptation', hostId: 'host-gamma' })
    }));
  });

  it('does not emit events when onEvent is not provided', async () => {
    const preflightResult = {
      ready: [],
      profilesNeeded: [{ name: 'model-a', host: 'host-gamma', hostUrl: 'http://192.0.2.99:11434' }],
      adaptsNeeded: [],
      warnings: []
    };
    // Should not throw
    await orchestrator.runPreflight(preflightResult, {});
  });
});
