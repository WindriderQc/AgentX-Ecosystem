/**
 * Benchmark claim lifecycle helpers.
 */

const logger = require('../../../config/logger');
const { DEFAULT_EXECUTION_CONFIG } = require('./config');
const {
    claimHostForBenchmark,
    heartbeatBenchmarkClaim,
    releaseBenchmarkClaim,
    acquireWorkloadAdmission,
    heartbeatWorkloadAdmission,
    releaseWorkloadAdmission
} = require('../../clients/coreApiClient');

const PHASE_BUDGET_PER_TEST_MS = 30_000;
const CLAIM_HEARTBEAT_INTERVAL_MS = 30_000;

/**
 * Announce to core that `hostUrls` are in use by this batch.
 *
 * Claiming is all-or-nothing. If core cannot reserve every affected host, the
 * benchmark must stop before model warmup can unload pinned production models.
 *
 * @param {string[]} hostUrls - unique host URLs the batch will touch
 * @param {string} batchId
 * @param {number} estimatedDurationMs
 * @returns {Promise<string[]>} - URLs that were claimed and must be released
 */
async function acquireBenchmarkClaims(hostUrls, batchId, estimatedDurationMs, claimOptions = {}) {
    const acquired = [];
    await acquireWorkloadAdmission(batchId, {
        requestId: claimOptions.requestId || `benchmark:${batchId}`,
        kind: claimOptions.kind || (claimOptions.source === 'profiler' ? 'profiler' : 'benchmark'),
        batchId: claimOptions.source === 'benchmark' || !claimOptions.source ? batchId : null,
        hosts: hostUrls,
        ttlMs: estimatedDurationMs
    });
    for (const hostUrl of hostUrls) {
        try {
            const result = await claimHostForBenchmark(hostUrl, batchId, estimatedDurationMs, {
                source: claimOptions.source || 'benchmark',
                owner: claimOptions.owner || 'agentx-benchmark'
            });
            if (result?.claimed) {
                acquired.push(hostUrl);
                logger.info('Benchmark claim acquired', { batchId, hostUrl });
            } else {
                const err = new Error(`Benchmark claim rejected for ${hostUrl}: ${result?.reason || 'unknown reason'}`);
                err.hostUrl = hostUrl;
                err.reason = result?.reason || null;
                throw err;
            }
        } catch (err) {
            logger.warn('Benchmark claim acquisition failed — aborting batch', {
                batchId, hostUrl, error: err.message
            });
            await releaseBenchmarkClaims(acquired, batchId);
            const wrapped = new Error(`Unable to reserve benchmark host ${hostUrl}: ${err.message}`);
            wrapped.hostUrl = hostUrl;
            wrapped.cause = err;
            wrapped.acquired = acquired;
            throw wrapped;
        }
    }
    return acquired;
}

/**
 * Release all benchmark claims acquired by this batch. Errors are logged
 * but never thrown — this runs in a finally block and must not mask the
 * original error.
 * @returns {Promise<{released: number, failed: number, details: object[]}>}
 */
async function releaseBenchmarkClaims(hostUrls, batchId, options = {}) {
    const details = await Promise.all(hostUrls.map(async (hostUrl) => {
        try {
            const hostOptions = options.byHost
                ? (options.byHost[hostUrl] || {})
                : options;
            const result = Object.keys(hostOptions).length > 0
                ? await releaseBenchmarkClaim(hostUrl, batchId, hostOptions)
                : await releaseBenchmarkClaim(hostUrl, batchId);
            if (result?.released === true) {
                logger.info('Benchmark claim released', { batchId, hostUrl });
                return {
                    hostUrl,
                    released: true,
                    runtimeRestore: result.runtimeRestore || null,
                    pinRestore: result.pinRestore || null,
                    releaseReceipt: result.releaseReceipt || null
                };
            }
            logger.warn('Benchmark claim release refused', {
                batchId,
                hostUrl,
                reason: result?.reason || 'core_refused_release'
            });
            return {
                hostUrl,
                released: false,
                reason: result?.reason || 'core_refused_release',
                runtimeRestore: result?.runtimeRestore || null,
                pinRestore: result?.pinRestore || null,
                releaseReceipt: result?.releaseReceipt || null
            };
        } catch (err) {
            logger.warn('Benchmark claim release failed', {
                batchId, hostUrl, error: err.message
            });
            return { hostUrl, released: false, reason: err.message };
        }
    }));
    let workloadAdmission = null;
    try {
        workloadAdmission = await releaseWorkloadAdmission(batchId);
    } catch (error) {
        workloadAdmission = { released: false, reason: error.message };
    }
    return {
        released: details.filter(detail => detail.released).length,
        failed: details.filter(detail => !detail.released).length + (workloadAdmission?.released === true ? 0 : 1),
        details,
        workloadAdmission
    };
}

