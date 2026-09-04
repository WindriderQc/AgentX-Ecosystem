'use strict';

const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const { listModels, pullModel, deleteModel } = require('../../clients/ollamaClient');
const settingsService = require('./settingsService');
const logger = require('../../../config/logger');

function resolveConfiguredHost(hostId) {
  const id = String(hostId || '').trim();
  if (!id) {
    const error = new Error('hostId is required');
    error.statusCode = 400;
    throw error;
  }

  const host = getConfiguredHosts().find(candidate => String(candidate.id) === id);
  if (!host) {
    const error = new Error(`Unknown configured Ollama host: ${id}`);
    error.statusCode = 400;
    throw error;
  }
  return host;
}

async function getBaselineModel() {
  const settings = await settingsService.getAll();
  const modelName = String(settings.baselineModel || '').trim().replace(/:latest$/i, '');
  if (!modelName) throw new Error('Profiler baseline model is not configured');
  return modelName;
}

async function setBaselineModel(modelName) {
  const normalized = String(modelName || '').trim().replace(/:latest$/i, '');
  if (!normalized) {
    const error = new Error('baselineModel is required');
    error.statusCode = 400;
    throw error;
  }
  const settings = await settingsService.save({ baselineModel: normalized });
  return settings.baselineModel;
}

async function getBaselineState(hostId, options = {}) {
  const [modelName, host] = await Promise.all([
    getBaselineModel(),
    Promise.resolve(resolveConfiguredHost(hostId))
  ]);
  const data = await listModels(host.url, { timeoutMs: 8_000, signal: options.signal });
  const models = (data.models || []).map(model => model.name).filter(Boolean);
  return {
    hostId: host.id,
    hostName: host.name,
    hostUrl: host.url,
    modelName,
    available: models.some(installed => isSameOllamaModel(installed, modelName)),
    models
  };
}

async function compensateBaselinePull(hostId, pullError) {
  // The artifact was absent before this operation. Inventory without the
  // possibly dead signal and remove any server-side install that completed
  // after the client lost its acknowledgement or its claim authority.
  const attempts = Math.max(1, Math.min(5, Number.parseInt(process.env.PROFILER_PULL_COMPENSATION_ATTEMPTS, 10) || 3));
  const settleMs = Math.max(0, Math.min(5000, Number.parseInt(process.env.PROFILER_PULL_COMPENSATION_SETTLE_MS, 10) || 250));
  try {
    let observed = null;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      if (attempt > 1 && settleMs > 0) await new Promise(resolve => setTimeout(resolve, settleMs));
      observed = await getBaselineState(hostId);
      if (observed.available) {
        await deleteModel(observed.hostUrl, observed.modelName, { timeoutMs: 120_000 });
      }
    }
    const verified = await getBaselineState(hostId);
    if (verified.available) {
      throw new Error('Late baseline artifact ' + verified.modelName + ' remained after compensation');
    }
  } catch (compensationError) {
    const error = new Error('Baseline pull outcome is ambiguous after failure: ' + compensationError.message);
    error.code = 'BASELINE_PULL_COMPENSATION_FAILED';
    error.statusCode = 503;
    error.cause = pullError;
    throw error;
  }
}

async function ensureBaselineModel(hostId, options = {}) {
  options.assertClaimActive?.();
  const before = await getBaselineState(hostId, options);
  options.assertClaimActive?.();
  if (before.available) return { ...before, pulled: false };

  const timeoutMs = Number.parseInt(process.env.OLLAMA_PULL_TIMEOUT_MS, 10) || 30 * 60 * 1000;
  logger.info('Profiler baseline model missing; pulling automatically', {
    hostId: before.hostId,
    hostUrl: before.hostUrl,
    modelName: before.modelName
  });
  options.assertClaimActive?.();
  try {
    await pullModel(before.hostUrl, before.modelName, { timeoutMs, signal: options.signal });
  } catch (pullError) {
    await compensateBaselinePull(hostId, pullError);
    throw pullError;
  }

  try {
    options.assertClaimActive?.();
    const after = await getBaselineState(hostId, options);
    options.assertClaimActive?.();
    if (!after.available) {
      const error = new Error(`Ollama reported a completed pull, but ${after.modelName} is still missing on ${after.hostName}`);
      error.statusCode = 502;
      throw error;
    }

    logger.info('Profiler baseline model pull complete', {
      hostId: after.hostId,
      hostUrl: after.hostUrl,
      modelName: after.modelName
    });
    return { ...after, pulled: true };
  } catch (postPullError) {
    await compensateBaselinePull(hostId, postPullError);
    throw postPullError;
  }
}

module.exports = {
  resolveConfiguredHost,
  getBaselineModel,
  setBaselineModel,
  getBaselineState,
  ensureBaselineModel
};
