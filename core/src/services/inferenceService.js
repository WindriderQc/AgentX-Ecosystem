'use strict';

const logger = require('../../config/logger');
const { normalizeHostUrl, validateHostUrl } = require('../helpers/ollamaHostConfig');
const { ensureTaskModelOverridesLoaded, getAdvisoryModelForTask, getModelForTask, getRoutingConfigVersion } = require('./modelRouterConfig');
const { getTargetForModel, recordInference, resolveHostKey } = require('./modelRouter');
const { emit: emitBuddyEvent } = require('./buddyEvents');
const { getModelReadiness } = require('./modelReadinessService');
const { scheduleShadowEvaluation } = require('./routing/shadowEvaluation');
const { buildRouteDecision, DECISION_MODES, REJECTION_REASONS, ROUTE_OUTCOME_CODES, ROUTE_OUTCOME_STAGES, fingerprintRuntimeOptions } = require('./routing/routeDecision');
const { tryDegradedResponse } = require('./routing/degradedRetryResponse');
const { executeAdmittedOllamaAttempt } = require('./routing/inferenceAttemptExecutor');
const { buildInferenceClientData, classifyHttpRetryFailure, buildInferenceResponseHeaders, setRouteOutcomeHeader } = require('./routing/inferenceResponsePresenter');
const { prepareInferenceRuntime } = require('./inferenceRuntimePolicy');
const lanePolicy = require('./inferenceLanePolicy');
const { resolveCallerPolicy } = require('./routing/callerPolicy');
const { assertHostAvailableForConsumer } = require('./benchmarkClaimGuard');
const alertService = require('./alertService');
const { summarizeOllamaOutcome } = require('./laneObservabilityService');

const INFERENCE_FETCH_TIMEOUT_MS = parseInt(process.env.INFERENCE_FETCH_TIMEOUT_MS, 10) || 600000;

function safeRoutingConfigVersion() {
    return typeof getRoutingConfigVersion === 'function'
        ? getRoutingConfigVersion()
        : 'router-unversioned-v1';
}

function requireProfiledModels() {
  return process.env.REQUIRE_PROFILED_MODELS === 'true';
}

function buildMessageShape(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.slice(-6).map((message, index) => {
        const content = typeof message?.content === 'string' ? message.content : '';
        const role = ['system', 'user', 'assistant', 'tool'].includes(message?.role)
            ? message.role
            : 'other';
        return {
            index: Math.max(0, messages.length - 6) + index,
            role,
            chars: content.length,
        };
    });
}

function buildRequestSummary({ prompt, messages, system, options, stream, think, keepAlive }) {
    return {
        mode: Array.isArray(messages) ? 'chat' : 'generate',
        promptChars: typeof prompt === 'string' ? prompt.length : 0,
        systemChars: typeof system === 'string' ? system.length : 0,
        messageCount: Array.isArray(messages) ? messages.length : 0,
        messageShape: buildMessageShape(messages),
        optionsFingerprint: fingerprintRuntimeOptions(options),
        stream: stream === true,
        thinkConfigured: think !== undefined,
        keepAliveConfigured: keepAlive !== undefined,
    };
}

function summarizeRecommendation(recommendation) {
    if (!recommendation) return null;
    const scheduler = recommendation.recommendation || null;
    return {
        model: recommendation.model || null,
        host: recommendation.host || null,
        hostUrl: recommendation.url || null,
        source: recommendation.source || null,
        reason: recommendation.reason || null,
        claimId: recommendation.claimId || null,
        claimExpiresAt: recommendation.claimExpiresAt || null,
        readiness: recommendation.readiness || null,
        scheduler: scheduler ? {
            host: scheduler.host || null,
            hostUrl: scheduler.hostUrl || null,
            reason: scheduler.reason || null,
            confidence: scheduler.confidence || null,
            warnings: Array.isArray(scheduler.warnings) ? scheduler.warnings : [],
            scored: Array.isArray(scheduler._scored) ? scheduler._scored : []
        } : null
    };
}

function buildRoutingDifference(trace) {
    const reasons = [];
    const recommendation = trace.recommendation;
    const selected = trace.selected || {};
    const requested = trace.request || {};

    if (requested.hostOverride) {
        reasons.push(`Caller supplied host override "${requested.hostOverride}".`);
    }

    if (recommendation?.host && selected.hostKey && recommendation.host !== selected.hostKey) {
        reasons.push(`Selected host ${selected.hostKey} differs from recommended host ${recommendation.host}.`);
    }

    if (recommendation?.hostUrl && selected.hostUrl && normalizeHostUrl(recommendation.hostUrl) !== normalizeHostUrl(selected.hostUrl)) {
        reasons.push(`Selected host URL differs from recommendation.`);
    }

    if (recommendation?.scheduler?.reason) {
        reasons.push(`Scheduler reason: ${recommendation.scheduler.reason}.`);
    } else if (recommendation?.reason) {
        reasons.push(`Router reason: ${recommendation.reason}.`);
    }

    if (reasons.length === 0) {
        reasons.push(recommendation ? 'Actual path matched the router recommendation.' : 'Direct path; no task recommendation was requested.');
    }

    return {
        differsFromRecommendation: !!(
            requested.hostOverride
            || (recommendation?.host && selected.hostKey && recommendation.host !== selected.hostKey)
            || (recommendation?.hostUrl && selected.hostUrl && normalizeHostUrl(recommendation.hostUrl) !== normalizeHostUrl(selected.hostUrl))
        ),
        reasons
    };
}

