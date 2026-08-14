'use strict';
/**
 * Host Preference Service
 *
 * Manages pinned model preferences per host, warmup, and periodic health checks.
 *
 * As of task 0151, the legacy `defaultModels` + `pinnedModel` dual-state model
 * has been unified into a single `pinnedModels: [{ model, keepAlive,
 * contextSize, autoRestore }]` array. The service still exposes
 * backward-compat helpers (getDefaultModelForHost, getDefaultModelsMap) that
 * project the new shape onto the old API for callers that haven't migrated
 * yet (modelRouterConfig pin cache, clusterScheduleService recommendHost,
 * inference.js keep-alive lookup).
 *
 * Task 0227 — this file was 1042 lines (cap 700) and mixed four concerns:
 * pin CRUD, a health-check daemon, the pin-reconciler grace-period state
 * machine, and benchmark-claim re-exports. The split moved:
 *   - the shared pin/loaded-model helpers → ./hostPinPrimitives
 *   - the reconciler + grace-period state machine → ./pinReconciler
 *   - the health-check interval scheduler → ./hostHealthDaemon
 * This file remains the facade: it keeps pin CRUD, the warm/restore
 * primitives, and re-exports every name the extracted modules own so the
 * public export surface is UNCHANGED. (Task 0183 had already moved the
 * benchmark-claim lifecycle to ./benchmarkClaimService; those re-exports stay.)
 */

const HostPreference = require('../../models/HostPreference');
const hostGate = require('./hostGate');
const logger = require('../../config/logger');
const { observePinRestoreFailure } = require('./laneObservabilityService');
const benchmarkClaimService = require('./benchmarkClaimService');
const hostHealthDaemon = require('./hostHealthDaemon');
const pinReconciler = require('./pinReconciler');
const hostPreferenceIdentity = require('./hostPreferenceIdentity');
const {
  pinRestoreVerifyTimeoutMs,
  normalizePinName,
  pinNamesMatch,
  getPinnedEntries,
  getPinnedModelNames,
  getPrimaryPinnedModel,
  resolvePinnedRuntimeOptions,
  positiveInteger,
  readLoadedContextLength,
  findLoadedModelInfo,
  isEmbeddingModelName,
  getWarmOrder,
  getLoadedEntryStatus,
  entrySatisfiedByLoadedModel,
  fetchRunningModelInfos,
  sleep,
  verifyPinnedEntriesLoaded
} = require('./hostPinPrimitives');

// Task 0183 — benchmark-claim lifecycle (acquire/release/list/reap +
// hasActiveBenchmarkClaim) was extracted to benchmarkClaimService.js.
// The reconciler (now in pinReconciler.js) still calls hasActiveBenchmarkClaim
// to short-circuit pin warming. The grace-period state machine (task 0176)
// moved to pinReconciler.js in task 0227.
const { hasActiveBenchmarkClaim } = benchmarkClaimService;

let pinWarmTimeoutMs = parseInt(process.env.PIN_WARM_TIMEOUT_MS, 10);
if (!Number.isFinite(pinWarmTimeoutMs) || pinWarmTimeoutMs < 30_000) {
  pinWarmTimeoutMs = 600_000;
}

const activePinRestores = new Map();

// ── CRUD ────────────────────────────────────────────────────

async function getAll() {
  return HostPreference.find().lean();
}

async function getByHost(hostUrl) {
  return HostPreference.findOne({ hostUrl }).lean();
}

async function updatePreference(hostUrl, updates) {
  const normalizedUpdates = hostPreferenceIdentity.normalizeHostPreferenceUpdates(hostUrl, updates);
  return HostPreference.findOneAndUpdate(
    { hostUrl },
    { $set: { hostUrl, ...normalizedUpdates } },
    { new: true, upsert: true }
  ).lean();
}

async function deletePreference(hostUrl) {
  return HostPreference.deleteOne({ hostUrl });
}

// ── Pin / loaded-model helpers ─────────────────────────────
// The shared low-level helpers (getPinnedEntries, getLoadedEntryStatus,
// fetchRunningModelInfos, verifyPinnedEntriesLoaded, the normalize aliases,
// etc.) live in ./hostPinPrimitives and are imported above. They are
// re-exported below where they were part of the public surface.

// Legacy API — returns the first pinned model's name. Some callers still
// expect a single "default" model name.
async function getDefaultModelForHost(hostUrl) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  return getPrimaryPinnedModel(pref);
}

