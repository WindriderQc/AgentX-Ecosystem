'use strict';
/**
 * Host Preference Service
 *
 * Manages pinned model preferences per host, warmup, and periodic health checks.
 *
 * As of task 0151, the legacy `defaultModels` + `pinnedModel` dual-state model
 * has been unified into a single `pinnedModels: [{ model, keepAlive,
 * contextSize, autoRestore }]` array. The service still exposes
 * helpers that expose the pinned model collection to routing and scheduling
 * callers (modelRouterConfig pin cache, clusterScheduleService recommendHost,
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
const crypto = require('crypto');
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
  fetchRunningModelInfosStrict,
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

function benchmarkSnapshotKeepAlive(modelInfo, capturedAt) {
  const expiresAt = modelInfo?.expires_at || modelInfo?.expiresAt;
  const parsed = expiresAt ? new Date(expiresAt) : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    const error = new Error(`Ollama did not expose an expiry for resident model ${modelInfo?.name || modelInfo?.model || 'unknown'}`);
    error.code = 'BENCHMARK_RUNTIME_SNAPSHOT_INCOMPLETE';
    throw error;
  }
  // Ollama represents an infinite keep-alive with a far-future timestamp.
  if (parsed.getUTCFullYear() >= 9000) return { keepAlive: -1, expiresAt: parsed };
  return {
    keepAlive: Math.max(1, Math.ceil((parsed.getTime() - capturedAt.getTime()) / 1000)),
    expiresAt: parsed
  };
}

function benchmarkRuntimeSnapshotIdentity(snapshot) {
  const residents = (snapshot?.residents || []).map(entry => ({
    model: entry.model,
    digest: entry.digest,
    artifactSize: Number(entry.artifactSize),
    sizeVram: Number(entry.sizeVram),
    contextLength: Number(entry.contextLength),
    keepAlive: Number(entry.keepAlive),
    expiresAt: entry.expiresAt ? new Date(entry.expiresAt).toISOString() : null
  })).sort((left, right) => left.model.localeCompare(right.model));
  return crypto.createHash('sha256').update(JSON.stringify({
    capturedAt: snapshot?.capturedAt ? new Date(snapshot.capturedAt).toISOString() : null,
    source: snapshot?.source || null,
    exact: snapshot?.exact === true,
    residents
  })).digest('hex');
}

/**
 * Capture the exact observable Ollama residency for a benchmark claim.
 * Called only after Core has fenced the host, and before claim acquisition is
 * returned to Benchmark, so no profiler mutation can precede the snapshot.
 */
async function captureBenchmarkRuntime(hostUrl) {
  const drainTimeoutMs = Math.max(1_000, Number(process.env.BENCHMARK_CLAIM_DRAIN_TIMEOUT_MS) || 30_000);
  const drainDeadline = Date.now() + drainTimeoutMs;
  while (true) {
    while (await hostGate.hostHasInflightAnywhere(hostUrl)) {
      if (Date.now() >= drainDeadline) {
        const error = new Error(`Timed out draining in-flight inference on ${hostUrl} before benchmark snapshot`);
        error.code = 'BENCHMARK_HOST_DRAIN_TIMEOUT';
        throw error;
      }
      await sleep(50);
    }
    // One quiet interval closes the release-to-next-waiter transition:
    // requests admitted before the claim may move from queued to in-flight as
    // the prior request releases, but new requests fail the status fence.
    await sleep(50);
    if (!await hostGate.hostHasInflightAnywhere(hostUrl)) break;
    if (Date.now() >= drainDeadline) {
      const error = new Error(`Timed out draining in-flight inference on ${hostUrl} before benchmark snapshot`);
      error.code = 'BENCHMARK_HOST_DRAIN_TIMEOUT';
      throw error;
    }
  }
  const capturedAt = new Date();
  const running = await fetchRunningModelInfosStrict(hostUrl);
  const residents = running.map((entry) => {
    const model = entry?.name || entry?.model;
    if (!model) {
      const error = new Error('Ollama returned a resident model without an identity');
      error.code = 'BENCHMARK_RUNTIME_SNAPSHOT_INCOMPLETE';
      throw error;
    }
    const contextLength = readLoadedContextLength(entry);
    if (!contextLength) {
      const error = new Error(`Ollama did not expose context_length for resident model ${model}`);
      error.code = 'BENCHMARK_RUNTIME_SNAPSHOT_INCOMPLETE';
      throw error;
    }
    const digest = typeof entry?.digest === 'string' && entry.digest.trim()
      ? entry.digest.trim()
      : null;
    const artifactSize = Number(entry?.size ?? entry?.artifact_size ?? entry?.artifactSize);
    const sizeVram = Number(entry?.size_vram ?? entry?.sizeVram);
    if (!digest
      || !Number.isFinite(artifactSize) || artifactSize <= 0
      || !Number.isFinite(sizeVram) || sizeVram < 0) {
      const error = new Error(`Ollama did not expose digest/size/size_vram for resident model ${model}`);
      error.code = 'BENCHMARK_RUNTIME_SNAPSHOT_INCOMPLETE';
      throw error;
    }
    const expiry = benchmarkSnapshotKeepAlive(entry, capturedAt);
    return {
      model,
      digest,
      artifactSize,
      sizeVram,
      contextLength,
      keepAlive: expiry.keepAlive,
      expiresAt: expiry.expiresAt
    };
  });
  const snapshot = {
    capturedAt,
    source: 'ollama_ps',
    exact: true,
    residents,
    error: null
  };
  return { ...snapshot, identityDigest: benchmarkRuntimeSnapshotIdentity(snapshot) };
}

