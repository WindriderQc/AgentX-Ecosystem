'use strict';

const crypto = require('crypto');
const logger = require('../../../config/logger');
const {
    acquireWorkloadAdmission,
    releaseWorkloadAdmission,
    transitionWorkloadRecovery
} = require('../../clients/coreApiClient');
const { startBenchmarkClaimHeartbeat } = require('./benchmarkClaimLifecycle');
const authorityReconciliation = require('./benchmarkAuthorityReconciliation');

const DEFAULT_MANAGED_WORKLOAD_TTL_MS = 30 * 60 * 1000;

async function beginManagedWorkload(workloadId, options = {}) {
    const id = String(workloadId || '');
    if (!id) throw new Error('workloadId is required');
    const ttlMs = Number(options.ttlMs) > 0
        ? Number(options.ttlMs)
        : DEFAULT_MANAGED_WORKLOAD_TTL_MS;
    await acquireWorkloadAdmission(id, {
        requestId: options.requestId || `benchmark:${id}`,
        kind: options.kind || 'benchmark',
        batchId: options.batchId || null,
        hosts: Array.isArray(options.hosts) ? options.hosts.filter(Boolean) : [],
        ttlMs
    });

    const controller = new AbortController();
    Object.defineProperty(controller.signal, 'workloadId', { value: id, enumerable: false });
    const heartbeat = startBenchmarkClaimHeartbeat([], id, ttlMs, {
        source: options.kind || 'benchmark',
        onFatal: error => {
            if (!controller.signal.aborted) controller.abort(error);
        }
    });
    await heartbeat.ready;
    try {
        heartbeat.assertActive();
    } catch (error) {
        await heartbeat.drain();
        // No host claim exists in this lifecycle, so there is no runtime
        // restoration to protect. Release the failed initial admission rather
        // than leaving every standalone judge surface blocked until TTL.
        try {
            await releaseWorkloadAdmission(id);
        } catch (releaseError) {
            error.releaseError = releaseError;
        }
        throw error;
    }

    let authorityGuard;
    try {
        authorityGuard = await authorityReconciliation.prepareWorkloadAuthority({
            workloadId: id,
            batchId: options.batchId || null,
            phase: options.kind || 'benchmark'
        });
        heartbeat.assertActive();
    } catch (error) {
        try {
            await releaseWorkloadAdmission(id);
        } catch (releaseError) {
            error.releaseError = releaseError;
        }
        await heartbeat.drain();
        throw error;
    }

    let closed = false;
    return {
        workloadId: id,
        signal: controller.signal,
        assertActive: heartbeat.assertActive,
        async abandon() {
            if (closed) return;
            closed = true;
            try {
                await transitionWorkloadRecovery(id, 'UNKNOWN', {
                    receipt: {
                        contract: 'agentx.workload-recovery/v1',
                        event: 'managed-workload-abandoned-for-reconciliation',
                        authorityGuardId: String(authorityGuard?._id || '')
                    }
                });
            } catch (error) {
                logger.error('Managed workload abandon could not transfer recovery ownership; Core quarantine remains', {
                    workloadId: id,
                    error: error.message
                });
            }
            await heartbeat.drain();
        },
        async retainForRecovery(reason = null) {
            if (closed) return { retained: true, reason: 'managed workload already retained' };
            closed = true;
            if (!controller.signal.aborted) {
                controller.abort(reason || new Error('Authority reconciliation requires retained admission'));
            }
            if (reason?.reconciliationPersistedPromise) {
                try {
                    await reason.reconciliationPersistedPromise;
                } catch (error) {
                    logger.error('Authority journal failed but Core quarantine remains durable', {
                        workloadId: id,
                        error: error.message
                    });
                }
            }
            try {
                await transitionWorkloadRecovery(id, 'UNKNOWN', {
                    receipt: {
                        contract: 'agentx.workload-recovery/v1',
                        event: 'owner-handoff-after-ambiguous-mutation',
                        reason: reason?.code || reason?.message || 'reconciliation pending'
                    }
                });
            } catch (error) {
                logger.error('Could not hand recovery quarantine to the restart worker; existing fence remains', {
                    workloadId: id,
                    error: error.message
                });
            }
            // Stop the crashed process heartbeat. Core does not reap an armed
            // recovery quarantine, so a restarted CAS worker can adopt it once
            // this process proof expires while maintenance remains blocked.
            await heartbeat.drain();
            return {
                retained: true,
                holdMs: null,
                reason: reason?.message || String(reason || 'reconciliation pending')
            };
        },
        async complete() {
            if (closed) return { released: false, reason: 'managed workload already closed' };
            heartbeat.assertActive();
            try {
                await authorityReconciliation.verifyWorkloadAuthority(id, {
                    authorityGuardId: String(authorityGuard?._id || ''),
                    event: 'managed-workload-complete'
                });
                heartbeat.assertActive();
                const released = await releaseWorkloadAdmission(id);
                if (released?.released !== true) {
                    const error = new Error(released?.reason || 'Core workload admission release failed');
                    error.code = 'WORKLOAD_ADMISSION_RELEASE_FAILED';
                    throw error;
                }
                await authorityReconciliation.resolveWorkloadAuthority(id, released);
                closed = true;
                await heartbeat.drain();
                return released;
            } catch (error) {
                // Keep renewing the exact admission if DELETE/recovery could
                // not prove the terminal CAS. The outer lifecycle will call
                // retainForRecovery rather than silently falling back to TTL.
                error.retainAdmission = true;
                error.code = error.code || 'WORKLOAD_ADMISSION_RELEASE_RECONCILIATION_PENDING';
                throw error;
            }
        }
    };
}

