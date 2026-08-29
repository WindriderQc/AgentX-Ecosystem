/**
 * Benchmark Execution Module
 * Core batch management, orchestration, and progress tracking
 */

const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { normalizeExecutionConfig } = require('./config');
const { seedPrompts } = require('./init');

const { samplePromptsByDepth } = require('./promptSampling');
const { runTest } = require('./testExecution');
const { buildExecutionPlan } = require('./batchPlanner');
const { runBatchOrchestrator, abortActiveBatchRequests } = require('./batchOrchestrator');
const {
    buildIdleCurrentTest,
    deriveTerminalBatchOutcome,
    setBatchPhase: _setBatchPhase
} = require('./batchHelpers');
const { emitBuddyEvent } = require('../../clients/buddyEventClient');

let activeBatchId = null;
let activeHeartbeatInterval = null;

function getActiveBatchId() {
    return activeBatchId;
}

function getActiveHeartbeatInterval() {
    return activeHeartbeatInterval;
}

function clearActiveBatch() {
    if (activeHeartbeatInterval) {
        clearInterval(activeHeartbeatInterval);
        activeHeartbeatInterval = null;
    }
    activeBatchId = null;
}

async function startBatch({
    host,
    models,
    levels,
    prompt_ids = null,
    run_name,
    judge_config = {},
    execution_config = {},
    tags = [],
    description = '',
    execution_mode = 'latency',
    depth_config = null
}) {
    if (!host || !models || !Array.isArray(models) || !levels || !Array.isArray(levels)) {
        throw new Error('host, models (array), and levels (array) are required');
    }
    judge_config = { ...(judge_config || {}), think: false };

    await seedPrompts();

    const explicitPromptIds = Array.isArray(prompt_ids)
        ? [...new Set(prompt_ids.map(id => String(id)).filter(Boolean))]
        : [];

    let selectedPrompts = [];
    if (explicitPromptIds.length > 0) {
        const docs = await BenchmarkPrompt.find({ _id: { $in: explicitPromptIds } });
        const byId = new Map(docs.map(doc => [doc._id.toString(), doc]));
        const missing = explicitPromptIds.filter(id => !byId.has(id));
        if (missing.length > 0) {
            throw new Error(`Prompt IDs not found: ${missing.join(', ')}`);
        }
        selectedPrompts = explicitPromptIds.map(id => byId.get(id));
    } else {
        selectedPrompts = await BenchmarkPrompt.getByLevels(levels);
    }

    if (explicitPromptIds.length === 0 && depth_config && typeof depth_config === 'object') {
        selectedPrompts = samplePromptsByDepth(selectedPrompts, depth_config);
    }

    if (explicitPromptIds.length === 0) {
        selectedPrompts.sort((a, b) => (a.level || 0) - (b.level || 0));
    }

    if (selectedPrompts.length === 0) {
        throw new Error('No prompts found for selected levels');
    }

    const { plan, normalizedExecutionConfig } = buildExecutionPlan(
        host,
        models,
        selectedPrompts,
        { judge_config, execution_config }
    );

    const repeats = Math.max(1, Math.min(5, Number(normalizedExecutionConfig.repeats) || 1));
    const batch = new BenchmarkBatch({
        host,
        models,
        levels,
        prompt_ids: explicitPromptIds,
        judge_config,
        execution_config: normalizedExecutionConfig,
        depth_config: (depth_config && typeof depth_config === 'object') ? depth_config : null,
        run_name: run_name || description || `Batch ${new Date().toLocaleString()}`,
        active_slot: 'benchmark_singleton',
        total_tests: models.length * selectedPrompts.length * repeats,
        plan,
        status: 'running',
        started_at: new Date(),
        tags: Array.isArray(tags) ? tags : [],
        description: typeof description === 'string' ? description : '',
        execution_mode: execution_mode || 'latency'
    });

    batch.captureSystemSnapshot();
    await batch.save();
    const batchId = batch._id.toString();

    if (process.env.NODE_ENV !== 'test') {
        executeBatch(batchId, host, models, selectedPrompts, {
            judge_config,
            execution_config: normalizedExecutionConfig,
            execution_mode
        }).catch((err) => {
            logger.error('Batch execution failed', { batchId, error: err.message });
        });
    }

    return {
        batch_id: batchId,
        total_tests: batch.total_tests,
        plan
    };
}

