'use strict';

const logger = require('../../../config/logger');
const RouterTaskConfig = require('../../../models/RouterTaskConfig');
const modelAggregator = require('../modelAggregator');
const { PRODUCT_DEFAULT_MODEL } = require('../modelRouterDefaults');
const {
  buildCouncilDefaults,
  configuredModelFromEnv
} = require('./defaults');

async function persistedGeneralChatModel() {
  try {
    const row = await RouterTaskConfig.findOne({ taskType: 'general_chat' }).lean();
    const model = String(row?.model || '').trim();
    return model ? { model, source: 'routertaskconfigs:general_chat' } : null;
  } catch (error) {
    logger.warn('Council could not read the persisted general-chat model', { error: error.message });
    return null;
  }
}

async function discoveredRuntimeModels() {
  try {
    return await modelAggregator.getAllModels({
      includeOllama: true,
      includeCustom: false,
      includeRegistry: false,
      includeEvidence: false,
      useCache: false
    });
  } catch (error) {
    logger.warn('Council model discovery failed', { error: error.message });
    return [];
  }
}

async function resolveConfiguredModel(env = process.env) {
  const councilSpecific = configuredModelFromEnv({ ROUNDTABLE_MODEL: env.ROUNDTABLE_MODEL });
  if (councilSpecific.model) return councilSpecific;

  const persisted = await persistedGeneralChatModel();
  if (persisted) return persisted;

  return configuredModelFromEnv(env);
}

async function resolveCouncilDefaults({ env = process.env } = {}) {
  const [catalog, configured] = await Promise.all([
    discoveredRuntimeModels(),
    resolveConfiguredModel(env)
  ]);
  return buildCouncilDefaults({
    catalog,
    configuredModel: configured.model,
    configuredSource: configured.source,
    // A code bootstrap value is only eligible after live discovery proves the
    // exact artifact exists. It is never advertised on its own.
    preferredDiscoveredModel: PRODUCT_DEFAULT_MODEL
  });
}

module.exports = {
  persistedGeneralChatModel,
  discoveredRuntimeModels,
  resolveConfiguredModel,
  resolveCouncilDefaults
};
