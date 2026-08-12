'use strict';
/**
 * Host Pin Primitives
 *
 * Low-level, mostly-pure helpers shared by the host-preference facade
 * (hostPreferenceService.js), the pin reconciler (pinReconciler.js), and the
 * warm/restore primitives. Extracted from hostPreferenceService.js in task
 * 0227 — that file was 1042 lines (cap 700) and mixed pin CRUD, a health-check
 * daemon, the pin-reconciler grace-period state machine, and these shared
 * helpers.
 *
 * This module holds the pin-name normalisation aliases, the pinnedModels
 * normalisation/fallback logic (getPinnedEntries and friends), the
 * loaded-model status helpers, and the bounded residency verifier. The
 * function bodies are copied VERBATIM — this is a pure structural split, no
 * behavior change.
 *
 * Symbol stability: hostPreferenceService.js re-exports getPinnedEntries,
 * getPinnedModelNames, and getPrimaryPinnedModel so existing callers keep
 * working.
 */

const {
  normalizeModelName: canonicalNormalize,
  modelsMatch
} = require('../helpers/modelNameNormalization');

let pinRestoreVerifyTimeoutMs = parseInt(process.env.PIN_RESTORE_VERIFY_TIMEOUT_MS, 10);
if (!Number.isFinite(pinRestoreVerifyTimeoutMs) || pinRestoreVerifyTimeoutMs < 1_000) {
  pinRestoreVerifyTimeoutMs = 15_000;
}

// ── Helpers to normalise pinnedModels ──────────────────────
// Runtime tolerance for pre-migration docs: if pinnedModels is empty but
// legacy `defaultModels` / `pinnedModel` still exist on the raw doc, derive
// entries on the fly. This lets a freshly-deployed binary run against
// un-migrated data without losing keep-alive behavior.

// Local aliases onto the ecosystem-wide normalizer (src/helpers/
// modelNameNormalization.js). Kept so the health check and pin-equivalence
// call sites read the same as before; semantics are unchanged (a pin on
// "gemma4:26b" is satisfied by a loaded "ax/gemma4:26b").
const normalizePinName = canonicalNormalize;
const pinNamesMatch = modelsMatch;

function getPinnedEntries(pref) {
  if (!pref) return [];
  if (Array.isArray(pref.pinnedModels) && pref.pinnedModels.length > 0) {
    return pref.pinnedModels.map(entry => ({
      model: entry.model,
      keepAlive: entry.keepAlive ?? -1,
      contextSize: entry.contextSize ?? 0,
      autoRestore: entry.autoRestore !== false
    }));
  }
  // Legacy fallback — pref was fetched as .lean() so stray keys are visible
  const legacy = [];
  const seen = new Set();
  const fallbackKeepAlive = pref.keepAlive ?? -1;
  const fallbackContextSize = pref.contextSize ?? 0;
  const fallbackAutoRestore = pref.autoRestore !== false;
  if (pref.pinnedModel) {
    legacy.push({
      model: pref.pinnedModel,
      keepAlive: -1, // pinnedModel semantics — always kept loaded
      contextSize: fallbackContextSize,
      autoRestore: fallbackAutoRestore
    });
    seen.add(pref.pinnedModel);
  }
  if (Array.isArray(pref.defaultModels)) {
    for (const m of pref.defaultModels) {
      if (!m || seen.has(m)) continue;
      legacy.push({
        model: m,
        keepAlive: fallbackKeepAlive,
        contextSize: fallbackContextSize,
        autoRestore: fallbackAutoRestore
      });
      seen.add(m);
    }
  }
  return legacy;
}

function getPinnedModelNames(pref) {
  return getPinnedEntries(pref).map(e => e.model);
}

function getPrimaryPinnedModel(pref) {
  const entries = getPinnedEntries(pref);
  return entries.length > 0 ? entries[0].model : null;
}

/**
 * Resolve the runtime-loading options shared by pin warming and inference.
 * Explicit caller values win; otherwise a matching pin supplies its context
 * and keep-alive. Keeping this in one helper prevents a warm 49K model from
 * being reloaded at its Modelfile context by the first chat turn (0512).
 */
function resolvePinnedRuntimeOptions(pref, model, callerOptions = {}, callerKeepAlive) {
  const { keep_alive: optionKeepAlive, ...options } = callerOptions || {};
  let keepAlive = callerKeepAlive ?? optionKeepAlive;
  let numCtxSource = options.num_ctx != null ? 'caller' : 'modelfile';
  const pinnedEntry = getPinnedEntries(pref)
    .find(entry => pinNamesMatch(entry.model, model)) || null;

  if (pinnedEntry) {
    if (keepAlive === undefined || keepAlive === '') {
      keepAlive = pinnedEntry.keepAlive ?? -1;
    }
    const pinnedContext = positiveInteger(pinnedEntry.contextSize);
    if (options.num_ctx == null && pinnedContext) {
      options.num_ctx = pinnedContext;
      numCtxSource = 'host_preference_pin';
    }
  }

  return { options, keepAlive, numCtxSource, pinnedEntry };
}

function positiveInteger(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n);
}

function readLoadedContextLength(modelInfo) {
  const value = modelInfo?.context_length
    ?? modelInfo?.contextLength
    ?? modelInfo?.details?.context_length;
  return positiveInteger(value);
}