async function updateHardwareProfiles(batchId) {
    // Hardware profile updates are handled by the Model Profiler service
    logger.debug('Hardware profile update skipped — use Model Profiler routes', { batchId });
}

async function executeBatch(batchId, defaultHost, models, prompts, options = {}) {
    const judgeConfig = { ...(options.judge_config || {}), think: false };
    const executionMode = options.execution_mode || 'latency';

    const now = new Date();
    const lockTimeoutMs = 10 * 60 * 1000;  // 10 minutes
    const activityTimeoutMs = 5 * 60 * 1000; // 5 minutes
    const lockTimeout = new Date(now - lockTimeoutMs);
    const activityTimeout = new Date(now - activityTimeoutMs);

    const batch = await BenchmarkBatch.findOneAndUpdate(
        {
            _id: batchId,
            $or: [
                { execution_started_at: null },
                {
                    execution_started_at: { $lt: lockTimeout },
                    last_activity_at: { $lt: activityTimeout }
                }
            ]
        },
        {
            $set: {
                execution_started_at: now,
                execution_pid: process.pid,
                last_activity_at: now
            }
        },
        { new: true }
    );

    if (!batch) {
        const existingBatch = await BenchmarkBatch.findById(batchId);
        if (!existingBatch) {
            logger.error('Batch not found', { batchId });
        } else {
            logger.warn('Skipping duplicate batch execution - already locked', {
                batchId,
                pid: process.pid,
                lockedBy: existingBatch.execution_pid
            });
        }
        return;
    }

    if (batch.execution_pid && batch.execution_pid !== process.pid) {
        logger.warn('Re-acquiring execution lock for abandoned batch', {
            batchId,
            previousPid: batch.execution_pid,
            pid: process.pid
        });
    }

    logger.info('Batch execution lock acquired', { batchId, pid: process.pid });

    emitBuddyEvent(
        'batch_started',
        'benchmark',
        `Benchmark batch started: ${models.length} models, ${prompts.length} prompts`
    );

    const executionConfig = normalizeExecutionConfig(options.execution_config || batch.execution_config || {});
    activeBatchId = batchId;
    let heartbeatInterval = null;

    const stopHeartbeat = () => {
        const interval = heartbeatInterval;
        if (!interval) {
            return;
        }

        clearInterval(interval);
        if (activeHeartbeatInterval === interval) {
            activeHeartbeatInterval = null;
        }
        heartbeatInterval = null;
    };

    const clearActiveState = () => {
        stopHeartbeat();
        if (activeBatchId === batchId) {
            activeBatchId = null;
        }
    };

    const recordBatchTimelineEvent = async (event, data = {}) => {
        try {
            // Separate known schema fields from ad-hoc details
            const { model, host, prompt_id, prompt_level, duration_ms, tokens_per_sec, time_to_first_token_ms, success, error, ...extras } = data;
            const entry = {
                batchId,
                timestamp: new Date(),
                event,
                model: model ?? null,
                host: host ?? null,
                prompt_id: prompt_id ?? null,
                prompt_level: prompt_level ?? null,
                duration_ms: duration_ms ?? null,
                tokens_per_sec: tokens_per_sec ?? null,
                time_to_first_token_ms: time_to_first_token_ms ?? null,
                success: success ?? null,
                error: error ?? null
            };
            if (Object.keys(extras).length > 0) {
                entry.details = extras;
            }
            await BenchmarkTimelineEntry.create(entry);
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $set: { last_activity_at: new Date() } }
            );
        } catch (err) {
            logger.debug('Failed to record timeline event', {
                batchId,
                event,
                error: err.message
            });
        }
    };

    const progressFlushThreshold = executionMode === 'throughput' ? 8 : 4;
    const progressFlushIntervalMs = 1500;
    const pendingBatchProgress = {
        completed: 0,
        failed: 0,
        results: [],
        dirtySince: 0
    };

    function queueBatchProgress(resultSummary, { failed = false } = {}) {
        pendingBatchProgress.completed += 1;
        if (failed) {
            pendingBatchProgress.failed += 1;
        }
        pendingBatchProgress.results.push(resultSummary);
        if (!pendingBatchProgress.dirtySince) {
            pendingBatchProgress.dirtySince = Date.now();
        }
    }

    async function flushBatchProgress(force = false) {
        if (pendingBatchProgress.completed === 0 && pendingBatchProgress.results.length === 0) {
            return;
        }

        const ageMs = pendingBatchProgress.dirtySince
            ? (Date.now() - pendingBatchProgress.dirtySince)
            : 0;

        if (!force && pendingBatchProgress.results.length < progressFlushThreshold && ageMs < progressFlushIntervalMs) {
            return;
        }

        const results = pendingBatchProgress.results.slice();
        const completed = pendingBatchProgress.completed;
        const failed = pendingBatchProgress.failed;
        const update = {
            $inc: { completed },
            $set: { last_activity_at: new Date() }
        };

        if (failed > 0) {
            update.$inc.failed = failed;
        }
        if (results.length > 0) {
            update.$push = {
                results: {
                    $each: results,
                    $slice: -1000
                }
            };
        }

        await BenchmarkBatch.updateOne({ _id: batchId }, update);

        pendingBatchProgress.completed = 0;
        pendingBatchProgress.failed = 0;
        pendingBatchProgress.results = [];
        pendingBatchProgress.dirtySince = 0;
    }

    try {
        await recordBatchTimelineEvent('prep_start', {
            model: judgeConfig.model || JUDGE_CONFIG.model,
            success: true
        });

        const setBatchPhase = (phase, detail = null) =>
            _setBatchPhase(BenchmarkBatch, batchId, phase, detail);
        await setBatchPhase('preparing', 'Building host plan and resolving prompts…');

        heartbeatInterval = setInterval(async () => {
            try {
                const heartbeatUpdate = await BenchmarkBatch.updateOne(
                    { _id: batchId, status: { $in: ['running', 'judging', 'completed'] } },
                    { $set: { last_activity_at: new Date() } }
                );
                if ((heartbeatUpdate && heartbeatUpdate.matchedCount) === 0) {
                    stopHeartbeat();
                }
            } catch (err) {
                logger.warn('Heartbeat failed', { batchId, error: err.message });
            }
        }, 10000);
        activeHeartbeatInterval = heartbeatInterval;

        const plannedRepeats = Math.max(1, Math.min(5, Number(executionConfig.repeats) || 1));
        const plannedTotalTests = models.length * prompts.length * plannedRepeats;
        if (plannedTotalTests > 0) {
            batch.total_tests = plannedTotalTests;
            await batch.save();
        }

        const orchestrationOutcome = await runBatchOrchestrator({
            batchId,
            defaultHost,
            models,
            prompts,
            judgeConfig,
            executionConfig,
            executionMode,
            recordBatchTimelineEvent,
            queueBatchProgress,
            flushBatchProgress,
            setBatchPhase,
            handleGracefulStop: clearActiveState
        });

        await flushBatchProgress(true);

        if (orchestrationOutcome?.stopped) {
            return orchestrationOutcome;
        }

        const finalSnapshot = await BenchmarkBatch.findById(batchId);
        if (finalSnapshot) {
            const outcome = deriveTerminalBatchOutcome({
                totalTests: finalSnapshot.total_tests,
                completed: finalSnapshot.completed,
                failed: finalSnapshot.failed
            });
            const completedAt = new Date();
            // Finalization is one conditional transition. A stop that wins
            // before this write cannot be overwritten by a stale document
            // save; a completion that wins first makes a later stop idempotent.
            const finalBatch = await BenchmarkBatch.findOneAndUpdate(
                {
                    _id: batchId,
                    status: { $in: ['pending', 'running', 'judging'] }
                },
                {
                    $set: {
                        status: outcome.status,
                        failure_reason: outcome.failureReason || null,
                        completed_at: completedAt,
                        last_activity_at: completedAt,
                        current_test: buildIdleCurrentTest(),
                        active_slot: null,
                        execution_pid: null
                    }
                },
                { new: true }
            );

            if (!finalBatch) {
                logger.info('Skipped batch finalization because a terminal transition already won', {
                    batchId
                });
                return;
            }

            if (outcome.failureReason === 'zero_cells_executed') {
                logger.error('Batch finalized with zero cells executed — host or model orchestration silently failed (0212 root cause)', {
                    batchId,
                    totalTests: finalBatch.total_tests
                });
            }
            await finalBatch.calculateMetrics();

            logger.info('Batch completed with metrics', {
                batchId,
                total_duration: finalBatch.execution_metrics?.total_duration_ms,
                tests_per_minute: finalBatch.execution_metrics?.tests_per_minute
            });

            const completedTests = finalBatch.completed || 0;
            const failedTests = finalBatch.failed || 0;
            emitBuddyEvent(
                'batch_completed',
                'benchmark',
                `Benchmark batch done: ${completedTests} tests, ${failedTests} failed`
            );

            try {
                await updateHardwareProfiles(batchId);
            } catch (err) {
                logger.warn('Failed to update hardware profiles', {
                    batchId,
                    error: err.message
                });
            }
        }
    } catch (err) {
        await flushBatchProgress(true).catch((flushErr) => {
            logger.warn('Failed to flush pending batch progress after crash', {
                batchId,
                error: flushErr.message
            });
        });

        const failedAt = new Date();
        const failureTransition = await BenchmarkBatch.updateOne(
            {
                _id: batchId,
                status: { $in: ['pending', 'running', 'judging'] }
            },
            {
                $set: {
                    status: 'failed',
                    judge_status: 'failed',
                    completed_at: failedAt,
                    last_activity_at: failedAt,
                    current_test: buildIdleCurrentTest(),
                    active_slot: null,
                    execution_pid: null
                }
            }
        ).catch((persistErr) => {
            logger.error('Failed to persist batch crash state', {
                batchId,
                error: persistErr.message
            });
            return null;
        });

        // A concurrent user stop is a successful terminal transition, not a
        // crash. Never overwrite it or emit misleading failure telemetry.
        if (failureTransition && failureTransition.matchedCount === 0) {
            let terminalBatch = null;
            try {
                terminalBatch = await BenchmarkBatch.findById(batchId)
                    .select('status')
                    .lean();
            } catch (_lookupErr) {
                terminalBatch = null;
            }
            if (terminalBatch?.status === 'stopped') {
                logger.info('Suppressed batch crash because user stop won the terminal race', {
                    batchId
                });
                return { stopped: true, cancelled: true };
            }
        }

        logger.error('Batch execution crashed', {
            batchId,
            error: err.message,
            stack: err.stack
        });

        emitBuddyEvent(
            'batch_failed',
            'benchmark',
            `Benchmark batch crashed: ${(err.message || 'unknown').slice(0, 120)}`,
            'high'
        );

        await BenchmarkTimelineEntry.create({
            batchId,
            timestamp: new Date(),
            event: 'execution_crash',
            success: false,
            error: err.message
        }).catch(() => {}); // best-effort

        throw err;
    } finally {
        await flushBatchProgress(true).catch((flushErr) => {
            logger.warn('Failed to flush pending batch progress during cleanup', {
                batchId,
                error: flushErr.message
            });
        });
        clearActiveState();
    }
}

