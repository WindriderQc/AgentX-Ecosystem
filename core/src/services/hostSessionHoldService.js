'use strict';

/**
 * Host session hold
 *
 * A trusted extension may ask Core to keep one model resident on one Ollama
 * host for the duration of an interactive session. While the hold is active:
 *
 *   - the pin reconciler does not restore the displaced pin;
 *   - the admission guard refuses inference on that host for any other model
 *     (503 HOST_SESSION_HOLD_ACTIVE, with the remaining hold time);
 *   - a benchmark batch cannot claim the host.
 *
 * The hold is idle-bounded: every touch pushes `expiresAt` forward by the
 * hold's `idleTtlMs`. When it expires or is released, the remaining pin grace
 * is forfeited so the reconciler restores the pin on its next tick.
 *
 * Model residency is prepared through the same exclusive admission path that a
 * held turn uses (`prepareExclusiveModel` + a one-token warm-up), so a hold
 * never bypasses host gating.
 *
 * A hold may carry the context its turns will request (`numCtx`). The warm-up
 * loads the model at that context and residency is judged against the context
 * Ollama reports, so the first held turn does not reload the model a second
 * time at a different context. Without `numCtx` the model loads at its
 * Modelfile context and residency is by name only, as before.
 */

const crypto = require('crypto');
const logger = require('../../config/logger');
const HostPreference = require('../../models/HostPreference');
const { hasActiveBenchmarkClaim } = require('./benchmarkClaimService');
const {
  pinNamesMatch,
  fetchRunningModelInfos,
  getPinnedEntries,
  entrySatisfiedByLoadedModel,
  findLoadedModelInfo,
  readLoadedContextLength
} = require('./hostPinPrimitives');

const MIN_IDLE_TTL_MS = 60_000;
const MAX_IDLE_TTL_MS = 6 * 60 * 60_000;
const DEFAULT_IDLE_TTL_MS = 10 * 60_000;
const WARM_TIMEOUT_MS = 10 * 60_000;
const OWNER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,159}$/;

const EMPTY_HOLD = Object.freeze({
  holdId: null,
  owner: null,
  model: null,
  note: null,
  claimedAt: null,
  lastActivityAt: null,
  idleTtlMs: null,
  expiresAt: null,
  numCtx: null
});

// In-process warm progress per host. Residency itself is always re-read from
// Ollama; this only explains why a held model is not resident yet.
const warmState = new Map();

// In-process mirror of active holds by host, refreshed on every hold
// mutation, status read, and reconciler tick. Callers that must never block
// on Mongo (the watchdog probe loop runs inside processes and fixtures
// without a database) read `isHostHeld` from this map instead of the
// preference document. After a Core restart it is empty until the first
// reconciler tick observes the stored hold.
const activeHolds = new Map();

function observeSessionHold(pref, now = Date.now()) {
  if (!pref?.hostUrl) return null;
  const hold = activeSessionHold(pref, now);
  if (hold) activeHolds.set(pref.hostUrl, { ...hold });
  else activeHolds.delete(pref.hostUrl);
  return hold;
}

function isHostHeld(hostUrl, now = Date.now()) {
  const hold = activeHolds.get(hostUrl);
  if (!hold) return null;
  if (!(timestampMs(hold.expiresAt) > now)) {
    activeHolds.delete(hostUrl);
    return null;
  }
  return hold;
}

function holdError(message, code, statusCode = 409, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  Object.assign(error, extra);
  return error;
}

function boundedIdleTtl(value) {
  if (value == null || value === '') return DEFAULT_IDLE_TTL_MS;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw holdError('idleTtlMs must be a positive number of milliseconds.', 'HOST_SESSION_HOLD_INVALID', 400);
  }
  return Math.max(MIN_IDLE_TTL_MS, Math.min(MAX_IDLE_TTL_MS, Math.round(parsed)));
}

function normalizeOwner(owner) {
  const text = String(owner || '').trim();
  if (!OWNER_PATTERN.test(text)) {
    throw holdError('owner must be a bounded opaque identifier.', 'HOST_SESSION_HOLD_INVALID', 400);
  }
  return text;
}

function normalizeModel(model) {
  const text = String(model || '').trim();
  if (!text || text.length > 512) {
    throw holdError('model is required.', 'HOST_SESSION_HOLD_INVALID', 400);
  }
  return text;
}

