'use strict';

jest.mock('../../../src/services/hostTestService', () => ({ testModelOnHost: jest.fn() }));
jest.mock('../../../src/services/contextProbeService', () => ({ probeModelContext: jest.fn() }));
jest.mock('../../../src/services/profiler/modelProfileService', () => ({
  updateReadiness: jest.fn(),
  updateThinkingCapability: jest.fn(),
  invalidateReadinessIfEvidence: jest.fn(),
  invalidateThinkingCapability: jest.fn()
}));
jest.mock('../../../src/services/profiler/modelPerformanceProfileService', () => ({
  saveProfile: jest.fn(),
  retireSupersededProfiles: jest.fn(),
  invalidateProfile: jest.fn()
}));
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
const contextProbeService = require('../../../src/services/contextProbeService');
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
    evidenceId: 'evidence-1',
    authorityReceipt: {
      version: 1,
      source: 'profiler_pipeline',
      evidenceId: 'evidence-1',
      digest: 'a'.repeat(64),
      issuedAt: new Date('2026-09-03T00:00:00Z')
    },
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
    ttftMeasurement: 'streamed_wall_clock',
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

  it.each([
    ['the measured throughput context', 16384, 16384],
    ['no context when throughput omitted it', undefined, null]
  ])('records spill at %s without inventing a safe context', async (_case, numCtx, expectedSpillNumCtx) => {
    ollamaClient.listRunning.mockResolvedValue({
      models: [{ name: MODEL, size: 100, size_vram: 75 }]
    });
    hostTestService.testModelOnHost.mockResolvedValue({
      status: 'pass',
      tokensPerSec: 42,
      promptEvalTokensPerSec: 100,
      timeToFirstTokenMs: 50,
      ttftMeasurement: 'streamed_wall_clock',
      promptTokens: 100,
      requestedPromptTokens: 100,
      promptWorkloadMode: 'fixed',
      numCtx,
      vramUsedMiB: 4096
    });

    const result = await orchestrator.profile(MODEL, HOST_ID, HOST_URL, 'quick');

    expect(result.profile.spill).toEqual(expect.objectContaining({
      spillDetected: true,
      spillNumCtx: expectedSpillNumCtx,
      lastSafeNumCtx: null
    }));
  });

  it('persists benchmark-qualified readiness after a zero-throughput context boundary', async () => {
    contextProbeService.probeModelContext.mockResolvedValue({
      status: 'completed',
      testedNumCtx: 32768,
      recommendedInteractiveContext: 16384,
      recommendedDocumentContext: 32768,
      degradationPct: 10,
      steps: [
        { numCtx: 2048, passed: true, tokensPerSec: 50 },
        { numCtx: 32768, passed: true, tokensPerSec: 45 },
        { numCtx: 65536, requestSucceeded: true, passed: false, tokensPerSec: 0 }
      ]
    });

    const result = await orchestrator.profile(MODEL, HOST_ID, HOST_URL, 'standard');

    expect(result.profile).toEqual(expect.objectContaining({
      profileDepth: 'standard',
      optimalNumCtx: 32768
    }));
    expect(modelProfileService.updateReadiness).toHaveBeenCalledWith(
      MODEL,
      HOST_ID,
      'profiled',
      expect.objectContaining({
        [`readiness.${HOST_ID}.profileDepth`]: 'standard',
        [`readiness.${HOST_ID}.benchmarkQualified`]: true,
        [`readiness.${HOST_ID}.stale`]: false,
        [`readiness.${HOST_ID}.artifact`]: ARTIFACT
      })
    );
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
      ttftMeasurement: 'streamed_wall_clock',
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

describe('profiler evidence qualification', () => {
  function qualifiedFullProfile() {
    return {
      profileDepth: 'full',
      maxVerifiedContext: 262144,
      recommendedInteractiveContext: 65536,
      recommendedDocumentContext: 131072,
      requiredRetainedSamples: 10,
      measurementQuality: { passingSampleCount: 10, reliability: 'medium' },
      ttftMs: 200,
      ttftMeasurement: 'streamed_wall_clock',
      throughputCurve: [10, 25, 50, 75, 90].map(contextFillPct => ({
        contextFillPct,
        tokensPerSec: 40,
        gpuOffloaded: false
      })),
      generationStability: [64, 256, 512].map(numPredict => ({
        numPredict,
        tokensPerSec: 40,
        totalLatencyMs: 1000
      })),
      prefillDecodeMatrix: {
        prefillTokens: [512],
        decodeTokens: [64],
        cellCount: 1,
        passCount: 1,
        skippedCount: 0,
        cells: [{
          status: 'pass',
          requestedPromptTokens: 512,
          promptTokens: 500,
          promptCoveragePct: 97.7,
          minimumPromptCoveragePct: 80
        }]
      },
      loadTiming: { coldLoadMs: 5000, hotLoadMs: 100 }
    };
  }

  it('requires medium or high reliability', () => {
    const profile = qualifiedFullProfile();
    profile.measurementQuality.reliability = 'low';
    expect(orchestrator.profileQualificationFailures(profile)).toContain('reliability_low');
  });

  it.each([
    ['throughput curve', profile => { profile.throughputCurve[2].tokensPerSec = 0; }, 'full_throughput_curve_incomplete'],
    ['throughput curve coverage', profile => { profile.throughputCurve[4].contextFillPct = 75; }, 'full_throughput_curve_incomplete'],
    ['stability', profile => { profile.generationStability[1].totalLatencyMs = 0; }, 'full_generation_stability_incomplete'],
    ['stability coverage', profile => { profile.generationStability[2].numPredict = 256; }, 'full_generation_stability_incomplete'],
    ['prefill/decode matrix', profile => { profile.prefillDecodeMatrix.cells[0].status = 'error'; }, 'full_prefill_decode_matrix_incomplete'],
    ['skipped matrix cell', profile => {
      profile.prefillDecodeMatrix.cells[0].status = 'skipped';
      profile.prefillDecodeMatrix.passCount = 0;
      profile.prefillDecodeMatrix.skippedCount = 1;
    }, 'full_prefill_decode_matrix_incomplete'],
    ['underfilled matrix prompt', profile => { profile.prefillDecodeMatrix.cells[0].promptCoveragePct = 40; }, 'full_prefill_decode_matrix_incomplete'],
    ['load timing', profile => { profile.loadTiming.hotLoadMs = null; }, 'full_load_timing_incomplete']
  ])('fails Full qualification when %s is incomplete', (_label, breakPhase, reason) => {
    const profile = qualifiedFullProfile();
    breakPhase(profile);
    expect(orchestrator.profileQualificationFailures(profile)).toContain(reason);
  });

  it('qualifies only when every Full phase has positive complete evidence', () => {
    expect(orchestrator.profileQualificationFailures(qualifiedFullProfile())).toEqual([]);
  });

  it('never qualifies workload recommendations above the verified capacity ceiling', () => {
    const profile = qualifiedFullProfile();
    profile.recommendedInteractiveContext = 524288;
    profile.recommendedDocumentContext = 524288;
    expect(orchestrator.profileQualificationFailures(profile)).toEqual(expect.arrayContaining([
      'interactive_context_exceeds_verified_max',
      'document_context_exceeds_verified_max'
    ]));
  });
});

describe('throughput statistics', () => {
  it('excludes discarded samples and uses Student-t for small samples', () => {
    const summary = orchestrator.summarizeThroughputSamples([
      { discarded: true, status: 'pass', tokensPerSec: 1000 },
      { status: 'pass', tokensPerSec: 10, ttftMs: 100, ttftMeasurement: 'streamed_wall_clock' },
      { status: 'pass', tokensPerSec: 12, ttftMs: 120, ttftMeasurement: 'streamed_wall_clock' },
      { status: 'pass', tokensPerSec: 11, ttftMs: 110, ttftMeasurement: 'streamed_wall_clock' },
      { status: 'pass', tokensPerSec: 13, ttftMs: 130, ttftMeasurement: 'streamed_wall_clock' },
      { status: 'pass', tokensPerSec: 14, ttftMs: 140, ttftMeasurement: 'streamed_wall_clock' }
    ], { minimumRetainedSamples: 5 });

    expect(summary).toMatchObject({
      sampleCount: 5,
      retainedSampleCount: 5,
      passingSampleCount: 5,
      tokensPerSecMean: 12,
      p50: 12,
      p95: 13.8,
      ttftP50Ms: 120,
      confidenceInterval95: { method: 'student_t' }
    });
    expect(summary.tokensPerSecMax).toBe(14);
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