// ── Warmup ──────────────────────────────────────────────────

async function warmDefaultModel(hostUrl, model, { keepAlive = -1, contextSize = 0 } = {}) {
  try {
    const isEmbedding = isEmbeddingModelName(model);
    const endpoint = isEmbedding ? 'embeddings' : 'generate';
    const payload = isEmbedding
      ? { model, prompt: 'warmup' }
      : {
          model,
          prompt: 'warmup',
          stream: false,
          keep_alive: keepAlive,
          options: { num_predict: 1 }
        };
    if (!isEmbedding && contextSize > 0) {
      payload.options.num_ctx = contextSize;
    }
    if (isEmbedding && keepAlive !== undefined && keepAlive !== '') {
      // 0508: pass keep_alive through for embeddings like the generate path —
      // including -1 (pin forever). The old positive-only guard let
      // keepAlive:-1 embedding pins silently expire on Ollama's 5-minute
      // default, leaving autoRestore in a perpetual re-warm loop.
      payload.keep_alive = Number(keepAlive) > 0
        ? `${Math.round(Number(keepAlive))}s`
        : keepAlive;
    }
    const response = await fetch(`${hostUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(pinWarmTimeoutMs)
    });
    if (!response.ok) {
      const text = await response.text();
      return { host: hostUrl, model, status: 'error', error: text };
    }
    await response.text();
    return { host: hostUrl, model, status: 'ok' };
  } catch (err) {
    return { host: hostUrl, model, status: 'error', error: err.message };
  }
}

/**
 * Warm every pinned model on a single host. Skips entries whose model is
 * already loaded. Updates loadedModel/status where appropriate.
 */
async function warmHost(hostUrl) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  if (!pref) return [];
  const entries = getPinnedEntries(pref);
  if (entries.length === 0) return [];

  // 0175: refuse to warm the pin while the host is claimed by a benchmark
  // batch. The bench unloaded the pin on purpose so its target model could
  // own VRAM; warming again here forces a swap that will tank every
  // remaining prompt in the batch. Callers (NerveCenter /reload button,
  // bench's restoreAllDedication) get a structured "skipped_claim" result
  // so they can log/UI accordingly. The bench's release path triggers a
  // restore on its own once the claim is cleared.
  if (hasActiveBenchmarkClaim(pref)) {
    logger.info(`[HostPreference] warmHost skipped on ${pref.displayName || hostUrl} — active benchmark claim`, {
      batchId: pref.benchmarkClaim?.batchId || null,
      pinnedModels: entries.map(e => e.model)
    });
    return entries.map(entry => ({
      host: hostUrl,
      model: entry.model,
      status: 'skipped_claim',
      batchId: pref.benchmarkClaim?.batchId || null
    }));
  }

  const results = [];

  // Fetch running models once per host; if unreachable we still attempt warmup
  let runningModelInfos = await fetchRunningModelInfos(hostUrl);

  for (const entry of getWarmOrder(entries)) {
    const t0 = Date.now();
    logger.info(`[HostPreference] Warming pinned model ${entry.model} on ${pref.displayName || hostUrl}`);

    const loadedStatus = getLoadedEntryStatus(entry, runningModelInfos);
    if (entrySatisfiedByLoadedModel(entry, runningModelInfos)) {
      await updateLoadedModel(hostUrl, entry.model);
      results.push({
        host: hostUrl, model: entry.model, status: 'already_loaded',
        durationMs: Date.now() - t0
      });
      continue;
    }

    if (loadedStatus.contextMismatch) {
      logger.info(`[HostPreference] Pinned model context mismatch on ${pref.displayName || hostUrl}; warming at configured context`, {
        model: entry.model,
        loadedModel: loadedStatus.loadedModel,
        loadedContextLength: loadedStatus.loadedContextLength,
        expectedContextLength: loadedStatus.expectedContextLength
      });
    }

    // Mark host as restoring while we warm. If there are multiple entries we
    // only care about the primary for status — secondary warmups inherit.
    if (entries[0].model === entry.model) {
      await setHostStatus(hostUrl, 'restoring');
    }
    const opts = { keepAlive: entry.keepAlive ?? -1, contextSize: entry.contextSize ?? 0 };
    const result = await warmDefaultModel(hostUrl, entry.model, opts);
    result.durationMs = Date.now() - t0;
    results.push(result);

    if (result.status === 'ok' && entries[0].model === entry.model) {
      await updateLoadedModel(hostUrl, entry.model);
      runningModelInfos = await fetchRunningModelInfos(hostUrl);
    } else if (result.status !== 'ok' && entries[0].model === entry.model) {
      await setHostStatus(hostUrl, 'idle');
    }
  }

  return results;
}

async function warmAllDefaults() {
  const prefs = await getAll();
  const results = [];
  for (const pref of prefs) {
    const hostResults = await warmHost(pref.hostUrl);
    results.push(...hostResults);
  }
  return results;
}

/**
 * Backward-compat shim: returns Map<hostUrl, string[]> of pinned model names.
 * Consumers (clusterScheduleService.recommendHost, modelRouterConfig pin
 * cache) care about "which models are preferred on which host" — they don't
 * care whether those come from `defaultModels` or `pinnedModel`. After
 * task 0151 they all come from `pinnedModels[*].model`.
 */
async function getDefaultModelsMap() {
  const prefs = await getAll();
  const map = new Map();
  for (const p of prefs) {
    map.set(p.hostUrl, getPinnedModelNames(p));
  }
  return map;
}

// ── Pinning ────────────────────────────────────────────────
//
// Historically `setPinnedModel` wrote a single top-level `pinnedModel`
// field. After 0151 we treat it as "make this the only pinned entry" — the
// UI's Pin panel is a single-model affair so this preserves its semantics.
// `addPinnedModel` / `removePinnedModel` are the multi-entry API.

async function getPinStatus(hostUrl) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  const entries = getPinnedEntries(pref);
  const loadedList = Array.isArray(pref?.loadedModels) && pref.loadedModels.length > 0
    ? pref.loadedModels
    : (pref?.loadedModel ? [pref.loadedModel] : []);
  return {
    pinnedModels: entries,
    loadedModel: pref?.loadedModel || null,
    loadedModels: loadedList,
    status: pref?.status || 'idle'
  };
}

async function setPinnedModel(hostUrl, model) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  if (!pref) return null;
  const alreadyLoaded = pref.loadedModel === model;

  // Replace pinnedModels with a single entry. Preserve the old entry's
  // keepAlive/contextSize/autoRestore if model matches one of them.
  const existingEntries = getPinnedEntries(pref);
  const match = existingEntries.find(e => e.model === model);
  const entry = match || {
    model,
    keepAlive: -1,
    contextSize: 0,
    autoRestore: true
  };

  return HostPreference.findOneAndUpdate(
    { hostUrl },
    {
      $set: {
        pinnedModels: [entry],
        status: alreadyLoaded ? 'ready' : 'restoring'
      },
      // Clean up legacy fields now that we're explicitly writing the new shape
      $unset: { pinnedModel: '', defaultModels: '', keepAlive: '', contextSize: '', autoRestore: '' }
    },
    { new: true }
  ).lean();
}

async function clearPinnedModel(hostUrl) {
  return HostPreference.findOneAndUpdate(
    { hostUrl },
    {
      $set: { pinnedModels: [], status: 'idle' },
      $unset: { pinnedModel: '', defaultModels: '', keepAlive: '', contextSize: '', autoRestore: '' }
    },
    { new: true }
  ).lean();
}

async function addPinnedModel(hostUrl, model, opts = {}) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  if (!pref) return null;
  const entries = getPinnedEntries(pref);
  if (entries.some(e => e.model === model)) return pref; // already pinned
  entries.push({
    model,
    keepAlive: opts.keepAlive ?? -1,
    contextSize: opts.contextSize ?? 0,
    autoRestore: opts.autoRestore !== false
  });
  return HostPreference.findOneAndUpdate(
    { hostUrl },
    {
      $set: { pinnedModels: entries },
      $unset: { pinnedModel: '', defaultModels: '', keepAlive: '', contextSize: '', autoRestore: '' }
    },
    { new: true }
  ).lean();
}

async function removePinnedModel(hostUrl, model) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  if (!pref) return null;
  const entries = getPinnedEntries(pref).filter(e => e.model !== model);
  return HostPreference.findOneAndUpdate(
    { hostUrl },
    {
      $set: { pinnedModels: entries, status: entries.length === 0 ? 'idle' : (pref.status || 'idle') },
      $unset: { pinnedModel: '', defaultModels: '', keepAlive: '', contextSize: '', autoRestore: '' }
    },
    { new: true }
  ).lean();
}

async function updateLoadedModel(hostUrl, model) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  const update = { loadedModel: model };
  const primary = getPrimaryPinnedModel(pref);
  if (primary && primary === model) {
    update.status = 'ready';
  } else if (pref?.status === 'swapping' || pref?.status === 'restoring') {
    update.status = 'idle';
  }
  return HostPreference.findOneAndUpdate(
    { hostUrl },
    { $set: update },
    { new: true }
  ).lean();
}

async function setHostStatus(hostUrl, status) {
  return HostPreference.findOneAndUpdate(
    { hostUrl },
    { $set: { status } },
    { new: true }
  ).lean();
}

async function unloadModel(hostUrl, model) {
  try {
    const response = await fetch(`${hostUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, keep_alive: 0 }),
      signal: AbortSignal.timeout(30_000)
    });
    if (!response.ok) {
      const text = await response.text();
      return { host: hostUrl, model, status: 'error', error: text };
    }
    await response.text();
    return { host: hostUrl, model, status: 'ok' };
  } catch (err) {
    return { host: hostUrl, model, status: 'error', error: err.message };
  }
}