const MIN_INFINITE_RESIDENCY_MS = 24 * 60 * 60 * 1000;

function readLoadedExpiresAtMs(modelInfo) {
  const parsed = Date.parse(modelInfo?.expires_at ?? modelInfo?.expiresAt ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}

function minimumExpectedExpiryMs(keepAlive, nowMs = Date.now()) {
  const seconds = Number(keepAlive);
  if (seconds === -1) return nowMs + MIN_INFINITE_RESIDENCY_MS;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;

  // Refresh finite pins once less than half their requested TTL remains. Cap
  // the threshold at one day so year-long pins do not churn unnecessarily.
  return nowMs + Math.min(seconds * 500, MIN_INFINITE_RESIDENCY_MS);
}

function findLoadedModelInfo(runningModelInfos, model) {
  return (runningModelInfos || []).find(info => pinNamesMatch(info?.name || info?.model, model)) || null;
}

function isEmbeddingModelName(model) {
  const name = String(model || '').toLowerCase();
  // 0508: the BAAI bge family (e.g. qllama/bge-m3:f16) and MiniLM embedders
  // carry no 'embed' substring — they used to hit /api/generate on warmup and
  // be refused with `does not support generate`.
  return name.includes('embed') || name.includes('embedding')
    || name.includes('nomic') || name.includes('bge') || name.includes('minilm');
}

function getWarmOrder(entries) {
  // Load the large generative model first, then the small embedding model.
  // On multi-pin hosts, loading the generative model last can evict an
  // embedding pin that was just restored even when both ultimately fit.
  return [...entries].sort((a, b) => Number(isEmbeddingModelName(a.model)) - Number(isEmbeddingModelName(b.model)));
}

function getLoadedEntryStatus(entry, runningModelInfos, nowMs = Date.now()) {
  const loadedInfo = findLoadedModelInfo(runningModelInfos, entry.model);
  if (!loadedInfo) return { loaded: false, contextMismatch: false, residencyMismatch: false };

  const expectedContextLength = positiveInteger(entry.contextSize);
  const loadedContextLength = readLoadedContextLength(loadedInfo);
  const loadedExpiresAtMs = readLoadedExpiresAtMs(loadedInfo);
  const minimumExpiresAtMs = minimumExpectedExpiryMs(entry.keepAlive, nowMs);
  const contextMismatch = !!(
    expectedContextLength &&
    loadedContextLength &&
    loadedContextLength !== expectedContextLength
  );
  const residencyMismatch = !!(
    loadedExpiresAtMs &&
    minimumExpiresAtMs &&
    loadedExpiresAtMs < minimumExpiresAtMs
  );

  return {
    loaded: true,
    contextMismatch,
    residencyMismatch,
    loadedModel: loadedInfo.name || loadedInfo.model || entry.model,
    loadedContextLength,
    expectedContextLength,
    loadedExpiresAt: loadedExpiresAtMs ? new Date(loadedExpiresAtMs).toISOString() : null,
    expectedKeepAlive: entry.keepAlive ?? null
  };
}

function entrySatisfiedByLoadedModel(entry, runningModelInfos) {
  const status = getLoadedEntryStatus(entry, runningModelInfos);
  return status.loaded && !status.contextMismatch && !status.residencyMismatch;
}

async function fetchRunningModelInfos(hostUrl, timeoutMs = 5_000) {
  try {
    const psResponse = await fetch(`${hostUrl}/api/ps`, { signal: AbortSignal.timeout(timeoutMs) });
    const psData = psResponse.ok ? await psResponse.json() : { models: [] };
    return psData.models || [];
  } catch {
    return [];
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function verifyPinnedEntriesLoaded(hostUrl, entries, timeoutMs = pinRestoreVerifyTimeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let runningModelInfos = [];
  let statuses = [];

  do {
    runningModelInfos = await fetchRunningModelInfos(hostUrl);
    statuses = entries.map(entry => ({
      model: entry.model,
      ...getLoadedEntryStatus(entry, runningModelInfos)
    }));

    if (statuses.every(status => status.loaded && !status.contextMismatch && !status.residencyMismatch)) {
      return {
        verified: true,
        runningModels: runningModelInfos.map(m => m.name || m.model).filter(Boolean),
        statuses
      };
    }

    if (Date.now() >= deadline) break;
    await sleep(1_000);
  } while (Date.now() < deadline);

  return {
    verified: false,
    runningModels: runningModelInfos.map(m => m.name || m.model).filter(Boolean),
    statuses
  };
}

module.exports = {
  pinRestoreVerifyTimeoutMs,
  normalizePinName,
  pinNamesMatch,
  getPinnedEntries,
  getPinnedModelNames,
  getPrimaryPinnedModel,
  resolvePinnedRuntimeOptions,
  positiveInteger,
  readLoadedContextLength,
  readLoadedExpiresAtMs,
  minimumExpectedExpiryMs,
  findLoadedModelInfo,
  isEmbeddingModelName,
  getWarmOrder,
  getLoadedEntryStatus,
  entrySatisfiedByLoadedModel,
  fetchRunningModelInfos,
  sleep,
  verifyPinnedEntriesLoaded
};
