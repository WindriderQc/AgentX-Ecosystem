/**
 * Nestor local-fallback prewarm (task 0454).
 *
 * Nestor's primary brain is a remote OpenRouter model, so a local warm-up
 * cannot lower that provider's latency. This service instead keeps the
 * effective `quick_chat` Ollama fallback healthy. The target is resolved from
 * live routing overrides on every run and is only warmed when it agrees with
 * the destination host's pins. This prevents a stale model list from evicting
 * the very models the platform has chosen to keep resident.
 */

const logger = require('../../config/logger');
const HostPreference = require('../../models/HostPreference');
const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
const { modelsMatch } = require('../helpers/modelNameNormalization');
const {
  ensureTaskModelOverridesLoaded,
  getModelForTask
} = require('./modelRouterConfig');

const FALLBACK_MODELS = (process.env.NESTOR_PREWARM_MODELS || '')
  .split(',')
  .map((model) => model.trim())
  .filter(Boolean);
const PREWARM_TASK_TYPE = process.env.NESTOR_PREWARM_TASK_TYPE || 'quick_chat';
const PREWARM_KEEP_ALIVE = process.env.NESTOR_PREWARM_KEEP_ALIVE || '15m';
const PREWARM_TIMEOUT_MS = Number(process.env.NESTOR_PREWARM_TIMEOUT_MS || 300_000);
const INVENTORY_TIMEOUT_MS = Number(process.env.NESTOR_PREWARM_INVENTORY_TIMEOUT_MS || 10_000);
const VRAM_BUDGET_FRACTION = Math.min(
  Math.max(Number(process.env.NESTOR_PREWARM_VRAM_FRACTION || 0.9), 0.1),
  1
);

let _fetch = null;
async function getFetch() {
  if (!_fetch) _fetch = (await import('node-fetch')).default;
  return _fetch;
}
function _setFetch(fn) { _fetch = fn; }

let _lastRun = null;
let _activeRun = null;

async function listHostModels(host) {
  const fetchFn = await getFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INVENTORY_TIMEOUT_MS);
  try {
    const response = await fetchFn(`${host.url}/api/tags`, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const payload = await response.json();
    return Array.isArray(payload?.models) ? payload.models : [];
  } catch (err) {
    const detail = err.name === 'AbortError' ? 'timed out' : err.message;
    throw new Error(`inventory failed: ${detail}`);
  } finally {
    clearTimeout(timer);
  }
}

function findMatchingEntry(entries, model) {
  return (entries || []).find((entry) => modelsMatch(entry?.model || entry?.name, model)) || null;
}

/**
 * Select installed targets without contradicting host pins or overcommitting
 * the host's VRAM budget. Selected entries retain their pin keep-alive so a
 * functional health ping cannot shorten an indefinite residency declaration.
 */
function buildHostPlan(host, models, inventory, { pinnedEntries = [] } = {}) {
  const capacityBytes = Number(host.vramMb) > 0
    ? Number(host.vramMb) * 1024 * 1024 * VRAM_BUDGET_FRACTION
    : Infinity;
  let plannedBytes = 0;
  const selected = [];
  const skipped = [];

  for (const requestedModel of models) {
    const pin = findMatchingEntry(pinnedEntries, requestedModel);
    if (pinnedEntries.length && !pin) {
      skipped.push({
        host: host.id,
        model: requestedModel,
        ok: true,
        skipped: true,
        reason: 'conflicts_with_pin'
      });
      continue;
    }

    const installed = findMatchingEntry(inventory, requestedModel);
    if (!installed) {
      skipped.push({
        host: host.id,
        model: requestedModel,
        ok: true,
        skipped: true,
        reason: 'not_installed'
      });
      continue;
    }

    const actualModel = installed.name || installed.model || requestedModel;
    if (selected.some((entry) => modelsMatch(entry.model, actualModel))) continue;
    const sizeBytes = Number(installed.size) > 0 ? Number(installed.size) : 0;
    if (sizeBytes && plannedBytes + sizeBytes > capacityBytes) {
      skipped.push({
        host: host.id,
        model: actualModel,
        ok: true,
        skipped: true,
        reason: 'vram_budget',
        sizeBytes
      });
      continue;
    }

    selected.push({
      model: actualModel,
      keepAlive: pin?.keepAlive ?? PREWARM_KEEP_ALIVE
    });
    plannedBytes += sizeBytes;
  }

  return { selected, skipped, plannedBytes, capacityBytes };
}