/** Execute a generation request without HTTP, sockets, or response mutation.
 * Caller policy and attribution are resolved at the transport boundary.
 * An undefined result means the caller cancelled; no response should be sent.
 */
async function executeInference(body = {}, {
    callerContext, telemetryContext = { runtime: 'agentx', attempt: 1 },
    consumerContract = null, signal, timeoutMs = INFERENCE_FETCH_TIMEOUT_MS,
} = {}) {
    const headers = {};
    const result = (status, data) => ({ ok: status >= 200 && status < 300, status, body: data, headers });
    const isCancelled = () => signal?.aborted === true;
    if (isCancelled()) return undefined;
    if (!callerContext) {
        const policy = resolveCallerPolicy(body.callerDetail || '');
        callerContext = { principal: 'core-inference', requestedPolicy: policy, effectivePolicy: policy };
    }
    const startedAt = Date.now();
    const requestedModel = typeof body.model === 'string' ? body.model.trim() : '';
    const taskType = typeof body.taskType === 'string' ? body.taskType.trim() : '';
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : '';
    const messages = Array.isArray(body.messages) ? body.messages : null;
    const system = typeof body.system === 'string' ? body.system : undefined;
    const stream = body.stream === true;
    const responseMode = typeof body.responseMode === 'string' ? body.responseMode.trim().toLowerCase() : '';
    const rawResponseRequested = body.rawResponse === true || responseMode === 'raw';
    // num_ctx policy:
    // - explicit caller options always win (benchmark/profiler/direct sweeps)
    // - routed daily lanes may inherit HostPreference.pinnedModels[*].contextSize
    // - routed daily lanes enforce the inference contract's output reserve as
    //   num_predict so Modelfile defaults cannot silently cap replies at 512
    let options = { ...(body.options || {}) };
    let numCtxSource = options.num_ctx != null ? 'caller' : 'modelfile';
    const requestedThink = body.think;
    let think = requestedThink;
    const thinkingMode = body.thinkingMode ?? body.thinking_mode;
    let keepAlive = body.keep_alive ?? body.keepAlive;
    const hostOverride = typeof body.host === 'string' ? body.host.trim() : '';
    const crossModelFallbackOptIn = body.allowCrossModelFallback === true;

    const { name: laneName, policy: lane } = lanePolicy.resolvePolicyLane(
        callerContext.effectivePolicy
    );
    const benchmarkClaimAuthorized = callerContext.principal === 'benchmark-service'
        && laneName === 'direct';
    const requestedTools = body.tools;
    if (requestedTools !== undefined
        && (!benchmarkClaimAuthorized || !Array.isArray(requestedTools) || requestedTools.length > 64)) {
        return result(benchmarkClaimAuthorized ? 400 : 403, {
            status: 'error',
            code: benchmarkClaimAuthorized ? 'INFERENCE_TOOLS_INVALID' : 'INFERENCE_TOOLS_FORBIDDEN',
            message: benchmarkClaimAuthorized
                ? 'Benchmark tool schemas must be a bounded array.'
                : 'Native tool schemas are restricted to an authenticated benchmark campaign.'
        });
    }
    if (callerContext.principal === 'benchmark-service'
        && (!body.workloadAdmissionId || !body.workloadGeneration)) {
        return result(403, {
            status: 'error',
            code: 'BENCHMARK_WORKLOAD_PROOF_REQUIRED',
            message: 'Benchmark inference requires an exact Core-minted workload admission id and generation'
        });
    }
    const routeManaged = lane.route === true && !hostOverride;

    let model = requestedModel;
    let target = null;
    let routedHostKey = null;
    let safeRequestedHost = null;
    let routingSource = hostOverride ? 'host_override' : 'model_router';

    let decisionMode = DECISION_MODES.DEFAULT;
    if (hostOverride || (requestedModel && !taskType)) decisionMode = DECISION_MODES.EXPLICIT_MODEL;
    else if (taskType) decisionMode = DECISION_MODES.EXPLICIT_TASK;

    const requestedPolicy = callerContext.requestedPolicy?.id || null;
    const effectivePolicy = callerContext.effectivePolicy?.id || null;
    const policyDowngraded = Boolean(
        requestedPolicy && effectivePolicy && requestedPolicy !== effectivePolicy
    );

    /** One payload-free builder for persisted attempts and structured rejects. */
    const buildGenerateRouteDecision = ({
        selectedModel = model || null,
        selectedHost = routedHostKey || resolveHostKey(target),
        selectedHostUrl = target,
        primaryModel = model || null,
        primaryHost = routedHostKey || resolveHostKey(target),
        primaryHostUrl = target,
        selectionSource = routingSource,
        attempt = telemetryContext.attempt,
        attemptOptions,
        fallbackUsed = false,
        fallbackReason = null,
        rejections = [],
        outcomeStage = ROUTE_OUTCOME_STAGES.UNKNOWN,
        outcomeCode = ROUTE_OUTCOME_CODES.UNKNOWN,
        outcomeReasonCode = null,
        durationMs = Date.now() - startedAt,
    } = {}) => {
        try {
            return buildRouteDecision({
                configVersion: safeRoutingConfigVersion(),
                mode: decisionMode,
                taskType: taskType || null,
                caller: 'proxy',
                callerDetail: body.callerDetail || null,
                consumerContract,
                correlationId: telemetryContext.correlationId,
                workItemId: telemetryContext.workItemId,
                runtime: telemetryContext.runtime,
                attempt,
                requestedModel: requestedModel || null,
                requestedHost: resolveHostKey(safeRequestedHost),
                requestedHostUrl: safeRequestedHost,
                primaryModel,
                primaryHost,
                primaryHostUrl,
                selectedModel,
                selectedHost,
                selectedHostUrl,
                selectionSource,
                requestedPolicy,
                effectivePolicy,
                effectiveLane: laneName,
                policyDowngraded,
                outcomeStage,
                outcomeCode,
                outcomeReasonCode,
                rejections,
                fallbackUsed,
                fallbackReason,
                degraded: Boolean(fallbackUsed),
                degradedReason: fallbackReason,
                runtimeOptions: attemptOptions,
                totalMs: durationMs,
            });
        } catch (err) {
            logger.debug('[InferenceProxy] route decision build failed', { error: err.message });
            return null;
        }
    };

    const observeRouteDecision = (routeDecision) => {
        logger.info('[InferenceProxy] route outcome', {
            routeDecision,
            outcomeCode: routeDecision?.outcome?.code || ROUTE_OUTCOME_CODES.UNKNOWN,
        });
        return routeDecision;
    };

    const observeRouteOutcome = (evidence) => (
        observeRouteDecision(buildGenerateRouteDecision(evidence))
    );

    const rejectRoute = ({ status, payload, ...evidence }) => {
        observeRouteOutcome(evidence);
        setRouteOutcomeHeader(headers, evidence.outcomeCode);
        return result(status, payload);
    };

    try {
    if (!requestedModel && !taskType) {
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.VALIDATION,
            outcomeCode: ROUTE_OUTCOME_CODES.REQUEST_TARGET_REQUIRED,
            payload: { status: 'error', message: 'model or taskType is required' },
        });
    }
    if (!prompt && !messages) {
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.VALIDATION,
            outcomeCode: ROUTE_OUTCOME_CODES.REQUEST_PAYLOAD_REQUIRED,
            payload: { status: 'error', message: 'prompt or messages is required' },
        });
    }

    // Allowlist check (task 0182). When the caller passes a `host` string it
    // MUST resolve to a configured Ollama host (URL allowlist with loopback
    // equivalence, or by host name/id). When the field is absent we fall
    // through to model-router resolution unchanged.
    const generateHostCheck = validateHostUrl(hostOverride);
    if (!generateHostCheck.valid) {
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.POLICY,
            outcomeCode: ROUTE_OUTCOME_CODES.HOST_OVERRIDE_REJECTED,
            rejections: [{ model: requestedModel || null, reason: REJECTION_REASONS.POLICY_EXCLUDED }],
            payload: { status: 'error', message: generateHostCheck.message },
        });
    }
    const allowlistedHostOverride = generateHostCheck.host || '';
    safeRequestedHost = allowlistedHostOverride || null;
    const routingTrace = {
        version: 1,
        request: {
            requestedModel: requestedModel || null,
            taskType: taskType || null,
            hostOverride: safeRequestedHost,
            callerDetail: body.callerDetail || null,
            lane: laneName,
            laneRoutesTasks: lane.route === true,
            crossModelFallbackOptIn,
            routeManaged,
            summary: null
        },
        lane: {
            name: laneName,
            route: lane.route === true,
            admit: lane.admit !== false,
            recordInferenceSync: lane.recordInferenceSync === true,
            alert: lane.alert
        },
        configured: null,
        recommendation: null,
        selected: null,
        artifactResolution: null,
        ollama: null,
        difference: null
    };

    if (lane.route && !model && taskType) {
        await ensureTaskModelOverridesLoaded();
        const configured = getModelForTask(taskType) || {};
        routingTrace.configured = {
            model: configured.model || null,
            host: configured.host || null,
            hostUrl: configured.url || null
        };
        const recommendation = await getAdvisoryModelForTask(taskType, {
            caller: body.callerDetail || 'inference-proxy',
            durationMs: Number(body.durationMs) || 30000,
            createSoftClaim: true
        });
        routingTrace.recommendation = summarizeRecommendation(recommendation);
        model = recommendation.model;
        target = hostOverride
            ? normalizeHostUrl(allowlistedHostOverride)
            : normalizeHostUrl(recommendation.url);
        routedHostKey = hostOverride ? resolveHostKey(target) : (recommendation.host || resolveHostKey(target));
        routingSource = hostOverride ? 'host_override' : (recommendation.source || 'task_router');
    } else if (!lane.route && !model && taskType) {
        // Direct lane: bench/profiler must specify model + host explicitly.
        // We do not run task→model routing for direct callers — they self-route.
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.POLICY,
            outcomeCode: ROUTE_OUTCOME_CODES.DIRECT_MODEL_REQUIRED,
            rejections: [{ reason: REJECTION_REASONS.POLICY_EXCLUDED }],
            payload: {
                status: 'error',
                message: 'direct-lane callers must specify `model` (and optionally `host`); taskType routing is not run for this lane'
            },
        });
    } else {
        target = hostOverride
            ? normalizeHostUrl(allowlistedHostOverride)
            : normalizeHostUrl(getTargetForModel(model));
        routedHostKey = resolveHostKey(target);
        routingTrace.recommendation = hostOverride ? null : {
            model,
            host: routedHostKey || null,
            hostUrl: target,
            source: 'model_target',
            reason: 'Selected from model-to-host routing because no task-only recommendation was requested.',
            claimId: null,
            claimExpiresAt: null,
            readiness: null,
            scheduler: null
        };
    }

    if (!target) {
        const blockedByClaim = routingTrace.recommendation?.source === 'scheduler-blocked'
            || routingTrace.recommendation?.scheduler?.blockedByBenchmarkClaim === true;
        return rejectRoute({
            status: blockedByClaim ? 503 : 500,
            outcomeStage: ROUTE_OUTCOME_STAGES.SELECTION,
            outcomeCode: blockedByClaim
                ? ROUTE_OUTCOME_CODES.BENCHMARK_CLAIMED
                : ROUTE_OUTCOME_CODES.NO_HOST_AVAILABLE,
            rejections: [{
                model: model || null,
                reason: blockedByClaim
                    ? REJECTION_REASONS.BENCHMARK_CLAIMED
                    : REJECTION_REASONS.HOST_UNCONFIGURED,
            }],
            payload: {
                status: 'error',
                code: blockedByClaim ? 'NO_UNCLAIMED_OLLAMA_HOST' : undefined,
                message: blockedByClaim
                    ? (routingTrace.recommendation?.reason || `No unclaimed Ollama host available for request: ${taskType || model}`)
                    : `No Ollama host configured for request: ${taskType || model}`
            },
        });
    }

    try {
        await assertHostAvailableForConsumer(target, {
            callerDetail: body.callerDetail || null,
            claimBatchId: body.claimBatchId || null,
            claimGeneration: body.claimGeneration || null,
            workloadAdmissionId: body.workloadAdmissionId || null,
            workloadGeneration: body.workloadGeneration || null,
            benchmarkAuthorized: benchmarkClaimAuthorized,
            model,
            path: '/api/inference/generate'
        });
    } catch (err) {
        const benchmarkClaim = err?.code === 'BENCHMARK_CLAIM_ACTIVE';
        if (Number.isFinite(err.retryAfterMs)) headers['Retry-After'] = String(Math.max(1, Math.ceil(err.retryAfterMs / 1000)));
        return rejectRoute({
            status: err.statusCode || 503,
            outcomeStage: ROUTE_OUTCOME_STAGES.ADMISSION,
            outcomeCode: benchmarkClaim
                ? ROUTE_OUTCOME_CODES.BENCHMARK_CLAIMED
                : ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR,
            outcomeReasonCode: err.code || 'BENCHMARK_CLAIM_ACTIVE',
            rejections: benchmarkClaim ? [{
                model,
                host: routedHostKey || resolveHostKey(target),
                hostUrl: target,
                reason: REJECTION_REASONS.BENCHMARK_CLAIMED,
            }] : [],
            payload: {
                status: 'error',
                code: err.code || 'BENCHMARK_CLAIM_ACTIVE',
                message: err.message,
                data: {
                    host: err.hostUrl || target,
                    batchId: err.batchId || null,
                    lane: laneName,
                    ...(Number.isFinite(err.retryAfterMs) && {
                        retryAfterMs: Math.max(0, err.retryAfterMs),
                        holdExpiresAt: err.holdExpiresAt || null,
                        holdModel: err.holdModel || null
                    })
                }
            },
        });
    }

    // Exact-artifact invariant: never rewrite the caller-selected model tag.
    if (body.useAdapted === true) {
        return rejectRoute({
            status: 400,
            outcomeStage: ROUTE_OUTCOME_STAGES.POLICY,
            outcomeCode: ROUTE_OUTCOME_CODES.ADAPTED_MODEL_RETIRED,
            rejections: [{
                model,
                host: routedHostKey || resolveHostKey(target),
                hostUrl: target,
                reason: REJECTION_REASONS.POLICY_EXCLUDED,
            }],
            payload: {
                status: 'error',
                code: 'ADAPTED_MODEL_RESOLUTION_RETIRED',
                message: 'useAdapted is retired; request the exact installed model tag explicitly'
            },
        });
    }
    const artifactResolution = {
        source: 'exact_artifact',
        requested: model,
        resolved: model,
        rewritten: false
    };
    routingTrace.artifactResolution = artifactResolution;

    if (lane.route && requireProfiledModels()) {
        const readinessState = await getModelReadiness(model, target);
        if (readinessState.readiness?.isReady !== true) {
            return rejectRoute({
                status: 409,
                outcomeStage: ROUTE_OUTCOME_STAGES.QUALIFICATION,
                outcomeCode: ROUTE_OUTCOME_CODES.MODEL_PROFILE_REQUIRED,
                rejections: [{
                    model,
                    host: routedHostKey || resolveHostKey(target),
                    hostUrl: target,
                    reason: REJECTION_REASONS.CAPABILITY_UNQUALIFIED,
                }],
                payload: {
                    status: 'error',
                    message: `Model "${model}" is not profiled on the selected host. Enable profiling first or disable REQUIRE_PROFILED_MODELS.`,
                    data: {
                        model,
                        host: target,
                        readiness: readinessState.readiness
                    }
                },
            });
        }
    }

    const runtime = await prepareInferenceRuntime({
        model, host: target, prompt, messages, system, options, keepAlive,
        think, thinkingMode, taskType, callerDetail: body.callerDetail,
        laneName, rawResponseRequested, stream,
        includeArtifactIdentity: requireProfiledModels(),
    }, lane.route ? 'generate' : 'direct');
    ({ options, keepAlive, numCtxSource } = runtime);
    const { inferenceContract, thinkingPolicy } = runtime;
    if (numCtxSource === 'host_preference_pin') routingSource += '+pin-ctx';
    if (requireProfiledModels() && inferenceContract.qualification?.qualified !== true) {
        return rejectRoute({
            status: 409,
            outcomeStage: ROUTE_OUTCOME_STAGES.QUALIFICATION,
            outcomeCode: ROUTE_OUTCOME_CODES.ARTIFACT_QUALIFICATION_REQUIRED,
            rejections: [{
                model,
                host: routedHostKey || resolveHostKey(target),
                hostUrl: target,
                reason: REJECTION_REASONS.CAPABILITY_UNQUALIFIED,
            }],
            payload: {
                status: 'error',
                code: 'EXACT_ARTIFACT_PROFILE_REQUIRED',
                message: `Model "${model}" is not qualified for this exact host digest/runtime. Re-profile it before inference.`,
                data: { model, host: target, qualification: inferenceContract.qualification, artifact: inferenceContract.artifact }
            },
        });
    }
    think = thinkingPolicy.think;
    routingTrace.thinking = thinkingPolicy;
    routingTrace.inferenceContract = inferenceContract;

    // Choose Ollama API: /api/chat if messages provided, else /api/generate
    const useChat = !!messages;
    const ollamaUrl = `${target}/api/${useChat ? 'chat' : 'generate'}`;

    const ollamaPayload = useChat
        ? {
            model,
            messages,
            stream,
            options,
            ...(requestedTools !== undefined && { tools: requestedTools }),
            ...(think !== undefined && { think }),
            ...(keepAlive !== undefined && { keep_alive: keepAlive })
        }
        : { model, prompt, system, stream, options, ...(think !== undefined && { think }), ...(keepAlive !== undefined && { keep_alive: keepAlive }) };
    routingTrace.request.summary = buildRequestSummary({ prompt, messages, system, options, stream, think, keepAlive });
    routingTrace.selected = {
        model,
        hostKey: routedHostKey || resolveHostKey(target) || null,
        hostUrl: target,
        routingSource
    };
    routingTrace.ollama = {
        api: useChat ? 'chat' : 'generate',
        endpoint: `/api/${useChat ? 'chat' : 'generate'}`,
        url: ollamaUrl,
        stream,
        thinkConfigured: think !== undefined,
        keepAliveConfigured: keepAlive !== undefined,
        optionsFingerprint: fingerprintRuntimeOptions(options)
    };
    routingTrace.difference = buildRoutingDifference(routingTrace);

    // Admission gate — per-(host, model) semaphore. Streaming is tracked too:
    // benchmark claims must drain every already-admitted inference before Core
    // snapshots and mutates Ollama residency. Bypassing streams made that
    // snapshot race an unobservable long-running generation.
    //
    // Lane policy:
    //   - direct lane: skip admission (bench/profiler self-sequence per host)
    //   - interactive: KEEP admission — load-bearing for cron fairness
    //   - automated:   keep admission
    const skipGate = !lane.admit;

    // recordInference dispatcher honoring the lane's sync/async preference.
    // recordInference is self-contained (only reads its `data` arg, no req/res
    // capture) so deferring via process.nextTick is safe.
    const dispatchRecord = (entry) => {
        if (lane.recordInferenceSync) {
            recordInference(entry);
        } else {
            process.nextTick(() => recordInference(entry));
        }
    };

    const dispatchAttemptRecord = ({
        hostUrl,
        hostKey,
        attemptModel,
        attempt,
        attemptData,
        attemptTrace,
        attemptContract = inferenceContract,
        attemptOptions,
        attemptNumCtxSource,
        durationMs,
        status,
        error,
        fallbackUsed = false,
        fallbackReason = null,
        outcomeStage,
        outcomeCode,
        outcomeReasonCode,
        rejections = [],
    }) => {
        const resolvedOutcomeStage = outcomeStage || (
            fallbackUsed ? ROUTE_OUTCOME_STAGES.FALLBACK : ROUTE_OUTCOME_STAGES.EXECUTION
        );
        const resolvedOutcomeCode = outcomeCode || (
            status === 'success'
                ? (fallbackUsed ? ROUTE_OUTCOME_CODES.FALLBACK_SUCCEEDED : ROUTE_OUTCOME_CODES.EXECUTION_SUCCEEDED)
                : status === 'timeout'
                    ? ROUTE_OUTCOME_CODES.UPSTREAM_TIMEOUT
                    : (fallbackUsed ? ROUTE_OUTCOME_CODES.FALLBACK_FAILED : ROUTE_OUTCOME_CODES.UPSTREAM_ERROR)
        );
        const routeDecision = buildGenerateRouteDecision({
            selectedModel: attemptModel,
            selectedHost: hostKey || resolveHostKey(hostUrl),
            selectedHostUrl: hostUrl,
            selectionSource: attemptTrace?.selected?.routingSource || routingSource,
            attempt,
            attemptOptions,
            fallbackUsed,
            fallbackReason,
            rejections,
            outcomeStage: resolvedOutcomeStage,
            outcomeCode: resolvedOutcomeCode,
            outcomeReasonCode: outcomeReasonCode || fallbackReason,
            durationMs,
        });

        dispatchRecord({
            host: hostUrl,
            model: attemptModel,
            caller: 'proxy',
            callerDetail: body.callerDetail || null,
            consumerContract,
            ...telemetryContext,
            routeDecision,
            observability: {
                contract: attemptContract,
                outcome: attemptData && status === 'success'
                    ? summarizeOllamaOutcome(attemptData)
                    : null,
                lane: laneName,
                campaignId: body.campaignId || body.batchId || telemetryContext.workItemId || null,
            },
            attempt,
            taskType: taskType || null,
            routed: !!taskType,
            routedModel: attemptModel,
            routedHost: hostKey || resolveHostKey(hostUrl),
            routedHostUrl: hostUrl,
            routingTrace: attemptTrace,
            num_ctx: attemptOptions?.num_ctx ?? null,
            num_ctx_source: attemptNumCtxSource,
            // Captured before dispatch from Core's context-budget estimator, so a
            // timeout with tokensIn=0 still records how large the request was.
            estimatedInputTokensAtDispatch:
                attemptContract?.contextBudget?.input?.estimatedTokens
                ?? attemptContract?.input?.estimatedTokens
                ?? null,
            tokensIn: attemptData?.prompt_eval_count || 0,
            tokensOut: attemptData?.eval_count || 0,
            fallbackUsed,
            fallbackReason,
            durationMs,
            status,
            error: error || null,
        });
        return routeDecision;
    };

    let primaryAttemptRecorded = false;
    const dispatchPrimaryAttemptRecord = (entry) => {
        primaryAttemptRecorded = true;
        return dispatchAttemptRecord(entry);
    };
    const recordClientCancellation = () => {
        if (primaryAttemptRecorded) return;
        dispatchPrimaryAttemptRecord({
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            attemptModel: model,
            attempt: telemetryContext.attempt,
            attemptTrace: routingTrace,
            attemptOptions: options,
            attemptNumCtxSource: numCtxSource,
            durationMs: Date.now() - startedAt,
            status: 'error',
            error: 'Inference request cancelled: caller disconnected',
            outcomeCode: ROUTE_OUTCOME_CODES.CALLER_DISCONNECTED,
            outcomeReasonCode: 'caller_disconnected',
        });
    };

    const attemptDegradedResponse = (failure) => tryDegradedResponse({
        failure,
        body,
        consumerContract,
        telemetryContext,
        taskType,
        model,
        target,
        options,
        numCtxSource,
        artifactResolution,
        ollamaPayload,
        useChat,
        prompt,
        messages,
        system,
        requestedThink,
        thinkingMode,
        lane,
        laneName,
        rawResponseRequested,
        stream,
        skipGate,
        routingSource,
        routingTrace,
        requestedModel,
        dispatchAttemptRecord,
        observeRouteDecision,
        buildRoutingDifference,
        timeoutMs,
        routeManaged,
        signal,
        callerPrincipal: callerContext.principal,
    });

    try {
        const primaryAttempt = await executeAdmittedOllamaAttempt({
            hostUrl: target,
            model,
            payload: ollamaPayload,
            useChat,
            stream,
            skipGate,
            timeoutMs,
            signal,
            principal: callerContext.principal,
            workloadAdmissionId: body.workloadAdmissionId || null,
            workloadGeneration: body.workloadGeneration || null,
            admissionKind: `inference-${laneName}${stream ? '-stream' : ''}`,
            afterAdmission: () => assertHostAvailableForConsumer(target, {
                callerDetail: body.callerDetail || null,
                claimBatchId: body.claimBatchId || null,
                claimGeneration: body.claimGeneration || null,
                workloadAdmissionId: body.workloadAdmissionId || null,
                workloadGeneration: body.workloadGeneration || null,
                benchmarkAuthorized: benchmarkClaimAuthorized,
                model,
                path: '/api/inference/generate:post-admission'
            })
        });
        const { response, raw, data } = primaryAttempt;

        if (isCancelled()) {
            recordClientCancellation();
            return undefined;
        }

        Object.assign(headers, buildInferenceResponseHeaders({
            model,
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            routingSource,
            laneName,
            rawResponseRequested,
            stream,
            thinkingPolicy,
            inferenceContract,
            taskType,
            routeOutcomeCode: response.ok
                ? ROUTE_OUTCOME_CODES.EXECUTION_SUCCEEDED
                : ROUTE_OUTCOME_CODES.UPSTREAM_ERROR,
        }));

        const primaryRouteDecision = dispatchPrimaryAttemptRecord({
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            attemptModel: model,
            attempt: telemetryContext.attempt,
            attemptData: data,
            attemptTrace: routingTrace,
            attemptOptions: options,
            attemptNumCtxSource: numCtxSource,
            durationMs: Date.now() - startedAt,
            status: response.ok ? 'success' : 'error',
            outcomeReasonCode: response.ok ? null : `upstream_http_${response.status}`,
        });
        observeRouteDecision(primaryRouteDecision);

        // Fire-and-forget alert evaluation. Lane policy:
        //   - 'error-only': skip latency alerts; keep error alerts
        //   - true: full alerts
        //   - false: would skip entirely (no lane uses this today)
        if (lane.alert) {
            try {
                const alertSvc = alertService;
                if (alertSvc) {
                    const durationMs = Date.now() - startedAt;
                    const alertComponent = routedHostKey || resolveHostKey(target) || 'inference';
                    if (response.ok) {
                        alertSvc.resolveRecoveredInferenceAlerts?.({
                            host: target,
                            hostKey: alertComponent,
                            model,
                            latencyMs: durationMs
                        }).catch(() => {});
                    }
                    if (response.ok && durationMs > 10000 && lane.alert !== 'error-only') {
                        alertSvc.evaluateEvent({
                            component: alertComponent, metric: 'latency',
                            value: durationMs, threshold: 10000, trend: 'spike',
                            source: 'inference-proxy',
                            additionalData: { model, host: target, caller: body.callerDetail, taskType: taskType || null, lane: laneName }
                        }).catch(() => {});
                    }
                    if (!response.ok) {
                        alertSvc.evaluateEvent({
                            component: alertComponent, metric: 'error',
                            value: 1, source: 'inference-proxy',
                            additionalData: { model, host: target, status: response.status, taskType: taskType || null, lane: laneName }
                        }).catch(() => {});
                    }
                }
            } catch { /* never block inference response */ }
        }

        if (!response.ok) {
            if (isCancelled()) return undefined;
            const degradedResult = await attemptDegradedResponse(
                classifyHttpRetryFailure(response.status, data, raw)
            );
            if (isCancelled()) return undefined;
            if (degradedResult.response) return degradedResult.response;
            if (degradedResult.routeDecision) observeRouteDecision(degradedResult.routeDecision);
            else observeRouteOutcome({
                    outcomeStage: ROUTE_OUTCOME_STAGES.FALLBACK,
                    outcomeCode: degradedResult.outcomeCode,
                    outcomeReasonCode: degradedResult.reasonCode,
                });
            setRouteOutcomeHeader(headers, degradedResult.outcomeCode);
            emitBuddyEvent('inference_error', 'infrastructure', 'Inference failed: ' + model + ' (' + response.status + ')', 'high');
            if (isCancelled()) return undefined;
            return result(response.status, {
                status: 'error',
                message: data?.error || raw || 'Ollama request failed',
            });
        }

        const clientData = buildInferenceClientData(
            data,
            model,
            inferenceContract,
            body,
            rawResponseRequested,
            stream
        );
        if (isCancelled()) return undefined;

        // Shadow route evaluation (task 0522), deliberately AFTER the reply is
        // sent. Inline it would add a Mongo read and a scoring pass to the
        // hottest path on the platform, and any bug in it would become a
        // user-visible failure. Deferred, the worst case is a missing
        // comparison sample. No-op unless ROUTE_RESOLVER_SHADOW is enabled.
        scheduleShadowEvaluation(
            { model, hostUrl: target },
            {
                taskType: taskType || null,
                requestedModel: requestedModel || null,
                caller: 'proxy',
                callerDetail: body.callerDetail || null,
                correlationId: telemetryContext.correlationId,
                cloudEligible: false,
                requiredContextTokens: options.num_ctx,
            }
        );
        return result(200, clientData);
    } catch (err) {
        const isClientCancellation = err.isCallerCancellation === true
            || isCancelled();
        if (isClientCancellation) {
            recordClientCancellation();
            logger.debug('[InferenceProxy] caller disconnected; upstream attempt cancelled', {
                host: target,
                model,
                lane: laneName,
            });
            return undefined;
        }

        if (err.isOllamaAttemptError !== true) {
            logger.error('[InferenceProxy] response processing failed', {
                host: target,
                model,
                error: err.message,
            });
            observeRouteOutcome({
                outcomeStage: ROUTE_OUTCOME_STAGES.EXECUTION,
                outcomeCode: ROUTE_OUTCOME_CODES.RESPONSE_PROCESSING_ERROR,
            });
            setRouteOutcomeHeader(headers, ROUTE_OUTCOME_CODES.RESPONSE_PROCESSING_ERROR);
            return result(500, { status: 'error', message: 'Inference response processing failed' });
        }

        const isTimeout = err.isOllamaTimeout === true || err.name === 'AbortError';
        if (isTimeout) {
            logger.warn('[InferenceProxy] fetch timeout — gate slot released', {
                host: target, model, timeoutMs, lane: laneName
            });
        }

        const primaryFailureDecision = dispatchPrimaryAttemptRecord({
            hostUrl: target,
            hostKey: routedHostKey || resolveHostKey(target),
            attemptModel: model,
            attempt: telemetryContext.attempt,
            attemptTrace: routingTrace,
            attemptOptions: options,
            attemptNumCtxSource: numCtxSource,
            durationMs: Date.now() - startedAt,
            status: isTimeout ? 'timeout' : 'error',
            error: isTimeout ? `fetch_timeout_${timeoutMs}ms` : err.message,
            outcomeReasonCode: isTimeout
                ? `fetch_timeout_${timeoutMs}ms`
                : 'connection_failure',
        });
        observeRouteDecision(primaryFailureDecision);

        // Fire-and-forget alert evaluation for host unreachable.
        // 'error-only' direct lane still emits these; 'false' (no lane today) would skip.
        if (lane.alert) {
            try {
                const alertSvc = alertService;
                if (alertSvc) {
                    alertSvc.evaluateEvent({
                        component: routedHostKey || resolveHostKey(target) || 'inference',
                        metric: isTimeout ? 'fetch_timeout' : 'host_unreachable',
                        value: 1, source: 'inference-proxy',
                        additionalData: { model, host: target, error: err.message, taskType: taskType || null, lane: laneName }
                    }).catch(() => {});
                }
            } catch { /* never block */ }
        }

        const degradedResult = await attemptDegradedResponse(
            isTimeout
                ? { kind: 'timeout', streamStarted: false }
                : { kind: 'connection' }
        );
        if (isCancelled()) return undefined;
        if (degradedResult.response) return degradedResult.response;
        if (degradedResult.routeDecision) observeRouteDecision(degradedResult.routeDecision);
        else observeRouteOutcome({
                outcomeStage: ROUTE_OUTCOME_STAGES.FALLBACK,
                outcomeCode: degradedResult.outcomeCode,
                outcomeReasonCode: degradedResult.reasonCode,
            });
        setRouteOutcomeHeader(headers, degradedResult.outcomeCode);

        emitBuddyEvent('inference_error', 'infrastructure',
            isTimeout
                ? 'Inference timeout: ' + model + ' @ ' + target
                : 'Host unreachable: ' + model + ' @ ' + target,
            'high');
        if (isCancelled()) return undefined;
        return result(isTimeout ? 504 : 502, { status: 'error', message: err.message });
    }
    } catch (err) {
        const errorCode = typeof err?.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(err.code)
            ? err.code
            : 'INFERENCE_PRE_DISPATCH_ERROR';
        logger.error('[InferenceProxy] pre-dispatch failed', {
            phase: 'pre_dispatch',
            errorCode,
            outcomeCode: ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR,
        });
        observeRouteOutcome({
            outcomeStage: ROUTE_OUTCOME_STAGES.SELECTION,
            outcomeCode: ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR,
            outcomeReasonCode: errorCode,
        });
        setRouteOutcomeHeader(headers, ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR);
        return result(Number.isInteger(err?.statusCode) ? err.statusCode : 500, {
            status: 'error',
            message: err?.message || 'Internal server error',
        });
    }
}

module.exports = { executeInference };
