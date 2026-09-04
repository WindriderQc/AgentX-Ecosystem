'use strict';

const logger = require('../../config/logger');
const hostPrefService = require('./hostPreferenceService');

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

async function assertHostAvailableForConsumer(hostUrl, {
  callerDetail = null,
  claimBatchId = null,
  claimGeneration = null,
  model = null,
  path = null,
  allowBenchmarkCallers = true,
  benchmarkAuthorized = false
} = {}) {
  const claim = await getActiveBenchmarkClaim(hostUrl);
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

  const hasExactProof = allowBenchmarkCallers
    && benchmarkAuthorized === true
    && typeof claimBatchId === 'string'
    && typeof claimGeneration === 'string'
    && claimBatchId === claim.batchId
    && claimGeneration === claim.claimGeneration;
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
