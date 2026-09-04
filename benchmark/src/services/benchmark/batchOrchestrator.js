/**
 * Benchmark batch execution internals.
 */

const logger = require('../../../config/logger');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { withBenchmarkServiceAuth } = require('../../helpers/coreServiceAuth');

// Benchmark test runs route through core's /api/inference/generate. As of
// task 0168, the proxy applies a caller-aware lane policy:
// the scoped Benchmark credential plus `callerDetail: 'benchmark-batch-<id>'`
// selects the **direct lane** —
// no probe, no admission gate, no Mongo lookups, async telemetry write.
// This delivers full direct-bypass throughput WITHOUT losing inference
// telemetry; verified end-to-end on 2026-04-30 (p50 68.63 tok/s on
// gemma4:26b L1, 14/14 telemetry rows landed).
const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');
// hardwareProfileService removed — profiler handles hardware detection now
const ConcurrencyQueue = require('./ConcurrencyQueue');
const { buildPromptHints } = require('./config');
const { classifyBenchmarkError } = require('./errorClassifier');
const { extractThinkingBlocks } = require('../../helpers/ollamaResponseHandler');
const { warmupModel } = require('./modelWarmup');
const { benchmarkFetch: fetch } = require('./http');
const { resolveJudgeHost } = require('./judgeHostResolution');
const { groupModelsByHost, createCurrentTestPersistenceStrategy } = require('./batchHelpers');
const { persistSuccessfulResult, persistFailedResult } = require('./batchResultPersistence');
const { detectDedication, releaseAllDedication } = require('./dedicationLifecycle');
const { findActiveProfilingForHost } = require('../profiler/activeProfileState');
const { capturePerformanceBaseline } = require('./performanceBaseline');
const { evaluateAndPersistEarlyStop, EARLY_STOP_MIN_JUDGED } = require('./earlyStop');
const { createJudgeOrchestrator } = require('./judgeOrchestration');
const {
    acquireBenchmarkClaims,
    releaseBenchmarkClaims,
    estimateBenchmarkClaimDurationMs,
    startBenchmarkClaimHeartbeat
} = require('./benchmarkClaimLifecycle');
const buddySurface = require('./buddySurfaceEvents');
const {
    assertFrozenArtifactDigest,
    getFrozenModelExecutionConfig,
    loadOrResolveCampaignInferenceContracts
} = require('./inferenceContractSnapshot');
const { createResumeRevalidation, RESUME_CODES } = require('./resumeRevalidation');
const { checkBatchPreflight, executionModelsFromHostGroups, preflightCounts, runBatchPreflight } = require('./batchPreflightLifecycle');
const { executionHost, normalizeBatchTargets } = require('../../../../shared/benchmarkTargetContract');
const { executeHarnessTarget, resolveHarnessTarget } = require('./harnessBrokerClient');
const { getBenchmarkClaimIdentity } = require('../../clients/coreApiClient');

// A throughput batch can have one in-flight Core request per host. Keep the
// controllers grouped by the exact batch id so the stop route can interrupt
// only the requested batch without coupling execution.js to prompt internals.
const activeBatchControllers = new Map();
const userStoppedControllers = new WeakSet();

function registerActiveBatchController(batchId, controller) {
    const key = String(batchId);
    let controllers = activeBatchControllers.get(key);
    if (!controllers) {
        controllers = new Set();
        activeBatchControllers.set(key, controllers);
    }
    controllers.add(controller);

    let registered = true;
    return () => {
        if (!registered) return false;
        registered = false;

        // A late cleanup must not touch a newer Set created for the same batch.
        const currentControllers = activeBatchControllers.get(key);
        if (currentControllers !== controllers) return false;

        const removed = currentControllers.delete(controller);
        if (currentControllers.size === 0 && activeBatchControllers.get(key) === controllers) {
            activeBatchControllers.delete(key);
        }
        return removed;
    };
}

function abortActiveBatchRequests(batchId, options = {}) {
    const key = String(batchId);
    const controllers = activeBatchControllers.get(key);
    if (!controllers) {
        return { batchId: key, activeRequestCount: 0, abortedRequestCount: 0 };
    }

    let abortedRequestCount = 0;
    for (const controller of controllers) {
        if (controller.signal.aborted) continue;

        const userInitiated = options.userInitiated !== false;
        if (userInitiated) userStoppedControllers.add(controller);
        const reason = options.reason instanceof Error
            ? options.reason
            : new Error(`Benchmark batch ${key} stopped by user`);
        if (userInitiated) {
            reason.name = 'BenchmarkBatchStoppedError';
            reason.code = 'BENCHMARK_BATCH_STOPPED';
        }
        controller.abort(reason);
        abortedRequestCount += 1;
    }

    return {
        batchId: key,
        activeRequestCount: controllers.size,
        abortedRequestCount
    };
}

function wasControllerStoppedByUser(controller) {
    return !!controller && (
        userStoppedControllers.has(controller)
        || controller.signal?.reason?.code === 'BENCHMARK_BATCH_STOPPED'
    );
}

function getActiveBatchRequestCount(batchId) {
    return activeBatchControllers.get(String(batchId))?.size || 0;
}

