/**
 * Judge orchestration for a benchmark batch.
 *
 * Encapsulates the judge surface that batchOrchestrator was previously hosting
 * inline (audit: docs/audits/scan-2026-04-22/benchmark/summary.md
 * #batch-orchestrator-monolith). One factory call returns the six related
 * helpers plus the shared deferred-task list:
 *
 *   - resolveJudgeNumCtx       — single source of truth for judge num_ctx
 *   - resolveJudgeTargetForHost — pick the judge host & warm the model on it
 *   - enqueueJudgeTask         — schedule a pipelined judge call
 *   - deferJudgeTask           — postpone a same-host judge until exec finishes
 *   - enqueueDeferredJudgeTasks — drain the deferred list with re-warm
 *   - drainJudgeQueue          — wait for all in-flight judges to settle
 *
 * Why a factory instead of free functions: every helper here closes over the
 * batchId, judgeConfig, judgeQueue instance, and (for defer/enqueueDeferred)
 * a shared mutable array. Passing all four through every call site would just
 * recreate the closure machinery with worse ergonomics.
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
const JudgeQueueEntry = require('../../../models/JudgeQueueEntry');
const { JUDGE_CONFIG } = require('../qualityScorer');
const { warmupModel } = require('./modelWarmup');
const { judgeResult } = require('./judging');
const { resolveJudgeHost } = require('./judgeHostResolution');
const { normalizeJudgeNumCtx } = require('../scoring/judgeRuntimeConfig');
const { classifyBenchmarkError } = require('./errorClassifier');
const { resolveHarnessTarget } = require('./harnessBrokerClient');
const { getBenchmarkClaimIdentity } = require('../../clients/coreApiClient');

function createJudgeOrchestrator({
    batchId,
    judgeConfig,
    judgeQueue,
    executionConfig,
    recordBatchTimelineEvent,
    setBatchPhase,
    expectedResultCount,
    expectedJudgeCount = expectedResultCount,
    cancelSignal = null
}) {
    const deferredJudgeTasks = [];
    let cancelDrainPromise = null;
    const _setPhase = typeof setBatchPhase === 'function' ? setBatchPhase : async () => {};
    const cancellationReason = () => {
        const reason = cancelSignal?.reason;
        if (reason instanceof Error) return reason;
        const error = new Error(`Benchmark batch ${batchId} judge queue cancelled`);
        error.name = 'BenchmarkBatchStoppedError';
        error.code = 'BENCHMARK_BATCH_STOPPED';
        return error;
    };
    const isCancelled = () => cancelSignal?.aborted === true || judgeQueue.cancelled === true;
    const isCancellationError = (error) => isCancelled()
        || error?.code === 'BENCHMARK_BATCH_STOPPED'
        || error?.code === 'QUEUE_CANCELLED';
    const guardedBatchUpdate = async (filter, update) => {
        if (isCancelled()) throw cancellationReason();
        try {
            await BenchmarkBatch.updateOne(
                filter,
                update,
                cancelSignal ? { signal: cancelSignal } : undefined
            );
            if (isCancelled()) throw cancellationReason();
        } catch (error) {
            if (isCancelled()) {
                await BenchmarkBatch.updateOne(
                    { _id: batchId, status: { $in: ['pending', 'running', 'judging'] } },
                    {
                        $set: {
                            status: 'interrupted',
                            failure_reason: 'authority_lost_during_judge_counter_write',
                            last_activity_at: new Date(),
                            active_slot: null,
                            execution_pid: null
                        }
                    }
                ).catch(() => {});
                throw cancellationReason();
            }
            throw error;
        }
    };
    const onCancel = () => {
        deferredJudgeTasks.splice(0);
        judgeQueue.cancel(cancellationReason());
    };
    if (cancelSignal) {
        if (cancelSignal.aborted) onCancel();
        else cancelSignal.addEventListener('abort', onCancel, { once: true });
    }

    // Escalation budget for live batches — mirrors the standalone re-judge
    // path (judging.js). judgeConfig.multi_judge is shared BY REFERENCE across
    // every enqueueJudgeTask capture ({ ...judgeConfig } is a shallow copy),
    // so this counter is batch-scoped and multiJudge's budget guard actually
    // engages during normal batch judging. Previously _escalation was only
    // initialized on manual re-judges, so live batches escalated unbounded.
    if (judgeConfig?.multi_judge?.enabled && !judgeConfig.multi_judge._escalation) {
        const mj = judgeConfig.multi_judge;
        const pct = Number.isFinite(Number(mj.escalation_budget_percent))
            ? Math.max(0, Math.min(100, Number(mj.escalation_budget_percent)))
            : 20;
        const expected = Number.isFinite(Number(expectedJudgeCount)) && Number(expectedJudgeCount) > 0
            ? Number(expectedJudgeCount)
            : null;
        mj._escalation = {
            budget: (pct >= 100 || expected === null) ? Infinity : Math.ceil(expected * (pct / 100)),
            used: 0
        };
        logger.info('Multi-judge escalation budget set (live batch)', {
            batchId,
            budget: mj._escalation.budget,
            percent: pct,
            expected_results: expected
        });
    }

    // ── num_ctx resolution ─────────────────────────────────
    // Keep warmup and evaluation aligned only when the operator supplied an
    // explicit context. Otherwise both omit num_ctx and use the resident
    // Ollama/Modelfile configuration.
    async function resolveJudgeNumCtx(_judgeModel, _judgeHostUrl, judgeCfg) {
        return normalizeJudgeNumCtx(judgeCfg?.num_ctx ?? JUDGE_CONFIG.num_ctx);
    }

    // ── Per-host judge target resolution + warmup ──────────
    async function resolveJudgeTargetForHost(hostUrl) {
        if (judgeConfig.target?.executionKind === 'harness') {
            const currentTarget = await resolveHarnessTarget(judgeConfig.target, { force: true });
            judgeConfig.target = currentTarget;
            judgeConfig.host = `harness:${currentTarget.harness.name}`;
            judgeConfig.model = currentTarget.model;
            return judgeConfig.host;
        }
        const { judgeHost: judgeHostUrl, resolution: judgeHostResolution } = resolveJudgeHost(hostUrl, judgeConfig);
        if (judgeHostResolution === 'explicit') {
            logger.info('Using explicit judge host override', { judgeHost: judgeHostUrl, execHost: hostUrl });
        } else {
            logger.info('Using execution host as judge host default', { host: hostUrl });
        }
        if (judgeHostUrl !== hostUrl) {
            const judgeModel = judgeConfig.model || JUDGE_CONFIG.model;
            const judgeNumCtx = await resolveJudgeNumCtx(judgeModel, judgeHostUrl, judgeConfig);
            await _setPhase('judge_warmup', `Warming judge ${judgeModel} on ${judgeHostUrl}…`);
            await BenchmarkBatch.findOneAndUpdate({ _id: batchId }, {
                $set: {
                    current_test: { model: judgeModel, stage: 'warmup', phase: 'judge_warmup', phase_detail: `Warming judge ${judgeModel} on ${judgeHostUrl}`, prompt_name: judgeHostUrl, started_at: new Date() }
                }
            });
            try {
                if (isCancelled()) throw cancellationReason();
                await warmupModel(judgeHostUrl, judgeModel, {
                    timelinePrefix: 'judge_warmup',
                    recordTimelineEvent: recordBatchTimelineEvent,
                    strict: true,
                    timeoutOverride: 90000,
                    num_ctx: judgeNumCtx,
                    onPhaseDetail: (detail) => _setPhase('judge_warmup', detail),
                    claimIdentity: getBenchmarkClaimIdentity(judgeHostUrl, String(batchId)),
                    assertClaimActive: () => { if (isCancelled()) throw cancellationReason(); }
                });
                logger.info('Judge model ready on configured host', { host: judgeHostUrl, model: judgeModel, num_ctx: judgeNumCtx });
            } finally {
                await BenchmarkBatch.findOneAndUpdate({ _id: batchId }, { $set: { 'current_test.stage': 'idle' } });
                await _setPhase('executing', null);
            }
        }
        return judgeHostUrl;
    }

    // ── Pipelined judge enqueue ────────────────────────────
    async function enqueueJudgeTask(model, prompt, judgeHostUrl, resultId) {
        if (isCancelled()) throw cancellationReason();
        const capturedResultId = resultId.toString();
        const capturedJudgeConfig = { ...judgeConfig, host: judgeHostUrl };
        delete capturedJudgeConfig.signal;
        const runtimeJudgeConfig = cancelSignal
            ? { ...capturedJudgeConfig, signal: cancelSignal }
            : capturedJudgeConfig;

        // Persist queue entry so it survives crashes
        const queueEntry = await JudgeQueueEntry.create({
            batchId, resultId: capturedResultId, status: 'pending', judgeConfig: capturedJudgeConfig
        }).catch(err => { logger.debug('JudgeQueueEntry persist failed', { error: err.message }); return null; });

        await judgeQueue.waitForCapacity(10);
        judgeQueue.add(async () => {
            if (isCancelled()) throw cancellationReason();
            if (queueEntry) await JudgeQueueEntry.updateOne({ _id: queueEntry._id }, { $set: { status: 'running', startedAt: new Date() } }).catch(() => {});
            const judgeStart = Date.now();
            try {
                // Record judge_start timeline event
                await BenchmarkTimelineEntry.create({
                    batchId,
                    timestamp: new Date(),
                    event: 'judge_start',
                    model,
                    prompt_id: prompt._id ? prompt._id.toString() : null,
                    prompt_level: prompt.level,
                    success: null
                }).catch(err => logger.debug('Failed to record judge_start event', { error: err.message }));

                const judgeOutcome = await judgeResult(
                    capturedResultId,
                    runtimeJudgeConfig,
                    null,
                    capturedJudgeConfig.multi_judge || null
                );
                if (isCancelled()) throw cancellationReason();
                const judgeDuration = Date.now() - judgeStart;

                // Record judge_complete timeline event with score
                BenchmarkTimelineEntry.create({
                    batchId,
                    timestamp: new Date(),
                    event: 'judge_complete',
                    model,
                    prompt_id: prompt._id ? prompt._id.toString() : null,
                    prompt_level: prompt.level,
                    duration_ms: judgeDuration,
                    tokens_per_sec: judgeOutcome?.quality_score ?? null,
                    success: true
                }).catch(() => {}); // best-effort

                await guardedBatchUpdate(
                    { _id: batchId },
                    {
                        $inc: { judge_completed: 1 },
                        $set: { last_activity_at: new Date() }
                    }
                );
                if (queueEntry) await JudgeQueueEntry.updateOne({ _id: queueEntry._id }, { $set: { status: 'completed', completedAt: new Date() } }).catch(() => {});
            } catch (scoreErr) {
                if (isCancellationError(scoreErr)) {
                    throw cancellationReason();
                }
                const judgeDuration = Date.now() - judgeStart;
                logger.warn('Pipelined judging failed', {
                    batchId,
                    model,
                    prompt: prompt.name,
                    error: scoreErr.message
                });

                const classifiedJudgeErr = classifyBenchmarkError(scoreErr);
                await BenchmarkResult.updateOne(
                    { _id: capturedResultId },
                    {
                        $set: {
                            scoring_method: 'llm_failed',
                            quality_explanation: scoreErr.message,
                            error: scoreErr.message,
                            infra_error: classifiedJudgeErr.infra,
                            error_type: classifiedJudgeErr.type,
                            error_http_status: classifiedJudgeErr.httpStatus,
                            judge_model: capturedJudgeConfig.model || JUDGE_CONFIG.model,
                            judge_host: capturedJudgeConfig.host || null
                        }
                    }
                ).catch((persistErr) => {
                    logger.warn('Failed to persist pipelined judge failure result', {
                        batchId,
                        resultId: capturedResultId,
                        error: persistErr.message
                    });
                });

                BenchmarkTimelineEntry.create({
                    batchId,
                    timestamp: new Date(),
                    event: 'judge_complete',
                    model,
                    prompt_id: prompt._id ? prompt._id.toString() : null,
                    prompt_level: prompt.level,
                    duration_ms: judgeDuration,
                    success: false,
                    error: scoreErr.message
                }).catch(() => {}); // best-effort

                await guardedBatchUpdate(
                    { _id: batchId },
                    {
                        $inc: { judge_completed: 1, judge_failed: 1 },
                        $set: { last_activity_at: new Date() }
                    }
                );
                if (queueEntry) await JudgeQueueEntry.updateOne({ _id: queueEntry._id }, { $set: { status: 'failed', completedAt: new Date(), error: scoreErr.message } }).catch(() => {});
            }
        }).catch(async (enqueueErr) => {
            if (isCancellationError(enqueueErr)) return;
            logger.error('Failed to enqueue judge task', {
                batchId,
                model,
                prompt: prompt.name,
                error: enqueueErr.message
            });

            await guardedBatchUpdate(
                { _id: batchId },
                { $inc: { judge_completed: 1, judge_failed: 1 } }
            ).catch(error => {
                if (isCancellationError(error)) throw error;
            });
        });
    }

    // ── Same-host judge deferral ───────────────────────────
    function deferJudgeTask({ hostUrl, judgeHostUrl, model, prompt, resultId }) {
        if (isCancelled()) return;
        deferredJudgeTasks.push({ hostUrl, judgeHostUrl, model, prompt, resultId });
        logger.info('Deferring same-host judge task until execution completes', {
            batchId,
            host: hostUrl,
            judgeHost: judgeHostUrl,
            model,
            prompt: prompt.name
        });
    }

    async function enqueueDeferredJudgeTasks() {
        if (isCancelled()) throw cancellationReason();
        if (deferredJudgeTasks.length === 0) {
            return;
        }

        const judgeModel = judgeConfig.model || JUDGE_CONFIG.model;
        const warmedJudgeHosts = new Set();

        logger.info('Starting deferred same-host judge phase', {
            batchId,
            deferredTasks: deferredJudgeTasks.length
        });

        for (const deferredTask of deferredJudgeTasks) {
            if (isCancelled()) throw cancellationReason();
            const { judgeHostUrl, model, prompt, resultId } = deferredTask;
            const warmupKey = `${judgeHostUrl}::${judgeModel}`;

            if (judgeConfig.target?.executionKind !== 'harness' && !warmedJudgeHosts.has(warmupKey)) {
                const judgeNumCtx = await resolveJudgeNumCtx(judgeModel, judgeHostUrl, judgeConfig);
                await _setPhase('judge_warmup', `Warming judge ${judgeModel} on ${judgeHostUrl} (deferred phase)…`);
                await BenchmarkBatch.findOneAndUpdate({ _id: batchId }, {
                    $set: {
                        current_test: {
                            model: judgeModel,
                            stage: 'warmup',
                            phase: 'judge_warmup',
                            phase_detail: `Warming judge ${judgeModel} on ${judgeHostUrl}`,
                            prompt_name: judgeHostUrl,
                            started_at: new Date()
                        }
                    }
                });
                try {
                    if (isCancelled()) throw cancellationReason();
                    await warmupModel(judgeHostUrl, judgeModel, {
                        timelinePrefix: 'judge_warmup',
                        recordTimelineEvent: recordBatchTimelineEvent,
                        strict: true,
                        timeoutOverride: 90000,
                        num_ctx: judgeNumCtx,
                        onPhaseDetail: (detail) => _setPhase('judge_warmup', detail),
                        claimIdentity: getBenchmarkClaimIdentity(judgeHostUrl, String(batchId)),
                        assertClaimActive: () => { if (isCancelled()) throw cancellationReason(); }
                    });
                    warmedJudgeHosts.add(warmupKey);
                    logger.info('Judge model ready for deferred same-host phase', {
                        batchId,
                        host: judgeHostUrl,
                        model: judgeModel,
                        num_ctx: judgeNumCtx
                    });
                } finally {
                    await BenchmarkBatch.findOneAndUpdate(
                        { _id: batchId },
                        { $set: { 'current_test.stage': 'idle' } }
                    );
                    await _setPhase('judging', null);
                }
            }

            await enqueueJudgeTask(model, prompt, judgeHostUrl, resultId);
        }
    }

    // ── Final drain ────────────────────────────────────────
    async function drainJudgeQueue() {
        if (isCancelled()) throw cancellationReason();
        const judgeableFilter = {
            batch_id: batchId,
            success: true,
            response: { $type: 'string', $nin: ['', null] }
        };
        const judgeableCount = await BenchmarkResult.countDocuments(judgeableFilter);

        await BenchmarkBatch.updateOne(
            { _id: batchId },
            { $set: { generated_at: new Date(), judge_total: judgeableCount, judge_status: 'running' } }
        );

        logger.info('Tests done, draining pipelined judge queue', {
            batchId,
            queueStatus: judgeQueue.getStatus()
        });

        const drainResult = await judgeQueue.drain({
            timeoutMs: executionConfig.judge_drain_timeout_ms || 30 * 60 * 1000,
            stallTimeoutMs: executionConfig.judge_stall_timeout_ms || 2 * 60 * 1000,
            onProgress: (status) => logger.debug('Judge queue progress', { batchId, ...status })
        });

        if (isCancelled()) throw cancellationReason();

        const [finalJudgeableCount, finalJudgeCompleted, finalJudgeFailed] = await Promise.all([
            BenchmarkResult.countDocuments(judgeableFilter),
            BenchmarkResult.countDocuments({ ...judgeableFilter, scoring_method: { $ne: 'pending' } }),
            BenchmarkResult.countDocuments({ ...judgeableFilter, scoring_method: 'llm_failed' })
        ]);

        if (drainResult.timedOut) {
            logger.error('Judge queue drain timed out', { batchId, reason: drainResult.reason });
        }

        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $set: {
                    judge_status: drainResult.timedOut ? 'failed' : 'completed',
                    judge_total: finalJudgeableCount,
                    judge_completed: finalJudgeCompleted,
                    judge_failed: finalJudgeFailed
                }
            }
        );

        logger.info('Judge queue drained', {
            batchId,
            completed: drainResult.completed,
            failed: drainResult.failed,
            authoritative: {
                total: finalJudgeableCount,
                completed: finalJudgeCompleted,
                failed: finalJudgeFailed
            }
        });
    }

    async function cancelAndDrainJudgeQueue(reason = null) {
        if (!cancelDrainPromise) {
            cancelDrainPromise = (async () => {
                deferredJudgeTasks.splice(0);
                judgeQueue.cancel(reason instanceof Error ? reason : cancellationReason());
                const drainResult = await judgeQueue.drain({
                    timeoutMs: executionConfig.judge_drain_timeout_ms || 30 * 60 * 1000,
                    stallTimeoutMs: executionConfig.judge_stall_timeout_ms || 2 * 60 * 1000,
                    onProgress: (status) => logger.debug('Cancelled judge queue settling', { batchId, ...status })
                });
                await JudgeQueueEntry.updateMany(
                    { batchId, status: { $in: ['pending', 'running'] } },
                    {
                        $set: {
                            status: 'cancelled',
                            completedAt: new Date(),
                            error: 'BENCHMARK_BATCH_STOPPED'
                        }
                    }
                ).catch(() => {});
                if (cancelSignal) cancelSignal.removeEventListener('abort', onCancel);
                return drainResult;
            })();
        }
        return cancelDrainPromise;
    }

    function disposeCancellationListener() {
        if (cancelSignal) cancelSignal.removeEventListener('abort', onCancel);
    }

    return {
        resolveJudgeNumCtx,
        resolveJudgeTargetForHost,
        enqueueJudgeTask,
        deferJudgeTask,
        enqueueDeferredJudgeTasks,
        drainJudgeQueue,
        cancelAndDrainJudgeQueue,
        disposeCancellationListener
    };
}

module.exports = { createJudgeOrchestrator };
