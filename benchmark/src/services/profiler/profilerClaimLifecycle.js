'use strict';

const logger = require('../../../config/logger');

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
    const cleanup = await releaseBenchmarkClaims(claimed, operationId, {
      releaseWorkloadAdmission: false
    });
    // A failed exact host restore intentionally keeps the global admission
    // fenced for recovery. If every host restored, close the admission now so
    // an initial heartbeat failure does not leak it until TTL expiry.
    if (cleanup.failed === 0) {
      try {
        await releaseWorkloadAdmission(operationId);
      } catch (releaseError) {
        err.releaseError = releaseError;
      }
    }
    err.statusCode = 503;
    throw err;
  }

  let releasePromise = null;
  let abandonPromise = null;
  let abandoned = false;
  const retainHeartbeatForRecovery = reason => {
    if (abandonPromise) return abandonPromise;
    abandoned = true;
    if (!leaseAbort.signal.aborted) {
      leaseAbort.abort(reason || new Error('Profiler lease retained for reconciliation'));
    }
    const configuredHoldMs = Number.parseInt(process.env.PROFILER_RECONCILIATION_HOLD_MS, 10);
    const holdMs = Number.isFinite(configuredHoldMs) && configuredHoldMs > 0
      ? Math.min(configuredHoldMs, 30 * 60 * 1000)
      : Math.min(Math.max(Number(estimatedDurationMs) || 300_000, 300_000), 30 * 60 * 1000);
    const timer = setTimeout(() => heartbeat.drain().catch(error => logger.error(
      'Retained profiler heartbeat drain failed',
      { operationId, error: error.message }
    )), holdMs);
    timer.unref?.();
    abandonPromise = Promise.resolve({
      abandoned: true,
      released: 0,
      failed: claimed.length + 1,
      holdMs,
      details: claimed.map(hostUrl => ({ hostUrl, released: false, reason: 'held under heartbeat for durable recovery' })),
      workloadAdmission: { released: false, reason: 'held under heartbeat for durable recovery' }
    });
    return abandonPromise;
  };
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
    async abandon(reason = null) {
      if (releasePromise) return releasePromise;
      if (!abandonPromise) {
        retainHeartbeatForRecovery(reason || new Error('Profiler lease abandoned for TTL recovery'));
      }
      return abandonPromise;
    },
    async release(options = {}) {
      if (abandoned) return abandonPromise;
      if (!releasePromise) {
        releasePromise = (async () => {
          const { beforeWorkloadRelease = null, ...claimReleaseOptions } = options;
          if (typeof heartbeat.drainHosts === 'function') await heartbeat.drainHosts();
          const result = await releaseBenchmarkClaims(claimed, operationId, {
            ...claimReleaseOptions,
            releaseWorkloadAdmission: false
          });
          if (result.failed === 0) {
            if (typeof beforeWorkloadRelease === 'function') {
              try {
                heartbeat.assertActive();
                await beforeWorkloadRelease(result);
                heartbeat.assertActive();
              } catch (error) {
                error.retainAdmission = true;
                error.code = error.code || 'PROFILER_PROJECTION_RECONCILIATION_PENDING';
                retainHeartbeatForRecovery(error);
                throw error;
              }
            }
            try {
              result.workloadAdmission = await releaseWorkloadAdmission(operationId);
              if (result.workloadAdmission?.released !== true) {
                throw new Error(result.workloadAdmission?.reason || 'Profiler workload admission release was not acknowledged');
              }
              await heartbeat.drain();
            } catch (error) {
              result.failed += 1;
              result.workloadAdmission = {
                released: false,
                reason: error.message,
                reconciliationPending: true
              };
              retainHeartbeatForRecovery(error);
            }
          } else {
            result.workloadAdmission = {
              released: false,
              reason: 'held because fenced host restoration failed',
              reconciliationPending: true
            };
            retainHeartbeatForRecovery(new Error('Fenced host restoration failed'));
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