/**
 * Restore every pinned model on a host that isn't currently loaded. Unloads
 * the primary host's loaded-but-not-pinned model first to free VRAM for the
 * primary pin, then performs bounded warmups and verifies the pinned models
 * are actually resident before reporting success.
 */
async function restorePinnedModels(hostUrl) {
  let restorePromise = activePinRestores.get(hostUrl);
  if (!restorePromise) {
    restorePromise = restorePinnedModelsInternal(hostUrl)
      .finally(() => activePinRestores.delete(hostUrl));
    activePinRestores.set(hostUrl, restorePromise);
  }

  const result = await restorePromise;
  if (result?.status === 'error') {
    void observePinRestoreFailure({
      host: hostUrl,
      models: result.pinnedModels || result.results?.map(entry => entry.model),
      error: result.error,
      source: 'host-preference-service'
    });
  }
  return result;
}

async function restorePinnedModelsInternal(hostUrl) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  const entries = getPinnedEntries(pref);
  if (entries.length === 0) {
    return { host: hostUrl, status: 'error', error: 'No pinned model configured' };
  }

  // 0175: refuse mid-batch restores. The benchmark batch's run path
  // explicitly unloads the pin so its target can own VRAM; an external
  // restore (NerveCenter button, watchdog post-unjam, late-firing release
  // path) would clobber that. The reaper and the rightful release path
  // both clear the claim BEFORE calling restorePinnedModels, so they
  // naturally pass this check.
  if (hasActiveBenchmarkClaim(pref)) {
    logger.info(`[HostPreference] restorePinnedModels skipped on ${pref.displayName || hostUrl} — active benchmark claim`, {
      batchId: pref.benchmarkClaim?.batchId || null,
      pinnedModels: entries.map(e => e.model)
    });
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'skipped_claim',
      batchId: pref.benchmarkClaim?.batchId || null
    };
  }

  let runningModelInfos = await fetchRunningModelInfos(hostUrl);
  const allAlreadyLoaded = entries.every(entry => entrySatisfiedByLoadedModel(entry, runningModelInfos));
  if (allAlreadyLoaded) {
    await updateLoadedModel(hostUrl, entries[0].model);
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'ready',
      verified: true,
      results: entries.map(entry => ({ host: hostUrl, model: entry.model, status: 'already_loaded' }))
    };
  }

  if (pref.status === 'restoring') {
    logger.info(`[HostPreference] Continuing pin restore on ${pref.displayName || hostUrl}; current status is already restoring`, {
      pinnedModels: entries.map(e => e.model)
    });
  }

  await setHostStatus(hostUrl, 'restoring');

  // Unload any currently-loaded model that isn't one of our pinned entries —
  // but skip the explicit unload if the loaded model has active inference.
  // Sending keep_alive:0 while a caller is generating risks truncating their
  // stream; letting Ollama manage eviction via the warmup below is safer.
  const pinnedNames = entries.map(e => e.model);
  const liveLoadedList = runningModelInfos.map(m => m.name || m.model).filter(Boolean);
  const loadedList = liveLoadedList.length > 0
    ? liveLoadedList
    : (Array.isArray(pref.loadedModels) && pref.loadedModels.length > 0
        ? pref.loadedModels
        : (pref.loadedModel ? [pref.loadedModel] : []));
  for (const loaded of loadedList) {
    if (pinnedNames.some(p => pinNamesMatch(loaded, p))) continue;
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      logger.info(`[HostPreference] Skipping explicit unload of ${loaded} on ${hostUrl} — active inference`);
      continue;
    }
    const unloadResult = await unloadModel(hostUrl, loaded);
    if (unloadResult.status !== 'ok') {
      logger.warn(`[HostPreference] Failed to unload ${loaded} on ${hostUrl}: ${unloadResult.error}`);
    }
  }

  const results = [];

  // Warm each pinned model and verify residency before reporting success.
  // updateLoadedModel is called on the PRIMARY entry so the host's
  // status/loadedModel reflects the first pin. Secondary pins still get
  // warmed to their configured keep_alive.
  const primaryModel = entries[0].model;
  for (const entry of getWarmOrder(entries)) {
    const opts = { keepAlive: entry.keepAlive ?? -1, contextSize: entry.contextSize ?? 0 };
    const isPrimary = entry.model === primaryModel;
    const t0 = Date.now();
    const loadedStatus = getLoadedEntryStatus(entry, runningModelInfos);
    if (entrySatisfiedByLoadedModel(entry, runningModelInfos)) {
      results.push({
        host: hostUrl,
        model: entry.model,
        status: 'already_loaded',
        durationMs: Date.now() - t0
      });
      if (isPrimary) await updateLoadedModel(hostUrl, entry.model);
      continue;
    }

    let result;
    try {
      result = await warmDefaultModel(hostUrl, entry.model, opts);
      result.durationMs = Date.now() - t0;
      results.push(result);
    } catch (err) {
      result = { host: hostUrl, model: entry.model, status: 'error', error: err.message, durationMs: Date.now() - t0 };
      results.push(result);
    }

    if (result.status === 'ok') {
      if (isPrimary) await updateLoadedModel(hostUrl, entry.model);
      runningModelInfos = await fetchRunningModelInfos(hostUrl);
      logger.info(`[HostPreference] Restored pinned model ${entry.model} on ${hostUrl}`);
    } else {
      if (isPrimary) await setHostStatus(hostUrl, 'offline');
      logger.warn(`[HostPreference] Failed to restore pin ${entry.model} on ${hostUrl}: ${result.error}`);
    }
  }

  const verification = await verifyPinnedEntriesLoaded(hostUrl, entries);
  if (!verification.verified) {
    await setHostStatus(hostUrl, 'offline');
    logger.warn(`[HostPreference] Pin restore did not verify on ${hostUrl}`, {
      pinnedModels: entries.map(e => e.model),
      runningModels: verification.runningModels,
      statuses: verification.statuses
    });
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'error',
      error: 'Pinned model restore did not verify resident model/context',
      verified: false,
      results,
      verification
    };
  }

  await updateLoadedModel(hostUrl, entries[0].model);
  return {
    host: hostUrl,
    pinnedModels: entries.map(e => e.model),
    status: 'ready',
    verified: true,
    results,
    verification
  };
}