function desiredBenchmarkResidents(snapshot, now = Date.now()) {
  return (snapshot?.residents || []).filter((entry) => {
    if (Number(entry.keepAlive) === -1) return true;
    const expiry = entry.expiresAt ? new Date(entry.expiresAt).getTime() : NaN;
    return Number.isFinite(expiry) && expiry > now;
  });
}

function benchmarkResidentExpiryMatches(target, runningEntry, now = Date.now()) {
  const actualRaw = runningEntry?.expires_at || runningEntry?.expiresAt;
  const actual = actualRaw ? new Date(actualRaw) : null;
  if (!actual || !Number.isFinite(actual.getTime())) return false;
  if (Number(target.keepAlive) === -1) return actual.getUTCFullYear() >= 9000;
  const expected = target.expiresAt ? new Date(target.expiresAt).getTime() : NaN;
  if (!Number.isFinite(expected) || expected <= now) return false;
  // Ollama exposes second-resolution expiry and reload itself consumes time.
  return Math.abs(actual.getTime() - expected) <= 5_000;
}

async function restoreBenchmarkRuntime(hostUrl, snapshot, benchmarkClaim) {
  const snapshotIdentityValid = /^[a-f0-9]{64}$/i.test(String(snapshot?.identityDigest || ''))
    && snapshot.identityDigest === benchmarkRuntimeSnapshotIdentity(snapshot);
  const residentsComplete = Array.isArray(snapshot?.residents)
    && snapshot.residents.every(entry => typeof entry?.model === 'string'
      && typeof entry?.digest === 'string'
      && entry.digest.trim()
      && Number.isFinite(Number(entry?.artifactSize))
      && Number(entry.artifactSize) > 0
      && Number.isFinite(Number(entry?.sizeVram))
      && Number(entry.sizeVram) >= 0
      && positiveInteger(entry?.contextLength));
  if (!snapshot || snapshot.exact !== true || !snapshotIdentityValid || !residentsComplete) {
    return {
      host: hostUrl,
      status: 'error',
      code: 'BENCHMARK_RUNTIME_SNAPSHOT_MISSING',
      verified: false,
      degraded: true,
      error: 'Exact pre-claim runtime snapshot is unavailable'
    };
  }

  const assertFence = async () => {
    const current = await HostPreference.findOne({ hostUrl }).lean();
    if (current?.status !== 'benchmarking'
      || current?.benchmarkClaim?.batchId !== benchmarkClaim?.batchId
      || current?.benchmarkClaim?.claimGeneration !== benchmarkClaim?.claimGeneration
      || (benchmarkClaim?.finalizeToken
        && current?.benchmarkClaim?.finalizeToken !== benchmarkClaim.finalizeToken)) {
      const error = new Error('Benchmark claim no longer owns the host while restoring runtime');
      error.code = 'BENCHMARK_CLAIM_LOST';
      throw error;
    }
  };

  const desired = benchmarkClaim?.snapshotAlreadyFiltered === true
    ? (snapshot?.residents || [])
    : desiredBenchmarkResidents(snapshot);
  const desiredNames = desired.map(entry => entry.model);
  let running = await fetchRunningModelInfosStrict(hostUrl);

  for (const entry of running) {
    const loaded = entry.name || entry.model;
    if (desired.some(target => pinNamesMatch(target.model, loaded))) continue;
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      return {
        host: hostUrl,
        status: 'busy',
        verified: false,
        degraded: false,
        error: `Cannot restore pre-claim runtime while ${loaded} has active inference`
      };
    }
    await assertFence();
    const unloaded = await unloadModel(hostUrl, loaded);
    if (unloaded.status !== 'ok') {
      return {
        host: hostUrl,
        status: 'error',
        verified: false,
        degraded: false,
        error: `Failed to unload post-claim resident ${loaded}: ${unloaded.error}`
      };
    }
  }

  for (const target of desired) {
    await assertFence();
    running = await fetchRunningModelInfosStrict(hostUrl);
    const loaded = findLoadedModelInfo(running, target.model);
    const loadedCtx = readLoadedContextLength(loaded);
    if (loaded && target.contextLength && loadedCtx !== target.contextLength) {
      const unloaded = await unloadModel(hostUrl, loaded.name || loaded.model || target.model);
      if (unloaded.status !== 'ok') {
        return {
          host: hostUrl,
          status: 'error',
          verified: false,
          degraded: false,
          error: `Failed to reset ${target.model} to pre-claim context: ${unloaded.error}`
        };
      }
    }
    const remainingKeepAlive = target.keepAlive === -1
      ? -1
      : Math.max(1, Math.ceil((new Date(target.expiresAt).getTime() - Date.now()) / 1000));
    const warmed = await warmDefaultModel(hostUrl, target.model, {
      keepAlive: remainingKeepAlive,
      contextSize: target.contextLength || 0
    });
    if (warmed.status !== 'ok') {
      return {
        host: hostUrl,
        status: 'error',
        verified: false,
        degraded: false,
        error: `Failed to restore pre-claim resident ${target.model}: ${warmed.error}`
      };
    }
  }

  await assertFence();
  const verifiedRunning = await fetchRunningModelInfosStrict(hostUrl);
  const noExtraResidents = verifiedRunning.every(entry => desired.some(target =>
    pinNamesMatch(target.model, entry.name || entry.model)
  ));
  const residentsVerified = desired.every((target) => {
    const entry = findLoadedModelInfo(verifiedRunning, target.model);
    if (!entry) return false;
    return String(entry.digest || '').trim() === String(target.digest || '').trim()
      && Number(entry.size ?? entry.artifact_size ?? entry.artifactSize) === Number(target.artifactSize)
      && Number(entry.size_vram ?? entry.sizeVram) === Number(target.sizeVram)
      && readLoadedContextLength(entry) === target.contextLength
      && benchmarkResidentExpiryMatches(target, entry);
  });
  const verified = noExtraResidents
    && residentsVerified
    && verifiedRunning.length === desired.length;
  if (!verified) {
    return {
      host: hostUrl,
      status: 'error',
      verified: false,
      degraded: false,
      error: 'Pre-claim runtime restore did not verify exact resident model/context set',
      expectedResidents: desiredNames,
      runningResidents: verifiedRunning.map(entry => entry.name || entry.model).filter(Boolean)
    };
  }

  const updated = await HostPreference.findOneAndUpdate(
    {
      hostUrl,
      status: 'benchmarking',
      'benchmarkClaim.batchId': benchmarkClaim.batchId,
      'benchmarkClaim.claimGeneration': benchmarkClaim.claimGeneration,
      ...(benchmarkClaim.finalizeToken
        ? { 'benchmarkClaim.finalizeToken': benchmarkClaim.finalizeToken }
        : {})
    },
    { $set: {
      loadedModel: desiredNames[0] || null,
      loadedModels: desiredNames
    } },
    { new: true }
  ).lean();
  if (!updated) {
    const error = new Error('Benchmark claim changed after runtime restore verification');
    error.code = 'BENCHMARK_CLAIM_LOST';
    throw error;
  }
  const observedResidents = verifiedRunning.map(entry => ({
    model: entry.name || entry.model,
    digest: entry.digest || null,
    artifactSize: Number(entry.size ?? entry.artifact_size ?? entry.artifactSize),
    sizeVram: Number(entry.size_vram ?? entry.sizeVram),
    contextLength: readLoadedContextLength(entry),
    expiresAt: entry.expires_at || entry.expiresAt || null
  }));
  return {
    host: hostUrl,
    status: 'ready',
    verified: true,
    degraded: false,
    mode: 'exact_runtime_snapshot',
    snapshotIdentity: snapshot.identityDigest || benchmarkRuntimeSnapshotIdentity(snapshot),
    residents: desired,
    observedResidents
  };
}

