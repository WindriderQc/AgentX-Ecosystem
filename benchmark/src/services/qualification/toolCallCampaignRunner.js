'use strict';

const crypto = require('crypto');
const mongoose = require('mongoose');
const connectDB = require('../../../config/db');
const {
  claimHostForBenchmark,
  getBenchmarkClaims,
  getDedicationStatuses,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim
} = require('../../clients/coreApiClient');
const {
  assertFrozenArtifactDigest,
  resolveStandaloneCampaignInferenceContracts
} = require('../benchmark/inferenceContractSnapshot');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const { normalizeHostUrl } = require('../../../../shared/artifactIdentity');
const { runHarness } = require('./toolCallHarness');
const qualificationStore = require('./toolCapabilityQualificationService');
const {
  identitiesMatch: artifactIdentitiesMatch,
  resolveArtifactIdentity
} = require('../profiler/artifactIdentityService');
const { beginManagedWorkload } = require('../benchmark/workloadAdmissionLifecycle');

const CONFIRMATION_TOKEN = 'RUN_NATIVE_TOOL_QUALIFICATION';
const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

class ToolCampaignError extends Error {
  constructor(message, code = 'TOOL_CAMPAIGN_REFUSED') {
    super(message);
    this.name = 'ToolCampaignError';
    this.code = code;
  }
}

function requireCampaignInput(options = {}) {
  if (options.confirmation !== CONFIRMATION_TOKEN) {
    throw new ToolCampaignError(
      `live campaign requires --confirm-campaign ${CONFIRMATION_TOKEN}`,
      'TOOL_CAMPAIGN_CONFIRMATION_REQUIRED'
    );
  }
  const model = normalizeModelTag(options.model);
  const host = normalizeHostUrl(options.host);
  const repetitions = Number(options.repetitions);
  if (!model || !host) {
    throw new ToolCampaignError('an exact --model and --host are required');
  }
  if (!Number.isInteger(repetitions)
    || repetitions < qualificationStore.MIN_REPETITIONS
    || repetitions > qualificationStore.MAX_REPETITIONS) {
    throw new ToolCampaignError(
      `--repetitions must be ${qualificationStore.MIN_REPETITIONS}-${qualificationStore.MAX_REPETITIONS}`,
      'TOOL_CAMPAIGN_REPETITIONS_REQUIRED'
    );
  }
  if (options.scenarios != null) {
    throw new ToolCampaignError(
      'live qualification must run the complete canonical fixture; scenario filters are dry-run only',
      'TOOL_CAMPAIGN_FULL_FIXTURE_REQUIRED'
    );
  }
  return { model, host, repetitions };
}

function pinnedModelNames(status) {
  return (Array.isArray(status?.pinnedModels) ? status.pinnedModels : [])
    .map((entry) => normalizeModelTag(typeof entry === 'string' ? entry : entry?.model))
    .filter(Boolean)
    .sort();
}

async function captureHostGuard(host, deps) {
  const statuses = await deps.getDedicationStatuses();
  const status = (statuses || []).find((entry) =>
    normalizeHostUrl(entry?.hostUrl || entry?.host) === host
  );
  if (!status) {
    throw new ToolCampaignError(
      `Core has no host-preference evidence for ${host}`,
      'TOOL_CAMPAIGN_HOST_EVIDENCE_MISSING'
    );
  }
  return {
    hostUrl: host,
    pinnedModels: pinnedModelNames(status),
    state: status.state || null,
    defaultLoaded: status.live?.defaultLoaded ?? null,
    observedAt: new Date().toISOString()
  };
}

function assertHostGuardRestored(before, after) {
  if (JSON.stringify(before?.pinnedModels || []) !== JSON.stringify(after?.pinnedModels || [])) {
    throw new ToolCampaignError(
      'Core default-model pins changed during the tool qualification campaign',
      'TOOL_CAMPAIGN_PIN_DRIFT'
    );
  }
  if (before?.defaultLoaded === true && after?.defaultLoaded !== true) {
    throw new ToolCampaignError(
      'a previously resident default model was not restored after the campaign claim',
      'TOOL_CAMPAIGN_RESIDENCY_NOT_RESTORED'
    );
  }
}