async function runBatchOrchestrator({
    batchId,
    defaultHost,
    models,
    targets = null,
    spendGrant = null,
    qualityCohortFingerprint = null,
    batchContractFingerprint = null,
    trustEvidenceContext = null,
    prompts,
    judgeConfig,
    executionConfig,
    executionMode,
    recordBatchTimelineEvent,
    queueBatchProgress,
    flushBatchProgress,
    setBatchPhase,
    handleGracefulStop
}) {
    // No-op fallback so older call sites don't crash if setBatchPhase isn't provided.
    if (typeof setBatchPhase !== 'function') {
        setBatchPhase = async () => {};
    }
    if (typeof handleGracefulStop !== 'function') {
        handleGracefulStop = () => {};
    }
    const batchCancellationController = new AbortController();
    let assertClaimActive = () => true;
    const claimIdentityFor = hostUrl => getBenchmarkClaimIdentity(hostUrl, String(batchId));
    let unregisterBatchCancellation = () => false;
    let orchestrationCompleted = false;
    const normalizedTargets = normalizeBatchTargets({ host: defaultHost, models, targets });
    const localTargets = normalizedTargets.filter((target) => target.executionKind === 'ollama');
    const harnessTargets = normalizedTargets.filter((target) => target.executionKind === 'harness');
    const localTargetByKey = new Map(localTargets.map((target) => [`${target.host}\0${target.model}`, target]));
    judgeConfig = {
        ...(judgeConfig || {}),
        batch_id: String(batchId),
        batch_contract_fingerprint: batchContractFingerprint,
        spend_grant: spendGrant || null
    };
    const judgeQueue = new ConcurrencyQueue(executionMode === 'latency' ? 1 : (judgeConfig.concurrency || 2));
    const shouldPersistCurrentTest = createCurrentTestPersistenceStrategy(executionMode);
    const judge = createJudgeOrchestrator({
        batchId,
        judgeConfig,
        judgeQueue,
        executionConfig,
        recordBatchTimelineEvent,
        setBatchPhase,
        cancelSignal: batchCancellationController.signal,
        // Sizes the multi-judge escalation budget for the live pipeline —
        // the same role pendingResults.length plays for standalone re-judges.
        expectedJudgeCount: normalizedTargets.length * (prompts?.length || 0)
    });
    const {
        resolveJudgeTargetForHost,
        enqueueJudgeTask,
        deferJudgeTask,
        enqueueDeferredJudgeTasks,
        drainJudgeQueue,
        cancelAndDrainJudgeQueue,
        disposeCancellationListener
    } = judge;

    // Load checkpoint for resume support — skip completed model+prompt pairs
    const batchDoc = await BenchmarkBatch.findById(batchId).select('checkpoint').lean();
    const completedPairs = new Set(batchDoc?.checkpoint?.completed_pairs || []);
    const isResuming = completedPairs.size > 0;
    const lastCheckpointModel = batchDoc?.checkpoint?.last_model || null;
    // Preserve the legacy host/model grouping contract exactly when callers
    // have not opted into BenchmarkTarget v1. Explicit targets are grouped by
    // their own frozen host identity instead.
    const localHostMap = Array.isArray(targets) && targets.length > 0
        ? localTargets.reduce((groups, target) => {
            (groups[target.host] ||= []).push(target.model);
            return groups;
        }, {})
        : groupModelsByHost(defaultHost, models);
    const requestedHostGroups = Object.entries(localHostMap);
    let executionHostGroups = requestedHostGroups;
    let inferenceContractCampaign = null;
    const resumeRevalidation = isResuming ? createResumeRevalidation({
        batchId, completedPairs, lastCheckpointModel, recordBatchTimelineEvent
    }) : null;

    const executionState = { testsStarted: false, stopped: false, stopCheckCounter: 0, lastStopCheckAt: 0, stopCheckEvery: 5, stopCheckMinIntervalMs: 2000 };
    const shouldStopBatch = async (model, options = {}) => {
        const force = !!options.force;
        if (batchCancellationController.signal.aborted) {
            executionState.stopped = true;
            return true;
        }
        if (executionState.stopped) return true;
        executionState.stopCheckCounter += 1;
        const now = Date.now();
        const shouldCheck = force
            || executionState.stopCheckCounter === 1
            || (executionState.stopCheckCounter % executionState.stopCheckEvery === 0)
            || ((now - executionState.lastStopCheckAt) >= executionState.stopCheckMinIntervalMs);
        if (!shouldCheck) return false;
        executionState.lastStopCheckAt = now;
        try {
            const stopCheck = await BenchmarkBatch.findById(batchId).select('status').lean();
            if (stopCheck && stopCheck.status === 'stopped') {
                executionState.stopped = true;
                return true;
            }
        } catch (err) {
                logger.warn('Failed to check batch status', { batchId, model, error: err.message });
        }
        return false;
    };

    const loadCurrentBatch = async (model) => {
        try {
            const currentBatch = await BenchmarkBatch.findById(batchId);
            if (!currentBatch) {
                logger.error('Batch not found during execution', { batchId, model });
                return null;
            }
            return currentBatch;
        } catch (err) {
            logger.error('Failed to fetch batch object', { batchId, model, error: err.message });
            return null;
        }
    };

    const flushModelTimeline = async (entries) => {
        if (!Array.isArray(entries) || entries.length === 0) {
            return;
        }

        const docs = entries.map(e => ({ ...e, batchId }));
        await BenchmarkTimelineEntry.insertMany(docs, { ordered: false }).catch(() => {});
        await BenchmarkBatch.updateOne(
            { _id: batchId },
            { $set: { last_activity_at: new Date() } }
        );
    };


    const executePrompt = async ({
        hostUrl,
        judgeHostUrl,
        model,
        prompt,
        currentBatch,
        testNumber,
        modelExecConfig,
        hardwareSnapshot,
        modelWarmupData,
        performanceBaseline,
        pendingModelTimeline,
        repeatIndex = 0,
        repeatTotal = 1,
        repeatGroupId = null,
        executionTarget = null
    }) => {
        const start = Date.now();
        const think = modelExecConfig.think === true;
        let testController = null;
        let frozenPromptText = prompt.prompt;

        try {
            pendingModelTimeline.push({
                timestamp: new Date(),
                event: 'test_start',
                model,
                prompt_id: prompt._id ? prompt._id.toString() : null,
                prompt_level: prompt.level,
                success: null
            });
            if (shouldPersistCurrentTest()) {
                await currentBatch.updateCurrentTest(
                    model,
                    prompt._id ? prompt._id.toString() : null,
                    prompt.name,
                    'executing',
                    {
                        testNumber,
                        promptLevel: prompt.level,
                        recordTimeline: false,
                        promptCategory: prompt.category || null,
                        promptText: (prompt.prompt || '').substring(0, 500)
                    }
                );
            }

            const numPredict = modelExecConfig.response_max_tokens || 32000;
            const promptHints = buildPromptHints(
                prompt.prompt,
                prompt.expected_tokens || null,
                numPredict,
                modelExecConfig
            );
            const promptText = promptHints.promptText;
            frozenPromptText = promptText;
            const hintApplied = promptHints.applied;
            const hintText = promptHints.hintText;
            const ollamaOptions = { num_predict: numPredict };
            if (modelExecConfig.num_ctx) ollamaOptions.num_ctx = modelExecConfig.num_ctx;
            // Pin sampling params for fairness across models/hosts. Without these,
            // each Modelfile contributes its own defaults and Ollama version drift
            // contributes more — score variance partly reflects RNG, not skill.
            if (Number.isFinite(modelExecConfig.temperature)) ollamaOptions.temperature = modelExecConfig.temperature;
            if (Number.isFinite(modelExecConfig.top_p)) ollamaOptions.top_p = modelExecConfig.top_p;
            if (Number.isFinite(modelExecConfig.top_k)) ollamaOptions.top_k = modelExecConfig.top_k;
            if (Number.isFinite(modelExecConfig.repeat_penalty)) ollamaOptions.repeat_penalty = modelExecConfig.repeat_penalty;
            if (Number.isFinite(modelExecConfig.seed)) ollamaOptions.seed = modelExecConfig.seed;

            const useChat = modelExecConfig.api_mode !== 'generate';
            const sendThink = modelExecConfig.send_think !== false;
            const url = `${CORE_URL}/api/inference/generate`;
            const requestBody = {
                model,
                host: hostUrl,
                stream: false,
                responseMode: 'normalized',
                callerDetail: `benchmark-batch-${batchId}`,
                ...(claimIdentityFor(hostUrl) || {}),
                options: ollamaOptions,
                ...(sendThink ? {
                    suppressThinking: !think,
                    includeThinking: think,
                    think
                } : {}),
                ...(useChat
                    ? { messages: [{ role: 'user', content: promptText }] }
                    : { prompt: promptText })
            };

            // Re-check immediately before registering the request. Once this
            // await resolves there is no event-loop yield between registration
            // and fetch, so a concurrent stop either sees the controller or has
            // already persisted a stopped status here.
            if (await shouldStopBatch(model, { force: true })) {
                return { infraError: false, stopped: true, cancelled: true };
            }

            testController = new AbortController();
            const fetchOptions = getFetchOptions(url, {
                method: 'POST',
                headers: withBenchmarkServiceAuth({ 'Content-Type': 'application/json' }),
                body: JSON.stringify(requestBody),
                signal: testController.signal
            });

            let response;
            let data;
            const testTimeoutId = setTimeout(() => testController.abort(), modelExecConfig.per_test_timeout_ms || 600000);
            const unregisterController = registerActiveBatchController(batchId, testController);
            try {
                response = await fetch(url, fetchOptions);
                // Headers alone do not complete a request. Keep the timeout and
                // stop registry active until the response body is consumed.
                data = await response.json();
            } finally {
                clearTimeout(testTimeoutId);
                unregisterController();
            }

            // A body implementation may resolve concurrently with abort
            // delivery. Preserve the user's stop decision in that race.
            if (wasControllerStoppedByUser(testController)) {
                return { infraError: false, stopped: true, cancelled: true };
            }

            const latency = Date.now() - start;
            const responseText = useChat ? (data.message?.content || '') : (data.response || '');
            const tokenEstimateText = `${responseText || ''}${data.thinking || data.message?.thinking || ''}`;
            const tokens = data.eval_count || Math.ceil(tokenEstimateText.length / 4);
            // Non-streamed batch execution cannot observe wall-to-wall TTFT.
            // Preserve Ollama's prompt evaluation duration under its truthful
            // name and leave the legacy TTFT field null.
            const promptEvalDurationMs = data.prompt_eval_duration > 0
                ? Number((data.prompt_eval_duration / 1e6).toFixed(1))
                : null;
            const timeToFirstTokenMs = null;
            const tokensPerSec = (tokens > 0 && latency > 0)
                ? Number((tokens / (latency / 1000)).toFixed(2))
                : 0;
            const responseTruncated = data.done_reason === 'length';

            if (responseTruncated) {
                logger.warn('Model response truncated', {
                    model,
                    prompt_name: prompt.name,
                    tokens,
                    num_predict: numPredict,
                    done_reason: data.done_reason
                });
            }

            // Silent input truncation detection. Ollama drops prompt tokens when
            // num_ctx < (prompt_tokens + num_predict) without raising an error —
            // the model emits a confident, plausible-sounding answer to a
            // truncated prompt, and the judge can't tell it didn't see the full
            // question. We compare prompt_eval_count to the available input
            // budget (num_ctx − num_predict) and flag when usage hits the
            // ceiling, which is the signature of silent truncation.
            const promptEvalCount = Number(data.prompt_eval_count) || 0;
            const ctxUsed = modelExecConfig.num_ctx || null;
            const inputBudget = ctxUsed ? Math.max(0, ctxUsed - numPredict) : null;
            // ~96% of budget = budget exhausted. False positives possible on
            // prompts that legitimately fill the window, but those still warrant
            // review (the judge can't trust the answer either way).
            const inputTruncated = !!(inputBudget && promptEvalCount > 0 && promptEvalCount >= Math.floor(inputBudget * 0.96));
            if (inputTruncated) {
                logger.warn('Suspected silent input truncation', {
                    model,
                    prompt_name: prompt.name,
                    prompt_eval_count: promptEvalCount,
                    num_ctx: ctxUsed,
                    num_predict: numPredict,
                    input_budget: inputBudget
                });
            }

            const hasRawEmptyResponse = !responseText || responseText.trim().length === 0;
            if (hasRawEmptyResponse) {
                logger.warn('Model produced empty response', {
                    model,
                    prompt_name: prompt.name,
                    prompt_level: prompt.level,
                    prompt_category: prompt.category,
                    done_reason: data.done_reason,
                    eval_count: data.eval_count,
                    latency_ms: latency,
                    host: hostUrl,
                    api_mode: useChat ? 'chat' : 'generate'
                });
            }

            // Hard fail: HTTP 200 + empty body + zero tokens + no done_reason =
            // Ollama accepted the request but couldn't actually run the model
            // (VRAM too tight, model not loaded, etc.). This is an
            // INFRASTRUCTURE failure, not a quality-zero result. Throwing here
            // routes it through persistFailedResult so the batch report
            // correctly distinguishes "model is bad" from "model never ran".
            const looksLikeNoRun =
                hasRawEmptyResponse &&
                (tokens === 0 || !data.eval_count) &&
                !data.done_reason;
            if (looksLikeNoRun) {
                const err = new Error(
                    `Model did not run on host (empty response, 0 tokens, ${latency}ms). ` +
                    `Likely VRAM conflict or model not loaded. ` +
                    `Profile the model first, or ensure it fits on the host.`
                );
                err.name = 'ModelDidNotRunError';
                err.infra = true;
                throw err;
            }

            const thinkingExtraction = extractThinkingBlocks(responseText, data.thinking || null);
            const cleanedResponse = thinkingExtraction.content;
            const extractedThinking = thinkingExtraction.thinking;
            const hasEmptyResponse = !cleanedResponse || cleanedResponse.trim().length === 0;

            if (extractedThinking) {
                logger.debug('Extracted thinking from response', {
                    model,
                    prompt_name: prompt.name,
                    thinking_length: extractedThinking.length,
                    cleaned_response_length: cleanedResponse.length
                });
            }
            if (!hasRawEmptyResponse && hasEmptyResponse) {
                logger.warn('Model produced no visible response after thinking extraction', {
                    model,
                    prompt_name: prompt.name,
                    prompt_level: prompt.level,
                    prompt_category: prompt.category,
                    done_reason: data.done_reason,
                    eval_count: data.eval_count,
                    thinking_length: extractedThinking ? extractedThinking.length : 0,
                    latency_ms: latency,
                    host: hostUrl,
                    api_mode: useChat ? 'chat' : 'generate'
                });
            }

            // Progressive update: mark as responded with preview data for live detail cards
            if (shouldPersistCurrentTest()) {
                await currentBatch.updateCurrentTestStage('responded', {
                    response_preview: cleanedResponse.substring(0, 300),
                    latency,
                    tokens,
                    tokens_per_sec: tokensPerSec,
                    time_to_first_token_ms: null,
                    prompt_eval_duration_ms: promptEvalDurationMs
                }).catch(err => logger.debug('Failed to update responded stage', { error: err.message }));
            }

            const resultId = await persistSuccessfulResult({
                batchId,
                judgeConfig,
                queueBatchProgress,
                flushBatchProgress,
                model,
                hostUrl,
                judgeHostUrl,
                prompt,
                promptText,
                latency,
                tokens,
                tokensPerSec,
                timeToFirstTokenMs,
                promptEvalDurationMs,
                cleanedResponse,
                extractedThinking,
                hasEmptyResponse,
                responseTruncated,
                doneReason: data.done_reason,
                numPredict,
                hintApplied,
                hintText,
                answerContract: promptHints.answerContract,
                lengthHintApplied: promptHints.lengthHintApplied,
                hardwareSnapshot,
                modelWarmupData,
                performanceBaseline,
                currentBatch,
                pendingModelTimeline,
                inputTruncated,
                promptEvalCount,
                inputBudget,
                executionSettings: {
                    sampling_profile: modelExecConfig.sampling_profile || 'controlled',
                    sampling_source: modelExecConfig.sampling_source || 'controlled_override',
                    num_ctx: ctxUsed,
                    num_ctx_source: modelExecConfig.num_ctx_source || null,
                    think,
                    think_mode: modelExecConfig.think_mode || (think ? 'on' : 'off'),
                    think_resolved_by: modelExecConfig.think_resolved_by || null,
                    thinking_profile_policy: modelExecConfig.thinking_profile_policy || null,
                    thinking_profile_host_id: modelExecConfig.thinking_profile_host_id || null,
                    thinking_profile_model_name: modelExecConfig.thinking_profile_model_name || null,
                    thinking_policy_reason: modelExecConfig.thinking_policy_reason || null,
                    thinking_final_answer_policy: modelExecConfig.thinking_final_answer_policy || null,
                    thinking_final_answer_text: promptHints.thinkingFinalAnswerContract?.text || null,
                    temperature: ollamaOptions.temperature ?? null,
                    top_p: ollamaOptions.top_p ?? null,
                    top_k: ollamaOptions.top_k ?? null,
                    repeat_penalty: ollamaOptions.repeat_penalty ?? null,
                    seed: ollamaOptions.seed ?? null,
                    rankable_mode: modelExecConfig.rankable_mode === true,
                    inference_contract_fingerprint: modelExecConfig.inference_contract_fingerprint || null,
                    inference_contract_request_fingerprint: modelExecConfig.inference_contract_request_fingerprint || null,
                    artifact_digest: modelExecConfig.artifact_digest || null
                },
                repeatIndex,
                repeatTotal,
                repeatGroupId,
                executionTarget,
                qualityCohortFingerprint,
                trustEvidenceContext
            });

            if (!hasEmptyResponse) {
                if (judgeHostUrl === hostUrl) {
                    deferJudgeTask({ hostUrl, judgeHostUrl, model, prompt, resultId });
                } else {
                    await enqueueJudgeTask(model, prompt, judgeHostUrl, resultId);
                }
            }
        } catch (err) {
            if (wasControllerStoppedByUser(testController) || batchCancellationController.signal.aborted) {
                logger.info('Cancelled in-flight benchmark request after user stop', {
                    batchId,
                    model,
                    prompt: prompt.name,
                    host: hostUrl
                });
                return { infraError: false, stopped: true, cancelled: true };
            }

            const classified = classifyBenchmarkError(err);
            await persistFailedResult({
                batchId,
                judgeConfig,
                queueBatchProgress,
                flushBatchProgress,
                model,
                hostUrl,
                judgeHostUrl,
                prompt,
                promptText: frozenPromptText,
                err,
                errorDuration: Date.now() - start,
                currentBatch,
                pendingModelTimeline,
                repeatIndex,
                repeatTotal,
                repeatGroupId,
                executionSettings: {
                    sampling_profile: modelExecConfig.sampling_profile || 'controlled',
                    sampling_source: modelExecConfig.sampling_source || 'controlled_override',
                    think,
                    think_mode: modelExecConfig.think_mode || null,
                    rankable_mode: modelExecConfig.rankable_mode === true,
                    inference_contract_fingerprint: modelExecConfig.inference_contract_fingerprint || null,
                    inference_contract_request_fingerprint: modelExecConfig.inference_contract_request_fingerprint || null,
                    artifact_digest: modelExecConfig.artifact_digest || null
                },
                executionTarget,
                qualityCohortFingerprint,
                trustEvidenceContext
            });
            if (classified.infra) return { infraError: true };
        }
        // A stop can arrive after the result was persisted while an async judge
        // task is being scheduled. Treat that edge as cancelled before the
        // prompt loop records a resumable checkpoint or starts more work.
        if (batchCancellationController.signal.aborted) {
            return { infraError: false, stopped: true, cancelled: true };
        }
        return { infraError: false };
    };

    const runHarnessTarget = async (selectedTarget) => {
        const target = await resolveHarnessTarget(selectedTarget, { force: true });
        const hostUrl = executionHost(target);
        const judgeHostUrl = await resolveJudgeTargetForHost(hostUrl);
        const currentBatch = await loadCurrentBatch(target.model);
        if (!currentBatch) return { stopped: true, cancelled: false };
        const pendingModelTimeline = [];
        const repeats = Math.max(1, Math.min(5, Number(executionConfig.repeats) || 1));

        try {
            for (const prompt of prompts) {
                const repeatGroupId = `${batchId}:${target.id}:${prompt.name || prompt._id}`;
                for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
                    const pairKey = `${target.id}::${prompt.name}::r${repeatIndex}`;
                    if (completedPairs.has(pairKey)) continue;
                    if (await shouldStopBatch(target.model, { force: true })) {
                        return { stopped: true, cancelled: batchCancellationController.signal.aborted };
                    }

                    if (!executionState.testsStarted) {
                        executionState.testsStarted = true;
                        await recordBatchTimelineEvent('tests_start', { success: true });
                        await setBatchPhase('executing', null);
                    }

                    const startedAt = Date.now();
                    const numPredict = executionConfig.response_max_tokens || 32000;
                    const promptHints = buildPromptHints(
                        prompt.prompt,
                        prompt.expected_tokens || null,
                        numPredict,
                        executionConfig
                    );
                    const controller = new AbortController();
                    const unregisterController = registerActiveBatchController(batchId, controller);
                    const timeoutId = setTimeout(
                        () => controller.abort(),
                        executionConfig.per_test_timeout_ms || 600000
                    );
                    let execution = null;
                    try {
                        pendingModelTimeline.push({
                            timestamp: new Date(), event: 'test_start', model: target.model,
                            host: hostUrl, prompt_id: prompt._id ? prompt._id.toString() : null,
                            prompt_level: prompt.level, success: null
                        });
                        execution = await executeHarnessTarget({
                            batchId,
                            batchFingerprint: batchContractFingerprint,
                            cellId: `${target.id}:${prompt._id || prompt.name}:${repeatIndex}`,
                            target,
                            promptText: promptHints.promptText,
                            parameters: {
                                temperature: executionConfig.temperature,
                                topP: executionConfig.top_p,
                                seed: executionConfig.seed,
                                maxTokens: numPredict,
                                timeoutMs: executionConfig.per_test_timeout_ms || 600000,
                                thinking: executionConfig.think === true
                            },
                            spendGrant,
                            role: 'candidate',
                            signal: controller.signal
                        });
                        const usage = execution.receipt.usage;
                        const cleanedResponse = execution.output;
                        const resultId = await persistSuccessfulResult({
                            batchId,
                            judgeConfig,
                            queueBatchProgress,
                            flushBatchProgress,
                            model: target.model,
                            hostUrl,
                            judgeHostUrl,
                            prompt,
                            promptText: promptHints.promptText,
                            latency: usage.durationMs || (Date.now() - startedAt),
                            tokens: usage.outputTokens,
                            tokensPerSec: usage.durationMs > 0 ? usage.outputTokens / (usage.durationMs / 1000) : null,
                            timeToFirstTokenMs: null,
                            cleanedResponse,
                            extractedThinking: execution.thinking || '',
                            hasEmptyResponse: cleanedResponse.trim().length === 0,
                            responseTruncated: execution.finishReason === 'length',
                            doneReason: execution.finishReason,
                            numPredict,
                            hintApplied: promptHints.applied,
                            hintText: promptHints.hintText,
                            answerContract: promptHints.answerContract,
                            lengthHintApplied: promptHints.lengthHintApplied,
                            hardwareSnapshot: null,
                            modelWarmupData: null,
                            performanceBaseline: null,
                            currentBatch,
                            pendingModelTimeline,
                            inputTruncated: false,
                            promptEvalCount: usage.inputTokens,
                            inputBudget: executionConfig.input_token_ceiling || null,
                            executionSettings: {
                                sampling_profile: executionConfig.sampling_profile || 'controlled',
                                sampling_source: executionConfig.sampling_source || 'controlled_override',
                                num_ctx: target.contextWindow,
                                num_ctx_source: 'target_catalog',
                                think: executionConfig.think === true,
                                think_mode: executionConfig.think_mode || (executionConfig.think === true ? 'on' : 'off'),
                                temperature: executionConfig.temperature ?? null,
                                top_p: executionConfig.top_p ?? null,
                                seed: executionConfig.seed ?? null,
                                rankable_mode: target.mode === 'isolated_model',
                                inference_contract_fingerprint: target.profile.fingerprint,
                                artifact_digest: execution.receipt.identity.model.digest || null
                            },
                            repeatIndex,
                            repeatTotal: repeats,
                            repeatGroupId: repeats > 1 ? repeatGroupId : null,
                            executionTarget: target,
                            executionReceipt: execution.publicReceipt,
                            trustExecutionReceipt: execution.receipt,
                            providerUsage: usage,
                            providerCost: {
                                estimated: target.pricing?.estimated === true && usage.costSource !== 'provider-reported',
                                costNanodollars: usage.costNanodollars,
                                pricing: target.pricing,
                                observedAt: new Date().toISOString()
                            },
                            qualityCohortFingerprint,
                            trustEvidenceContext
                        });
                        if (cleanedResponse.trim()) {
                            if (judgeHostUrl === hostUrl) deferJudgeTask({ hostUrl, judgeHostUrl, model: target.model, prompt, resultId });
                            else await enqueueJudgeTask(target.model, prompt, judgeHostUrl, resultId);
                        }
                    } catch (error) {
                        if (wasControllerStoppedByUser(controller) || batchCancellationController.signal.aborted) {
                            return { stopped: true, cancelled: true };
                        }
                        await persistFailedResult({
                            batchId, judgeConfig, queueBatchProgress, flushBatchProgress,
                            model: target.model, hostUrl, judgeHostUrl, prompt, err: error,
                            errorDuration: Date.now() - startedAt, currentBatch, pendingModelTimeline,
                            repeatIndex, repeatTotal: repeats,
                            repeatGroupId: repeats > 1 ? repeatGroupId : null,
                            executionSettings: {
                                sampling_profile: executionConfig.sampling_profile || 'controlled',
                                sampling_source: executionConfig.sampling_source || 'controlled_override',
                                think: executionConfig.think === true,
                                think_mode: executionConfig.think_mode || (executionConfig.think === true ? 'on' : 'off'),
                                rankable_mode: target.mode === 'isolated_model',
                                inference_contract_fingerprint: target.profile.fingerprint
                            },
                            executionTarget: target,
                            executionReceipt: execution?.publicReceipt || null,
                            trustExecutionReceipt: execution?.receipt || null,
                            providerUsage: execution?.receipt?.usage || null,
                            qualityCohortFingerprint,
                            trustEvidenceContext,
                            promptText: promptHints.promptText
                        });
                    } finally {
                        clearTimeout(timeoutId);
                        unregisterController();
                    }

                    completedPairs.add(pairKey);
                    await BenchmarkBatch.updateOne({ _id: batchId }, {
                        $addToSet: { 'checkpoint.completed_pairs': pairKey },
                        $set: {
                            'checkpoint.last_model': target.id,
                            'checkpoint.last_prompt': prompt.name,
                            'checkpoint.updated_at': new Date()
                        }
                    }).catch(() => {});
                }
            }
            return { stopped: false, cancelled: false };
        } finally {
            await flushModelTimeline(pendingModelTimeline);
        }
    };

    const runModelPromptLoop = async (hostUrl, judgeHostUrl, model) => {
        if (await shouldStopBatch(model, { force: true })) {
            logger.info('Skipping model because batch is stopped', { batchId, model, host: hostUrl });
            return { stopped: true, cancelled: false };
        }

        const modelExecConfig = isResuming
            ? await resumeRevalidation.validateModel(
                inferenceContractCampaign,
                model,
                hostUrl,
                executionConfig
            )
            : getFrozenModelExecutionConfig(
                inferenceContractCampaign,
                model,
                hostUrl,
                executionConfig
            );
        if (!isResuming) {
            await assertFrozenArtifactDigest(inferenceContractCampaign, model, hostUrl);
        }
        if (modelExecConfig.num_ctx !== executionConfig.num_ctx) {
            logger.info('Using per-model execution config', {
                model,
                num_ctx: modelExecConfig.num_ctx,
                batch_num_ctx: executionConfig.num_ctx
            });
        }

        await setBatchPhase('baseline', `Performance baseline: ${model} on ${hostUrl}`);
        const performanceBaseline = await capturePerformanceBaseline({
            batchId,
            model,
            hostUrl,
            numCtx: modelExecConfig.num_ctx || null,
            claimIdentity: claimIdentityFor(hostUrl),
            assertClaimActive,
            signal: batchCancellationController.signal
        });
        assertClaimActive();
        if (await shouldStopBatch(model, { force: true })) {
            logger.info('Stopping before model warmup because batch is stopped', { batchId, model, host: hostUrl });
            return { stopped: true, cancelled: false };
        }

        const warmupTimeoutCold = executionConfig.warmup_timeout_cold || 180000;
        const warmupTimeoutLoaded = executionConfig.warmup_timeout_loaded || 90000;
        await setBatchPhase('warmup', `Warming up ${model} on ${hostUrl} (cold ≤${Math.round(warmupTimeoutCold/1000)}s)`);
        const modelWarmupData = await warmupModel(hostUrl, model, {
            timelinePrefix: 'model_warmup',
            recordTimelineEvent: recordBatchTimelineEvent,
            num_ctx: modelExecConfig.num_ctx || null,
            warmupTimeoutCold,
            warmupTimeoutLoaded,
            onPhaseDetail: (detail) => setBatchPhase('warmup', detail),
            claimIdentity: claimIdentityFor(hostUrl),
            assertClaimActive,
            signal: batchCancellationController.signal
        });
        if (await shouldStopBatch(model, { force: true })) {
            logger.info('Stopping after model warmup because batch is stopped', { batchId, model, host: hostUrl });
            return { stopped: true, cancelled: false };
        }

        const hardwareSnapshot = null; // hardware detection now handled by profiler pipeline
        const currentBatch = await loadCurrentBatch(model);
        if (!currentBatch) return;
        const pendingModelTimeline = [];

        const INFRA_ERROR_CIRCUIT_BREAKER_THRESHOLD = 3;
        let consecutiveInfraErrors = 0;

        let earlyStopped = false;
        let promptsCompletedForModel = 0;

        const repeats = Math.max(1, Math.min(5, Number(modelExecConfig.repeats) || 1));

        try {
            for (const prompt of prompts) {
                if (earlyStopped) break;
                // repeat_group_id ties together N runs of the same (model, host, prompt).
                // Stable across the loop so analytics can aggregate variance per group.
                const repeatGroupId = `${batchId}:${model}:${prompt.name || prompt._id}`;

                for (let repeatIndex = 0; repeatIndex < repeats; repeatIndex++) {
                    // Pair key — keep r0 unsuffixed so resume-from-old-batches still works.
                    // New repeats use ::r<N> so they don't collide with the legacy key.
                    const pairKey = repeatIndex === 0
                        ? `${model}::${prompt.name}`
                        : `${model}::${prompt.name}::r${repeatIndex}`;
                    if (completedPairs.has(pairKey)) continue;

                    if (await shouldStopBatch(model)) {
                        logger.info('Batch execution stopped by user', { batchId });
                        handleGracefulStop();
                        return { stopped: true, cancelled: false };
                    }
                    assertClaimActive();

                    if (consecutiveInfraErrors >= INFRA_ERROR_CIRCUIT_BREAKER_THRESHOLD) {
                        logger.warn(`Circuit breaker: skipping remaining prompts on ${hostUrl} after ${consecutiveInfraErrors} consecutive infra errors`, {
                            batchId,
                            model,
                            host: hostUrl,
                            infraErrorCount: consecutiveInfraErrors
                        });
                        break;
                    }

                    if (!executionState.testsStarted) {
                        executionState.testsStarted = true;
                        await recordBatchTimelineEvent('tests_start', { success: true });
                        await setBatchPhase('executing', null);
                        // Rate-limited: fires once per batch when the run phase begins.
                        buddySurface.emitLifecycle('run_phase', 'Running benchmark prompts across models…');
                    }

                    const execResult = await executePrompt({
                        hostUrl,
                        judgeHostUrl,
                        model,
                        prompt,
                        currentBatch,
                        testNumber: (currentBatch.completed || 0) + 1,
                        modelExecConfig,
                        hardwareSnapshot,
                        modelWarmupData,
                        performanceBaseline,
                        pendingModelTimeline,
                        repeatIndex,
                        repeatTotal: repeats,
                        repeatGroupId: repeats > 1 ? repeatGroupId : null,
                        executionTarget: localTargetByKey.get(`${hostUrl}\0${model}`) || null
                    });

                    if (execResult?.stopped || batchCancellationController.signal.aborted) {
                        executionState.stopped = true;
                        logger.info('Batch request cancelled; stopping prompt loop', {
                            batchId,
                            model,
                            prompt: prompt.name,
                            host: hostUrl
                        });
                        handleGracefulStop();
                        return {
                            stopped: true,
                            cancelled: execResult?.cancelled === true || batchCancellationController.signal.aborted
                        };
                    }

                    // Record checkpoint for resume support
                    completedPairs.add(pairKey);
                    BenchmarkBatch.updateOne({ _id: batchId }, {
                        $addToSet: { 'checkpoint.completed_pairs': pairKey },
                        $set: { 'checkpoint.last_model': model, 'checkpoint.last_prompt': prompt.name, 'checkpoint.updated_at': new Date() }
                    }).catch(() => {}); // best-effort, don't block execution

                    if (execResult?.infraError) {
                        consecutiveInfraErrors++;
                        logger.warn('Infra error on prompt — re-warming model before next prompt', { batchId, model, host: hostUrl, consecutiveInfraErrors });
                        try {
                            await setBatchPhase('warmup', `Recovery warmup: ${model} on ${hostUrl}`);
                            await warmupModel(hostUrl, model, {
                                timelinePrefix: 'infra_recovery_warmup',
                                recordTimelineEvent: recordBatchTimelineEvent,
                                num_ctx: modelExecConfig.num_ctx || null,
                                onPhaseDetail: (detail) => setBatchPhase('warmup', detail),
                                claimIdentity: claimIdentityFor(hostUrl),
                                assertClaimActive
                            });
                            await setBatchPhase('executing', null);
                            logger.info('Model recovered after infra error', { batchId, model, host: hostUrl });
                        } catch (recoveryErr) {
                            logger.error('Model recovery warmup failed', { batchId, model, host: hostUrl, error: recoveryErr.message });
                        }
                        // Bail out of repeat loop on infra error — outer prompt loop's
                        // circuit breaker handles whether to continue.
                        break;
                    } else {
                        consecutiveInfraErrors = 0;
                    }

                    promptsCompletedForModel += 1;

                    // Judge runs async; once enough prompts have been generated for
                    // this model, evaluateAndPersistEarlyStop checks already-judged
                    // results in DB and decides whether the running quality average
                    // is low enough to halt remaining prompts for this model only.
                    if (!earlyStopped && promptsCompletedForModel >= EARLY_STOP_MIN_JUDGED) {
                        earlyStopped = await evaluateAndPersistEarlyStop({
                            batchId, model, hostUrl, recordBatchTimelineEvent
                        });
                        if (earlyStopped) break;
                    }
                }
                if (earlyStopped) break;
            }
        } finally {
            await flushModelTimeline(pendingModelTimeline);
        }
    };

    const runHostBatch = async (hostUrl, hostModels) => {
        if (await shouldStopBatch(null, { force: true })) {
            return { stopped: true, cancelled: false };
        }

        // Resolve the judge host once per host group. If this fails, the whole
        // host group is unrecoverable (no judge available) — that's the only
        // "host-level" failure left worth aborting the group for.
        let judgeHostUrl;
        try {
            judgeHostUrl = await resolveJudgeTargetForHost(hostUrl);
        } catch (hostErr) {
            logger.error('Host execution failed - judge resolution error, skipping all models on this host', {
                batchId,
                host: hostUrl,
                models: hostModels,
                error: hostErr.message,
                stack: hostErr.stack
            });
            await recordBatchTimelineEvent('host_execution_failed', {
                host: hostUrl,
                models: hostModels,
                error: hostErr.message
            }).catch((err) => logger.error('Failed to record host failure event', { error: err.message }));
            // Whole host group is unrecoverable (no judge) — blocked, not warning.
            // Allowed mid-critical: blocked is never silenced.
            buddySurface.emitLifecycle(
                'run_blocked',
                `Host failed — judge unavailable on ${hostUrl}; skipping ${hostModels.length} model(s).`
            );
            return { stopped: false, cancelled: false };
        }

        // 0212: per-model try/catch so model #1 throwing (typically warmupModel
        // rejecting on cold-load or VRAM exhaustion) doesn't silently skip
        // models #2..N. Pre-fix, a single throw in the outer loop bailed the
        // whole host group; this is what produced 0207 order 5's completed=0/315
        // (filed + symptom-handled by 0209's zero-cells finalizer guard).
        for (const model of hostModels) {
            if (await shouldStopBatch(model, { force: true })) {
                logger.info('Stopping host model loop because batch is stopped', { batchId, host: hostUrl, model });
                return { stopped: true, cancelled: false };
            }

            const modelStartedAt = new Date();
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                { $push: { model_timings: { model, started_at: modelStartedAt, completed_at: null, duration_ms: null } } }
            ).catch((err) => logger.warn('Failed to record model start timing', { batchId, model, error: err.message }));

            let stopAfterModel = null;
            try {
                const modelResult = await runModelPromptLoop(hostUrl, judgeHostUrl, model);
                if (modelResult?.stopped) {
                    stopAfterModel = modelResult;
                }
            } catch (modelErr) {
                logger.error('Model execution failed - continuing with next model on this host', {
                    batchId,
                    host: hostUrl,
                    model,
                    error: modelErr.message,
                    stack: modelErr.stack
                });
                await recordBatchTimelineEvent('model_execution_failed', {
                    host: hostUrl,
                    model,
                    error: modelErr.message
                }).catch((err) => logger.error('Failed to record model failure event', { error: err.message }));
                // One model failed but the batch continues — warning, not blocked.
                // Allowed mid-critical: warning is never silenced.
                buddySurface.emitLifecycle('run_warning', `Model failed and was skipped: ${model} on ${hostUrl}.`);
                // Resume-blocked errors must fail the whole batch closed, not be
                // swallowed by the per-model catch that was added for 0212.
                if (modelErr.resumeBlocked === true) {
                    throw modelErr;
                }
                // Fall through to record model_timings completion so the failed
                // model shows up in the timeline with a duration.
            }

            const modelCompletedAt = new Date();
            const modelDurationMs = modelCompletedAt - modelStartedAt;
            await BenchmarkBatch.updateOne(
                { _id: batchId, 'model_timings.model': model },
                { $set: { 'model_timings.$.completed_at': modelCompletedAt, 'model_timings.$.duration_ms': modelDurationMs } }
            ).catch((err) => logger.warn('Failed to record model complete timing', { batchId, model, error: err.message }));
            if (stopAfterModel) {
                return stopAfterModel;
            }
        }
        return { stopped: false, cancelled: false };
    };


    if (isResuming && requestedHostGroups.length > 0) {
        await setBatchPhase('contract', `Resuming: verifying frozen campaign snapshot for ${lastCheckpointModel || 'next model'}…`);
        inferenceContractCampaign = await resumeRevalidation.loadFrozenCampaign({
            hostGroups: requestedHostGroups,
            executionConfig
        });
        executionHostGroups = await resumeRevalidation.selectPendingHostGroups(
            inferenceContractCampaign,
            requestedHostGroups,
            prompts,
            executionConfig
        );
    }

    const executionModels = executionModelsFromHostGroups(executionHostGroups);
    const preflightResult = await checkBatchPreflight({
        batchId,
        executionModels,
        setBatchPhase
    });
    const { allowanceMs: preflightAllowanceMs } = preflightCounts(preflightResult);
    const hostUrls = executionHostGroups.map(([url]) => url);

    // Include judge hosts in dedication detection so pinned models get unloaded there too
    const judgeSourceHosts = hostUrls.length > 0
        ? hostUrls
        : requestedHostGroups.map(([url]) => url);
    const judgeHostUrls = judgeConfig.target?.executionKind === 'harness'
        ? []
        : [...new Set([
            ...judgeSourceHosts.map(url => resolveJudgeHost(url, judgeConfig).judgeHost),
            ...(judgeSourceHosts.length === 0 && judgeConfig.host ? [judgeConfig.host] : [])
        ].filter(Boolean))];
    const allAffectedHosts = [...new Set([...hostUrls, ...judgeHostUrls])];

    // Server-side profiling guard: refuse to start while a profiler run or
    // profile queue owns any affected host. The UI enforces this lockout in
    // the browser, but out-of-band launches (curl, scripts, another tab) must
    // hit the same wall here.
    assertNoActiveProfiling(allAffectedHosts);

    await setBatchPhase('dedication', `Detecting host dedication on ${allAffectedHosts.length} host(s)…`);
    let dedicationState = new Map();
    try {
        if (allAffectedHosts.length > 0) {
            dedicationState = await detectDedication(allAffectedHosts, {
                batchId,
                recordBatchTimelineEvent,
                failClosed: isResuming
            });
        }
    } catch (error) {
        await resumeRevalidation.fail(error, RESUME_CODES.PIN_DETECTION_FAILED);
    }

    // Announce to core that these hosts are in use for the duration of the
    // batch. Other consumers (chat, buddy, bounded API clients) can see status==='benchmarking'
    // on HostPreference and route around them. Claiming is a hard startup
    // guard: if any affected host cannot be reserved, the batch aborts before
    // releasing pinned models.
    //
    // Estimate calc: hosts run in parallel (hostGroups), so hostUrls.length
    // is NOT a multiplier. Models on the same host run serially within the
    // host task. We extend the claim through the post-execution judge drain
    // window so the reaper doesn't drop the signal while judge work is still
    // in flight. Core still caps the stored estimate at 2h.
    // Preflight auto-profiling now runs under this claim (see stage 2 below),
    // so its duration must be part of the estimate: a standard profile is
    // ~20 min, plus short orchestration overhead. Core still caps the stored estimate.
    const claimEstimateMs = estimateBenchmarkClaimDurationMs({
        hostCount: hostUrls.length,
        modelCount: executionModels.length,
        promptCount: prompts.length,
        executionConfig,
        executionMode,
        judgeConfig
    }) + preflightAllowanceMs;
    await setBatchPhase('claiming', `Reserving ${allAffectedHosts.length} host(s) with core…`);
    let claimedHostUrls;
    try {
        claimedHostUrls = await acquireBenchmarkClaims(allAffectedHosts, batchId, claimEstimateMs, {
            kind: harnessTargets.length > 0 || judgeConfig.target?.executionKind === 'harness'
                ? 'benchmark-cloud'
                : 'benchmark',
            source: 'benchmark'
        });
    } catch (error) {
        if (!isResuming) throw error;
        await resumeRevalidation.fail(error, RESUME_CODES.CLAIM_ACQUISITION_FAILED);
    }
    const stopClaimHeartbeat = startBenchmarkClaimHeartbeat(
        claimedHostUrls,
        batchId,
        claimEstimateMs,
        {
            onFatal: error => {
                if (!batchCancellationController.signal.aborted) {
                    batchCancellationController.abort(error);
                }
                // Child Core and harness requests own separate controllers.
                // Abort the whole registered set immediately on lease loss;
                // waiting for their next checkpoint would let stale work run.
                abortActiveBatchRequests(batchId, {
                    reason: error,
                    userInitiated: false
                });
            }
        }
    );
    await stopClaimHeartbeat.ready;
    try {
        stopClaimHeartbeat.assertActive();
    } catch (error) {
        if (typeof stopClaimHeartbeat.drain === 'function') await stopClaimHeartbeat.drain();
        else stopClaimHeartbeat();
        await releaseBenchmarkClaims(claimedHostUrls, batchId);
        throw error;
    }
    assertClaimActive = stopClaimHeartbeat.assertActive;
    await recordBatchTimelineEvent('benchmark_claim_acquired', {
        hosts: claimedHostUrls,
        requested: allAffectedHosts,
        estimatedDurationMs: claimEstimateMs
    }).catch(() => {});
    let hostLifecycleFinalized = false;
    const finalizeHostLifecycle = async () => {
        if (hostLifecycleFinalized) {
            return;
        }
        hostLifecycleFinalized = true;
        if (typeof stopClaimHeartbeat.drain === 'function') await stopClaimHeartbeat.drain();
        else stopClaimHeartbeat();

        const release = await releaseBenchmarkClaims(claimedHostUrls, batchId);
        await recordBatchTimelineEvent(release.failed > 0 ? 'benchmark_claim_release_failed' : 'benchmark_claim_released', {
            hosts: claimedHostUrls,
            ...(release.failed > 0 ? { failed: release.failed } : {})
        }).catch(() => {});
        if (release.failed > 0) {
            const detail = release.details?.find(item => !item.released);
            const error = new Error(
                detail?.reason
                || release.workloadAdmission?.reason
                || 'Benchmark runtime restore/release failed'
            );
            error.code = 'BENCHMARK_RUNTIME_RESTORE_FAILED';
            error.release = release;
            throw error;
        }
    };

    // Registered only once claim/dedication lifecycle protection exists. From
    // this point a stop aborts both prompt requests and the local judge queue.
    unregisterBatchCancellation = registerActiveBatchController(batchId, batchCancellationController);

    try {
        assertClaimActive();
        if (dedicationState.size > 0) {
            try {
                await releaseAllDedication(dedicationState, {
                    batchId,
                    recordBatchTimelineEvent,
                    failClosed: isResuming
                });
            } catch (error) {
                if (!isResuming) throw error;
                await resumeRevalidation.fail(
                    error,
                    RESUME_CODES.PIN_RELEASE_FAILED,
                    error.resumeContext
                );
            }
        }
        if (isResuming && requestedHostGroups.length > 0) await resumeRevalidation.recordReady(executionHostGroups);
        await runBatchPreflight({
            preflightResult,
            batchId,
            defaultHost,
            setBatchPhase,
            recordBatchTimelineEvent,
            assertClaimActive,
            claimIdentityFor,
            signal: batchCancellationController.signal
        });

        if (!isResuming && requestedHostGroups.length > 0) {
            await setBatchPhase('contract', 'Freezing deployed artifact and inference budgets for this campaign…');
            inferenceContractCampaign = await loadOrResolveCampaignInferenceContracts({
                batchId,
                hostGroups: requestedHostGroups,
                executionConfig,
                recordBatchTimelineEvent
            });
        }
        const hostTasks = executionHostGroups
            .map(([hostUrl, hostModels]) => async () => runHostBatch(hostUrl, hostModels));
        const harnessTasks = harnessTargets.map((target) => async () => runHarnessTarget(target));
        const executionTasks = [...hostTasks, ...harnessTasks];

        const hostOutcomes = [];
        if (executionMode === 'latency') {
            for (const task of executionTasks) {
                const outcome = await task();
                hostOutcomes.push(outcome);
                if (outcome?.stopped) break;
            }
        } else {
            hostOutcomes.push(...await Promise.all(executionTasks.map((task) => task())));
        }

        await flushBatchProgress(true);
        const stoppedOutcome = hostOutcomes.find((outcome) => outcome?.stopped);
        const cancelledAfterExecution = hostOutcomes.some((outcome) => outcome?.cancelled === true);
        const stoppedAfterExecution = stoppedOutcome || await shouldStopBatch(null, { force: true });
        if (stoppedAfterExecution) {
            executionState.stopped = true;
            await cancelAndDrainJudgeQueue();
            handleGracefulStop();
            return {
                stopped: true,
                cancelled: cancelledAfterExecution
            };
        }

        await setBatchPhase('judging', 'Draining judge queue…');
        // Enter the critical judge/scoring window. While active, buddySurface
        // suppresses suggesting/idle (quiet-during-critical); watching +
        // warning/blocked still pass. endJudgePhase() runs in finally so a
        // throw mid-drain cannot leave Buddy permanently muted.
        buddySurface.beginJudgePhase();
        buddySurface.emitLifecycle('judge_start', 'Judging responses…');
        try {
            await enqueueDeferredJudgeTasks();
            await drainJudgeQueue();
        } catch (error) {
            if (batchCancellationController.signal.aborted) {
                executionState.stopped = true;
                await cancelAndDrainJudgeQueue(error);
                handleGracefulStop();
                return { stopped: true, cancelled: true };
            }
            throw error;
        } finally {
            buddySurface.emitLifecycle('judge_done', 'Judging complete.');
            buddySurface.endJudgePhase();
        }
        orchestrationCompleted = true;
        return { stopped: false, cancelled: false };
    } finally {
        try {
            if (!orchestrationCompleted || executionState.stopped || batchCancellationController.signal.aborted) {
                await cancelAndDrainJudgeQueue();
            } else {
                disposeCancellationListener();
            }
        } finally {
            unregisterBatchCancellation();
            await finalizeHostLifecycle();
        }
    }
}

