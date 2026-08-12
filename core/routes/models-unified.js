/**
 * Unified Models API Routes
 *
 * Provides endpoints for unified model catalog (Ollama + custom + registry)
 */

const express = require('express');
const router = express.Router();
const modelAggregator = require('../src/services/modelAggregator');
const ollamaModelOperations = require('../src/services/ollamaModelOperations');
const logger = require('../config/logger');
const { isReadyStage } = require('../src/services/modelReadinessService');
const { validateObjectId } = require('../src/helpers/objectIdValidator');
const { getConfiguredHosts, hostUrlKey, validateHostUrl } = require('../src/helpers/ollamaHostConfig');
const { requireOperatorUiAccess } = require('../src/middleware/operatorAccess');

function readModelFilters(query = {}) {
  const { provider, category, tag, search, status, host } = query;
  return { provider, category, tag, search, status, host };
}

function requireProfiledModels() {
  return process.env.REQUIRE_PROFILED_MODELS === 'true';
}

function applyChatEligibility(models) {
  const hardGateEnabled = requireProfiledModels();
  return models.map((model) => {
    const readiness = model?.readiness || {};
    const ready = isReadyStage(readiness.stage);
    return {
      ...model,
      chatAllowed: hardGateEnabled ? ready : true
    };
  });
}

function resolveExplicitHost(rawHost) {
  if (!rawHost || !String(rawHost).trim()) {
    return { valid: false, message: 'A target Ollama host is required.' };
  }
  return validateHostUrl(rawHost);
}

function readRequiredModelName(rawName) {
  const name = String(rawName || '').trim();
  return name || null;
}

function sendOperationError(res, error, context) {
  logger.error('Ollama model operation failed', { ...context, error: error.message });
  res.status(error.statusCode || (error.type === 'request-timeout' ? 504 : 502)).json({
    status: 'error',
    message: error.message
  });
}

/**
 * GET /api/models/all
 * Get all models from all sources as a flat array.
 * Query params: ?provider=ollama&category=coding&tag=production&search=qwen&status=available
 */
router.get('/all', async (req, res) => {
  try {
    const filters = readModelFilters(req.query);

    const models = applyChatEligibility(await modelAggregator.getAllModels({
      includeOllama: true,
      includeCustom: true,
      includeRegistry: true,
      filters,
      useCache: true
    }));

    res.set('X-Require-Profiled-Models', String(requireProfiledModels()));
    res.json(models);

  } catch (error) {
    logger.error('Failed to get all models', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch models',
      error: error.message
    });
  }
});

/**
 * GET /api/models/catalog
 * Get the full catalog payload for the models page.
 */
router.get('/catalog', async (req, res) => {
  try {
    const filters = readModelFilters(req.query);

    const models = applyChatEligibility(await modelAggregator.getAllModels({
      includeOllama: true,
      includeCustom: true,
      includeRegistry: true,
      filters,
      useCache: false,
      deduplicateOllama: false
    }));

    const sources = await modelAggregator.getModelSources();

    res.json({
      status: 'success',
      data: {
        models,
        sources,
        total: models.length,
        filters,
        config: {
          requireProfiledModels: requireProfiledModels()
        }
      }
    });
  } catch (error) {
    logger.error('Failed to get model catalog', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch model catalog',
      error: error.message
    });
  }
});

/**
 * GET /api/models/sources
 * List all model sources (Ollama hosts, custom count, registry count)
 */
router.get('/sources', async (req, res) => {
  try {
    const sources = await modelAggregator.getModelSources();

    res.json({
      status: 'success',
      data: sources
    });

  } catch (error) {
    logger.error('Failed to get model sources', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch model sources',
      error: error.message
    });
  }
});

/**
 * GET /api/models/:name/detail
 * Get unified model detail
 * Query params: ?provider=ollama (optional)
 */