async function stopBatch(batchId) {
    const stoppedAt = new Date();
    const managedLocally = activeBatchId === String(batchId);

    // Establish the user stop as durable truth before interrupting work. This
    // small atomic write releases the singleton slot even if authoritative
    // counter reconciliation later fails.
    let batch = await BenchmarkBatch.findOneAndUpdate(
        {
            _id: batchId,
            status: { $in: ['pending', 'running'] }
        },
        {
            $set: {
                status: 'stopped',
                judge_status: 'stopped',
                completed_at: stoppedAt,
                last_activity_at: stoppedAt,
                current_test: buildIdleCurrentTest(),
                active_slot: null,
                execution_pid: null
            }
        },
        { new: true }
    );

    if (!batch) {
        batch = await BenchmarkBatch.findById(batchId);
        if (!batch) {
            throw new Error('Batch not found');
        }
        if (batch.status === 'stopped') {
            // Safe to repeat: already-aborted controllers are ignored.
            abortActiveBatchRequests(batchId);
        }
        return { batch, alreadyStopped: true, managedLocally };
    }

    abortActiveBatchRequests(batchId);

    await BenchmarkTimelineEntry.create({
        batchId,
        timestamp: stoppedAt,
        event: 'stop_requested',
        success: false,
        error: null
    }).catch(() => {});

    try {
        batch = await batch.reconcileFromResults({ status: 'stopped' });
    } catch (err) {
        // The stop intent is already committed. Reconciliation is valuable,
        // but its failure must never resurrect the runner or turn a successful
        // stop into an HTTP 500.
        logger.warn('Batch stopped but authoritative reconciliation failed', {
            batchId,
            error: err.message
        });
    } finally {
        // Catch a request registered between the durable transition and the
        // first abort pass.
        abortActiveBatchRequests(batchId);
    }
    logger.info('Batch stopped by user', { batchId });

    return { batch, alreadyStopped: false, managedLocally };
}

