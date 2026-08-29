'use strict';

/**
 * Host Gate — per-(host, model) admission queue for the inference proxy.
 *
 * Protects Ollama hosts from thundering-herd fan-out. Under normal load the
 * gate is a no-op; under cascade conditions it serializes concurrent hits on
 * the same (host, model) and surfaces the queue depth so operators can see
 * it before KV-cache thrashing masks the cause.
 *
 * Semantics:
 *  - Per-(host, model) semaphore, max `GATE_MAX_INFLIGHT` in-flight (default 2)
 *  - Streaming and embedding calls bypass the gate — they have different
 *    concurrency characteristics (long-lived vs short, no KV-cache contention)
 *  - When disabled (`GATE_ENABLED=false`) acquire() returns immediately
 *  - Observability: stats() returns per-(host, model) counters
 *
 * Not a distributed lock — single-process. Restart drops all state.
 */

const logger = require('../../config/logger');
const os = require('os');
const { randomUUID } = require('crypto');
const mongoose = require('mongoose');

const ENABLED = process.env.GATE_ENABLED !== 'false';
const MAX_INFLIGHT = Math.max(1, parseInt(process.env.GATE_MAX_INFLIGHT, 10) || 2);
const SHARED_SLOT_TTL_MS = Math.max(60_000, parseInt(process.env.GATE_SHARED_SLOT_TTL_MS, 10) || 30 * 60_000);
const SHARED_RETRY_MS = Math.max(25, parseInt(process.env.GATE_SHARED_RETRY_MS, 10) || 100);
const SHARED_OWNER_ID = `${os.hostname()}:${process.pid}:${randomUUID()}`;

// key = `${host}::${model}` → { inFlight, peak, totalAcquired, totalRejected, waiters }
const _stats = new Map();
// key → array of pending waiter records waiting for a slot
const _waitQueues = new Map();
let HostGateAdmission = null;

const HOST_GATE_ABORT_CODE = 'HOST_GATE_ADMISSION_ABORTED';

function _key(host, model) {
  return `${host || 'unknown'}::${model || 'unknown'}`;
}

function _getStats(key) {
  let s = _stats.get(key);
  if (!s) {
    s = { inFlight: 0, peak: 0, totalAcquired: 0, totalReleased: 0, waiters: 0, maxWaiters: 0 };
    _stats.set(key, s);
  }
  return s;
}

function _admissionModel() {
  if (!HostGateAdmission) HostGateAdmission = require('../../models/HostGateAdmission');
  return HostGateAdmission;
}

function sharedStateEnabled() {
  return ['1', 'true', 'yes', 'on'].includes(String(process.env.GATE_SHARED_STATE_ENABLED || '').trim().toLowerCase());
}

function sharedStateReady() {
  return sharedStateEnabled() && mongoose.connection.readyState === 1;
}

function createAdmissionAbortError() {
  const error = new Error('Host gate admission cancelled');
  error.name = 'AbortError';
  error.code = HOST_GATE_ABORT_CODE;
  return error;
}

function throwIfAdmissionAborted(signal) {
  if (signal?.aborted) throw createAdmissionAbortError();
}

function abortableSleep(ms, signal) {
  if (!signal) return new Promise(resolve => setTimeout(resolve, ms));
  if (signal.aborted) return Promise.reject(createAdmissionAbortError());

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => finish(() => reject(createAdmissionAbortError()));

    timer = setTimeout(() => finish(resolve), ms);
    signal.addEventListener('abort', onAbort, { once: true });

    // Cover a signal that changed between the pre-check and listener setup;
    // the timer already exists here, so the abort path always clears it.
    if (signal.aborted) onAbort();
  });
}

/**
 * Acquire a slot for (host, model). Resolves with a release function that
 * MUST be called exactly once when the request completes (success or failure).
 *
 * Callers that should bypass the gate (streaming / embeddings) should not
 * call acquire at all.
 *
 * @param {string} host
 * @param {string} model
 * @param {{signal?: AbortSignal}} options
 * @returns {Promise<() => void>} release fn
 */
async function acquire(host, model, { signal } = {}) {
  throwIfAdmissionAborted(signal);

  if (!ENABLED) {
    // No-op release — gate disabled
    return () => {};
  }

  if (sharedStateReady()) {
    return acquireShared(host, model, { signal });
  }

  return acquireLocal(host, model, { signal });
}

