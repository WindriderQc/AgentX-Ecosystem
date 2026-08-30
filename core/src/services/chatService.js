const Conversation = require('../../models/Conversation');
const { getOrCreateProfile } = require('../helpers/userHelpers');
const { extractResponse, buildOllamaPayload } = require('../helpers/ollamaResponseHandler');
const { summarizeOllamaOutcome } = require('./laneObservabilityService');
const { sanitizeOptions, resolveTarget } = require('../helpers/ollamaUtils');
const { recordInference } = require('./modelRouter');
const hostPreferenceService = require('./hostPreferenceService');
const { assertHostAvailableForConsumer } = require('./benchmarkClaimGuard');
const logger = require('../../config/logger');
const fetch = require('node-fetch');

// Extracted modules
const { getActivePrompt, buildSystemPrompt } = require('./chat/chatPromptHelpers');
const { resolveThinkingPolicy } = require('./thinkingPolicy');
const {
    hasQualifiedThinkingCapability,
    resolveInferenceContract
} = require('./inferenceContractService');
const { persistConversation } = require('./chat/conversationPersistence');
const { prepareChatOrchestration } = require('./chat/chatOrchestrationPrelude');
const {
    finalizeRouteDecision,
    ROUTE_OUTCOME_CODES,
    ROUTE_OUTCOME_STAGES
} = require('./routing/routeDecision');
const {
    readOllamaErrorDetail,
    buildOllamaStatusError,
    wrapOllamaFetchError
} = require('./chat/chatUpstreamErrors');

// Core Chat Service
function resolveRequestedMaxTokens(value) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function buildRoutingPayload(routingInfo, effectiveModel, effectiveTarget, autoRouteEnabled) {
    if (!routingInfo && !effectiveModel && !effectiveTarget) {
        return null;
    }

    return {
        taskType: routingInfo?.taskType || null,
        routed: routingInfo?.routed || false,
        autoRouted: autoRouteEnabled === true && routingInfo?.routed === true,
        classificationMs: routingInfo?.classificationMs || 0,
        routedModel: routingInfo?.model || effectiveModel || null,
        routedHost: routingInfo?.host || null,
        routedHostUrl: routingInfo?.target || effectiveTarget || null
    };
}

