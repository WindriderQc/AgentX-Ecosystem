'use strict';

jest.mock('../../../src/services/hostTestService', () => ({ testModelOnHost: jest.fn() }));
jest.mock('../../../src/services/contextProbeService', () => ({ probeModelContext: jest.fn() }));
jest.mock('../../../src/services/profiler/modelProfileService', () => ({
  updateReadiness: jest.fn(),
  updateThinkingCapability: jest.fn()
}));
jest.mock('../../../src/services/profiler/modelPerformanceProfileService', () => ({ saveProfile: jest.fn() }));
jest.mock('../../../src/services/profiler/artifactIdentityService', () => ({
  identitiesMatch: jest.fn((left, right) => left?.digest === right?.digest && left?.runtimeFingerprint === right?.runtimeFingerprint),
  resolveArtifactIdentity: jest.fn()
}));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({ getById: jest.fn(), getByUrl: jest.fn() }));
jest.mock('../../../src/services/profiler/settingsService', () => ({ getAll: jest.fn() }));
jest.mock('../../../src/services/profiler/liveProbeService', () => ({ getLiveProbeStatus: jest.fn() }));
jest.mock('../../../src/services/profiler/thinkingProfileService', () => ({ profileThinkingBehavior: jest.fn() }));
jest.mock('../../../src/services/profiler/prefillDecodeMatrix', () => ({ runPrefillDecodeMatrix: jest.fn() }));
jest.mock('../../../src/clients/ollamaClient', () => ({
  listRunning: jest.fn(),
  generate: jest.fn(),
  showModel: jest.fn()
}));
jest.mock('../../../models/ModelProfile', () => ({ findOne: jest.fn() }));
jest.mock('../../../src/services/benchmark/buddySurfaceEvents', () => ({ emitLifecycle: jest.fn() }));

const hostTestService = require('../../../src/services/hostTestService');
const modelProfileService = require('../../../src/services/profiler/modelProfileService');
const performanceProfiles = require('../../../src/services/profiler/modelPerformanceProfileService');
const artifactIdentityService = require('../../../src/services/profiler/artifactIdentityService');
const hostProfileService = require('../../../src/services/profiler/hostProfileService');
const settingsService = require('../../../src/services/profiler/settingsService');
const liveProbeService = require('../../../src/services/profiler/liveProbeService');
const thinkingProfileService = require('../../../src/services/profiler/thinkingProfileService');
const ollamaClient = require('../../../src/clients/ollamaClient');
const ModelProfile = require('../../../models/ModelProfile');
const orchestrator = require('../../../src/services/profiler/profilerOrchestrator');

const MODEL = 'owner/model:8b-q4';
const HOST_ID = 'host-alpha';
const HOST_URL = 'http://host-alpha:11434';
const ARTIFACT = {
  model: MODEL,
  hostId: HOST_ID,
  hostUrl: HOST_URL,
  digest: 'sha256:exact',
  runtimeFingerprint: 'runtime-a',
  registryDigest: 'sha256:exact',
  registryQualified: true
};

function readiness(overrides = {}) {
  return {
    stage: 'profiled',
    profileDepth: 'standard',
    benchmarkQualified: true,
    stale: false,
    artifact: ARTIFACT,
    ...overrides
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  artifactIdentityService.resolveArtifactIdentity.mockResolvedValue({ ...ARTIFACT });
  hostProfileService.getById.mockResolvedValue({ hostId: HOST_ID, hostUrl: HOST_URL });
  hostProfileService.getByUrl.mockResolvedValue({ hostId: HOST_ID, hostUrl: HOST_URL });
  settingsService.getAll.mockResolvedValue({
    maxPromptTokens: 512,
    numPredict: 32,
    testTimeoutSec: 30,
    throughputSamples: 1,
    thinkingProbeEnabled: false,
    collectHardwareTelemetry: false,
    contextProbeFillPct: 80
  });
  liveProbeService.getLiveProbeStatus.mockResolvedValue({});
  ollamaClient.showModel.mockResolvedValue({ model_info: { 'test.context_length': 8192 } });
  ollamaClient.listRunning.mockResolvedValue({ models: [{ name: MODEL, size: 100, size_vram: 100 }] });
  hostTestService.testModelOnHost.mockResolvedValue({
    status: 'pass',
    tokensPerSec: 42,
    promptEvalTokensPerSec: 100,
    timeToFirstTokenMs: 50,
    promptTokens: 100,
    requestedPromptTokens: 100,
    promptWorkloadMode: 'fixed',
    numCtx: 8192,
    vramUsedMiB: 4096
  });
  performanceProfiles.saveProfile.mockResolvedValue({ _id: 'evidence-1' });
});

