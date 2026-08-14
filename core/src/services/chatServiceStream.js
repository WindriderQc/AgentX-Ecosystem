'use strict';
/**
 * Chat Service — Streaming (SSE) Handler
 *
 * Extracted from chatService.js to keep file size within 600-line limit.
 * Imported and re-exported by chatService.js for API compatibility.
 */

const { getOrCreateProfile } = require('../helpers/userHelpers');
const { buildOllamaPayload, buildOllamaStats } = require('../helpers/ollamaResponseHandler');
const { sanitizeOptions, resolveTarget } = require('../helpers/ollamaUtils');
const { tryHandleToolCommand } = require('./toolService');
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
    readOllamaErrorDetail,
    buildOllamaStatusError,
    wrapOllamaFetchError
} = require('./chat/chatUpstreamErrors');


// Streaming Chat Service (SSE)
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

const handleChatRequestStream = async ({
    userId,
    model,
    message,
    messages = [],
    system,
    authoritativeSystem = false,
    options = {},
    persona,
    conversationId,
    persist = true,
    callerDetail = null,
    allowTools = true,
    allowRag = true,
    loadUserProfile = true,
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
    thinkingMode,
    abortSignal,
    onWebSearchStart,
    onWebSearchDone,
    onToken,
    onThinking,
    onComplete,
    onError
}) => {
    const personaName = persona || options.persona || 'default_chat';
    const effectiveCallerDetail = callerDetail
        || (userId ? 'chat-' + String(userId) : 'chat');
    let resolvedHost = null;
    let streamAbortHandler = null;

    logger.info('DEBUG_STREAM: handleChatRequestStream called', {
        userId, conversationId
    });

    try {
        if (abortSignal?.aborted) return;

        // 1. Check for Tool Commands (no streaming for tools) — handled
        //    before orchestration so we don't route/RAG/search for tool cmds.
        const toolCommand = allowTools === false ? null : await tryHandleToolCommand(message);
        if (toolCommand) {
            onComplete({
                response: toolCommand.responseText,
                tool: toolCommand.tool || null,
                toolOk: toolCommand.ok === true
            });
            return;
        }

        // 2. Standard Chat Flow with Streaming
        const activePrompt = await getActivePrompt(system, personaName, {
            preferSystem: authoritativeSystem === true
        });
        const userProfile = loadUserProfile === false ? {} : await getOrCreateProfile(userId);

        // Shared orchestration prelude — routing + RAG + web-search in one call.
        // onWebSearchStart / onWebSearchDone are threaded through so the
        // SSE-only side effects remain in this file.
        const ragRequested = allowRag !== false
            && (ragEnabled === true || useRag === true || process.env.RAG_ENABLED === 'true');
        const {
            routingInfo,
            effectiveModel,
            effectiveTarget,
            ragUsed,
            ragSources,
            ragContext,
            webSearchResults,
            webSearchContext
        } = await prepareChatOrchestration({
            message,
            model,
            target,
            autoRoute,
            taskType,
            caller: effectiveCallerDetail,
            callerDetail: effectiveCallerDetail,
            ragRequested,
            ragStore,
            ragTopK,
            ragFilters,
            ragOptions: options,
            enableWebSearch,
            onWebSearchStart,
            onWebSearchDone
        });

        if (!effectiveTarget || routingInfo?.source === 'scheduler-blocked') {
            const err = new Error(routingInfo?.reason || 'No Ollama host is available for streaming chat routing');
            err.statusCode = 503;
            err.code = 'NO_UNCLAIMED_OLLAMA_HOST';
            throw err;
        }

        resolvedHost = resolveTarget(effectiveTarget);
        await assertHostAvailableForConsumer(resolvedHost, {
            callerDetail: effectiveCallerDetail,
            model: effectiveModel,
            path: '/api/chat'
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

        let streamSanitized = sanitizeOptions(options) || {};
        const hostPref = await hostPreferenceService.getByHost(resolvedHost);
        const pinnedRuntime = hostPreferenceService.resolvePinnedRuntimeOptions(
            hostPref,
            effectiveModel,
            streamSanitized
        );
        streamSanitized = {
            ...pinnedRuntime.options,
            ...(pinnedRuntime.keepAlive !== undefined && { keep_alive: pinnedRuntime.keepAlive })
        };
        const streamNumCtxSource = pinnedRuntime.numCtxSource;
        const inferenceContract = await resolveInferenceContract({
            model: effectiveModel,
            host: resolvedHost,
            messages: formattedMessages,
            requestedNumCtx: streamSanitized.num_ctx,
            numCtxSource: streamNumCtxSource,
            requestedMaxOutputTokens: streamSanitized.num_predict
        });
        const thinkingPolicy = resolveThinkingPolicy({
            requestedThink: think,
            thinkingMode,
            capabilityContract: inferenceContract,
            taskType: taskType || routingInfo?.taskType || null,
            callerDetail: effectiveCallerDetail,
            laneName: 'interactive',
            rawResponseRequested: false,
            stream: true
        });
        const ollamaPayload = buildOllamaPayload({
            model: effectiveModel,
            messages: formattedMessages,
            options: streamSanitized,
            streamEnabled: true,
            think: thinkingPolicy.think
        });

        const url = `${resolveTarget(effectiveTarget)}/api/chat`;
        const controller = new AbortController();
        streamAbortHandler = () => controller.abort();
        if (abortSignal) abortSignal.addEventListener('abort', streamAbortHandler);
        const timeout = setTimeout(() => controller.abort(), 300000);

        let response;
        try {
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
            clearTimeout(timeout);
            if (err.name === 'AbortError') {
                if (abortSignal?.aborted) return;
            }
            throw wrapOllamaFetchError({
                url,
                error: err,
                model: effectiveModel,
                timeoutMessage: 'Ollama request timed out (5m limit).'
            });
        } finally {
            clearTimeout(timeout);
        }

        // Parse NDJSON stream
        let fullContent = '';
        let thinkingContent = '';
        let stats = null;
        let sawDone = false;
        let finishReason = null;

        const decoder = new TextDecoder();
        let lineBuffer = '';
        const consumeLine = (line) => {
            if (!line.trim()) return;
            try {
                const data = JSON.parse(line);

                if (data.message?.thinking) {
                    thinkingContent += data.message.thinking;
                    if (!abortSignal?.aborted) onThinking(data.message.thinking);
                }

                if (data.message?.content) {
                    fullContent += data.message.content;
                    if (!abortSignal?.aborted) onToken(data.message.content);
                }

                if (data.done) {
                    sawDone = true;
                    finishReason = data.done_reason || data.stop_reason || data.finish_reason || null;
                    stats = buildOllamaStats(data, fullContent);
                    if (stats?.performance) {
                        stats.performance.promptEvalDuration = data.prompt_eval_duration || 0;
                    }
                }
            } catch (parseErr) {
                logger.warn('Failed to parse streaming chunk', { error: parseErr.message });
            }
        };

        try {
            for await (const chunk of response.body) {
                if (abortSignal?.aborted) return;

                lineBuffer += decoder.decode(chunk, { stream: true });
                let boundary;
                while ((boundary = lineBuffer.indexOf('\n')) !== -1) {
                    consumeLine(lineBuffer.slice(0, boundary));
                    lineBuffer = lineBuffer.slice(boundary + 1);
                }
            }
            lineBuffer += decoder.decode();
            consumeLine(lineBuffer);
        } catch (streamErr) {
            logger.error('Stream reading error', { error: streamErr.message });
            throw streamErr;
        }

        // Record streaming inference (fire-and-forget)
        recordInference({
            host: resolveTarget(effectiveTarget),
            model: effectiveModel,
            caller: 'chat',
            callerDetail: effectiveCallerDetail,
            taskType: routingInfo?.taskType || null,
            routed: routingInfo?.routed || false,
            autoRouted: routingInfo?.autoRouted || false,
            classificationMs: routingInfo?.classificationMs || 0,
            routedModel: routingInfo?.model || effectiveModel || null,
            routedHost: routingInfo?.host || null,
            routedHostUrl: routingInfo?.target || effectiveTarget || null,
            // RouteDecision v1 (task 0519): built by routeRequest, durable here.
            routeDecision: routingInfo?.decision || null,
            observability: {
                contract: inferenceContract,
                lane: 'interactive',
                outcome: {
                    visibleFinal: fullContent.trim().length > 0,
                    thinkingOnly: fullContent.trim().length === 0 && thinkingContent.trim().length > 0,
                    completed: sawDone,
                    truncated: !sawDone || /^(length|max(?:imum)?[_ -]?(?:tokens|context)|token_limit)$/i.test(String(finishReason || '')),
                    finishReason: finishReason ? String(finishReason).slice(0, 64) : null
                }
            },
            num_ctx: streamSanitized.num_ctx || null,
            num_ctx_source: streamNumCtxSource,
            tokensIn: stats?.usage?.promptTokens || 0,
            tokensOut: stats?.usage?.completionTokens || 0,
            durationMs: stats?.performance?.totalDuration
                ? Math.round(stats.performance.totalDuration / 1e6) : 0,
            status: 'success'
        });

        // Persist conversation
        const routingPayload = buildRoutingPayload(routingInfo, effectiveModel, effectiveTarget, autoRoute);
        let conversation = null;
        let assistantMessageId = null;
        if (persist !== false) {
            const saved = await persistConversation({
                userId, conversationId, model: effectiveModel,
                effectiveSystemPrompt, message, assistantContent: fullContent,
                activePrompt,
                metadata: { thinking: thinkingContent || null, options, webSearchResults, routingInfo: routingPayload },
                stats, ragUsed, useRag, ragSources
            });
            conversation = saved.conversation;
            assistantMessageId = saved.assistantMessageId;
        }

        if (!abortSignal?.aborted) {
            onComplete({
                response: fullContent,
                conversationId: conversation?._id || null,
                messageId: assistantMessageId,
                model: effectiveModel,
                target: effectiveTarget,
                routing: routingPayload,
                numCtx: streamSanitized.num_ctx || null,
                inferenceContract,
                stats: stats || null,
                ragUsed, ragSources,
                webSearchResults: webSearchResults.length > 0 ? webSearchResults : undefined,
                thinking: thinkingContent || null,
                warning: hasQualifiedThinkingCapability(inferenceContract)
                    ? 'Streaming enabled for a qualified thinking-capable artifact.'
                    : undefined
            });
        }

    } catch (err) {
        if (!abortSignal?.aborted) {
            logger.error('Streaming chat error', { error: err.message, stack: err.stack });
            onError(err);
        }
    } finally {
        if (abortSignal && streamAbortHandler) {
            abortSignal.removeEventListener('abort', streamAbortHandler);
        }
    }
};


module.exports = { handleChatRequestStream };
