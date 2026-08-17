'use strict';

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
 *   - resolveLane(callerDetail): returns { name, policy } based on regex
 *     match against callerDetail. Mirrors the matcher style used in
 *     core/src/middleware/rateLimiter.js (inferenceCallerRouter).
 *   - probeCache: small in-memory TTL cache for the ax/-prefix probe.
 *
 * Trust model — LOAD-BEARING ASSUMPTION
 * --------------------------------------
 * `callerDetail` is a free-form string set by the caller. The proxy trusts
 * it for **lane selection only**. Lane is a *performance* policy, not an
 * authorization mechanism. Today's network is internal-only (no external
 * exposure of /api/inference/generate), so this is acceptable.
 *
 * If /api/inference/generate ever moves to an externally reachable surface,
 * lane selection MUST be replaced with auth-middleware-set headers or signed
 * tokens BEFORE the exposure ships. See docs/LLM_USAGE.md "Lane Policy".
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

// Caller patterns evaluated in priority order (most specific first).
// Mirrors the regex style in core/src/middleware/rateLimiter.js.
const LANE_RULES = [
  // direct lane — bench / profiler / warmup / judge self-sequence per host
  { pattern: /^benchmark-batch-/, lane: 'direct' },
  { pattern: /^benchmark-warmup$/, lane: 'direct' },
  { pattern: /^benchmark-host-test-/, lane: 'direct' },
  { pattern: /^benchmark-decomposed-judge$/, lane: 'direct' },
  { pattern: /^profiler-/, lane: 'direct' },

  // interactive lane — UI / companion / human-driven
  { pattern: /^chat$/, lane: 'interactive' },
  { pattern: /^chat-/, lane: 'interactive' },
  { pattern: /^buddy\//, lane: 'interactive' },
  { pattern: /^buddy-reaction$/, lane: 'interactive' },
  { pattern: /^nestor\//, lane: 'interactive' },
  { pattern: /^nerve-center-/, lane: 'interactive' },
  { pattern: /^alerts-/, lane: 'interactive' },

];

/**
 * Resolve the lane for a given callerDetail.
 *
 * @param {string|undefined|null} callerDetail
 * @returns {{ name: 'direct'|'interactive'|'automated', policy: object }}
 */
function resolveLane(callerDetail) {
  if (typeof callerDetail === 'string' && callerDetail.length > 0) {
    for (const rule of LANE_RULES) {
      if (rule.pattern.test(callerDetail)) {
        return { name: rule.lane, policy: LANE_POLICY[rule.lane] };
      }
    }
  }
  return { name: 'automated', policy: LANE_POLICY.automated };
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
  LANE_RULES,
  PROBE_CACHE_TTL_MS,
  resolveLane,
  getProbe,
  setProbe,
  _resetProbeCacheForTests,
};