/**
 * Resume a stopped/failed batch from its last checkpoint.
 * Re-uses the original batch config; the orchestrator skips completed pairs.
 */
async function resumeBatch(batchId, options = {}) {
    const batch = await BenchmarkBatch.findById(batchId);
    if (!batch) throw new Error('Batch not found');
    if (!['stopped', 'failed', 'interrupted'].includes(batch.status)) {
        throw new Error(`Cannot resume batch in status "${batch.status}"`);
    }

    const totalTests = Number(batch.total_tests) || 0;
    const completed = Number(batch.completed) || 0;
    const judgePending = Number(batch.judge_stats?.pending) || 0;
    const checkpointCount = Array.isArray(batch.checkpoint?.completed_pairs)
        ? batch.checkpoint.completed_pairs.length
        : 0;
    const executionRemaining = totalTests > 0
        ? Math.max(0, totalTests - Math.max(completed, checkpointCount)) > 0
        : false;

    if (!executionRemaining && judgePending <= 0) {
        throw new Error('Cannot resume batch with no remaining work');
    }

    // Reset to running
    if (options.judgeConfig && typeof options.judgeConfig === 'object') {
        batch.judge_config = {
            ...(batch.judge_config || {}),
            ...options.judgeConfig
        };
    }
    batch.status = 'running';
    batch.active_slot = 'benchmark_singleton';
    batch.execution_started_at = null;
    batch.execution_pid = null;
    await batch.save();

    const explicitPromptIds = Array.isArray(batch.prompt_ids)
        ? batch.prompt_ids.map(id => String(id)).filter(Boolean)
        : [];
    let selectedPrompts;
    if (explicitPromptIds.length > 0) {
        const prompts = await BenchmarkPrompt.find({ _id: { $in: explicitPromptIds } });
        const byId = new Map(prompts.map(doc => [doc._id.toString(), doc]));
        selectedPrompts = explicitPromptIds.map(id => byId.get(id)).filter(Boolean);
    } else {
        const prompts = await BenchmarkPrompt.getByLevels(batch.levels);
        selectedPrompts = (batch.depth_config && typeof batch.depth_config === 'object')
            ? samplePromptsByDepth(prompts, batch.depth_config)
            : prompts;
        selectedPrompts.sort((a, b) => (a.level || 0) - (b.level || 0));
    }

    if (process.env.NODE_ENV !== 'test') {
        executeBatch(batchId, batch.host, batch.models, selectedPrompts, {
            judge_config: batch.judge_config || {},
            execution_config: batch.execution_config || {},
            execution_mode: batch.execution_mode || 'latency'
        });
    }

    return { batch_id: batchId, status: 'resumed', checkpoint: batch.checkpoint };
}

module.exports = {
    runTest,
    startBatch,
    resumeBatch,
    executeBatch,
    stopBatch,
    getActiveBatchId,
    getActiveHeartbeatInterval,
    clearActiveBatch
};
