'use strict';

const logger = require('../../../config/logger');
const { HOSTS } = require('../modelRouterConfig');
const { hostUrlKey } = require('../../helpers/ollamaHostConfig');
const hostPreferenceService = require('../hostPreferenceService');
const { applyContractOutputLimit } = require('../inferenceRuntimePolicy');
const { resolveInferenceContract } = require('../inferenceContractService');
const { resolveThinkingPolicy } = require('../thinkingPolicy');
const { buildCandidates } = require('./shadowEvaluation');
const {
  REFUSAL_REASONS,
  runDegradedRetry,
  resolveRetryCandidates,
  isEnabled,
  isRetryEligible,
} = require('./degradedFallback');
const {
  executeAdmittedOllamaAttempt,
  resolveVerifiedFallbackModel,
} = require('./inferenceAttemptExecutor');

async function prepareCandidates({
  preferences,
  candidates,
  baseModel,
  model,
  ollamaPayload,
  useAdapted,
  requestContext,
}) {
  const prepared = [];
  for (const candidate of candidates) {
    const resolvedModel = await resolveVerifiedFallbackModel({
      hostUrl: candidate.hostUrl,
      baseModel,
      resolvedPrimaryModel: model,
      useAdapted,
    });
    if (!resolvedModel) continue;

    const preference = preferences.find(
      (pref) => hostUrlKey(pref.hostUrl) === hostUrlKey(candidate.hostUrl)
    );
    const fallbackBaseOptions = { ...(ollamaPayload.options || {}) };
    if (requestContext.numCtxSource === 'host_preference_pin') delete fallbackBaseOptions.num_ctx;
    const runtime = hostPreferenceService.resolvePinnedRuntimeOptions(
      preference,
      resolvedModel,
      fallbackBaseOptions,
      requestContext.callerKeepAlive
    );
    const contract = await resolveInferenceContract({
      model: resolvedModel,
      host: candidate.hostUrl,
      prompt: requestContext.prompt,
      messages: requestContext.messages,
      system: requestContext.system,
      requestedNumCtx: runtime.options.num_ctx,
      numCtxSource: runtime.numCtxSource,
      requestedMaxOutputTokens: runtime.options.num_predict,
    });
    applyContractOutputLimit({
      routed: requestContext.lane.route,
      options: runtime.options,
      inferenceContract: contract,
    });
    const thinkingPolicy = resolveThinkingPolicy({
      requestedThink: requestContext.requestedThink,
      thinkingMode: requestContext.thinkingMode,
      capabilityContract: contract,
      taskType: requestContext.taskType,
      callerDetail: requestContext.callerDetail,
      laneName: requestContext.laneName,
      rawResponseRequested: requestContext.rawResponseRequested,
      stream: false,
    });
    const payload = {
      ...ollamaPayload,
      model: resolvedModel,
      stream: false,
      options: runtime.options,
    };
    if (thinkingPolicy.think === undefined) delete payload.think;
    else payload.think = thinkingPolicy.think;
    if (runtime.keepAlive === undefined) delete payload.keep_alive;
    else payload.keep_alive = runtime.keepAlive;

    prepared.push({
      ...candidate,
      model: resolvedModel,
      artifact: {
        ...candidate.artifact,
        pinOptions: {
          ...(runtime.options.num_ctx != null && { num_ctx: runtime.options.num_ctx }),
          ...(runtime.keepAlive !== undefined && { keep_alive: runtime.keepAlive }),
        },
      },
      attempt: { payload, contract, thinkingPolicy, numCtxSource: runtime.numCtxSource },
    });
  }
  return prepared;
}

async function tryDegradedRetry(options) {
  const {
    attemptState, model, failedHostUrl, ollamaPayload, useChat, useAdapted,
    requestContext, beforeAttempt,
  } = options;
  const baseModel = options.baseModel || model;
  if (!isEnabled()) return null;
  const eligibility = isRetryEligible(attemptState);
  if (!eligibility.eligible) return { retried: false, reason: eligibility.reason };

  try {
    const preferences = await hostPreferenceService.getAll();
    const configuredCandidates = buildCandidates(preferences, baseModel, failedHostUrl)
      .filter((candidate) => {
        const configuredUrl = HOSTS[candidate.host?.key];
        return configuredUrl && hostUrlKey(configuredUrl) === hostUrlKey(candidate.hostUrl);
      });
    const { candidates } = resolveRetryCandidates(configuredCandidates, {
      taskType: attemptState.lane,
      requestedModel: baseModel,
      requiredContextTokens: attemptState.requiredContextTokens,
    });
    const alternatives = candidates.filter(
      (candidate) => hostUrlKey(candidate.hostUrl) !== hostUrlKey(failedHostUrl)
    );
    if (alternatives.length && typeof beforeAttempt === 'function') beforeAttempt();
    const prepared = await prepareCandidates({
      preferences,
      candidates: alternatives,
      baseModel,
      model,
      ollamaPayload,
      useAdapted,
      requestContext: { ...requestContext, numCtxSource: attemptState.numCtxSource, taskType: attemptState.lane },
    });
    if (!prepared.length) return { retried: false, reason: REFUSAL_REASONS.ARTIFACT_NOT_VERIFIED };

    const outcome = await runDegradedRetry({
      attemptState,
      candidates: prepared,
      failedCandidate: { model: baseModel, hostUrl: failedHostUrl },
      executeAttempt: async (candidate) => {
        try {
          const result = await executeAdmittedOllamaAttempt({
            hostUrl: candidate.hostUrl,
            model: candidate.model,
            payload: candidate.attempt.payload,
            useChat,
            stream: false,
            skipGate: requestContext.skipGate,
            timeoutMs: requestContext.timeoutMs,
          });
          return {
            ...result,
            model: candidate.model,
            contract: candidate.attempt.contract,
            thinkingPolicy: candidate.attempt.thinkingPolicy,
            numCtxSource: candidate.attempt.numCtxSource,
            payload: candidate.attempt.payload,
          };
        } catch (err) {
          return {
            ok: false,
            status: null,
            error: err,
            isTimeout: err.name === 'AbortError',
            durationMs: err.attemptDurationMs || 0,
            model: candidate.model,
            contract: candidate.attempt.contract,
            thinkingPolicy: candidate.attempt.thinkingPolicy,
            numCtxSource: candidate.attempt.numCtxSource,
            payload: candidate.attempt.payload,
          };
        }
      },
    });

    if (!outcome.retried) return outcome;
    return {
      ...outcome,
      ok: outcome.result?.ok === true,
      data: outcome.result?.data,
      hostUrl: outcome.candidate.hostUrl,
      model: outcome.result?.model || outcome.candidate.model,
      status: outcome.result?.status,
      error: outcome.result?.error,
      isTimeout: outcome.result?.isTimeout === true,
      durationMs: outcome.result?.durationMs || 0,
      contract: outcome.result?.contract,
      thinkingPolicy: outcome.result?.thinkingPolicy,
      numCtxSource: outcome.result?.numCtxSource,
      payload: outcome.result?.payload,
    };
  } catch (err) {
    logger.debug('[InferenceProxy] degraded retry failed', { error: err.message });
    return { retried: false, reason: 'retry_execution_failed' };
  }
}

module.exports = { tryDegradedRetry };