function normalizeClaimReceipt(result, batchId, host) {
  const claim = result?.pref?.benchmarkClaim || result?.benchmarkClaim || result || {};
  const receipt = {
    batchId: claim.batchId || result?.batchId || batchId,
    claimGeneration: claim.claimGeneration || result?.claimGeneration || null,
    hostUrl: normalizeHostUrl(result?.pref?.hostUrl || host),
    claimedAt: claim.claimedAt || null
  };
  if (result?.claimed !== true
    || receipt.batchId !== batchId
    || receipt.hostUrl !== host
    || !receipt.claimGeneration) {
    throw new ToolCampaignError(
      'Core claim receipt does not attest the requested batch, generation, and host',
      'TOOL_CAMPAIGN_CLAIM_RECEIPT_INVALID'
    );
  }
  return receipt;
}

async function assertActiveClaim(receipt, deps) {
  const claims = await deps.getBenchmarkClaims();
  const active = (claims || []).find((entry) =>
    normalizeHostUrl(entry?.hostUrl || entry?.host) === receipt.hostUrl
    && entry?.batchId === receipt.batchId
  );
  if (!active || active.claimGeneration !== receipt.claimGeneration) {
    throw new ToolCampaignError(
      'the exact Benchmark claim is not active or no longer belongs to this campaign',
      'TOOL_CAMPAIGN_CLAIM_LOST'
    );
  }
  return active;
}

function startGuardedHeartbeat(receipt, estimatedDurationMs, deps, options = {}) {
  const intervalMs = Number(options.intervalMs) > 0
    ? Number(options.intervalMs)
    : DEFAULT_HEARTBEAT_INTERVAL_MS;
  let stopped = false;
  let running = false;
  let failure = null;
  let inFlight = Promise.resolve();

  const beat = () => {
    if (stopped || running) return inFlight;
    running = true;
    inFlight = (async () => {
      try {
        const result = await deps.heartbeatBenchmarkClaim(
          receipt.hostUrl,
          receipt.batchId,
          estimatedDurationMs
        );
        if (result?.heartbeat !== true) {
          throw new ToolCampaignError(
            result?.reason || 'Core rejected the claim heartbeat',
            'TOOL_CAMPAIGN_CLAIM_LOST'
          );
        }
      } catch (error) {
        failure = failure || error;
      } finally {
        running = false;
      }
    })();
    return inFlight;
  };

  const ready = beat();
  const interval = setInterval(beat, intervalMs);
  if (typeof interval.unref === 'function') interval.unref();
  return {
    ready,
    assertActive() {
      if (failure) throw failure;
      if (stopped) throw new ToolCampaignError('claim heartbeat is stopped', 'TOOL_CAMPAIGN_CLAIM_LOST');
    },
    async stop() {
      stopped = true;
      clearInterval(interval);
      await inFlight;
    }
  };
}

function exactIdentityFromCandidate(candidate) {
  const artifact = candidate?.contract?.artifact || {};
  const contract = qualificationStore.currentEvidenceContract();
  const identity = {
    modelName: artifact.model || candidate?.model,
    hostUrl: artifact.host || candidate?.host,
    hostId: artifact.hostId,
    artifactDigest: artifact.digest || candidate?.artifactDigest,
    runtimeFingerprint: artifact.runtimeFingerprint,
    protocolVersion: contract.protocolVersion,
    fixtureVersion: contract.fixtureVersion,
    fixtureFingerprint: contract.fixtureFingerprint
  };
  return qualificationStore.normalizeIdentity(identity);
}