async function acquireLocal(host, model, { signal } = {}) {
  const key = _key(host, model);
  const s = _getStats(key);
  throwIfAdmissionAborted(signal);

  if (s.inFlight < MAX_INFLIGHT) {
    s.inFlight++;
    s.totalAcquired++;
    if (s.inFlight > s.peak) s.peak = s.inFlight;
    return _makeRelease(key);
  }

  // Need to wait — join the wait queue
  s.waiters++;
  if (s.waiters > s.maxWaiters) s.maxWaiters = s.waiters;

  if (s.waiters === 1) {
    logger.info('[HostGate] queue forming', { key, inFlight: s.inFlight, limit: MAX_INFLIGHT });
  }

  return new Promise((resolve, reject) => {
    let q = _waitQueues.get(key);
    if (!q) {
      q = [];
      _waitQueues.set(key, q);
    }

    const waiter = {
      state: 'waiting',
      signal,
      resolve,
      reject,
      onAbort: null,
    };

    waiter.onAbort = () => {
      if (waiter.state !== 'waiting') return;
      waiter.state = 'cancelled';

      const currentQueue = _waitQueues.get(key);
      if (currentQueue) {
        const index = currentQueue.indexOf(waiter);
        if (index >= 0) currentQueue.splice(index, 1);
        if (currentQueue.length === 0 && _waitQueues.get(key) === currentQueue) {
          _waitQueues.delete(key);
        }
      }

      s.waiters = Math.max(0, s.waiters - 1);
      signal?.removeEventListener('abort', waiter.onAbort);
      reject(createAdmissionAbortError());
    };

    q.push(waiter);
    if (signal?.addEventListener) {
      signal.addEventListener('abort', waiter.onAbort, { once: true });
      if (signal.aborted) waiter.onAbort();
    }
  });
}

async function tryAcquireSharedSlot(key, host, model, ownerId, signal) {
  const Admission = _admissionModel();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + SHARED_SLOT_TTL_MS);

  for (let slot = 0; slot < MAX_INFLIGHT; slot++) {
    throwIfAdmissionAborted(signal);
    const slotId = `${key}::${slot}`;
    try {
      const claimed = await Admission.findOneAndUpdate(
        {
          _id: slotId,
          $or: [
            { expiresAt: { $lte: now } },
            { ownerId }
          ]
        },
        {
          $set: {
            key,
            host: host || 'unknown',
            model: model || 'unknown',
            slot,
            ownerId,
            acquiredAt: now,
            expiresAt
          }
        },
        { upsert: true, new: true }
      ).lean();

      if (claimed && claimed.ownerId === ownerId) {
        return { slotId, ownerId, expiresAt };
      }
      throwIfAdmissionAborted(signal);
    } catch (err) {
      if (err && (err.code === 11000 || /duplicate key/i.test(err.message || ''))) {
        throwIfAdmissionAborted(signal);
        continue;
      }
      throw err;
    }
  }

  return null;
}

async function releaseSharedSlotWonAfterAbort(key, slotId, ownerId) {
  try {
    await _admissionModel().deleteOne({ _id: slotId, ownerId });
  } catch (err) {
    logger.warn('[HostGate] failed to release shared slot after cancelled admission', {
      key,
      error: err.message,
    });
  }
}

async function acquireShared(host, model, { signal } = {}) {
  const key = _key(host, model);
  const s = _getStats(key);
  const ownerId = `${SHARED_OWNER_ID}:${randomUUID()}`;
  let countedWaiter = false;

  try {
    while (true) {
      throwIfAdmissionAborted(signal);
      const slot = await tryAcquireSharedSlot(key, host, model, ownerId, signal);
      if (signal?.aborted) {
        if (slot) {
          await releaseSharedSlotWonAfterAbort(key, slot.slotId, ownerId);
        }
        throw createAdmissionAbortError();
      }

      if (slot) {
        if (countedWaiter) {
          s.waiters = Math.max(0, s.waiters - 1);
          countedWaiter = false;
        }
        s.inFlight++;
        s.totalAcquired++;
        if (s.inFlight > s.peak) s.peak = s.inFlight;
        return _makeSharedRelease(key, slot.slotId, ownerId);
      }

      if (!countedWaiter) {
        countedWaiter = true;
        s.waiters++;
        if (s.waiters > s.maxWaiters) s.maxWaiters = s.waiters;
        logger.info('[HostGate] shared queue forming', { key, limit: MAX_INFLIGHT });
      }

      await abortableSleep(SHARED_RETRY_MS, signal);
    }
  } finally {
    if (countedWaiter) {
      s.waiters = Math.max(0, s.waiters - 1);
    }
  }
}

