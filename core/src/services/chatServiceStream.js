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
const { recordInference } = require('./modelRouter');
const hostPreferenceService = require('./hostPreferenceService');
const { assertHostAvailableForConsumer } = require('./benchmarkClaimGuard');
const logger = require('../../config/logger');
const fetch = require('node-fetch');
const { beginInferenceAdmission } = require('./inferenceAdmissionService');

// Extracted modules
const { getActivePrompt, buildSystemPrompt } = require('./chat/chatPromptHelpers');
const { resolveThinkingPolicy } = require('./thinkingPolicy');
const {
    hasQualifiedThinkingCapability,
    resolveInferenceContract
} = require('./inferenceContractService');
const { persistConversation } = require('./chat/conversationPersistence');
const { prepareChatOrchestration } = require('./chat/chatOrchestrationPrelude');
const { finalizeRouteDecision } = require('./routing/routeDecision');
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
    promptVersion,
    conversationId,
    persist = true,
    callerDetail = null,
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
    upstreamTimeoutMs = 300000,
    abortSignal,
    onWebSearchStart,
    onWebSearchDone,
    onToken,
    onThinking,
    onComplete,
    onError
}) => {
    const personaName = persona || options.persona || 'default_chat';
    const exactPromptVersion = promptVersion ?? options.promptVersion;
    const effectiveCallerDetail = callerDetail
        || (userId ? 'chat-' + String(userId) : 'chat');
    let resolvedHost = null;
    let streamAbortHandler = null;
    let inferenceDispatched = false;
    let inferenceStartedAt = 0;
    let telemetryRecorded = false;
    let streamTelemetry = null;
    let upstreamTimeout = null;
    let upstreamTimeoutTriggered = false;
    let inferenceAdmission = null;

    logger.info('DEBUG_STREAM: handleChatRequestStream called', {
        userId, conversationId
    });

    try {
        if (abortSignal?.aborted) return;

        // Standard Chat Flow with Streaming
        const promptResolutionOptions = { preferSystem: authoritativeSystem === true };
        if (exactPromptVersion != null) promptResolutionOptions.promptVersion = exactPromptVersion;
        const activePrompt = await getActivePrompt(system, personaName, promptResolutionOptions);
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
        streamTelemetry = { routingInfo, effectiveModel, effectiveTarget };

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
        Object.assign(streamTelemetry, {
            inferenceContract,
            streamSanitized,
            streamNumCtxSource
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
        // Keep the deadline alive for the response body too. Ollama sends
        // headers before generation, so a headers-only timer leaves a stalled
        // NDJSON stream holding the gateway indefinitely.
        const boundedUpstreamTimeoutMs = Math.max(1, Math.min(300000, Number(upstreamTimeoutMs) || 300000));
        upstreamTimeout = setTimeout(() => {
            upstreamTimeoutTriggered = true;
            controller.abort();
        }, boundedUpstreamTimeoutMs);

        let response;
        try {
            inferenceAdmission = await beginInferenceAdmission({
                host: resolvedHost,
                model: effectiveModel,
                kind: 'chat-stream',
                principal: 'core-chat',
                runtimeOptions: ollamaPayload.options,
                ...(Object.prototype.hasOwnProperty.call(ollamaPayload, 'keep_alive')
                    && { keepAlive: ollamaPayload.keep_alive }),
                signal: controller.signal
            });
            inferenceAdmission.markDispatched();
            inferenceDispatched = true;
            inferenceStartedAt = Date.now();
            response = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(ollamaPayload),
                signal: inferenceAdmission.signal
            });
            if (!response.ok) {
                const errDetail = await readOllamaErrorDetail(response);
                throw buildOllamaStatusError({ url, response, detail: errDetail, model: effectiveModel });
            }
        } catch (err) {
            if (err.name === 'AbortError') {
                if (abortSignal?.aborted) return;
            }
            throw wrapOllamaFetchError({
                url,
                error: err,
                model: effectiveModel,
                timeoutMessage: 'Ollama request timed out (5m limit).'
            });
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
                // The terminal NDJSON record is authoritative. Do not wait for
                // a misbehaving upstream to close its HTTP body afterwards.
                if (sawDone) break;
            }
            if (!sawDone) {
                lineBuffer += decoder.decode();
                consumeLine(lineBuffer);
            }
        } catch (streamErr) {
            if (!abortSignal?.aborted) logger.error('Stream reading error', { error: streamErr.message });
            throw streamErr;
        }

        if (!sawDone) {
            const terminalError = new Error('Ollama stream ended before its terminal record');
            terminalError.code = 'OLLAMA_STREAM_INCOMPLETE';
            throw terminalError;
        }
        await inferenceAdmission.complete();
        inferenceAdmission = null;
        clearTimeout(upstreamTimeout);
        upstreamTimeout = null;

        const successDurationMs = stats?.performance?.totalDuration
            ? Math.round(stats.performance.totalDuration / 1e6)
            : Date.now() - inferenceStartedAt;

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
            routeDecision: finalizeRouteDecision(routingInfo?.decision, {
                status: 'success',
                durationMs: successDurationMs
            }),
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
            durationMs: successDurationMs,
            status: 'success'
        });
        telemetryRecorded = true;

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
                prompt: {
                    name: activePrompt.name || personaName,
                    version: activePrompt.version,
                    exact: exactPromptVersion != null,
                    requestedVersion: exactPromptVersion == null ? null : Number(exactPromptVersion)
                },
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
        if (inferenceAdmission) {
            await inferenceAdmission.abandon(err).catch(quarantineError => {
                err.inferenceQuarantineError = quarantineError;
            });
            inferenceAdmission = null;
        }
        if (upstreamTimeoutTriggered && err.name === 'AbortError') {
            const timeoutError = new Error('Ollama request timed out (5m limit).');
            timeoutError.name = 'AbortError';
            timeoutError.code = 'OLLAMA_TIMEOUT';
            err = timeoutError;
        }
        if (inferenceDispatched && !telemetryRecorded && !abortSignal?.aborted && streamTelemetry) {
            const terminalStatus = err.code === 'OLLAMA_TIMEOUT' || err.name === 'AbortError'
                ? 'timeout'
                : 'error';
            recordInference({
                host: resolvedHost || resolveTarget(streamTelemetry.effectiveTarget),
                model: streamTelemetry.effectiveModel,
                caller: 'chat',
                callerDetail: effectiveCallerDetail,
                taskType: streamTelemetry.routingInfo?.taskType || null,
                routed: streamTelemetry.routingInfo?.routed || false,
                autoRouted: streamTelemetry.routingInfo?.autoRouted || false,
                classificationMs: streamTelemetry.routingInfo?.classificationMs || 0,
                routedModel: streamTelemetry.routingInfo?.model || streamTelemetry.effectiveModel || null,
                routedHost: streamTelemetry.routingInfo?.host || null,
                routedHostUrl: streamTelemetry.routingInfo?.target || streamTelemetry.effectiveTarget || null,
                routeDecision: finalizeRouteDecision(streamTelemetry.routingInfo?.decision, {
                    status: terminalStatus,
                    durationMs: Date.now() - inferenceStartedAt,
                    reasonCode: err.code || (terminalStatus === 'timeout' ? 'OLLAMA_TIMEOUT' : 'OLLAMA_UPSTREAM_ERROR')
                }),
                observability: {
                    contract: streamTelemetry.inferenceContract,
                    lane: 'interactive',
                    outcome: null
                },
                num_ctx: streamTelemetry.streamSanitized?.num_ctx || null,
                num_ctx_source: streamTelemetry.streamNumCtxSource,
                durationMs: Date.now() - inferenceStartedAt,
                status: terminalStatus,
                error: err.message
            });
            telemetryRecorded = true;
        }
        if (!abortSignal?.aborted) {
            logger.error('Streaming chat error', { error: err.message, stack: err.stack });
            onError(err);
        }
    } finally {
        if (upstreamTimeout) clearTimeout(upstreamTimeout);
        if (abortSignal && streamAbortHandler) {
            abortSignal.removeEventListener('abort', streamAbortHandler);
        }
    }
};


module.exports = { handleChatRequestStream };