async function assertCurrentArtifactIdentity(identity, deps) {
  const current = await deps.resolveArtifactIdentity(
    identity.modelName,
    identity.hostId,
    identity.hostUrl,
    { refresh: true }
  );
  const frozen = {
    model: identity.modelName,
    hostId: identity.hostId,
    hostUrl: identity.hostUrl,
    digest: identity.artifactDigest,
    runtimeFingerprint: identity.runtimeFingerprint
  };
  if (!artifactIdentitiesMatch(frozen, current)) {
    throw new ToolCampaignError(
      'deployed artifact identity or runtime changed after the Core contract was frozen',
      'TOOL_CAMPAIGN_RUNTIME_IDENTITY_DRIFT'
    );
  }
  return current;
}

function defaultDependencies(overrides = {}) {
  return {
    connectDB,
    disconnectDB: () => mongoose.disconnect(),
    claimHostForBenchmark,
    getBenchmarkClaims,
    getDedicationStatuses,
    heartbeatBenchmarkClaim,
    releaseBenchmarkClaim,
    resolveStandaloneCampaignInferenceContracts,
    assertFrozenArtifactDigest,
    resolveArtifactIdentity,
    runHarness,
    beginManagedWorkload,
    beginQualification: qualificationStore.beginQualification,
    recordRepetition: qualificationStore.recordRepetition,
    finalizeQualification: qualificationStore.finalizeQualification,
    ...overrides
  };
}