function startBenchmarkClaimHeartbeat(hostUrls, batchId, estimatedDurationMs, options = {}) {
    const intervalMs = Number(options.intervalMs) > 0
        ? Number(options.intervalMs)
        : CLAIM_HEARTBEAT_INTERVAL_MS;
    let stopped = false;
    let running = false;
    let inFlight = Promise.resolve();
    let failure = null;
    let resolveReady;
    const ready = new Promise(resolve => { resolveReady = resolve; });

    const fail = (hostUrl, reason, cause = null) => {
        if (failure) return;
        failure = new Error(`Benchmark claim heartbeat lost for ${hostUrl || batchId}: ${reason}`);
        failure.code = 'BENCHMARK_CLAIM_LOST';
        failure.hostUrl = hostUrl || null;
        failure.cause = cause;
        if (typeof options.onFatal === 'function') options.onFatal(failure);
    };

    const heartbeat = () => {
        if (stopped || running) return inFlight;
        running = true;
        inFlight = (async () => {
            try {
                const workload = await heartbeatWorkloadAdmission(batchId, estimatedDurationMs);
                if (workload?.heartbeat === false) {
                    fail(null, workload.reason || 'workload admission ownership rejected');
                    return;
                }
                await Promise.all(hostUrls.map(async (hostUrl) => {
                    const result = await heartbeatBenchmarkClaim(hostUrl, batchId, estimatedDurationMs, {
                        source: options.source || 'benchmark',
                        owner: options.owner || 'agentx-benchmark'
                    });
                    if (result?.heartbeat === false) {
                        logger.error('Benchmark claim heartbeat lost ownership', {
                            batchId,
                            hostUrl,
                            reason: result.reason || null
                        });
                        fail(hostUrl, result.reason || 'ownership rejected');
                    }
                }));
            } catch (err) {
                logger.warn('Benchmark claim heartbeat failed', { batchId, error: err.message });
                fail(null, err.message, err);
            } finally {
                running = false;
                resolveReady();
            }
        })();
        return inFlight;
    };

    heartbeat();
    const interval = setInterval(heartbeat, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
    const stop = () => {
        stopped = true;
        clearInterval(interval);
    };
    stop.ready = ready;
    stop.drain = async () => {
        stop();
        await inFlight;
    };
    stop.getFailure = () => failure;
    stop.assertActive = () => {
        if (failure) throw failure;
        if (stopped) {
            const err = new Error('Benchmark claim heartbeat is stopped');
            err.code = 'BENCHMARK_CLAIM_STOPPED';
            throw err;
        }
        return true;
    };
    return stop;
}

function positiveNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Estimate how long the benchmark claim should stay alive.
 *
 * The claim must outlive both model execution and the post-execution judge
 * drain window. The reaper in core still caps the stored estimate to 2h, so
 * we bias toward slightly-too-long rather than releasing the signal too soon.
 */
function estimateBenchmarkClaimDurationMs({
    hostCount,
    modelCount,
    promptCount,
    executionConfig,
    executionMode,
    judgeConfig
}) {
    const safeHostCount = Math.max(1, positiveNumber(hostCount) || 1);
    const safeModelCount = Math.max(0, positiveNumber(modelCount));
    const rawPromptCount = Math.max(0, positiveNumber(promptCount));
    const executionPromptCount = rawPromptCount || 1;
    const modelsPerHost = safeModelCount > 0
        ? Math.ceil(safeModelCount / safeHostCount)
        : 1;

    const heuristicExecutionEstimateMs = modelsPerHost * executionPromptCount * PHASE_BUDGET_PER_TEST_MS;
    const configuredExecutionEstimateMs = positiveNumber(executionConfig?.estimated_duration_ms);
    const executionEstimateMs = Math.max(heuristicExecutionEstimateMs, configuredExecutionEstimateMs);

    const totalJudgeCalls = safeModelCount * rawPromptCount;
    if (totalJudgeCalls === 0) {
        return executionEstimateMs;
    }

    const judgeConcurrency = executionMode === 'latency'
        ? 1
        : Math.max(1, positiveNumber(judgeConfig?.concurrency) || 2);
    const heuristicJudgePhaseMs = Math.ceil(totalJudgeCalls / judgeConcurrency) * PHASE_BUDGET_PER_TEST_MS;
    const stallBudgetMs = positiveNumber(executionConfig?.judge_stall_timeout_ms)
        || DEFAULT_EXECUTION_CONFIG.judge_stall_timeout_ms;
    const configuredDrainTimeoutMs = positiveNumber(executionConfig?.judge_drain_timeout_ms)
        || DEFAULT_EXECUTION_CONFIG.judge_drain_timeout_ms;
    const judgePhaseBudgetMs = Math.max(
        stallBudgetMs,
        Math.min(configuredDrainTimeoutMs, heuristicJudgePhaseMs)
    );

    return executionEstimateMs + judgePhaseBudgetMs;
}

module.exports = {
    CLAIM_HEARTBEAT_INTERVAL_MS,
    acquireBenchmarkClaims,
    releaseBenchmarkClaims,
    startBenchmarkClaimHeartbeat,
    estimateBenchmarkClaimDurationMs
};
