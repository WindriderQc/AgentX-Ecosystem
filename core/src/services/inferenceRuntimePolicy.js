'use strict';

const logger = require('../../config/logger');
const hostPreferenceService = require('./hostPreferenceService');
const { modelsMatch } = require('../helpers/modelNameNormalization');
const { resolveInferenceContract } = require('./inferenceContractService');
const { resolveThinkingPolicy } = require('./thinkingPolicy');

/**
 * Runtime preparation shared by HTTP generation, chat and injected consumers.
 * These are existing caller semantics, not permissions. In particular, direct
 * evaluation keeps its exact options; chat keeps caller residency overrides;
 * injected native consumers keep their explicit think value and native format.
 */
async function prepareInferenceRuntime(request, policy, overrides = {}) {
  const deps = {
    hostPreferenceService, modelsMatch, resolveInferenceContract,
    resolveThinkingPolicy, applyContractOutputLimit, ...overrides,
  };
  const { model, host, prompt, messages, system } = request;
  let options = { ...(request.options || {}) };
  let keepAlive = request.keepAlive;
  let numCtxSource = options.num_ctx != null ? 'caller'
    : ['extension', 'embed'].includes(policy) ? 'unresolved' : 'modelfile';

  if (policy !== 'direct') {
    const preference = await deps.hostPreferenceService.getByHost(host);
    if (policy === 'chat') {
      ({ options, keepAlive, numCtxSource } = deps.hostPreferenceService.resolvePinnedRuntimeOptions(
        preference, model, options, keepAlive
      ));
    } else {
      const entries = policy === 'generate'
        ? (preference ? deps.hostPreferenceService.getPinnedEntries(preference) : [])
        : (preference?.pinnedModels || []);
      const pin = entries.find(entry => policy === 'generate'
        ? entry.model === model : deps.modelsMatch(entry.model, model));
      if (pin) {
        keepAlive = pin.keepAlive ?? -1;
        const contextSize = Number(pin.contextSize);
        if (options.num_ctx == null && Number.isFinite(contextSize) && contextSize > 0) {
          options.num_ctx = Math.round(contextSize);
          numCtxSource = 'host_preference_pin';
        }
      }
    }
  }
  const contractInput = {
    model, host, prompt, messages, system,
    requestedNumCtx: options.num_ctx, numCtxSource,
    requestedMaxOutputTokens: options.num_predict,
  };
  const inferenceContract = request.includeArtifactIdentity === undefined
    ? await deps.resolveInferenceContract(contractInput)
    : await deps.resolveInferenceContract(contractInput, { includeArtifactIdentity: request.includeArtifactIdentity });
  if (policy !== 'chat' && policy !== 'embed') {
    deps.applyContractOutputLimit({ routed: policy !== 'direct', options, inferenceContract });
  }
  const thinkingPolicy = ['extension', 'embed'].includes(policy) ? null : deps.resolveThinkingPolicy({
    requestedThink: request.think,
    thinkingMode: request.thinkingMode,
    capabilityContract: inferenceContract,
    taskType: request.taskType,
    callerDetail: request.callerDetail,
    laneName: request.laneName,
    rawResponseRequested: request.rawResponseRequested,
    stream: request.stream,
  });
  return { options, keepAlive, numCtxSource, inferenceContract, thinkingPolicy,
    think: thinkingPolicy ? thinkingPolicy.think : request.think };
}

/**
 * Preserve an app-managed embedding pin across normal inference traffic.
 * Preference lookup fails open so Mongo availability cannot block embeddings.
 */
async function resolveEmbeddingKeepAlive(host, model) {
  try {
    const pref = await hostPreferenceService.getByHost(host);
    return hostPreferenceService.resolvePinnedRuntimeOptions(pref, model, {}).keepAlive;
  } catch (err) {
    logger.warn('Embedding pin options unavailable; using Ollama default residency', {
      host,
      model,
      error: err.message
    });
    return undefined;
  }
}

/**
 * Enforce the contract's output reserve only on routed daily traffic. Direct
 * profiler/benchmark calls and explicit caller values keep full control.
 */
function applyContractOutputLimit({ routed, options, inferenceContract }) {
  const resolvedOutputTokens = Number(inferenceContract?.contextBudget?.output?.reservedTokens);
  if (routed && options.num_predict == null
      && Number.isInteger(resolvedOutputTokens) && resolvedOutputTokens > 0) {
    options.num_predict = resolvedOutputTokens;
    inferenceContract.contextBudget.enforcement = 'ollama_num_predict';
  } else if (options.num_predict != null) {
    inferenceContract.contextBudget.enforcement = 'caller_num_predict';
  }
}

module.exports = {
  prepareInferenceRuntime,
  applyContractOutputLimit,
  resolveEmbeddingKeepAlive
};
