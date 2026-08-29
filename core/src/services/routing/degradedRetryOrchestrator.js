'use strict';

const logger = require('../../../config/logger');
const { HOSTS } = require('../modelRouterConfig');
const { hostUrlKey } = require('../../helpers/ollamaHostConfig');
const { modelsMatch } = require('../../helpers/modelNameNormalization');
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
  isCrossModelFallbackAllowed,
  isRetryEligible,
} = require('./degradedFallback');
const {
  executeAdmittedOllamaAttempt,
  modelExistsOnHost,
  resolveVerifiedFallbackModel,
} = require('./inferenceAttemptExecutor');

/**
 * Operator pins are the server-owned cross-model allowlist. A request cannot
 * nominate an arbitrary replacement model: it may only use an exact model tag
 * already pinned on an approved fallback host. Exact live identity and
 * Benchmark qualification are checked later, immediately before dispatch.
 */
function buildPinnedCrossModelCandidates(preferences = [], primaryModel, failedHostUrl) {
  const candidates = [];
  const seen = new Set();

  for (const preference of preferences) {
    const pinnedEntries = hostPreferenceService.getPinnedEntries(preference) || [];
    for (const entry of pinnedEntries) {
      const candidateModel = typeof entry?.model === 'string' ? entry.model.trim() : '';
      if (!candidateModel || modelsMatch(candidateModel, primaryModel)) continue;

      const [candidate] = buildCandidates([
        { ...preference, pinnedModels: [entry] },
      ], candidateModel, failedHostUrl);
      if (!candidate) continue;

      const key = `${candidateModel.toLowerCase()}@${hostUrlKey(candidate.hostUrl)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push({
        ...candidate,
        crossModel: true,
        selectionPolicy: 'operator_pinned_exact_artifact',
      });
    }
  }

  return candidates;
}

function exactArtifactQualified(contract) {
  return contract?.qualification?.qualified === true
    && contract?.qualification?.exactArtifact === true
    && contract?.artifact?.identityQualified === true;
}

function inputFitsCandidate(contract) {
  const budget = contract?.contextBudget;
  return budget?.input?.fits === true
    && budget?.input?.validatedFits !== false
    && budget?.transformations?.upstreamTruncationRisk !== true;
}

async function prepareCandidates({
  preferences,
  candidates,
  baseModel,
  model,
  ollamaPayload,
  requestContext,
}) {
  const prepared = [];
  for (const candidate of candidates) {
    if (requestContext.signal?.aborted) break;
    const crossModel = candidate.crossModel === true
      || !modelsMatch(candidate.model, baseModel);
    const candidateModel = crossModel
      ? candidate.model
      : await resolveVerifiedFallbackModel({
        hostUrl: candidate.hostUrl,
        baseModel,
        resolvedPrimaryModel: model,
      });
    const exactInstalled = crossModel
      ? await modelExistsOnHost(candidate.hostUrl, candidateModel)
      : Boolean(candidateModel);
    const resolvedCandidateModel = exactInstalled ? candidateModel : null;
    if (!resolvedCandidateModel) continue;

    const preference = preferences.find(
      (pref) => hostUrlKey(pref.hostUrl) === hostUrlKey(candidate.hostUrl)
    );
    const fallbackBaseOptions = { ...(ollamaPayload.options || {}) };
    if (requestContext.numCtxSource === 'host_preference_pin') delete fallbackBaseOptions.num_ctx;
    const runtime = hostPreferenceService.resolvePinnedRuntimeOptions(
      preference,
      resolvedCandidateModel,
      fallbackBaseOptions,
      requestContext.callerKeepAlive
    );
    const contract = await resolveInferenceContract({
      model: resolvedCandidateModel,
      host: candidate.hostUrl,
      prompt: requestContext.prompt,
      messages: requestContext.messages,
      system: requestContext.system,
      requestedNumCtx: runtime.options.num_ctx,
      numCtxSource: runtime.numCtxSource,
      requestedMaxOutputTokens: runtime.options.num_predict,
    }, { includeArtifactIdentity: crossModel });
    if (crossModel && (!exactArtifactQualified(contract) || !inputFitsCandidate(contract))) {
      continue;
    }
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
      model: resolvedCandidateModel,
      stream: false,
      options: runtime.options,
    };
    if (thinkingPolicy.think === undefined) delete payload.think;
    else payload.think = thinkingPolicy.think;
    if (runtime.keepAlive === undefined) delete payload.keep_alive;
    else payload.keep_alive = runtime.keepAlive;

    prepared.push({
      ...candidate,
      model: resolvedCandidateModel,
      crossModel,
      artifact: {
        ...candidate.artifact,
        qualified: crossModel ? true : candidate.artifact?.qualified,
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
    attemptState, model, failedHostUrl, ollamaPayload, useChat,
    requestContext, beforeAttempt,
  } = options;
  const baseModel = options.baseModel || model;
  if (requestContext.signal?.aborted) return { retried: false, reason: 'caller_cancelled' };
  if (!isEnabled()) return null;
  const eligibility = isRetryEligible(attemptState);
  if (!eligibility.eligible) return { retried: false, reason: eligibility.reason };
  const crossModelAllowed = isCrossModelFallbackAllowed(attemptState);

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
    let prepared = await prepareCandidates({
      preferences,
      candidates: alternatives,
      baseModel,
      model,
      ollamaPayload,
      requestContext: { ...requestContext, numCtxSource: attemptState.numCtxSource, taskType: attemptState.lane },
    });

    if (!prepared.length && crossModelAllowed) {
      const pinnedCrossModelCandidates = buildPinnedCrossModelCandidates(
        preferences,
        baseModel,
        failedHostUrl
      ).filter((candidate) => {
        const configuredUrl = HOSTS[candidate.host?.key];
        return configuredUrl && hostUrlKey(configuredUrl) === hostUrlKey(candidate.hostUrl);
      });
      const crossResolved = resolveRetryCandidates(pinnedCrossModelCandidates, {
        taskType: attemptState.lane,
        requestedModel: baseModel,
        // The primary host's requested num_ctx is not a request-size fact. The
        // exact candidate contract below checks the actual input estimate
        // against the alternate's own profiled/pinned context window.
        requiredContextTokens: undefined,
      });
      const crossAlternatives = crossResolved.candidates.filter(
        (candidate) => hostUrlKey(candidate.hostUrl) !== hostUrlKey(failedHostUrl)
      );
      if (!crossAlternatives.length) {
        return { retried: false, reason: REFUSAL_REASONS.NO_LOCAL_CANDIDATE };
      }
      prepared = await prepareCandidates({
        preferences,
        candidates: crossAlternatives,
        baseModel,
        model,
        ollamaPayload,
        requestContext: { ...requestContext, numCtxSource: attemptState.numCtxSource, taskType: attemptState.lane },
      });
      if (!prepared.length) {
        return { retried: false, reason: REFUSAL_REASONS.CROSS_MODEL_NOT_QUALIFIED };
      }
    }

    if (!prepared.length) return { retried: false, reason: REFUSAL_REASONS.ARTIFACT_NOT_VERIFIED };
    if (requestContext.signal?.aborted) return { retried: false, reason: 'caller_cancelled' };
    if (typeof beforeAttempt === 'function') beforeAttempt();

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
            signal: requestContext.signal,
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
            isTimeout: err.isOllamaTimeout === true
              || (err.name === 'AbortError' && err.isCallerCancellation !== true),
            isCallerCancellation: err.isCallerCancellation === true,
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
      isCallerCancellation: outcome.result?.isCallerCancellation === true,
      durationMs: outcome.result?.durationMs || 0,
      contract: outcome.result?.contract,
      thinkingPolicy: outcome.result?.thinkingPolicy,
      numCtxSource: outcome.result?.numCtxSource,
      payload: outcome.result?.payload,
    };
  } catch (err) {
    if (requestContext.signal?.aborted) {
      return { retried: false, reason: 'caller_cancelled' };
    }
    logger.debug('[InferenceProxy] degraded retry failed', { error: err.message });
    return { retried: false, reason: 'retry_execution_failed' };
  }
}

module.exports = {
  buildPinnedCrossModelCandidates,
  exactArtifactQualified,
  inputFitsCandidate,
  prepareCandidates,
  tryDegradedRetry,
};