router.get('/:name/detail', async (req, res) => {
  try {
    const { name } = req.params;
    const { provider } = req.query;

    const model = await modelAggregator.getModelByName(name, provider);

    if (!model) {
      return res.status(404).json({
        status: 'error',
        message: 'Model not found',
        name,
        provider
      });
    }

    res.json({
      status: 'success',
      data: model
    });

  } catch (error) {
    logger.error('Failed to get model detail', { error: error.message, name: req.params.name });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch model detail',
      error: error.message
    });
  }
});

/**
 * POST /api/models/refresh-cache
 * Force cache refresh (admin action)
 */
router.post('/refresh-cache', async (req, res) => {
  try {
    const result = await modelAggregator.refreshModelCache();

    logger.info('Model cache refreshed', { result });

    res.json({
      status: 'success',
      data: result,
      message: `Found ${result.modelsFound} models across all sources`
    });

  } catch (error) {
    logger.error('Failed to refresh model cache', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to refresh cache',
      error: error.message
    });
  }
});

// ========================================
// Ollama Management
// ========================================

/**
 * POST /api/models/ollama/pull
 * Pull a model from Ollama library
 */
router.post('/ollama/pull', requireOperatorUiAccess, async (req, res) => {
  try {
    const name = readRequiredModelName(req.body?.name);
    const host = req.body?.host;

    if (!name) {
      return res.status(400).json({ status: 'error', message: 'Model name required' });
    }

    const hostCheck = resolveExplicitHost(host);
    if (!hostCheck.valid) {
      return res.status(400).json({ status: 'error', message: hostCheck.message });
    }

    const result = await ollamaModelOperations.pullModel(hostCheck.host, name);
    modelAggregator.clearCache();
    logger.info('Ollama pull complete', result);

    res.json({
      status: 'success',
      data: result,
      message: `Pulled ${name} to ${hostCheck.host}.`
    });

  } catch (error) {
    sendOperationError(res, error, { action: 'pull', name: req.body?.name, host: req.body?.host });
  }
});

/**
 * POST /api/models/ollama/start
 * Load a model into memory on one explicit host.
 */
router.post('/ollama/start', requireOperatorUiAccess, async (req, res) => {
  try {
    const name = readRequiredModelName(req.body?.name);
    const hostCheck = resolveExplicitHost(req.body?.host);
    if (!name) return res.status(400).json({ status: 'error', message: 'Model name required' });
    if (!hostCheck.valid) return res.status(400).json({ status: 'error', message: hostCheck.message });

    const result = await ollamaModelOperations.startModel(hostCheck.host, name, req.body?.keepAlive || '10m');
    res.json({ status: 'success', data: result, message: `Loaded ${name} on ${hostCheck.host}.` });
  } catch (error) {
    sendOperationError(res, error, { action: 'start', name: req.body?.name, host: req.body?.host });
  }
});

/**
 * POST /api/models/ollama/stop
 * Unload a model from memory
 */
router.post('/ollama/stop', requireOperatorUiAccess, async (req, res) => {
  try {
    const name = readRequiredModelName(req.body?.name);
    const host = req.body?.host;
    if (!name) return res.status(400).json({ status: 'error', message: 'Name required' });

    const hostCheck = resolveExplicitHost(host);
    if (!hostCheck.valid) {
      return res.status(400).json({ status: 'error', message: hostCheck.message });
    }

    const result = await ollamaModelOperations.stopModel(hostCheck.host, name);
    res.json({ status: 'success', data: result, message: `Unloaded ${name} from ${hostCheck.host}.` });
  } catch(error) {
    sendOperationError(res, error, { action: 'stop', name: req.body?.name, host: req.body?.host });
  }
});

/**
 * DELETE /api/models/ollama/:name
 * Delete a model
 */
