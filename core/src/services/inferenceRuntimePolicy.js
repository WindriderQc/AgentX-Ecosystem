'use strict';

const logger = require('../../config/logger');
const hostPreferenceService = require('./hostPreferenceService');

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
  applyContractOutputLimit,
  resolveEmbeddingKeepAlive
};
