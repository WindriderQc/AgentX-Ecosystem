'use strict';

const logger = require('../../config/logger');
const hostPrefService = require('./hostPreferenceService');
const sessionHoldService = require('./hostSessionHoldService');

function isBenchmarkCaller(callerDetail) {
  return typeof callerDetail === 'string'
    && (/^benchmark-/.test(callerDetail) || /^profiler-/.test(callerDetail));
}

function buildBenchmarkClaimError(hostUrl, claim, messagePrefix = 'Ollama host is held by an active benchmark claim') {
  const batchId = claim?.batchId || null;
  const err = new Error(batchId ? `${messagePrefix}: ${hostUrl} (${batchId})` : `${messagePrefix}: ${hostUrl}`);
  err.statusCode = 503;
  err.code = 'BENCHMARK_CLAIM_ACTIVE';
  err.hostUrl = hostUrl;
  err.batchId = batchId;
  return err;
}

async function getActiveBenchmarkClaim(hostUrl) {
  if (!hostUrl) return null;
  const pref = await hostPrefService.getByHost(hostUrl);
  return hostPrefService.hasActiveBenchmarkClaim(pref) ? (pref.benchmarkClaim || {}) : null;
}

async function claimWorkloadAdmissionIsActive(hostUrl, claim) {
  if (!claim?.admissionId || !claim?.admissionGeneration || !claim?.admissionPrincipal) return false;
  const runtimeCoordinationService = require('./runtimeCoordinationService');
  const admission = await runtimeCoordinationService.assertWorkloadAdmission({
    id: claim.admissionId,
    generation: claim.admissionGeneration,
    principal: claim.admissionPrincipal,
    workloadId: claim.batchId,
    host: hostUrl
  });
  return admission?.admitted === true;
}

async function assertHostAvailableForConsumer(hostUrl, {
  callerDetail = null,
  claimBatchId = null,
  claimGeneration = null,
  workloadAdmissionId = null,
  workloadGeneration = null,
  model = null,
  path = null,
  allowBenchmarkCallers = true,
  benchmarkAuthorized = false
} = {}) {
  // One preference read answers both questions. A session hold refuses every
  // model except the held one. It cannot coexist with a benchmark claim (each
  // acquisition refuses the other), so checking it first never hides a claim
  // from a proof-bearing benchmark caller.
  const pref = hostUrl ? await hostPrefService.getByHost(hostUrl) : null;
  const hold = sessionHoldService.activeSessionHold(pref);
  if (hold && sessionHoldService.holdBlocksModel(hold, model)) {
    logger.info('[session-hold-guard] blocked consumer inference on held host', {
      hostUrl,
      model,
      path,
      callerDetail,
      holdOwner: hold.owner || null,
      holdModel: hold.model || null,
      holdExpiresAt: hold.expiresAt || null
    });
    throw sessionHoldService.buildSessionHoldError(hostUrl, hold);
  }

  const claim = hostPrefService.hasActiveBenchmarkClaim(pref) ? (pref.benchmarkClaim || {}) : null;
  if (!claim) {
    // A caller-supplied prefix is telemetry, never authority. Supplying stale
    // claim proof is also an error: the mutator must reacquire before swapping.
    if (claimBatchId || claimGeneration) {
      const err = buildBenchmarkClaimError(hostUrl, null, 'Benchmark claim proof is stale or inactive');
      err.code = 'BENCHMARK_CLAIM_PROOF_INVALID';
      throw err;
    }
    return null;
  }

  const proofShapeMatches = allowBenchmarkCallers
    && benchmarkAuthorized === true
    && typeof claimBatchId === 'string'
    && typeof claimGeneration === 'string'
    && claimBatchId === claim.batchId
    && claimGeneration === claim.claimGeneration
    && typeof workloadAdmissionId === 'string'
    && typeof workloadGeneration === 'string'
    && workloadAdmissionId === claim.admissionId
    && workloadGeneration === claim.admissionGeneration;
  const admissionActive = proofShapeMatches
    ? await claimWorkloadAdmissionIsActive(hostUrl, claim)
    : false;
  const hasExactProof = proofShapeMatches && admissionActive;
  if (hasExactProof) return claim;

  logger.info('[benchmark-claim-guard] blocked consumer inference on claimed host', {
    hostUrl,
    model,
    path,
    callerDetail,
    batchId: claim.batchId || null,
    suppliedBatchId: claimBatchId || null
  });

  throw buildBenchmarkClaimError(hostUrl, claim);
}

module.exports = {
  assertHostAvailableForConsumer,
  buildBenchmarkClaimError,
  getActiveBenchmarkClaim,
  isBenchmarkCaller
};