function normalizeNote(note) {
  if (note == null) return null;
  const text = String(note).trim().slice(0, 200);
  return text || null;
}

function normalizeNumCtx(value) {
  if (value == null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw holdError('numCtx must be a positive integer context length when supplied.', 'HOST_SESSION_HOLD_INVALID', 400);
  }
  return parsed;
}

function timestampMs(value) {
  if (!value) return 0;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function activeSessionHold(pref, now = Date.now()) {
  const hold = pref?.sessionHold;
  if (!hold?.holdId || !hold.model) return null;
  if (!(timestampMs(hold.expiresAt) > now)) return null;
  return hold;
}

function hasActiveSessionHold(pref, now = Date.now()) {
  return activeSessionHold(pref, now) !== null;
}

function holdBlocksModel(hold, model) {
  if (!hold?.model) return false;
  if (!model) return true;
  return !pinNamesMatch(String(model), String(hold.model));
}

function publicHold(hold, now = Date.now()) {
  if (!hold) return null;
  const expiresAt = timestampMs(hold.expiresAt);
  return {
    holdId: hold.holdId,
    owner: hold.owner,
    model: hold.model,
    note: hold.note || null,
    claimedAt: hold.claimedAt ? new Date(hold.claimedAt).toISOString() : null,
    lastActivityAt: hold.lastActivityAt ? new Date(hold.lastActivityAt).toISOString() : null,
    expiresAt: expiresAt ? new Date(expiresAt).toISOString() : null,
    idleTtlMs: hold.idleTtlMs ?? null,
    numCtx: hold.numCtx ?? null,
    remainingMs: Math.max(0, expiresAt - now)
  };
}

function buildSessionHoldError(hostUrl, hold, now = Date.now()) {
  const shown = publicHold(hold, now);
  const error = holdError(
    `Ollama host is held by an active session${shown?.owner ? ` (${shown.owner})` : ''}: ${hostUrl}`,
    'HOST_SESSION_HOLD_ACTIVE',
    503
  );
  error.hostUrl = hostUrl;
  error.holdOwner = shown?.owner || null;
  error.holdModel = shown?.model || null;
  error.holdExpiresAt = shown?.expiresAt || null;
  error.retryAfterMs = shown?.remainingMs ?? null;
  return error;
}

async function getActiveSessionHold(hostUrl, now = Date.now()) {
  if (!hostUrl) return null;
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  return observeSessionHold(pref, now);
}

// ── Warm-up ────────────────────────────────────────────────

async function warmSessionHoldModel(hostUrl, hold, deps = {}) {
  // Lazy: hostPreferenceService requires this module through the reconciler.
  const hostPreferenceService = deps.hostPreferenceService || require('./hostPreferenceService');
  const executeAdmittedOllamaAttempt = deps.executeAdmittedOllamaAttempt
    || require('./routing/inferenceAttemptExecutor').executeAdmittedOllamaAttempt;
  const payload = {
    model: hold.model,
    prompt: 'warmup',
    stream: false,
    keep_alive: -1,
    options: { num_predict: 1, ...(hold.numCtx ? { num_ctx: hold.numCtx } : {}) }
  };
  const attempt = await executeAdmittedOllamaAttempt({
    hostUrl,
    model: hold.model,
    payload,
    mode: 'generate',
    useChat: false,
    stream: false,
    timeoutMs: WARM_TIMEOUT_MS,
    admissionKind: 'session-hold-warm',
    principal: 'core-session-hold',
    verifyRejection: true,
    exclusive: true,
    prepareExclusive: async (admission) => {
      const prepared = await hostPreferenceService.prepareExclusiveModel(hostUrl, hold.model, {
        signal: admission.signal,
        assertAuthorityActive: () => admission.assertActive()
      });
      admission.assertActive();
      if (prepared?.status !== 'ready') {
        throw holdError(
          prepared?.status === 'busy'
            ? `Host is busy with ${prepared.blockingModel || 'another model'}; warm-up deferred.`
            : `Exclusive handoff failed: ${prepared?.error || 'unknown error'}`,
          prepared?.status === 'busy' ? 'HOST_SESSION_HOLD_WARM_BUSY' : 'HOST_SESSION_HOLD_WARM_FAILED',
          503
        );
      }
    }
  });
  if (!attempt.ok) {
    throw holdError(`Warm-up returned HTTP ${attempt.status}.`, 'HOST_SESSION_HOLD_WARM_FAILED', 503);
  }
  return attempt;
}

/**
 * Residency of a held model. By name alone when the hold carries no context
 * or Ollama does not report one; otherwise the loaded context must match,
 * unless Core's own warm-up already completed for this hold at this context:
 * Ollama may report a capped context for an oversized request, and that must
 * not re-warm the model on every touch.
 */
function holdResidency(hostUrl, hold, runningModelInfos) {
  const loaded = findLoadedModelInfo(runningModelInfos, hold?.model);
  if (!loaded) return { resident: false, loadedContextLength: null };
  const loadedContextLength = readLoadedContextLength(loaded);
  const requested = hold.numCtx ?? null;
  if (!requested || !loadedContextLength || loadedContextLength === requested) {
    return { resident: true, loadedContextLength };
  }
  const state = warmState.get(hostUrl);
  const warmedHere = state?.status === 'ready' && state.holdId === hold.holdId
    && (state.numCtx ?? null) === requested;
  return { resident: warmedHere, loadedContextLength };
}

function warmSnapshot(hostUrl, hold, now = Date.now()) {
  const state = warmState.get(hostUrl);
  if (!state || !hold || state.holdId !== hold.holdId || !pinNamesMatch(state.model, hold.model)) {
    return { status: 'idle', startedAt: null, elapsedMs: null, error: null };
  }
  return {
    status: state.status,
    startedAt: new Date(state.startedAt).toISOString(),
    elapsedMs: Math.max(0, (state.completedAt || now) - state.startedAt),
    error: state.error
  };
}

function startWarm(hostUrl, hold, deps = {}) {
  const current = warmState.get(hostUrl);
  if (current?.status === 'loading' && pinNamesMatch(current.model, hold.model)) {
    current.holdId = hold.holdId;
    return current;
  }
  const state = {
    holdId: hold.holdId,
    model: hold.model,
    numCtx: hold.numCtx ?? null,
    status: 'loading',
    startedAt: Date.now(),
    completedAt: null,
    error: null
  };
  warmState.set(hostUrl, state);
  const run = deps.warm || warmSessionHoldModel;
  void Promise.resolve()
    .then(() => run(hostUrl, hold, deps))
    .then(() => {
      state.status = 'ready';
      state.completedAt = Date.now();
      logger.info(`[SessionHold] ${hold.model} resident on ${hostUrl}`, {
        owner: hold.owner,
        numCtx: state.numCtx,
        elapsedMs: state.completedAt - state.startedAt
      });
    })
    .catch((error) => {
      state.status = 'error';
      state.error = error?.message || String(error);
      state.completedAt = Date.now();
      logger.warn(`[SessionHold] warm-up failed on ${hostUrl}: ${state.error}`, {
        owner: hold.owner,
        model: hold.model,
        code: error?.code || null
      });
    });
  return state;
}

async function ensureWarm(hostUrl, hold, deps = {}) {
  const current = warmState.get(hostUrl);
  if (current?.status === 'loading' && pinNamesMatch(current.model, hold.model)) return current;
  const running = await fetchRunningModelInfos(hostUrl, 5_000);
  const { resident } = holdResidency(hostUrl, hold, running);
  if (resident) {
    if (!current || current.holdId !== hold.holdId) {
      warmState.set(hostUrl, {
        holdId: hold.holdId, model: hold.model, numCtx: hold.numCtx ?? null, status: 'ready',
        startedAt: Date.now(), completedAt: Date.now(), error: null
      });
    }
    return warmState.get(hostUrl);
  }
  return startWarm(hostUrl, hold, deps);
}

// ── Lifecycle ──────────────────────────────────────────────

async function acquireSessionHold(hostUrl, {
  owner,
  model,
  idleTtlMs,
  note = null,
  numCtx = null,
  warm = true
} = {}, deps = {}) {
  if (!hostUrl || typeof hostUrl !== 'string') {
    throw holdError('hostUrl is required.', 'HOST_SESSION_HOLD_INVALID', 400);
  }
  const normalizedOwner = normalizeOwner(owner);
  const normalizedModel = normalizeModel(model);
  const ttl = boundedIdleTtl(idleTtlMs);
  const normalizedNote = normalizeNote(note);
  const normalizedNumCtx = normalizeNumCtx(numCtx);

  const pref = await HostPreference.findOne({ hostUrl }).lean();
  if (!pref) {
    throw holdError(`Host is not configured: ${hostUrl}`, 'HOST_SESSION_HOLD_HOST_UNKNOWN', 404);
  }
  if (hasActiveBenchmarkClaim(pref)) {
    throw holdError(
      `Ollama host is held by an active benchmark claim: ${hostUrl}`,
      'BENCHMARK_CLAIM_ACTIVE',
      503,
      { batchId: pref.benchmarkClaim?.batchId || null }
    );
  }
  const now = Date.now();
  const existing = activeSessionHold(pref, now);
  if (existing && existing.owner !== normalizedOwner) {
    const error = buildSessionHoldError(hostUrl, existing, now);
    error.code = 'HOST_SESSION_HOLD_BUSY';
    error.statusCode = 409;
    throw error;
  }
  const sameModel = existing ? pinNamesMatch(existing.model, normalizedModel) : false;
  const nextHold = {
    holdId: sameModel ? existing.holdId : crypto.randomUUID(),
    owner: normalizedOwner,
    model: normalizedModel,
    note: normalizedNote,
    claimedAt: sameModel && existing.claimedAt ? new Date(existing.claimedAt) : new Date(now),
    lastActivityAt: new Date(now),
    idleTtlMs: ttl,
    expiresAt: new Date(now + ttl),
    numCtx: normalizedNumCtx
  };
  const updated = await HostPreference.findOneAndUpdate(
    {
      hostUrl,
      status: { $ne: 'benchmarking' },
      'benchmarkClaim.batchId': null,
      $or: [
        { 'sessionHold.holdId': null },
        { 'sessionHold.expiresAt': { $lte: new Date(now) } },
        { 'sessionHold.owner': normalizedOwner }
      ]
    },
    { $set: { sessionHold: nextHold } },
    { new: true }
  ).lean();
  if (!updated) {
    throw holdError(`Host hold could not be acquired: ${hostUrl}`, 'HOST_SESSION_HOLD_BUSY', 409);
  }
  observeSessionHold(updated);
  logger.info(`[SessionHold] ${sameModel ? 'renewed' : 'acquired'} ${normalizedModel} on ${updated.displayName || hostUrl}`, {
    owner: normalizedOwner,
    holdId: nextHold.holdId,
    idleTtlMs: ttl,
    numCtx: normalizedNumCtx,
    expiresAt: nextHold.expiresAt.toISOString()
  });
  if (warm) await ensureWarm(hostUrl, nextHold, deps);
  return getSessionHoldStatus(hostUrl, { pref: updated, deps });
}

async function touchSessionHold(hostUrl, holdId, { owner = null, warm = true } = {}, deps = {}) {
  if (!hostUrl || !holdId) {
    throw holdError('hostUrl and holdId are required.', 'HOST_SESSION_HOLD_INVALID', 400);
  }
  const pref = await HostPreference.findOne({ hostUrl }).lean();
  const now = Date.now();
  const hold = activeSessionHold(pref, now);
  if (!hold || hold.holdId !== holdId || (owner && hold.owner !== owner)) {
    throw holdError(`No active session hold ${holdId} on ${hostUrl}`, 'HOST_SESSION_HOLD_NOT_FOUND', 404);
  }
  const ttl = boundedIdleTtl(hold.idleTtlMs);
  const updated = await HostPreference.findOneAndUpdate(
    { hostUrl, 'sessionHold.holdId': holdId, 'sessionHold.expiresAt': { $gt: new Date(now) } },
    { $set: { 'sessionHold.lastActivityAt': new Date(now), 'sessionHold.expiresAt': new Date(now + ttl) } },
    { new: true }
  ).lean();
  if (!updated) {
    activeHolds.delete(hostUrl);
    throw holdError(`Session hold ${holdId} expired on ${hostUrl}`, 'HOST_SESSION_HOLD_NOT_FOUND', 404);
  }
  observeSessionHold(updated);
  if (warm) await ensureWarm(hostUrl, updated.sessionHold, deps);
  return getSessionHoldStatus(hostUrl, { pref: updated, deps });
}

async function clearHold(hostUrl, holdId, reason) {
  // Forfeit the remaining pin grace: the pin reconciler treats an epoch stamp
  // as an elapsed grace and restores the displaced pin on its next tick.
  const updated = await HostPreference.findOneAndUpdate(
    { hostUrl, 'sessionHold.holdId': holdId },
    { $set: { sessionHold: { ...EMPTY_HOLD }, pinFirstDisplacedAt: new Date(0) } },
    { new: true }
  ).lean();
  const current = warmState.get(hostUrl);
  if (current && current.holdId === holdId) warmState.delete(hostUrl);
  if (updated) observeSessionHold(updated);
  if (updated) {
    logger.info(`[SessionHold] ${reason} on ${updated.displayName || hostUrl}`, { holdId });
  }
  return updated;
}

async function releaseSessionHold(hostUrl, holdId) {
  if (!hostUrl || !holdId) {
    throw holdError('hostUrl and holdId are required.', 'HOST_SESSION_HOLD_INVALID', 400);
  }
  const updated = await clearHold(hostUrl, holdId, 'released');
  return { host: hostUrl, holdId, released: Boolean(updated) };
}

/**
 * Reconciler helper: clear a hold that is present but no longer active.
 * Returns the refreshed preference when a hold was cleared, otherwise null.
 */
async function expireStaleSessionHold(pref, now = Date.now()) {
  const holdId = pref?.sessionHold?.holdId;
  if (!holdId || activeSessionHold(pref, now)) return null;
  return clearHold(pref.hostUrl, holdId, 'expired after idle timeout');
}

async function getSessionHoldStatus(hostUrl, { pref = null, deps = {} } = {}) {
  if (!hostUrl || typeof hostUrl !== 'string') {
    throw holdError('hostUrl is required.', 'HOST_SESSION_HOLD_INVALID', 400);
  }
  const current = pref || await HostPreference.findOne({ hostUrl }).lean();
  if (!current) {
    throw holdError(`Host is not configured: ${hostUrl}`, 'HOST_SESSION_HOLD_HOST_UNKNOWN', 404);
  }
  const now = Date.now();
  const hold = observeSessionHold(current, now);
  const fetchRunning = deps.fetchRunningModelInfos || fetchRunningModelInfos;
  const running = await fetchRunning(hostUrl, 5_000);
  const runningNames = running.map((entry) => entry.name || entry.model).filter(Boolean);
  const pinned = getPinnedEntries(current);
  const residency = hold ? holdResidency(hostUrl, hold, running) : { resident: false, loadedContextLength: null };
  const modelResident = residency.resident;
  // An active hold whose model is not resident and has no warm-up in flight
  // (Core restarted, or Ollama evicted it) is a promise Core is not keeping.
  // Re-warm it here so the hold heals on the next status read instead of
  // waiting for the next turn.
  if (hold && !modelResident && warmSnapshot(hostUrl, hold, now).status === 'idle') {
    logger.info(`[SessionHold] ${hold.model} not resident under an active hold on ${hostUrl}; re-warming`, {
      owner: hold.owner
    });
    startWarm(hostUrl, hold, deps);
  }
  const warm = warmSnapshot(hostUrl, hold, now);
  let phase = 'none';
  if (hold) {
    if (modelResident) phase = 'resident';
    else if (warm.status === 'loading') phase = 'loading';
    else if (warm.status === 'error') phase = 'error';
    else phase = 'pending';
  }
  return {
    host: hostUrl,
    displayName: current.displayName || null,
    hostStatus: current.status || null,
    hold: publicHold(hold, now),
    phase,
    modelResident,
    residentContextLength: residency.loadedContextLength,
    running: runningNames,
    pinnedModels: pinned.map((entry) => entry.model),
    pinResident: pinned.length > 0 && entrySatisfiedByLoadedModel(pinned[0], running),
    warm
  };
}

function resetWarmStateForTests() {
  warmState.clear();
  activeHolds.clear();
}

module.exports = {
  DEFAULT_IDLE_TTL_MS,
  MIN_IDLE_TTL_MS,
  MAX_IDLE_TTL_MS,
  EMPTY_HOLD,
  activeSessionHold,
  hasActiveSessionHold,
  observeSessionHold,
  isHostHeld,
  holdBlocksModel,
  publicHold,
  buildSessionHoldError,
  getActiveSessionHold,
  acquireSessionHold,
  touchSessionHold,
  releaseSessionHold,
  expireStaleSessionHold,
  getSessionHoldStatus,
  warmSessionHoldModel,
  resetWarmStateForTests
};