async function runManagedWorkload(workloadId, options, task) {
    const lifecycle = await beginManagedWorkload(workloadId, options);
    try {
        const result = await task({
            workloadId: lifecycle.workloadId,
            signal: lifecycle.signal,
            assertActive: lifecycle.assertActive
        });
        lifecycle.assertActive();
        await lifecycle.complete();
        return result;
    } catch (error) {
        await lifecycle.retainForRecovery(error);
        throw error;
    }
}

function withManagedWorkloadRoute(kind, resolveOptions, handler) {
    return async function managedWorkloadRoute(req, res, next) {
        let lifecycle = null;
        const originalJson = res.json.bind(res);
        let pendingJson = null;
        try {
            const options = typeof resolveOptions === 'function' ? (resolveOptions(req) || {}) : {};
            const workloadId = `${kind}:${crypto.randomUUID()}`;
            lifecycle = await beginManagedWorkload(workloadId, {
                requestId: workloadId,
                kind: options.kind || 'judge',
                batchId: options.batchId || null,
                hosts: options.hosts || [],
                ttlMs: options.ttlMs || null
            });
            req.workloadAdmissionSignal = lifecycle.signal;
            req.workloadAdmissionId = workloadId;
            req.assertWorkloadAdmissionActive = lifecycle.assertActive;

            // Do not acknowledge a mutating route before Core has accepted the
            // exact admission release. Express normally flushes json()
            // immediately, which made an admission-release failure appear as a
            // successful judge mutation to the caller. These routes all use
            // json responses, so retain the status/body until the final fenced
            // lifecycle transition is durable.
            res.json = body => {
                pendingJson = { statusCode: res.statusCode, body };
                return res;
            };
            await handler(req, res, next);
            if (res.statusCode >= 500) {
                await lifecycle.retainForRecovery(req.workloadAdmissionReconciliationError
                    || Object.assign(new Error('Managed route failed after durable authority guard'), { retainAdmission: true }));
                res.json = originalJson;
                if (pendingJson) return res.status(pendingJson.statusCode).json(pendingJson.body);
                return;
            }
            lifecycle.assertActive();
            await lifecycle.complete();
            res.json = originalJson;
            if (pendingJson) return res.status(pendingJson.statusCode).json(pendingJson.body);
        } catch (error) {
            if (lifecycle) {
                try {
                    await lifecycle.retainForRecovery(error);
                } catch (lifecycleError) {
                    error.lifecycleError = lifecycleError;
                }
            }
            res.json = originalJson;
            if (res.headersSent) {
                logger.error('Managed judge workload failed after response', { kind, error: error.message });
                return;
            }
            return res.status(error.statusCode || 409).json({
                status: 'error',
                code: error.code || 'WORKLOAD_ADMISSION_REQUIRED',
                error: error.message
            });
        }
    };
}

module.exports = {
    DEFAULT_MANAGED_WORKLOAD_TTL_MS,
    beginManagedWorkload,
    runManagedWorkload,
    withManagedWorkloadRoute
};
