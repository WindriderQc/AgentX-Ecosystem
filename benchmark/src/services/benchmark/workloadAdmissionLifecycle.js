'use strict';

const crypto = require('crypto');
const logger = require('../../../config/logger');
const {
    acquireWorkloadAdmission,
    releaseWorkloadAdmission
} = require('../../clients/coreApiClient');
const { startBenchmarkClaimHeartbeat } = require('./benchmarkClaimLifecycle');

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
        await releaseWorkloadAdmission(id).catch(() => {});
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
            await heartbeat.drain();
        },
        async complete() {
            if (closed) return { released: false, reason: 'managed workload already closed' };
            closed = true;
            heartbeat.assertActive();
            await heartbeat.drain();
            const heartbeatFailure = heartbeat.getFailure();
            if (heartbeatFailure) throw heartbeatFailure;
            const released = await releaseWorkloadAdmission(id);
            if (released?.released !== true) {
                const error = new Error(released?.reason || 'Core workload admission release failed');
                error.code = 'WORKLOAD_ADMISSION_RELEASE_FAILED';
                throw error;
            }
            return released;
        }
    };
}

async function runManagedWorkload(workloadId, options, task) {
    const lifecycle = await beginManagedWorkload(workloadId, options);
    try {
        const result = await task({
            signal: lifecycle.signal,
            assertActive: lifecycle.assertActive
        });
        lifecycle.assertActive();
        await lifecycle.complete();
        return result;
    } catch (error) {
        await lifecycle.abandon();
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
                await lifecycle.abandon();
                res.json = originalJson;
                if (pendingJson) return res.status(pendingJson.statusCode).json(pendingJson.body);
                return;
            }
            lifecycle.assertActive();
            await lifecycle.complete();
            res.json = originalJson;
            if (pendingJson) return res.status(pendingJson.statusCode).json(pendingJson.body);
        } catch (error) {
            if (lifecycle) await lifecycle.abandon().catch(() => {});
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