describe('profile', () => {
  it('records evidence for the exact requested tag without creating another model', async () => {
    const result = await orchestrator.profile(MODEL, HOST_ID, HOST_URL, 'quick');
    expect(hostTestService.testModelOnHost).toHaveBeenCalledWith(MODEL, HOST_URL, expect.any(Object));
    expect(hostTestService.testModelOnHost.mock.calls[0][2]).not.toHaveProperty('numCtx');
    expect(performanceProfiles.saveProfile).toHaveBeenCalledWith(expect.objectContaining({
      modelName: MODEL,
      hostId: HOST_ID,
      artifact: ARTIFACT
    }));
    expect(modelProfileService.updateReadiness).toHaveBeenCalledWith(
      MODEL,
      HOST_ID,
      'profiled',
      expect.objectContaining({
        [`readiness.${HOST_ID}.benchmarkQualified`]: false,
        [`readiness.${HOST_ID}.artifact`]: ARTIFACT
      })
    );
    expect(result).toMatchObject({ modelName: MODEL, artifact: ARTIFACT, evidenceId: 'evidence-1' });
  });

  it('retires adaptation explicitly', async () => {
    await expect(orchestrator.adapt()).rejects.toMatchObject({ statusCode: 410 });
  });

  it('probes thinking at the already-loaded throughput context', async () => {
    settingsService.getAll.mockResolvedValue({
      maxPromptTokens: 512,
      numPredict: 32,
      testTimeoutSec: 30,
      throughputSamples: 1,
      thinkingProbeEnabled: true,
      collectHardwareTelemetry: false,
      contextProbeFillPct: 80
    });
    ollamaClient.listRunning.mockResolvedValue({
      models: [{ name: MODEL, context_length: 262144, size: 100, size_vram: 100 }]
    });
    hostTestService.testModelOnHost.mockImplementation(async (_model, _host, options) => ({
      status: 'pass',
      tokensPerSec: 42,
      promptEvalTokensPerSec: 100,
      timeToFirstTokenMs: 50,
      promptTokens: 100,
      requestedPromptTokens: 100,
      promptWorkloadMode: 'fixed',
      numCtx: options.numCtx || 4096,
      vramUsedMiB: 4096
    }));
    thinkingProfileService.profileThinkingBehavior.mockResolvedValue({ recommendedPolicy: 'on' });

    await orchestrator.profile(MODEL, HOST_ID, HOST_URL, 'quick');

    expect(hostTestService.testModelOnHost).toHaveBeenCalledWith(
      MODEL,
      HOST_URL,
      expect.objectContaining({ numCtx: 262144 })
    );
    expect(thinkingProfileService.profileThinkingBehavior).toHaveBeenCalledWith(
      MODEL,
      HOST_URL,
      expect.objectContaining({ numCtx: 262144, maxNumCtx: 262144 })
    );
  });
});

describe('preflight', () => {
  function mockReadiness(value) {
    ModelProfile.findOne.mockReturnValue({
      select: jest.fn().mockReturnValue({ lean: jest.fn().mockResolvedValue({ readiness: { [HOST_ID]: value } }) })
    });
  }

  it('accepts only a benchmark-qualified profile bound to the current digest/runtime', async () => {
    mockReadiness(readiness({ stage: 'available' }));
    const result = await orchestrator.preflight({ models: [{ name: MODEL, host: HOST_URL }] });
    expect(result.ready).toHaveLength(1);
    expect(result.profilesNeeded).toHaveLength(0);
    expect(result).not.toHaveProperty('adaptsNeeded');
  });

  it.each([
    ['quick profile', readiness({ benchmarkQualified: false }), 'missing_or_quick_profile'],
    ['stale profile', readiness({ stale: true }), 'profile_marked_stale'],
    ['digest drift', readiness({ artifact: { ...ARTIFACT, digest: 'sha256:old' } }), 'artifact_or_runtime_drift']
  ])('requires a standard reprofile for %s', async (_label, value, reason) => {
    mockReadiness(value);
    const result = await orchestrator.preflight({ models: [{ name: MODEL, host: HOST_URL }] });
    expect(result.ready).toHaveLength(0);
    expect(result.profilesNeeded).toEqual([expect.objectContaining({ name: MODEL, profileReason: reason })]);
  });
});