async function prepareExclusiveModel(hostUrl, model) {
  let runningModelInfos;
  try {
    runningModelInfos = await fetchRunningModelInfosStrict(hostUrl);
  } catch (error) {
    return { host: hostUrl, model, status: 'error', error: error.message, unloaded: [] };
  }
  const runningModels = runningModelInfos.map(entry => entry.name || entry.model).filter(Boolean);
  const unloaded = [];

  for (const loaded of runningModels) {
    if (pinNamesMatch(loaded, model)) continue;
    if (hostGate.inFlightFor(hostUrl, loaded) > 0) {
      return { host: hostUrl, model, status: 'busy', unloaded, blockingModel: loaded };
    }
    const result = await unloadModel(hostUrl, loaded);
    if (result.status !== 'ok') {
      return { host: hostUrl, model, status: 'error', error: result.error, unloaded };
    }
    unloaded.push(loaded);
  }

  if (unloaded.length > 0) {
    await HostPreference.findOneAndUpdate(
      { hostUrl },
      { $set: { status: 'swapping', loadedModel: null, loadedModels: [] } }
    );
    logger.info(`[HostPreference] Prepared exclusive model handoff to ${model} on ${hostUrl}`, { unloaded });
  }
  return { host: hostUrl, model, status: 'ready', unloaded };
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
 * Return Map<hostUrl, string[]> of pinned model names.
 */
async function getPinnedModelsMap() {
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

async function updateLoadedModel(hostUrl, model, options = {}) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  const fencedClaim = options.benchmarkClaim || null;
  if (fencedClaim && (pref?.status !== 'benchmarking'
    || pref?.benchmarkClaim?.batchId !== fencedClaim.batchId
    || pref?.benchmarkClaim?.claimGeneration !== fencedClaim.claimGeneration)) {
    const error = new Error('Benchmark claim no longer owns the host while restoring pins');
    error.code = 'BENCHMARK_CLAIM_LOST';
    throw error;
  }
  const update = { loadedModel: model };
  const primary = getPrimaryPinnedModel(pref);
  if (!fencedClaim && primary && primary === model) {
    update.status = 'ready';
  } else if (!fencedClaim && (pref?.status === 'swapping' || pref?.status === 'restoring')) {
    update.status = 'idle';
  }
  const filter = { hostUrl };
  if (fencedClaim) {
    filter.status = 'benchmarking';
    filter['benchmarkClaim.batchId'] = fencedClaim.batchId;
    filter['benchmarkClaim.claimGeneration'] = fencedClaim.claimGeneration;
  }
  const updated = await HostPreference.findOneAndUpdate(
    filter,
    { $set: update },
    { new: true }
  ).lean();
  if (fencedClaim && !updated) {
    const error = new Error('Benchmark claim changed during fenced pin restore');
    error.code = 'BENCHMARK_CLAIM_LOST';
    throw error;
  }
  return updated;
}

async function setHostStatus(hostUrl, status) {
  return HostPreference.findOneAndUpdate(
    { hostUrl },
    { $set: { status } },
    { new: true }
  ).lean();
}

/**
 * Restore every pinned model on a host that isn't currently loaded. Unloads
 * the primary host's loaded-but-not-pinned model first to free VRAM for the
 * primary pin, then performs bounded warmups and verifies the pinned models
 * are actually resident before reporting success.
 */
async function restorePinnedModels(hostUrl, options = {}) {
  const claim = options.benchmarkClaim || null;
  const restoreKey = claim
    ? `${hostUrl}\n${claim.batchId}\n${claim.claimGeneration}`
    : hostUrl;
  let restorePromise = activePinRestores.get(restoreKey);
  if (!restorePromise) {
    restorePromise = restorePinnedModelsInternal(hostUrl, options)
      .finally(() => activePinRestores.delete(restoreKey));
    activePinRestores.set(restoreKey, restorePromise);
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

async function restorePinnedModelsInternal(hostUrl, options = {}) {
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  const entries = getPinnedEntries(pref);
  if (entries.length === 0) {
    return { host: hostUrl, status: 'error', error: 'No pinned model configured' };
  }

  const claim = options.benchmarkClaim || null;
  const fencedClaim = hasActiveBenchmarkClaim(pref)
    && claim
    && pref.status === 'benchmarking'
    && pref.benchmarkClaim?.batchId === claim.batchId
    && pref.benchmarkClaim?.claimGeneration === claim.claimGeneration;
  if (claim && !fencedClaim) {
    return {
      host: hostUrl,
      pinnedModels: entries.map(e => e.model),
      status: 'error',
      code: 'BENCHMARK_CLAIM_LOST',
      error: 'Benchmark claim no longer owns the host; fenced pin restore refused',
      verified: false
    };
  }
  // External restores remain forbidden while any claim is active. The exact
  // claim owner may restore through the fenced release path, which keeps the
  // host unavailable to chat/watchdog until residency has been verified.
  if (hasActiveBenchmarkClaim(pref) && !fencedClaim) {
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

  const assertFence = async () => {
    if (!fencedClaim) return;
    const current = await HostPreference.findOne({ hostUrl }).lean();
    if (current?.status !== 'benchmarking'
      || current?.benchmarkClaim?.batchId !== claim.batchId
      || current?.benchmarkClaim?.claimGeneration !== claim.claimGeneration) {
      const error = new Error('Benchmark claim no longer owns the host while restoring pins');
      error.code = 'BENCHMARK_CLAIM_LOST';
      throw error;
    }
  };

  let runningModelInfos = await fetchRunningModelInfos(hostUrl);
  const allAlreadyLoaded = entries.every(entry => entrySatisfiedByLoadedModel(entry, runningModelInfos));
  if (allAlreadyLoaded) {
    await updateLoadedModel(hostUrl, entries[0].model, { benchmarkClaim: fencedClaim ? claim : null });
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

  if (!fencedClaim) await setHostStatus(hostUrl, 'restoring');

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
    await assertFence();
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
    await assertFence();
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
      if (isPrimary) await updateLoadedModel(hostUrl, entry.model, { benchmarkClaim: fencedClaim ? claim : null });
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
      if (isPrimary) await updateLoadedModel(hostUrl, entry.model, { benchmarkClaim: fencedClaim ? claim : null });
      runningModelInfos = await fetchRunningModelInfos(hostUrl);
      logger.info(`[HostPreference] Restored pinned model ${entry.model} on ${hostUrl}`);
    } else {
      if (isPrimary && !fencedClaim) await setHostStatus(hostUrl, 'offline');
      logger.warn(`[HostPreference] Failed to restore pin ${entry.model} on ${hostUrl}: ${result.error}`);
    }
  }

  const verification = await verifyPinnedEntriesLoaded(hostUrl, entries);
  if (!verification.verified) {
    if (!fencedClaim) await setHostStatus(hostUrl, 'offline');
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

  await updateLoadedModel(hostUrl, entries[0].model, { benchmarkClaim: fencedClaim ? claim : null });
  return {
    host: hostUrl,
    pinnedModels: entries.map(e => e.model),
    status: 'ready',
    verified: true,
    results,
    verification
  };
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
// symbol stability. Existing callers (routes/nerve-center.js, server.js,
// clusterScheduleService,
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
  getPinnedModelsMap,
  getPinnedEntries,
  getPinnedModelNames,
  getPrimaryPinnedModel,
  resolvePinnedRuntimeOptions,
  warmDefaultModel,
  benchmarkRuntimeSnapshotIdentity,
  desiredBenchmarkResidents,
  captureBenchmarkRuntime,
  restoreBenchmarkRuntime,
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
  prepareExclusiveModel,
  restorePinnedModels,
  pinNamesMatch,
  swapModel,
  claimBenchmark: benchmarkClaimService.claimBenchmark,
  heartbeatBenchmarkClaim: benchmarkClaimService.heartbeatBenchmarkClaim,
  releaseBenchmarkClaim: benchmarkClaimService.releaseBenchmarkClaim,
  listBenchmarkClaims: benchmarkClaimService.listBenchmarkClaims,
  summarizeBenchmarkClaimReaps: benchmarkClaimService.summarizeBenchmarkClaimReaps,
  reapStaleBenchmarkClaims: benchmarkClaimService.reapStaleBenchmarkClaims
};