router.delete('/ollama/:name', requireOperatorUiAccess, async (req, res) => {
  try {
    const name = readRequiredModelName(req.params.name);
    const { host } = req.query;

    const hostCheck = resolveExplicitHost(host);
    if (!hostCheck.valid) {
      return res.status(400).json({ status: 'error', message: hostCheck.message });
    }

    const result = await ollamaModelOperations.deleteModel(hostCheck.host, name);
    modelAggregator.clearCache();
    res.json({ status: 'success', data: result, message: `Deleted ${name} from ${hostCheck.host}.` });
  } catch(error) {
    sendOperationError(res, error, { action: 'delete', name: req.params.name, host: req.query.host });
  }
});

/**
 * GET /api/models/cluster-summary
 * Compact view of the local Ollama cluster for cross-app consumers
 * (notably the official OpenClaw runtime). Read-only snapshot of host preferences
 * + pinned model list. No auth, stable shape — keep backward compatible.
 */
router.get('/cluster-summary', async (_req, res) => {
  try {
    const Host = require('../models/Host');
    const HostPreference = require('../models/HostPreference');

    const [hosts, prefs] = await Promise.all([
      Host.find({}, { hostname: 1, name: 1, status: 1, ollamaStatus: 1 }).lean(),
      HostPreference.find({}, {
        hostId: 1, hostUrl: 1, hostKey: 1, displayName: 1, pinnedModels: 1,
        loadedModel: 1, loadedModels: 1, status: 1, vramTotalMiB: 1, vramReservedMiB: 1,
        gpu: 1, tags: 1
      }).lean()
    ]);

    const hostById = new Map(hosts.map(h => [String(h._id), h]));
    const prefByUrl = new Map(prefs.map(p => [hostUrlKey(p.hostUrl), p]).filter(([key]) => key));
    const configuredHosts = getConfiguredHosts();
    const configuredKeys = new Set(configuredHosts.map(h => hostUrlKey(h.url)).filter(Boolean));

    function buildPinned(p) {
      return (p?.pinnedModels || []).map(m => ({
        model: m.model,
        contextSize: m.contextSize || null,
        keepAlive: typeof m.keepAlive === 'number' ? m.keepAlive : -1
      }));
    }

    const rows = configuredHosts.map(configured => {
      const p = prefByUrl.get(hostUrlKey(configured.url)) || {};
      const h = hostById.get(String(p.hostId)) || {};
      const pinned = buildPinned(p);
      return {
        hostKey: configured.id,
        name: p.displayName || configured.name || h.name || h.hostname || configured.id,
        hostUrl: configured.url,
        hostname: h.hostname || '',
        online: h.status ? h.status === 'online' && h.ollamaStatus !== 'offline' : p.status !== 'offline',
        status: p.status || 'idle',
        loadedModel: p.loadedModel || null,
        loadedModels: Array.isArray(p.loadedModels) && p.loadedModels.length > 0
          ? p.loadedModels
          : (p.loadedModel ? [p.loadedModel] : []),
        pinnedModels: pinned,
        vramTotalMiB: p.vramTotalMiB || Math.round((configured.vramMb || 0)),
        vramReservedMiB: p.vramReservedMiB || 0,
        gpuModel: p.gpu?.model || ''
      };
    });

    const stalePreferences = prefs
      .filter(p => {
        const key = hostUrlKey(p.hostUrl);
        return key && !configuredKeys.has(key);
      })
      .map(p => ({
        hostKey: p.hostKey,
        hostUrl: p.hostUrl,
        name: p.displayName || p.hostKey || p.hostUrl,
        status: p.status || 'idle',
        pinnedCount: buildPinned(p).length,
        stale: true
      }));

    const order = { primary: 0, secondary: 1, tertiary: 2 };
    rows.sort((a, b) => (order[a.hostKey] ?? 9) - (order[b.hostKey] ?? 9));

    res.json({
      status: 'ok',
      hosts: rows,
      stalePreferences,
      totalPinned: rows.reduce((n, r) => n + r.pinnedModels.length, 0),
      generatedAt: new Date().toISOString()
    });
  } catch (err) {
    logger.warn('[models] cluster-summary failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
