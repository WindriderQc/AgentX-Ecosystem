'use strict';

const logger = require('../../../config/logger');

const {
  acquireBenchmarkClaims,
  releaseBenchmarkClaims,
  startBenchmarkClaimHeartbeat
} = require('../benchmark/benchmarkClaimLifecycle');
const { getBenchmarkClaimIdentity } = require('../../clients/coreApiClient');
const {
  getWorkloadRecoveryIdentity,
  releaseWorkloadAdmission,
  transitionWorkloadRecovery
} = require('../../clients/coreApiClient');

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
    abandonPromise = (async () => {
      try {
        await transitionWorkloadRecovery(operationId, 'UNKNOWN', {
          receipt: {
            contract: 'agentx.workload-recovery/v1',
            event: 'profiler-runtime-mutation-terminality-unknown',
            reason: reason?.code || reason?.message || 'reconciliation pending'
          }
        });
      } catch (error) {
        logger.error('Profiler recovery handoff failed; existing Core quarantine remains armed', {
          operationId,
          error: error.message
        });
      }
      await heartbeat.drain();
      return {
        abandoned: true,
        released: 0,
        failed: claimed.length + 1,
        holdMs: null,
        details: claimed.map(hostUrl => ({ hostUrl, released: false, reason: 'held in durable Core recovery quarantine' })),
        workloadAdmission: { released: false, reason: 'held in durable Core recovery quarantine' }
      };
    })();
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
    authorityProof() {
      const recovery = getWorkloadRecoveryIdentity(operationId);
      if (!recovery?.admissionId || !recovery?.generation || !recovery?.principal) {
        const err = new Error('Missing workload authority generation for profiler projection write');
        err.code = 'PROFILER_AUTHORITY_PROOF_MISSING';
        throw err;
      }
      return Object.freeze({
        admissionId: recovery.admissionId,
        generation: recovery.generation,
        principal: recovery.principal
      });
    },
    async abandon(reason = null) {
      // A failed release can already have switched the lease into durable
      // recovery from inside beforeWorkloadRelease. Prefer that retained
      // receipt over the rejected release promise so route error handlers can
      // acknowledge the recovery state without rethrowing the original write.
      if (abandonPromise) return abandonPromise;
      if (releasePromise) {
        try {
          return await releasePromise;
        } catch (error) {
          if (abandonPromise) return abandonPromise;
          retainHeartbeatForRecovery(reason || error);
          return abandonPromise;
        }
      }
      retainHeartbeatForRecovery(reason || new Error('Profiler lease abandoned for TTL recovery'));
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