/**
 * Throw when any of the given hosts has an active profiler run or profile
 * queue. Server-side counterpart of the browser profiling lockout — the batch
 * must never unload models out from under a running profile.
 */
function assertNoActiveProfiling(hostUrls) {
    for (const hostUrl of hostUrls) {
        const activeProfiling = findActiveProfilingForHost({ hostUrl });
        if (activeProfiling.length > 0) {
            const active = activeProfiling[0];
            const what = active.type === 'profile-host'
                ? `profile queue (${active.currentModel || 'starting'}, ${active.currentIndex + 1}/${active.total})`
                : `profile job (${active.modelName})`;
            const err = new Error(
                `Host ${hostUrl} has an active ${what}. Wait for profiling to finish before launching a benchmark.`
            );
            err.conflict = 'profiling_active';
            err.hostUrl = hostUrl;
            throw err;
        }
    }
}

module.exports = {
    runBatchOrchestrator,
    abortActiveBatchRequests,
    assertNoActiveProfiling,
    // Exposed for unit testing — not part of the stable API
    _registerActiveBatchController: registerActiveBatchController,
    _getActiveBatchRequestCount: getActiveBatchRequestCount,
    _acquireBenchmarkClaims: acquireBenchmarkClaims,
    _releaseBenchmarkClaims: releaseBenchmarkClaims,
    _estimateBenchmarkClaimDurationMs: estimateBenchmarkClaimDurationMs
};
