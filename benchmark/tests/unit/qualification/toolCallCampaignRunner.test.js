'use strict';

const {
  CONFIRMATION_TOKEN,
  runToolCapabilityCampaign
} = require('../../../src/services/qualification/toolCallCampaignRunner');

function report(classification = 'ok', pass = classification === 'ok') {
  const fixtures = require('../../../src/services/qualification/toolCallFixtures');
  return {
    harnessVersion: fixtures.HARNESS_VERSION,
    fixtureVersion: fixtures.FIXTURE_VERSION,
    fixtureFingerprint: fixtures.fixtureFingerprint(),
    toolCallOutcomes: {
      scenarios: [{ scenarioId: 's1', classification, pass }],
      reliability: { passed: pass ? 1 : 0, graded: classification.includes('unsupported') ? 0 : 1, ratio: pass ? 1 : 0 },
      classificationCounts: { [classification]: 1 }
    }
  };
}

function frozenCampaign() {
  return {
    candidates: [{
      model: 'owner/model:8b',
      host: 'http://host-a:11434',
      artifactDigest: 'sha256:a',
      contractFingerprint: 'a'.repeat(64),
      mode: { think: false },
      execution: {
        num_ctx: 32768,
        num_predict: 1024,
        sampling: { temperature: 0, seed: 42 }
      },
      contract: {
        artifact: {
          model: 'owner/model:8b',
          host: 'http://host-a:11434',
          hostId: 'host-a',
          digest: 'sha256:a',
          runtimeFingerprint: 'runtime-a'
        }
      }
    }]
  };
}

function options(overrides = {}) {
  return {
    model: 'owner/model:8b',
    host: 'http://host-a:11434',
    repetitions: 3,
    confirmation: CONFIRMATION_TOKEN,
    campaignId: 'toolcall-campaign-a',
    transport: jest.fn(),
    ...overrides
  };
}

function dependencies(overrides = {}) {
  const claim = {
    claimed: true,
    claimGeneration: '11111111-1111-4111-8111-111111111111',
    pref: {
      hostUrl: 'http://host-a:11434',
      benchmarkClaim: {
        batchId: 'toolcall-campaign-a',
        claimGeneration: '11111111-1111-4111-8111-111111111111',
        claimedAt: '2026-09-04T00:00:00Z'
      }
    }
  };
  const workload = {
    signal: new AbortController().signal,
    assertActive: jest.fn(),
    complete: jest.fn(async () => ({ released: true })),
    retainForRecovery: jest.fn(async () => ({ retained: true }))
  };
  return {
    connectDB: jest.fn(async () => {}),
    disconnectDB: jest.fn(async () => {}),
    beginManagedWorkload: jest.fn(async () => workload),
    getDedicationStatuses: jest.fn(async () => [{
      host: 'http://host-a:11434',
      pinnedModels: ['resident/model:8b'],
      state: 'ready',
      live: { defaultLoaded: true }
    }]),
    claimHostForBenchmark: jest.fn(async () => claim),
    getBenchmarkClaims: jest.fn(async () => [{
      hostUrl: 'http://host-a:11434',
      batchId: 'toolcall-campaign-a',
      claimGeneration: '11111111-1111-4111-8111-111111111111'
    }]),
    heartbeatBenchmarkClaim: jest.fn(async () => ({ heartbeat: true })),
    releaseBenchmarkClaim: jest.fn(async () => ({ released: true })),
    resolveStandaloneCampaignInferenceContracts: jest.fn(async () => frozenCampaign()),
    assertFrozenArtifactDigest: jest.fn(async () => 'sha256:a'),
    resolveArtifactIdentity: jest.fn(async () => ({
      model: 'owner/model:8b',
      hostId: 'host-a',
      hostUrl: 'http://host-a:11434',
      digest: 'sha256:a',
      runtimeFingerprint: 'runtime-a',
      registryQualified: true
    })),
    runHarness: jest.fn(async (transport) => {
      await transport({ messages: [], tools: [] });
      return report();
    }),
    beginQualification: jest.fn(async () => ({ runState: 'running' })),
    recordRepetition: jest.fn(async () => ({ runState: 'running' })),
    finalizeQualification: jest.fn(async (_campaignId, _identity, input) => ({
      runState: 'finalized',
      outcome: input.interrupted ? 'interrupted' : 'supported'
    })),
    ...overrides
  };
}