/** Generate one token: this verifies inference, not merely residency. */
async function prewarmOne(host, model, { keepAlive = PREWARM_KEEP_ALIVE } = {}) {
  const fetchFn = await getFetch();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PREWARM_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const response = await fetchFn(`${host.url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt: 'warmup',
        stream: false,
        keep_alive: keepAlive,
        options: { num_predict: 1 }
      }),
      signal: controller.signal
    });
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return { host: host.id, model, ok: false, durationMs, error: `HTTP ${response.status}` };
    }
    return { host: host.id, model, ok: true, durationMs };
  } catch (err) {
    return {
      host: host.id,
      model,
      ok: false,
      durationMs: Date.now() - startedAt,
      error: err.name === 'AbortError' ? 'timed out' : err.message
    };
  } finally {
    clearTimeout(timer);
  }
}

async function resolveTargets({ models, hosts } = {}) {
  const configuredHosts = hosts && hosts.length ? hosts : getConfiguredHosts();
  if (!configuredHosts.length) return { targets: [], skipped: 'no_hosts_configured' };

  const explicitModels = Array.isArray(models) ? models.filter(Boolean) : FALLBACK_MODELS;
  if (explicitModels.length) {
    return {
      targets: configuredHosts.map((host) => ({ host, models: explicitModels })),
      source: 'explicit_models'
    };
  }

  await ensureTaskModelOverridesLoaded();
  const route = getModelForTask(PREWARM_TASK_TYPE);
  const targetHost = configuredHosts.find((host) => (
    host.id === route?.host || host.url === route?.url
  ));
  if (!route?.model || !targetHost) {
    return { targets: [], skipped: 'routing_target_unavailable', route: route || null };
  }

  return {
    targets: [{ host: targetHost, models: [route.model] }],
    source: 'effective_task_route',
    taskType: PREWARM_TASK_TYPE,
    route
  };
}

async function loadPinnedEntries(host) {
  const pref = await HostPreference.findOne({ hostUrl: host.url }).lean();
  return Array.isArray(pref?.pinnedModels) ? pref.pinnedModels : [];
}

async function runPrewarm(options = {}) {
  const resolution = await resolveTargets(options);
  if (!resolution.targets.length) {
    logger.warn('Nestor prewarm skipped', { reason: resolution.skipped });
    _lastRun = {
      at: new Date().toISOString(),
      results: [],
      skipped: resolution.skipped,
      route: resolution.route || null
    };
    return _lastRun;
  }

  const hostRuns = await Promise.all(resolution.targets.map(async ({ host, models }) => {
    let pinnedEntries;
    let inventory;
    try {
      pinnedEntries = await loadPinnedEntries(host);
    } catch (err) {
      return [{ host: host.id, model: null, ok: false, phase: 'preferences', error: err.message }];
    }
    try {
      inventory = await listHostModels(host);
    } catch (err) {
      return [{ host: host.id, model: null, ok: false, phase: 'inventory', error: err.message }];
    }

    const plan = buildHostPlan(host, models, inventory, { pinnedEntries });
    const results = [...plan.skipped];
    for (const target of plan.selected) {
      results.push(await prewarmOne(host, target.model, { keepAlive: target.keepAlive }));
    }
    return results;
  }));

  const results = hostRuns.flat();
  const failed = results.filter((result) => !result.ok);
  if (failed.length) logger.warn('Nestor prewarm failed for some targets', { failed });
  _lastRun = {
    at: new Date().toISOString(),
    source: resolution.source,
    taskType: resolution.taskType || null,
    route: resolution.route || null,
    summary: {
      warmed: results.filter((result) => result.ok && !result.skipped).length,
      skipped: results.filter((result) => result.skipped).length,
      failed: failed.length
    },
    results
  };
  return _lastRun;
}

/** Coalesce overlapping scheduler/manual requests into one health cycle. */
function prewarmFallbackModels(options = {}) {
  if (_activeRun) return _activeRun;
  _activeRun = runPrewarm(options).finally(() => { _activeRun = null; });
  return _activeRun;
}

function getLastRun() {
  return _lastRun;
}

module.exports = {
  prewarmFallbackModels,
  getLastRun,
  FALLBACK_MODELS,
  PREWARM_TASK_TYPE,
  PREWARM_KEEP_ALIVE,
  prewarmOne,
  listHostModels,
  buildHostPlan,
  resolveTargets,
  _setFetch
};
