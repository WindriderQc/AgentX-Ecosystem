/**
 * Pure helper functions for batch orchestration.
 */

function toPerformanceBaseline(model, hostUrl, snapshot = {}) {
    return {
        model,
        host: hostUrl,
        hostId: snapshot.hostId || null,
        status: snapshot.status || 'error',
        source: snapshot.source || 'benchmark_host_test',
        tokensPerSec: snapshot.tokensPerSec ?? null,
        promptEvalTokensPerSec: snapshot.promptEvalTokensPerSec ?? null,
        latencyMs: snapshot.latencyMs ?? null,
        timeToFirstTokenMs: snapshot.timeToFirstTokenMs ?? null,
        ttftMeasurement: snapshot.ttftMeasurement || undefined,
        vramUsedMiB: snapshot.vramUsedMiB ?? null,
        vramTotalMiB: snapshot.vramTotalMiB ?? null,
        numCtx: snapshot.numCtx ?? null,
        numCtxSource: snapshot.numCtxSource ?? null,
        testedAt: snapshot.testedAt || new Date(),
        error: snapshot.error || null
    };
}

function groupModelsByHost(defaultHost, models) {
    const modelsByHost = {};
    for (const model of models) {
        const targetHost = defaultHost;
        if (!modelsByHost[targetHost]) modelsByHost[targetHost] = [];
        modelsByHost[targetHost].push(model);
    }
    return modelsByHost;
}

function createCurrentTestPersistenceStrategy(executionMode) {
    let currentTestWriteCount = 0;
    let lastCurrentTestWriteAt = 0;
    const writeEvery = executionMode === 'throughput' ? 3 : 1;
    const minIntervalMs = executionMode === 'throughput' ? 1500 : 0;
    return () => {
        if (executionMode !== 'throughput') return true;
        currentTestWriteCount += 1;
        const now = Date.now();
        const shouldWrite = currentTestWriteCount === 1
            || (currentTestWriteCount % writeEvery === 0)
            || ((now - lastCurrentTestWriteAt) >= minIntervalMs);
        if (shouldWrite) lastCurrentTestWriteAt = now;
        return shouldWrite;
    };
}

/**
 * Build a reset current_test object (all fields null, stage = 'idle').
 * Used when a batch finishes or is reconciled.
 */
function buildIdleCurrentTest() {
    return {
        model: null,
        prompt_id: null,
        prompt_name: null,
        prompt_level: null,
        prompt_category: null,
        prompt_text: null,
        stage: 'idle',
        phase: null,
        phase_detail: null,
        started_at: null,
        test_number: null,
        response_preview: null,
        latency: null,
        tokens: null,
        tokens_per_sec: null
    };
}

/**
 * Update the high-level pipeline phase + detail string on a batch document.
 * Best-effort: failures are swallowed because phase is observability-only and
 * must never break execution flow.
 *
 * @param {Object} BenchmarkBatch - mongoose model
 * @param {string} batchId
 * @param {string|null} phase - preparing|profiling|dedication|claiming|baseline|warmup|judge_warmup|executing|judging|null
 * @param {string|null} detail - human-readable detail line for the UI
 */
async function setBatchPhase(BenchmarkBatch, batchId, phase, detail = null) {
    if (!BenchmarkBatch || !batchId) return;
    try {
        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $set: {
                    'current_test.phase': phase,
                    'current_test.phase_detail': detail,
                    last_activity_at: new Date()
                }
            }
        );
    } catch (_err) {
        // swallow — phase is observability only
    }
}

/**
 * Build a MongoDB filter for judgeable results in a batch.
 * A result is judgeable if it succeeded and has a non-empty string response.
 */
function buildJudgeableFilter(batchId) {
    return {
        batch_id: batchId,
        success: true,
        response: { $type: 'string', $nin: ['', null] }
    };
}

const TERMINAL_BATCH_FAILURE_RATE_THRESHOLD = Math.max(
    0,
    Math.min(1, Number(process.env.BENCHMARK_TERMINAL_FAILURE_RATE_THRESHOLD) || 0.25)
);

function deriveTerminalBatchStatus({ totalTests = 0, failed = 0 } = {}) {
    const safeTotalTests = Number(totalTests) || 0;
    const safeFailed = Number(failed) || 0;
    if (safeTotalTests <= 0) {
        return 'completed';
    }
    return (safeFailed / safeTotalTests) >= TERMINAL_BATCH_FAILURE_RATE_THRESHOLD ? 'failed' : 'completed';
}

// 0209: stricter sibling of deriveTerminalBatchStatus that also returns a
// captured failure_reason. The zero-cells case (totalTests > 0 && completed
// === 0) is ALWAYS 'failed' regardless of the failure-rate ratio — a batch
// where the orchestrator caught a host- or model-level error before any
// test ran is never "completed". Symptom of the deeper bug filed as 0212.
function deriveTerminalBatchOutcome({ totalTests = 0, completed = 0, failed = 0 } = {}) {
    const safeTotalTests = Number(totalTests) || 0;
    const safeCompleted = Number(completed) || 0;
    const safeFailed = Number(failed) || 0;
    if (safeTotalTests <= 0) {
        return { status: 'completed', failureReason: null };
    }
    if (safeCompleted === 0) {
        return { status: 'failed', failureReason: 'zero_cells_executed' };
    }
    if (safeCompleted < safeTotalTests) {
        return { status: 'failed', failureReason: 'incomplete_cells' };
    }
    if ((safeFailed / safeTotalTests) >= TERMINAL_BATCH_FAILURE_RATE_THRESHOLD) {
        return { status: 'failed', failureReason: 'high_failure_rate' };
    }
    return { status: 'completed', failureReason: null };
}

/**
 * Derive the terminal judge_status when a batch reaches a terminal execution status.
 * @param {Object} batch - batch (or prior state snapshot) with judge_status and status fields
 * @param {Object} counts - { judge_total, judge_completed }
 * @param {string} terminalStatus - the terminal execution status ('completed', 'stopped', 'interrupted')
 * @returns {string} terminal judge_status
 */
function deriveTerminalJudgeStatus(batch, counts, terminalStatus) {
    if (counts.judge_total > 0 && counts.judge_completed >= counts.judge_total) {
        return 'completed';
    }

    if (terminalStatus === 'stopped') {
        if (batch.judge_status === 'running' || batch.status === 'judging' || counts.judge_completed > 0) {
            return counts.judge_total > 0 ? 'stopped' : 'none';
        }
        return batch.judge_status === 'completed' ? 'completed' : 'none';
    }

    if (terminalStatus === 'interrupted') {
        if (batch.judge_status === 'running' || batch.status === 'judging' || counts.judge_total > 0 || counts.judge_completed > 0) {
            return 'failed';
        }
        return batch.judge_status === 'completed' ? 'completed' : 'none';
    }

    return batch.judge_status || 'none';
}

module.exports = {
    TERMINAL_BATCH_FAILURE_RATE_THRESHOLD,
    toPerformanceBaseline,
    groupModelsByHost,
    createCurrentTestPersistenceStrategy,
    buildIdleCurrentTest,
    buildJudgeableFilter,
    deriveTerminalBatchStatus,
    deriveTerminalBatchOutcome,
    deriveTerminalJudgeStatus,
    setBatchPhase
};
