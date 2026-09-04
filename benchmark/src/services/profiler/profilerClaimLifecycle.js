'use strict';

const {
  acquireBenchmarkClaims,
  releaseBenchmarkClaims,
  startBenchmarkClaimHeartbeat
} = require('../benchmark/benchmarkClaimLifecycle');
const { getBenchmarkClaimIdentity } = require('../../clients/coreApiClient');
const { releaseWorkloadAdmission } = require('../../clients/coreApiClient');

async function acquireProfilerClaimLease(hostUrls, operationId, estimatedDurationMs, options = {}) {
  const uniqueHosts = [...new Set((hostUrls || []).filter(Boolean))];
  if (!uniqueHosts.length) {
    const err = new Error('Profiler claim requires at least one host');
    err.statusCode = 400;
    throw err;
  }

  let claimed;
  try {
    claimed = await acquireBenchmarkClaims(uniqueHosts, operationId, estimatedDurationMs, {
      source: 'profiler',
      owner: 'agentx-profiler'
    });
  } catch (cause) {
    const err = new Error(`Profiler cannot reserve its target host(s): ${cause.message}`);
    err.code = 'PROFILER_CLAIM_UNAVAILABLE';
    err.statusCode = cause?.cause?.status === 409 ? 409 : 503;
    err.cause = cause;
    throw err;
  }

  const leaseAbort = new AbortController();
  const heartbeat = startBenchmarkClaimHeartbeat(claimed, operationId, estimatedDurationMs, {
    intervalMs: options.heartbeatIntervalMs,
    onFatal: error => {
      if (!leaseAbort.signal.aborted) leaseAbort.abort(error);
      options.onFatal?.(error);
    },
    source: 'profiler',
    owner: 'agentx-profiler'
  });
  await heartbeat.ready;
  try {
    heartbeat.assertActive();
  } catch (err) {
    await heartbeat.drain();
    await releaseBenchmarkClaims(claimed, operationId);
    err.statusCode = 503;
    throw err;
  }

  let releasePromise = null;
  return {
    operationId,
    hostUrls: claimed,
    signal: leaseAbort.signal,
    assertActive: heartbeat.assertActive,
    get lost() { return Boolean(heartbeat.getFailure()); },
    identityFor(hostUrl) {
      const identity = getBenchmarkClaimIdentity(hostUrl, operationId);
      if (!identity) {
        const err = new Error(`Missing claim generation for ${hostUrl}`);
        err.code = 'PROFILER_CLAIM_IDENTITY_MISSING';
        throw err;
      }
      return identity;
    },
    async release(options = {}) {
      if (!releasePromise) {
        releasePromise = (async () => {
          if (typeof heartbeat.drainHosts === 'function') await heartbeat.drainHosts();
          const result = await releaseBenchmarkClaims(claimed, operationId, {
            ...options,
            releaseWorkloadAdmission: false
          });
          await heartbeat.drain();
          if (result.failed === 0) {
            result.workloadAdmission = await releaseWorkloadAdmission(operationId);
            if (result.workloadAdmission?.released !== true) result.failed += 1;
          } else {
            result.workloadAdmission = {
              released: false,
              reason: 'held because fenced host restoration failed'
            };
          }
          return result;
        })();
      }
      return releasePromise;
    },
    async finalize(options = {}) {
      const result = await this.release(options);
      if (result.failed > 0) {
        const detail = result.details?.find(item => !item.released);
        const error = new Error(detail?.reason || 'Fenced runtime restore/release failed');
        error.code = 'PROFILER_RUNTIME_RESTORE_FAILED';
        error.statusCode = 503;
        error.release = result;
        throw error;
      }
      return result;
    }
  };
}

module.exports = { acquireProfilerClaimLease };
