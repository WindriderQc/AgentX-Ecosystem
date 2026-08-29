'use strict';

const logger = require('../../../config/logger');
const { resolveHostKey } = require('../modelRouter');
const { scheduleShadowEvaluation } = require('./shadowEvaluation');
const { tryDegradedRetry } = require('./degradedRetryOrchestrator');
const {
  buildInferenceClientData,
  setInferenceResponseHeaders,
} = require('./inferenceResponsePresenter');

async function tryAndRespondDegraded(context) {
  const {
    failure, res, body, consumerContract, telemetryContext, taskType,
    model, target, options, numCtxSource, artifactResolution, ollamaPayload,
    useChat, gateRelease, prompt, messages, system,
    requestedThink, thinkingMode, lane, laneName, rawResponseRequested,
    stream, skipGate, routingSource, routingTrace, requestedModel,
    dispatchAttemptRecord, buildRoutingDifference, timeoutMs, routeManaged,
    signal,
  } = context;
  if (signal?.aborted) return false;

  const degradedOutcome = await tryDegradedRetry({
    attemptState: {
      lane: taskType || null,
      attempt: telemetryContext.attempt,
      streamStarted: stream,
      failure,
      requiredContextTokens: options.num_ctx,
      numCtxSource,
      crossModelOptIn: body.allowCrossModelFallback === true,
      routeManaged: routeManaged === true,
      requestedModel: artifactResolution.requested || model,
    },
    baseModel: artifactResolution.requested || model,
    model,
    failedHostUrl: target,
    ollamaPayload,
    useChat,
    beforeAttempt: gateRelease,
    requestContext: {
      prompt,
      messages,
      system,
      requestedThink,
      thinkingMode,
      callerDetail: body.callerDetail,
      callerKeepAlive: body.keep_alive ?? body.keepAlive,
      lane,
      laneName,
      rawResponseRequested,
      skipGate,
      timeoutMs,
      signal,
    },
  });

  if (signal?.aborted) return false;

  if (degradedOutcome?.retried) {
    const fallbackType = degradedOutcome.degraded.fallbackType || 'same_model';
    const fallbackRoutingSource = fallbackType === 'cross_model'
      ? `${routingSource}+degraded-cross-model`
      : `${routingSource}+degraded-fallback`;
    const fallbackTrace = {
      ...routingTrace,
      selected: {
        model: degradedOutcome.model,
        hostKey: resolveHostKey(degradedOutcome.hostUrl) || null,
        hostUrl: degradedOutcome.hostUrl,
        routingSource: fallbackRoutingSource,
      },
      artifactResolution: {
        ...routingTrace.artifactResolution,
        requested: artifactResolution.requested || model,
        resolved: degradedOutcome.model,
        rewritten: (artifactResolution.requested || model) !== degradedOutcome.model,
        source: fallbackType === 'cross_model'
          ? 'verified_cross_model_fallback'
          : 'verified_degraded_fallback',
      },
      thinking: degradedOutcome.thinkingPolicy,
      inferenceContract: degradedOutcome.contract,
      ollama: {
        api: useChat ? 'chat' : 'generate',
        endpoint: `/api/${useChat ? 'chat' : 'generate'}`,
        url: `${degradedOutcome.hostUrl}/api/${useChat ? 'chat' : 'generate'}`,
        stream: false,
        think: degradedOutcome.thinkingPolicy?.think ?? null,
        keepAlive: degradedOutcome.payload?.keep_alive ?? null,
        options: { ...(degradedOutcome.payload?.options || {}) },
      },
    };
    fallbackTrace.difference = buildRoutingDifference(fallbackTrace);
    const fallbackError = degradedOutcome.error?.message
      || (!degradedOutcome.ok
        ? degradedOutcome.data?.error || `upstream_status_${degradedOutcome.status || 'unknown'}`
        : null);

    dispatchAttemptRecord({
      hostUrl: degradedOutcome.hostUrl,
      attemptModel: degradedOutcome.model,
      attempt: (Number(telemetryContext.attempt) || 1) + 1,
      attemptData: degradedOutcome.data,
      attemptTrace: fallbackTrace,
      attemptContract: degradedOutcome.contract,
      attemptOptions: degradedOutcome.payload?.options,
      attemptNumCtxSource: degradedOutcome.numCtxSource,
      durationMs: degradedOutcome.durationMs,
      status: degradedOutcome.ok ? 'success' : 'error',
      error: fallbackError,
      fallbackUsed: true,
      fallbackReason: degradedOutcome.degraded.degradedReason,
    });

    if (degradedOutcome.ok) {
      setInferenceResponseHeaders(res, {
        model: degradedOutcome.model,
        hostUrl: degradedOutcome.hostUrl,
        hostKey: resolveHostKey(degradedOutcome.hostUrl),
        routingSource: fallbackRoutingSource,
        laneName,
        rawResponseRequested,
        stream: false,
        thinkingPolicy: degradedOutcome.thinkingPolicy,
        inferenceContract: degradedOutcome.contract,
        taskType,
      });
      res.set('X-AgentX-Degraded', 'true');
      res.set('X-AgentX-Degraded-Reason', degradedOutcome.degraded.degradedReason);
      res.set('X-AgentX-Degraded-Fallback-Type', fallbackType);
      res.set('X-AgentX-Degraded-Model-Changed', String(degradedOutcome.degraded.modelChanged === true));
      res.set('X-AgentX-Degraded-Primary-Model', degradedOutcome.degraded.primary?.model || model);
      res.set('X-AgentX-Degraded-Actual-Model', degradedOutcome.model);
      const clientData = buildInferenceClientData(
        degradedOutcome.data,
        degradedOutcome.model,
        degradedOutcome.contract,
        body,
        rawResponseRequested,
        false
      );
      clientData.agentx_degraded = degradedOutcome.degraded;
      res.json(clientData);
      scheduleShadowEvaluation(
        { model: degradedOutcome.model, hostUrl: degradedOutcome.hostUrl },
        {
          taskType: taskType || null,
          requestedModel: requestedModel || null,
          caller: 'proxy',
          callerDetail: body.callerDetail || null,
          correlationId: telemetryContext.correlationId,
          cloudEligible: false,
          requiredContextTokens: degradedOutcome.payload?.options?.num_ctx,
          consumerContract,
        }
      );
      return true;
    }
  }

  if (degradedOutcome && !degradedOutcome.retried) {
    logger.debug('[InferenceProxy] degraded retry not attempted', {
      reason: degradedOutcome.reason,
      taskType: taskType || null,
      model,
    });
  }
  return false;
}

module.exports = { tryAndRespondDegraded };