// Legacy alias for callers (watchdog, nerve-center route) that still use
// restorePin to refer to "restore the primary pinned model on this host".
// Now operates on the full pinnedModels array.
async function restorePin(hostUrl) {
  return restorePinnedModels(hostUrl);
}

async function swapModel(hostUrl, model) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();

  // Guard: skip if already swapping
  if (pref?.status === 'swapping') {
    return { host: hostUrl, model, status: 'swapping' };
  }

  await setHostStatus(hostUrl, 'swapping');

  // Unload any currently-loaded model that isn't the swap target — unless it
  // has active inference, in which case we let Ollama's VRAM manager handle
  // eviction rather than force-unloading mid-stream.
  const loadedList = Array.isArray(pref?.loadedModels) && pref.loadedModels.length > 0
    ? pref.loadedModels
    : (pref?.loadedModel ? [pref.loadedModel] : []);
  for (const loaded of loadedList) {
    if (pinNamesMatch(loaded, model)) continue;
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      logger.info(`[HostPreference] Skipping explicit unload of ${loaded} on ${hostUrl} during swap — active inference`);
      continue;
    }
    const unloadResult = await unloadModel(hostUrl, loaded);
    if (unloadResult.status !== 'ok') {
      logger.warn(`[HostPreference] Failed to unload ${loaded} on ${hostUrl}: ${unloadResult.error}`);
    }
  }

  // Warm the new model — only pinned models get keep_alive -1, everything
  // else uses Ollama default. Look up the model's pinned entry if it exists
  // so contextSize carries over.
  const entries = getPinnedEntries(pref);
  const matchingPin = entries.find(e => e.model === model);
  const opts = matchingPin
    ? { keepAlive: matchingPin.keepAlive ?? -1, contextSize: matchingPin.contextSize ?? 0 }
    : { keepAlive: 0, contextSize: 0 };
  warmDefaultModel(hostUrl, model, opts).then(async (result) => {
    if (result.status === 'ok') {
      await updateLoadedModel(hostUrl, model);
      logger.info(`[HostPreference] Swapped to ${model} on ${hostUrl}`);
    } else {
      await setHostStatus(hostUrl, 'idle');
      logger.warn(`[HostPreference] Failed to swap to ${model} on ${hostUrl}: ${result.error}`);
    }
  }).catch(async (err) => {
    await setHostStatus(hostUrl, 'idle');
    logger.warn(`[HostPreference] Swap error on ${hostUrl}: ${err.message}`);
  });

  return { host: hostUrl, model, status: 'swapping' };
}