async function runToolCapabilityCampaign(options = {}, overrides = {}) {
  const { model, host, repetitions } = requireCampaignInput(options);
  if (typeof options.transport !== 'function') {
    throw new ToolCampaignError('a live model transport is required', 'TOOL_CAMPAIGN_TRANSPORT_REQUIRED');
  }
  const deps = defaultDependencies(overrides);
  const campaignId = String(options.campaignId || `toolcall-${Date.now()}-${crypto.randomUUID()}`);
  const estimatedDurationMs = Math.min(2 * 60 * 60 * 1000, Math.max(10 * 60 * 1000, repetitions * 10 * 60 * 1000));
  let connected = false;
  let claimReceipt = null;
  let workload = null;
  let heartbeat = null;
  let identity = null;
  let persistenceStarted = false;
  let failure = null;
  let releaseReceipt = null;
  let pinBefore = null;
  let pinAfter = null;
  let qualification = null;
  let frozenCampaign = null;
  const reports = [];

  try {
    await deps.connectDB();
    connected = true;
    pinBefore = await captureHostGuard(host, deps);
    workload = await deps.beginManagedWorkload(campaignId, {
      requestId: `tool-capability:${campaignId}`,
      kind: 'tool-capability-qualification',
      batchId: campaignId,
      hosts: [host],
      ttlMs: estimatedDurationMs
    });
    workload.assertActive();
    const claimResult = await deps.claimHostForBenchmark(host, campaignId, estimatedDurationMs, {
      source: 'tool-capability-qualification',
      owner: 'agentx-benchmark',
      note: 'mocked tools only',
      heartbeatTtlMs: DEFAULT_HEARTBEAT_INTERVAL_MS * 4
    });
    claimReceipt = normalizeClaimReceipt(claimResult, campaignId, host);
    await assertActiveClaim(claimReceipt, deps);
    heartbeat = startGuardedHeartbeat(claimReceipt, estimatedDurationMs, deps, {
      intervalMs: options.heartbeatIntervalMs
    });
    await heartbeat.ready;
    heartbeat.assertActive();

    frozenCampaign = await deps.resolveStandaloneCampaignInferenceContracts({
      hostGroups: new Map([[host, [model]]]),
      executionConfig: {
        response_mode: 'final_only',
        repeats: repetitions,
        sampling_profile: 'controlled',
        sampling_source: 'tool_capability_qualification'
      }
    });
    if (!Array.isArray(frozenCampaign?.candidates) || frozenCampaign.candidates.length !== 1) {
      throw new ToolCampaignError('Core did not freeze exactly one artifact', 'TOOL_CAMPAIGN_FREEZE_INVALID');
    }
    const candidate = frozenCampaign.candidates[0];
    identity = exactIdentityFromCandidate(candidate);
    const frozenExecution = {
      numCtx: candidate.execution?.num_ctx,
      numPredict: candidate.execution?.num_predict,
      think: candidate.mode?.think === true,
      sampling: candidate.execution?.sampling || {}
    };
    await deps.assertFrozenArtifactDigest(frozenCampaign, model, host);
    await assertCurrentArtifactIdentity(identity, deps);
    await assertActiveClaim(claimReceipt, deps);

    await deps.beginQualification({
      campaignId,
      ...identity,
      repetitionsRequested: repetitions,
      contractFingerprint: candidate.contractFingerprint,
      claim: claimReceipt
    });
    persistenceStarted = true;

    for (let index = 0; index < repetitions; index += 1) {
      heartbeat.assertActive();
      await assertActiveClaim(claimReceipt, deps);
      // The same frozen contract and exact mocked toolbox are reused for every
      // repetition. Production tools are never inputs to runHarness.
      // eslint-disable-next-line no-await-in-loop
      const frozenTransport = (input) => options.transport({
        ...input,
        execution: frozenExecution,
        signal: workload.signal,
        workloadId: campaignId
      });
      const report = await deps.runHarness(frozenTransport, {
        artifact: {
          model: identity.modelName,
          digest: identity.artifactDigest,
          host: identity.hostUrl,
          hostId: identity.hostId,
          runtimeFingerprint: identity.runtimeFingerprint
        },
        contractSnapshot: candidate.contract,
        scenarios: undefined
      });
      reports.push(report);
      // eslint-disable-next-line no-await-in-loop
      await deps.recordRepetition(campaignId, identity, report);
    }

  } catch (error) {
    failure = error;
  } finally {
    // Final evidence is written while both the exact host claim and the global
    // workload admission are still live. Re-resolve the runtime immediately
    // before the CAS so a tag/restart race can only finalize as interrupted.
    if (persistenceStarted && identity) {
      try {
        heartbeat?.assertActive();
        await assertActiveClaim(claimReceipt, deps);
        await deps.assertFrozenArtifactDigest(frozenCampaign, model, host);
        await assertCurrentArtifactIdentity(identity, deps);
      } catch (error) {
        failure = failure || error;
      }
      try {
        qualification = await deps.finalizeQualification(campaignId, identity, {
          interrupted: Boolean(failure),
          failureCode: failure?.code || (failure ? 'TOOL_CAMPAIGN_FAILED' : null)
        });
      } catch (error) {
        if (failure) failure.finalizationError = error;
        else failure = error;
      }
    }
    if (heartbeat) {
      try {
        await heartbeat.stop();
      } catch (error) {
        failure = failure || error;
      }
    }
    if (claimReceipt) {
      try {
        releaseReceipt = await deps.releaseBenchmarkClaim(host, campaignId);
        if (releaseReceipt?.released !== true) {
          throw new ToolCampaignError(
            releaseReceipt?.reason || 'Core refused the exact claim release',
            'TOOL_CAMPAIGN_RELEASE_FAILED'
          );
        }
        pinAfter = await captureHostGuard(host, deps);
        assertHostGuardRestored(pinBefore, pinAfter);
      } catch (error) {
        failure = failure || error;
      }
    }
    if (workload) {
      try {
        if (failure) await workload.retainForRecovery(failure);
        else await workload.complete();
      } catch (error) {
        failure = failure || error;
      }
    }
    if (connected) {
      try {
        await deps.disconnectDB();
      } catch (error) {
        failure = failure || error;
      }
    }
  }

  if (failure) throw failure;
  return {
    campaignId,
    identity,
    repetitionsRequested: repetitions,
    repetitionsCompleted: reports.length,
    claim: claimReceipt,
    release: releaseReceipt,
    hostGuard: { before: pinBefore, after: pinAfter },
    qualification,
    reports
  };
}

module.exports = {
  CONFIRMATION_TOKEN,
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  ToolCampaignError,
  assertActiveClaim,
  assertCurrentArtifactIdentity,
  assertHostGuardRestored,
  captureHostGuard,
  exactIdentityFromCandidate,
  normalizeClaimReceipt,
  requireCampaignInput,
  runToolCapabilityCampaign,
  startGuardedHeartbeat
};
