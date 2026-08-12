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
const { resolveModelNumCtxDetails } = require('../modelContextResolver');
const { classifyBenchmarkError } = require('./errorClassifier');

function createJudgeOrchestrator({
    batchId,
    judgeConfig,
    judgeQueue,
    executionConfig,
    recordBatchTimelineEvent,
    setBatchPhase,
    expectedResultCount,
    expectedJudgeCount = expectedResultCount
}) {
    const deferredJudgeTasks = [];
    const _setPhase = typeof setBatchPhase === 'function' ? setBatchPhase : async () => {};

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
    // Resolve the judge's num_ctx from the profiler (adaptation → probe → VRAM
    // estimate → explicit config → safety floor). This value is the single
    // source of truth for the entire judge lifecycle: warmup, evaluation calls,
    // and any re-warm after infra recovery. Passing it to warmupModel is load-
    // bearing: without it, Ollama loads the model at its Modelfile default
    // (e.g. 262144 for gemma4:26b), which either OOMs the host or forces a
    // reload on every subsequent call at a smaller ctx — both produce 100%
    // judge-call failures.
    async function resolveJudgeNumCtx(judgeModel, judgeHostUrl, judgeCfg) {
        if (judgeCfg && Number.isFinite(Number(judgeCfg.num_ctx))) {
            return Number(judgeCfg.num_ctx);
        }
        const details = await resolveModelNumCtxDetails(judgeModel, {
            targetHost: judgeHostUrl,
            fallback: JUDGE_CONFIG.num_ctx || 8192
        });
        if (!details.authoritative) {
            logger.warn('Judge num_ctx resolved from caller fallback — judge model is unprofiled on host', {
                judge_model: judgeModel, judge_host: judgeHostUrl, num_ctx: details.num_ctx
            });
        } else {
            logger.info('Judge num_ctx resolved from profile', {
                judge_model: judgeModel, judge_host: judgeHostUrl, num_ctx: details.num_ctx, source: details.source
            });
        }
        return details.num_ctx;
    }

    // ── Per-host judge target resolution + warmup ──────────
    async function resolveJudgeTargetForHost(hostUrl) {
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
                await warmupModel(judgeHostUrl, judgeModel, {
                    timelinePrefix: 'judge_warmup',
                    recordTimelineEvent: recordBatchTimelineEvent,
                    strict: true,
                    timeoutOverride: 90000,
                    num_ctx: judgeNumCtx,
                    onPhaseDetail: (detail) => _setPhase('judge_warmup', detail)
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
        const capturedResultId = resultId.toString();
        const capturedJudgeConfig = { ...judgeConfig, host: judgeHostUrl };

        // Persist queue entry so it survives crashes
        const queueEntry = await JudgeQueueEntry.create({
            batchId, resultId: capturedResultId, status: 'pending', judgeConfig: capturedJudgeConfig
        }).catch(err => { logger.debug('JudgeQueueEntry persist failed', { error: err.message }); return null; });

        await judgeQueue.waitForCapacity(10);
        judgeQueue.add(async () => {
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
                    capturedJudgeConfig,
                    null,
                    capturedJudgeConfig.multi_judge || null
                );
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

                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    {
                        $inc: { judge_completed: 1 },
                        $set: { last_activity_at: new Date() }
                    }
                );
                if (queueEntry) await JudgeQueueEntry.updateOne({ _id: queueEntry._id }, { $set: { status: 'completed', completedAt: new Date() } }).catch(() => {});
            } catch (scoreErr) {
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

                await BenchmarkBatch.updateOne(
                    { _id: batchId },
                    {
                        $inc: { judge_completed: 1, judge_failed: 1 },
                        $set: { last_activity_at: new Date() }
                    }
                );
                if (queueEntry) await JudgeQueueEntry.updateOne({ _id: queueEntry._id }, { $set: { status: 'failed', completedAt: new Date(), error: scoreErr.message } }).catch(() => {});
            }
        }).catch(async (enqueueErr) => {
            logger.error('Failed to enqueue judge task', {
                batchId,
                model,
                prompt: prompt.name,
                error: enqueueErr.message
            });

            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $inc: { judge_completed: 1, judge_failed: 1 } }
            ).catch(() => {});
        });
    }

    // ── Same-host judge deferral ───────────────────────────
    function deferJudgeTask({ hostUrl, judgeHostUrl, model, prompt, resultId }) {
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
            const { judgeHostUrl, model, prompt, resultId } = deferredTask;
            const warmupKey = `${judgeHostUrl}::${judgeModel}`;

            if (!warmedJudgeHosts.has(warmupKey)) {
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
                    await warmupModel(judgeHostUrl, judgeModel, {
                        timelinePrefix: 'judge_warmup',
                        recordTimelineEvent: recordBatchTimelineEvent,
                        strict: true,
                        timeoutOverride: 90000,
                        num_ctx: judgeNumCtx,
                        onPhaseDetail: (detail) => _setPhase('judge_warmup', detail)
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

    return {
        resolveJudgeNumCtx,
        resolveJudgeTargetForHost,
        enqueueJudgeTask,
        deferJudgeTask,
        enqueueDeferredJudgeTasks,
        drainJudgeQueue
    };
}

module.exports = { createJudgeOrchestrator };