// ── Exports ─────────────────────────────────────────────────

// Task 0183 — claim-lifecycle names re-export benchmarkClaimService for
// symbol stability. Existing callers (routes/openclaw-ollama-proxy.js,
// routes/nerve-center.js, server.js, clusterScheduleService,
// inferenceHealthService, and the test mocks that replace this module
// wholesale) continue to call `hostPreferenceService.releaseBenchmarkClaim`
// etc. New code SHOULD import directly from `./benchmarkClaimService`.
//
// Task 0227 — the health daemon (./hostHealthDaemon), the pin reconciler +
// grace-period state machine (./pinReconciler), and the shared pin helpers
// (./hostPinPrimitives) were extracted. They are re-exported here so the
// public export surface is UNCHANGED.
module.exports = {
  getAll,
  getByHost,
  updatePreference,
  deletePreference,
  hasActiveBenchmarkClaim,
  getDefaultModelForHost,
  getDefaultModelsMap,
  getPinnedEntries,
  getPinnedModelNames,
  getPrimaryPinnedModel,
  resolvePinnedRuntimeOptions,
  warmDefaultModel,
  warmHost,
  warmAllDefaults,
  checkAndReloadDefaults: pinReconciler.checkAndReloadDefaults,
  startHealthCheck: hostHealthDaemon.startHealthCheck,
  stopHealthCheck: hostHealthDaemon.stopHealthCheck,
  getHealthCheckIntervalMs: hostHealthDaemon.getHealthCheckIntervalMs,
  setHealthCheckIntervalMs: hostHealthDaemon.setHealthCheckIntervalMs,
  startBenchmarkClaimReaper: benchmarkClaimService.startBenchmarkClaimReaper,
  stopBenchmarkClaimReaper: benchmarkClaimService.stopBenchmarkClaimReaper,
  getBenchmarkClaimReaperIntervalMs: benchmarkClaimService.getBenchmarkClaimReaperIntervalMs,
  getPinRestoreGraceMs: pinReconciler.getPinRestoreGraceMs,
  setPinRestoreGraceMs: pinReconciler.setPinRestoreGraceMs,
  getPinStatus,
  findConfiguredHostByUrl: hostPreferenceIdentity.findConfiguredHostByUrl,
  normalizeHostPreferenceIdentity: hostPreferenceIdentity.normalizeHostPreferenceIdentity,
  normalizeHostPreferenceUpdates: hostPreferenceIdentity.normalizeHostPreferenceUpdates,
  detectHostPreferenceIdentityDrift: hostPreferenceIdentity.detectHostPreferenceIdentityDrift,
  setPinnedModel,
  clearPinnedModel,
  addPinnedModel,
  removePinnedModel,
  updateLoadedModel,
  setHostStatus,
  unloadModel,
  restorePin,
  restorePinnedModels,
  swapModel,
  claimBenchmark: benchmarkClaimService.claimBenchmark,
  heartbeatBenchmarkClaim: benchmarkClaimService.heartbeatBenchmarkClaim,
  releaseBenchmarkClaim: benchmarkClaimService.releaseBenchmarkClaim,
  listBenchmarkClaims: benchmarkClaimService.listBenchmarkClaims,
  reapStaleBenchmarkClaims: benchmarkClaimService.reapStaleBenchmarkClaims
};
