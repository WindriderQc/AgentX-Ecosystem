'use strict';

const { resolveCallerPolicy } = require('./routing/callerPolicy');

/**
 * Inference Lane Policy — caller-aware fast/safe/direct lanes for /api/inference/generate.
 *
 * Background (task 0168): the inference proxy historically ran every step
 * (ax/-prefix probe, Mongo lookups, hostGate.acquire, sync recordInference,
 * alert evaluation) for every caller. That's correct for unknown automated
 * traffic but kills throughput for high-volume bench/profiler runs and adds
 * non-load-bearing overhead to interactive callers.
 *
 * This module exports:
 *   - LANE_POLICY: policy map keyed by lane name. Each policy has booleans
 *     `route`, `probe`, `admit`, `recordInferenceSync`, `alert`.
 *   - resolveLane(callerDetail): resolves the declared policy catalog.
 *   - resolvePolicyLane(callerPolicy): resolves an already authenticated
 *     request policy without re-trusting callerDetail.
 *   - probeCache: small in-memory TTL cache for the ax/-prefix probe.
 *
 * Trust model — LOAD-BEARING ASSUMPTION
 * --------------------------------------
 * `callerDetail` is a free-form telemetry string. The HTTP request boundary
 * authenticates any privileged performance policy and passes that effective
 * policy to `resolvePolicyLane`. An untrusted claim remains observable but
 * runs through the automated safe path.
 *
 * Safety invariant — the interactive lane keeps `hostGate.acquire`
 * --------------------------------------------------------------
 * Skipping admission for chat/buddy would let interactive callers cut in
 * line on a cron job mid-call and force model swaps — exactly what the
 * gate exists to prevent. Interactive's speed comes from skipping the
 * /api/show probe (cached after first hit), Mongo lookups, and the sync
 * recordInference write — not from skipping admission.
 *
 * The direct lane skips admission because bench/profiler self-sequence per
 * host and own the host for the duration; admission is ceremony for them,
 * not safety.
 */

// Default probe-cache TTL (5 minutes) chosen so an interactive session
// touching the same (host, model) repeatedly amortizes the probe to one
// /api/show roundtrip. ax/-deployments rarely change within 5 minutes; if
// they do, the worst case is one stale lookup, never a correctness bug.
const PROBE_CACHE_TTL_MS = 5 * 60 * 1000;

const LANE_POLICY = Object.freeze({
  direct: Object.freeze({
    route: false,
    probe: false,
    admit: false,
    recordInferenceSync: false, // async via process.nextTick
    alert: 'error-only',         // skip latency alerts; keep error alerts
  }),
  interactive: Object.freeze({
    route: true,
    probe: true,                 // but cached (PROBE_CACHE_TTL_MS)
    admit: true,                 // load-bearing: keeps cron fairness
    recordInferenceSync: false,  // async via process.nextTick
    alert: true,
  }),
  automated: Object.freeze({
    route: true,
    probe: true,
    admit: true,
    recordInferenceSync: true,
    alert: true,
  }),
});

/**
 * Resolve the lane for a given callerDetail.
 *
 * @param {string|undefined|null} callerDetail
 * @returns {{ name: 'direct'|'interactive'|'automated', policy: object }}
 */
function resolveLane(callerDetail) {
  const { lane } = resolveCallerPolicy(callerDetail);
  return { name: lane, policy: LANE_POLICY[lane] };
}

function resolvePolicyLane(callerPolicy) {
  const lane = callerPolicy && LANE_POLICY[callerPolicy.lane]
    ? callerPolicy.lane
    : 'automated';
  return { name: lane, policy: LANE_POLICY[lane] };
}

// ── Probe cache ───────────────────────────────────────────────────────────
//
// Caches the result of the ax/-prefix existence check per (host, model).
// Key: `${host}::${model}`. Value: { resolvedModel, expiresAt }.
//
// Used only by the interactive lane. The direct lane skips probing entirely;
// the automated lane stays uncached so unknown callers retain the safe path.

const _probeCache = new Map();

function _cacheKey(host, model) {
  return `${host || 'unknown'}::${model || 'unknown'}`;
}

/**
 * Get a cached probe result if still fresh, else null.
 * Callers should perform the probe and call `setProbe` to populate.
 *
 * @returns {string|null} resolved model name (e.g. 'ax/foo' or original 'foo'), or null if no fresh entry
 */
function getProbe(host, model, now = Date.now()) {
  const key = _cacheKey(host, model);
  const entry = _probeCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= now) {
    _probeCache.delete(key);
    return null;
  }
  return entry.resolvedModel;
}

function setProbe(host, model, resolvedModel, now = Date.now()) {
  const key = _cacheKey(host, model);
  _probeCache.set(key, {
    resolvedModel,
    expiresAt: now + PROBE_CACHE_TTL_MS,
  });
}

function _resetProbeCacheForTests() {
  _probeCache.clear();
}

module.exports = {
  LANE_POLICY,
  PROBE_CACHE_TTL_MS,
  resolveLane,
  resolvePolicyLane,
  getProbe,
  setProbe,
  _resetProbeCacheForTests,
};