const handleChatRequest = async ({
    userId,
    model,
    message,
    messages = [],
    system,
    options = {},
    persona,
    promptVersion,
    conversationId,
    useRag,
    ragEnabled,
    ragTopK,
    ragFilters,
    target,
    ragStore,
    autoRoute = false,
    taskType = null,
    enableWebSearch = false,
    think,
    thinkingMode
}) => {
    let personaName = persona || options.persona || 'default_chat';
    const exactPromptVersion = promptVersion ?? options.promptVersion;

    // Shared orchestration prelude — routing decision.
    //     RAG + web-search happen later (after tool/image branches), so we
    //     call the prelude twice: once for routing only, once for RAG/search
    //     when we reach the standard chat flow. Same helper, different flags.
    const routingPrelude = await prepareChatOrchestration({
        message,
        model,
        target,
        autoRoute,
        taskType,
        caller: 'chat-service',
        callerDetail: userId ? 'chat-' + String(userId) : 'chat'
    });
    let effectiveModel = routingPrelude.effectiveModel;
    let effectiveTarget = routingPrelude.effectiveTarget;
    const routingInfo = routingPrelude.routingInfo;

    if (!effectiveTarget || routingInfo?.source === 'scheduler-blocked') {
        const err = new Error(routingInfo?.reason || 'No Ollama host is available for chat routing');
        err.statusCode = 503;
        err.code = 'NO_UNCLAIMED_OLLAMA_HOST';
        throw err;
    }

    const resolvedHost = resolveTarget(effectiveTarget);
    await assertHostAvailableForConsumer(resolvedHost, {
        callerDetail: userId ? 'chat-' + String(userId) : 'chat',
        model: effectiveModel,
        path: '/api/chat'
    });

    // 2. Standard Chat Flow
    const activePrompt = await getActivePrompt(
        system,
        personaName,
        exactPromptVersion == null ? {} : { promptVersion: exactPromptVersion }
    );
    const userProfile = await getOrCreateProfile(userId);

    // Shared prelude, second pass: RAG + web-search.
    // Routing already ran above (no model/target passed here, so it's skipped).
    const ragRequested = ragEnabled === true || useRag === true || process.env.RAG_ENABLED === 'true';
    const {
        ragUsed,
        ragSources,
        ragContext,
        webSearchResults,
        webSearchContext
    } = await prepareChatOrchestration({
        message,
        caller: 'chat-service',
        ragRequested,
        ragStore,
        ragTopK,
        ragFilters,
        ragOptions: options,
        enableWebSearch
    });

    const effectiveSystemPrompt = buildSystemPrompt(activePrompt.systemPrompt, userProfile, ragContext);

    const formattedMessages = [
        { role: 'system', content: effectiveSystemPrompt },
        ...messages.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: message.trim() }
    ];

    // Inject web search context before the last user message
    if (webSearchContext && formattedMessages.length > 1) {
        formattedMessages.splice(formattedMessages.length - 1, 0, {
            role: 'user',
            content: `Use these web search results as additional context for your analysis:\n\n${webSearchContext}`
        });
    }

    // Model call
    let assistantMessageContent, thinking, warning, stats;
    let inferenceContract = null;
    let observabilityOutcome = null;
    let sanitized = {};
    let numCtxSource = null;
    let inferenceDispatched = false;
    const inferenceStartedAt = Date.now();
    try {
        sanitized = sanitizeOptions(options) || {};
        const hostPref = await hostPreferenceService.getByHost(resolvedHost);
        const pinnedRuntime = hostPreferenceService.resolvePinnedRuntimeOptions(
            hostPref,
            effectiveModel,
            sanitized
        );
        sanitized = {
            ...pinnedRuntime.options,
            ...(pinnedRuntime.keepAlive !== undefined && { keep_alive: pinnedRuntime.keepAlive })
        };
        numCtxSource = pinnedRuntime.numCtxSource;
        inferenceContract = await resolveInferenceContract({
            model: effectiveModel,
            host: resolvedHost,
            messages: formattedMessages,
            requestedNumCtx: sanitized.num_ctx,
            numCtxSource,
            requestedMaxOutputTokens: sanitized.num_predict
        });
        const thinkingPolicy = resolveThinkingPolicy({
            requestedThink: think,
            thinkingMode,
            capabilityContract: inferenceContract,
            taskType: taskType || routingInfo?.taskType || null,
            callerDetail: userId ? 'chat-' + String(userId) : 'chat',
            laneName: 'interactive',
            rawResponseRequested: false,
            stream: false
        });
        const ollamaPayload = buildOllamaPayload({
            model: effectiveModel,
            messages: formattedMessages,
            options: sanitized,
            streamEnabled: false,
            think: thinkingPolicy.think
        });

        const url = `${resolveTarget(effectiveTarget)}/api/chat`;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 300000);

        let response;
        try {
            inferenceDispatched = true;
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ollamaPayload),
                signal: controller.signal
            });
            if (!response.ok) {
                const errDetail = await readOllamaErrorDetail(response);
                throw buildOllamaStatusError({ url, response, detail: errDetail, model: effectiveModel });
            }
        } catch (err) {
            throw wrapOllamaFetchError({
                url,
                error: err,
                model: effectiveModel,
                timeoutMessage: 'Ollama request timed out (2m limit).'
            });
        } finally {
            clearTimeout(timeout);
        }

        const data = await response.json();
        observabilityOutcome = summarizeOllamaOutcome(data);

        const extracted = extractResponse(data, effectiveModel, {
            thinkingSupported: hasQualifiedThinkingCapability(inferenceContract)
        });
        assistantMessageContent = extracted.content;
        thinking = extracted.thinking;
        warning = extracted.warning;
        stats = extracted.stats;

        if (warning) logger.warn('Response extraction warning', { model, warning });
    } catch (err) {
        logger.error('Model request failed', { model: effectiveModel, error: err.message });
        const terminalStatus = err.code === 'OLLAMA_TIMEOUT' || err.name === 'AbortError'
            ? 'timeout'
            : 'error';
        const durationMs = Date.now() - inferenceStartedAt;
        // Record failed inference before re-throwing
        recordInference({
            host: resolveTarget(effectiveTarget),
            model: effectiveModel,
            caller: 'chat',
            callerDetail: userId ? 'chat-' + String(userId) : 'chat',
            taskType: routingInfo?.taskType || null,
            routed: routingInfo?.routed || false,
            autoRouted: routingInfo?.autoRouted || false,
            classificationMs: routingInfo?.classificationMs || 0,
            routedModel: routingInfo?.model || effectiveModel || null,
            routedHost: routingInfo?.host || null,
            routedHostUrl: routingInfo?.target || effectiveTarget || null,
            // RouteDecision v1 (task 0519): routeRequest builds this; the row
            // is where it becomes durable. Failed chats are the rows an
            // alerting surface most needs attributed.
            routeDecision: finalizeRouteDecision(routingInfo?.decision, {
                status: terminalStatus,
                durationMs,
                reasonCode: inferenceDispatched
                    ? (err.code || (terminalStatus === 'timeout' ? 'OLLAMA_TIMEOUT' : 'OLLAMA_UPSTREAM_ERROR'))
                    : 'INFERENCE_PRE_DISPATCH_ERROR',
                ...(!inferenceDispatched && {
                    outcomeStage: ROUTE_OUTCOME_STAGES.SELECTION,
                    outcomeCode: ROUTE_OUTCOME_CODES.PRE_DISPATCH_ERROR
                })
            }),
            observability: {
                contract: inferenceContract,
                outcome: observabilityOutcome,
                lane: 'interactive'
            },
            num_ctx: sanitized.num_ctx || null,
            num_ctx_source: numCtxSource,
            durationMs,
            status: terminalStatus,
            error: err.message
        });
        throw err;
    }

    const successDurationMs = stats?.performance?.totalDuration
        ? Math.round(stats.performance.totalDuration / 1e6)
        : Date.now() - inferenceStartedAt;

    // Record successful inference (fire-and-forget)
    recordInference({
        host: resolveTarget(effectiveTarget),
        model: effectiveModel,
        caller: 'chat',
        callerDetail: userId ? 'chat-' + String(userId) : 'chat',
        taskType: routingInfo?.taskType || null,
        routed: routingInfo?.routed || false,
        autoRouted: routingInfo?.autoRouted || false,
        classificationMs: routingInfo?.classificationMs || 0,
        routedModel: routingInfo?.model || effectiveModel || null,
        routedHost: routingInfo?.host || null,
        routedHostUrl: routingInfo?.target || effectiveTarget || null,
        // RouteDecision v1 (task 0519): built by routeRequest, durable here.
        routeDecision: finalizeRouteDecision(routingInfo?.decision, {
            status: 'success',
            durationMs: successDurationMs
        }),
        observability: {
            contract: inferenceContract,
            outcome: observabilityOutcome,
            lane: 'interactive'
        },
        num_ctx: sanitized.num_ctx || null,
        num_ctx_source: numCtxSource,
        tokensIn: stats?.usage?.promptTokens || 0,
        tokensOut: stats?.usage?.completionTokens || 0,
        durationMs: successDurationMs,
        status: 'success'
    });

    // Persist conversation
    const routingPayload = buildRoutingPayload(routingInfo, effectiveModel, effectiveTarget, autoRoute);
    const { conversation, assistantMessageId } = await persistConversation({
        userId, conversationId, model: effectiveModel,
        effectiveSystemPrompt, message, assistantContent: assistantMessageContent,
        activePrompt,
        metadata: { thinking, options, webSearchResults, routingInfo: routingPayload },
        stats, ragUsed, useRag, ragSources
    });

    return {
        response: assistantMessageContent,
        conversationId: conversation?._id || null,
        messageId: assistantMessageId,
        model: effectiveModel,
        target: effectiveTarget,
        routing: routingPayload,
        prompt: {
            name: activePrompt.name || personaName,
            version: activePrompt.version,
            exact: exactPromptVersion != null,
            requestedVersion: exactPromptVersion == null ? null : Number(exactPromptVersion)
        },
        numCtx: sanitized.num_ctx || null,
        inferenceContract,
        stats: stats || null,
        ragUsed,
        ragSources,
        webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
        warning: hasQualifiedThinkingCapability(inferenceContract)
            ? 'This deployed model artifact has qualified thinking capabilities. Enable streaming for better response quality.'
            : undefined
    };
};


// Streaming handler extracted to chatServiceStream.js
const { handleChatRequestStream } = require('./chatServiceStream');

module.exports = { handleChatRequest, handleChatRequestStream };
