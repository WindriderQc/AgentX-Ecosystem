/**
 * Benchmark claim lifecycle helpers.
 */

const logger = require('../../../config/logger');
const { DEFAULT_EXECUTION_CONFIG } = require('./config');
const {
    claimHostForBenchmark,
    heartbeatBenchmarkClaim,
    releaseBenchmarkClaim
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
async function acquireBenchmarkClaims(hostUrls, batchId, estimatedDurationMs) {
    const acquired = [];
    for (const hostUrl of hostUrls) {
        try {
            const result = await claimHostForBenchmark(hostUrl, batchId, estimatedDurationMs, {
                source: 'benchmark',
                owner: 'agentx-benchmark'
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
            if (acquired.length > 0) {
                await releaseBenchmarkClaims(acquired, batchId);
            }
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
 */
async function releaseBenchmarkClaims(hostUrls, batchId) {
    await Promise.allSettled(hostUrls.map(async (hostUrl) => {
        try {
            await releaseBenchmarkClaim(hostUrl, batchId);
            logger.info('Benchmark claim released', { batchId, hostUrl });
        } catch (err) {
            logger.warn('Benchmark claim release failed', {
                batchId, hostUrl, error: err.message
            });
        }
    }));
}

function startBenchmarkClaimHeartbeat(hostUrls, batchId, estimatedDurationMs, options = {}) {
    const intervalMs = Number(options.intervalMs) > 0
        ? Number(options.intervalMs)
        : CLAIM_HEARTBEAT_INTERVAL_MS;
    let stopped = false;
    let running = false;

    const heartbeat = async () => {
        if (stopped || running) return;
        running = true;
        try {
            await Promise.all(hostUrls.map(async (hostUrl) => {
                const result = await heartbeatBenchmarkClaim(hostUrl, batchId, estimatedDurationMs);
                if (result?.heartbeat === false) {
                    logger.error('Benchmark claim heartbeat lost ownership', {
                        batchId,
                        hostUrl,
                        reason: result.reason || null
                    });
                }
            }));
        } catch (err) {
            logger.warn('Benchmark claim heartbeat failed', { batchId, error: err.message });
        } finally {
            running = false;
        }
    };

    heartbeat();
    const interval = setInterval(heartbeat, intervalMs);
    if (typeof interval.unref === 'function') interval.unref();
    return () => {
        stopped = true;
        clearInterval(interval);
    };
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