describe('toolCallCampaignRunner', () => {
  it('refuses live work without the exact disruption token before any dependency call', async () => {
    const deps = dependencies();
    await expect(runToolCapabilityCampaign(options({ confirmation: true }), deps))
      .rejects.toMatchObject({ code: 'TOOL_CAMPAIGN_CONFIRMATION_REQUIRED' });
    expect(deps.connectDB).not.toHaveBeenCalled();
    expect(deps.claimHostForBenchmark).not.toHaveBeenCalled();
  });

  it('refuses a partial live fixture before any dependency call', async () => {
    const deps = dependencies();
    await expect(runToolCapabilityCampaign(options({ scenarios: ['s1_selection_basic'] }), deps))
      .rejects.toMatchObject({ code: 'TOOL_CAMPAIGN_FULL_FIXTURE_REQUIRED' });
    expect(deps.connectDB).not.toHaveBeenCalled();
    expect(deps.claimHostForBenchmark).not.toHaveBeenCalled();
  });

  it('freezes one exact artifact, repeats, heartbeats, persists, releases, and verifies pins', async () => {
    const deps = dependencies();
    const campaignOptions = options();
    const result = await runToolCapabilityCampaign(campaignOptions, deps);

    expect(result).toMatchObject({
      campaignId: 'toolcall-campaign-a',
      repetitionsRequested: 3,
      repetitionsCompleted: 3,
      identity: {
        modelName: 'owner/model:8b',
        hostId: 'host-a',
        artifactDigest: 'sha256:a',
        runtimeFingerprint: 'runtime-a'
      },
      qualification: { outcome: 'supported' }
    });
    expect(deps.runHarness).toHaveBeenCalledTimes(3);
    expect(deps.beginManagedWorkload).toHaveBeenCalledWith(
      'toolcall-campaign-a',
      expect.objectContaining({
        kind: 'tool-capability-qualification',
        batchId: 'toolcall-campaign-a',
        hosts: ['http://host-a:11434']
      })
    );
    expect(campaignOptions.transport).toHaveBeenCalledWith(expect.objectContaining({
      execution: {
        numCtx: 32768,
        numPredict: 1024,
        think: false,
        sampling: { temperature: 0, seed: 42 }
      }
    }));
    expect(deps.recordRepetition).toHaveBeenCalledTimes(3);
    expect(deps.assertFrozenArtifactDigest).toHaveBeenCalledTimes(2);
    expect(deps.resolveArtifactIdentity).toHaveBeenCalledTimes(2);
    expect(deps.getBenchmarkClaims.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(deps.heartbeatBenchmarkClaim).toHaveBeenCalled();
    expect(deps.releaseBenchmarkClaim).toHaveBeenCalledWith(
      'http://host-a:11434',
      'toolcall-campaign-a'
    );
    expect(deps.getDedicationStatuses).toHaveBeenCalledTimes(2);
    expect(deps.finalizeQualification).toHaveBeenCalledWith(
      'toolcall-campaign-a',
      expect.any(Object),
      expect.objectContaining({ interrupted: false, failureCode: null })
    );
    expect(deps.disconnectDB).toHaveBeenCalled();
    const workload = await deps.beginManagedWorkload.mock.results[0].value;
    expect(workload.complete).toHaveBeenCalledTimes(1);
    expect(workload.retainForRecovery).not.toHaveBeenCalled();
  });

  it('marks a started campaign interrupted and releases its exact claim after a run error', async () => {
    const failure = Object.assign(new Error('transport stopped'), { code: 'TRANSPORT_STOPPED' });
    const deps = dependencies({ runHarness: jest.fn(async () => { throw failure; }) });

    await expect(runToolCapabilityCampaign(options(), deps)).rejects.toBe(failure);
    expect(deps.releaseBenchmarkClaim).toHaveBeenCalledTimes(1);
    const workload = await deps.beginManagedWorkload.mock.results[0].value;
    expect(workload.retainForRecovery).toHaveBeenCalledWith(failure);
    expect(workload.complete).not.toHaveBeenCalled();
    expect(deps.finalizeQualification).toHaveBeenCalledWith(
      'toolcall-campaign-a',
      expect.any(Object),
      { interrupted: true, failureCode: 'TRANSPORT_STOPPED' }
    );
    expect(deps.disconnectDB).toHaveBeenCalledTimes(1);
  });

  it('fails closed when the claim heartbeat loses ownership', async () => {
    const deps = dependencies({
      heartbeatBenchmarkClaim: jest.fn(async () => ({ heartbeat: false, reason: 'generation replaced' }))
    });

    await expect(runToolCapabilityCampaign(options(), deps))
      .rejects.toMatchObject({ code: 'TOOL_CAMPAIGN_CLAIM_LOST' });
    expect(deps.resolveStandaloneCampaignInferenceContracts).not.toHaveBeenCalled();
    expect(deps.releaseBenchmarkClaim).toHaveBeenCalledTimes(1);
  });

  it('turns post-release pin or residency drift into interrupted evidence', async () => {
    const getDedicationStatuses = jest.fn()
      .mockResolvedValueOnce([{
        host: 'http://host-a:11434',
        pinnedModels: ['resident/model:8b'],
        state: 'ready',
        live: { defaultLoaded: true }
      }])
      .mockResolvedValueOnce([{
        host: 'http://host-a:11434',
        pinnedModels: ['other/model:8b'],
        state: 'ready',
        live: { defaultLoaded: true }
      }]);
    const deps = dependencies({ getDedicationStatuses });

    await expect(runToolCapabilityCampaign(options(), deps))
      .rejects.toMatchObject({ code: 'TOOL_CAMPAIGN_PIN_DRIFT' });
    expect(deps.finalizeQualification).toHaveBeenCalledWith(
      'toolcall-campaign-a',
      expect.any(Object),
      expect.objectContaining({ interrupted: true, failureCode: 'TOOL_CAMPAIGN_PIN_DRIFT' })
    );
  });

  it('turns post-campaign runtime identity drift into interrupted evidence', async () => {
    const resolveArtifactIdentity = jest.fn()
      .mockResolvedValueOnce({
        model: 'owner/model:8b',
        hostId: 'host-a',
        hostUrl: 'http://host-a:11434',
        digest: 'sha256:a',
        runtimeFingerprint: 'runtime-a',
        registryQualified: true
      })
      .mockResolvedValueOnce({
        model: 'owner/model:8b',
        hostId: 'host-a',
        hostUrl: 'http://host-a:11434',
        digest: 'sha256:a',
        runtimeFingerprint: 'runtime-b',
        registryQualified: true
      });
    const deps = dependencies({ resolveArtifactIdentity });

    await expect(runToolCapabilityCampaign(options(), deps))
      .rejects.toMatchObject({ code: 'TOOL_CAMPAIGN_RUNTIME_IDENTITY_DRIFT' });
    expect(deps.releaseBenchmarkClaim).toHaveBeenCalledTimes(1);
    expect(deps.finalizeQualification).toHaveBeenCalledWith(
      'toolcall-campaign-a',
      expect.any(Object),
      expect.objectContaining({
        interrupted: true,
        failureCode: 'TOOL_CAMPAIGN_RUNTIME_IDENTITY_DRIFT'
      })
    );
  });
});