function _makeRelease(key) {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const s = _getStats(key);
    s.inFlight--;
    s.totalReleased++;

    _admitNextLocalWaiter(key, s);
  };
}

function _admitNextLocalWaiter(key, s) {
  const q = _waitQueues.get(key);
  if (!q) return;

  while (q.length > 0) {
    const waiter = q.shift();
    if (q.length === 0 && _waitQueues.get(key) === q) {
      _waitQueues.delete(key);
    }
    if (!waiter || waiter.state !== 'waiting') continue;

    if (waiter.signal?.aborted) {
      waiter.onAbort();
      continue;
    }

    // Handoff is synchronous with release. Abort-before-release removes the
    // waiter; release-before-abort transfers ownership and a release function.
    waiter.state = 'admitted';
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    s.waiters = Math.max(0, s.waiters - 1);
    s.inFlight++;
    s.totalAcquired++;
    if (s.inFlight > s.peak) s.peak = s.inFlight;
    waiter.resolve(_makeRelease(key));
    return;
  }
}

function _makeSharedRelease(key, slotId, ownerId) {
  let released = false;
  const Admission = _admissionModel();
  const renewEveryMs = Math.max(10_000, Math.floor(SHARED_SLOT_TTL_MS / 3));
  const renewTimer = setInterval(() => {
    const expiresAt = new Date(Date.now() + SHARED_SLOT_TTL_MS);
    Admission.updateOne({ _id: slotId, ownerId }, { $set: { expiresAt } }).catch(err => {
      logger.warn('[HostGate] shared slot renewal failed', { key, error: err.message });
    });
  }, renewEveryMs);
  if (typeof renewTimer.unref === 'function') renewTimer.unref();

  return function release() {
    if (released) return;
    released = true;
    clearInterval(renewTimer);
    const s = _getStats(key);
    s.inFlight = Math.max(0, s.inFlight - 1);
    s.totalReleased++;
    Admission.deleteOne({ _id: slotId, ownerId }).catch(err => {
      logger.warn('[HostGate] shared slot release failed', { key, error: err.message });
    });
  };
}

/**
 * Current in-flight count for a specific (host, model). Returns 0 if the
 * gate is disabled or the key has never been touched. Used by reload/unload
 * paths to avoid killing active inference.
 */
function inFlightFor(host, model) {
  if (!ENABLED) return 0;
  const s = _stats.get(_key(host, model));
  return s ? s.inFlight : 0;
}

/**
 * True if any model on this host currently has in-flight inference tracked
 * by the gate. Host-level guard for pin reloaders that would force a VRAM
 * swap and disrupt the active caller.
 */
function hostHasInflight(host) {
  if (!ENABLED || !host) return false;
  const prefix = `${host}::`;
  for (const [key, s] of _stats.entries()) {
    if (key.startsWith(prefix) && s.inFlight > 0) return true;
  }
  return false;
}

function stats() {
  const out = {};
  for (const [key, s] of _stats.entries()) {
    const [host, model] = key.split('::');
    out[key] = {
      host,
      model,
      inFlight: s.inFlight,
      peak: s.peak,
      waiters: s.waiters,
      maxWaiters: s.maxWaiters,
      totalAcquired: s.totalAcquired,
      totalReleased: s.totalReleased
    };
  }
  return {
    enabled: ENABLED,
    maxInflight: MAX_INFLIGHT,
    mode: sharedStateReady() ? 'mongo-shared' : 'local-process',
    sharedStateEnabled: sharedStateEnabled(),
    sharedStateReady: sharedStateReady(),
    entries: out
  };
}

function _resetForTests() {
  _stats.clear();
  _waitQueues.clear();
}

async function _clearSharedAdmissionsForTests() {
  if (mongoose.connection.readyState !== 1) return;
  await _admissionModel().deleteMany({});
}

module.exports = {
  acquire,
  stats,
  inFlightFor,
  hostHasInflight,
  _resetForTests,
  _clearSharedAdmissionsForTests,
  MAX_INFLIGHT,
  ENABLED,
  get SHARED_STATE_ENABLED() { return sharedStateEnabled(); },
  SHARED_SLOT_TTL_MS,
  HOST_GATE_ABORT_CODE
};
