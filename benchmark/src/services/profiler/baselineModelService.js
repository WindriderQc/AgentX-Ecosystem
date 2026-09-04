'use strict';

const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const { isSameOllamaModel } = require('../../helpers/ollamaModelIdentity');
const { listModels, pullModel } = require('../../clients/ollamaClient');
const settingsService = require('./settingsService');
const hostProfileService = require('./hostProfileService');
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

function pendingBaselinePullError(pullError, reconciliation) {
  const error = new Error(`Baseline pull outcome is pending durable reconciliation: ${pullError.message}`);
  error.code = 'BASELINE_PULL_RECONCILIATION_PENDING';
  error.statusCode = 503;
  error.cause = pullError;
  error.retainAdmission = true;
  error.reconciliation = reconciliation;
  return error;
}

async function resolveBaselineReconciliation(hostId, reconciliation, options = {}) {
  options.assertClaimActive?.();
  return hostProfileService.upsert({
    hostId,
    reconciliation: {
      ...reconciliation,
      state: 'resolved',
      reason: null,
      resolvedAt: new Date()
    }
  }, {
    assertAuthorityActive: options.assertClaimActive
  });
}

async function ensureBaselineModel(hostId, options = {}) {
  options.assertClaimActive?.();
  const before = await getBaselineState(hostId, options);
  options.assertClaimActive?.();
  if (before.available) return { ...before, pulled: false };

  const timeoutMs = Number.parseInt(process.env.OLLAMA_PULL_TIMEOUT_MS, 10) || 30 * 60 * 1000;
  const operationId = String(options.operationId || `baseline-pull-${Date.now()}`);
  const reconciliation = {
    state: 'pending_reconciliation',
    operation: 'baseline_pull',
    operationId,
    model: before.modelName,
    priorAvailable: false,
    timeoutAt: new Date(Date.now() + timeoutMs),
    reason: 'Ollama pull has not reached a server-terminal observation',
    startedAt: new Date()
  };
  await hostProfileService.upsert({ hostId: before.hostId, reconciliation }, {
    signal: options.signal,
    assertAuthorityActive: options.assertClaimActive
  });
  options.assertClaimActive?.();
  logger.info('Profiler baseline model missing; pulling automatically', {
    hostId: before.hostId,
    hostUrl: before.hostUrl,
    modelName: before.modelName
  });
  options.assertClaimActive?.();
  try {
    await pullModel(before.hostUrl, before.modelName, { timeoutMs, signal: options.signal });
  } catch (pullError) {
    throw pendingBaselinePullError(pullError, reconciliation);
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
    return { ...after, pulled: true, reconciliation };
  } catch (postPullError) {
    throw pendingBaselinePullError(postPullError, reconciliation);
  }
}

module.exports = {
  resolveConfiguredHost,
  getBaselineModel,
  setBaselineModel,
  getBaselineState,
  ensureBaselineModel,
  resolveBaselineReconciliation
};
