'use strict';

/**
 * Shadow route resolver — task 0522.
 *
 * Turns routing from "try things until one works" into a decision with a
 * defensible shape: build explicit (model, host) tuples, remove the ones that
 * *cannot* work, score what survives exactly once, and record a reason for
 * every candidate that lost.
 *
 * THE STRUCTURAL RULES
 * --------------------
 * 1. HARD FILTERS ARE NOT SCORES. A benchmark-claimed host or a model that is
 *    not installed is not "a worse option" — it is not an option. Expressing
 *    impossibility as a low score is how a resolver eventually returns
 *    something that cannot serve the request, because a low enough score still
 *    wins when everything else scores lower.
 * 2. SCORE ONCE. Survivors are scored in a single pass over a fixed set of
 *    weights. Re-scoring during selection is how tie-breaks become dependent on
 *    iteration order.
 * 3. NEVER RETURN A FAILED CANDIDATE. If nothing survives, the answer is `null`
 *    plus the rejection list. There is no "best of the impossible".
 *
 * SHADOW ONLY
 * -----------
 * This module selects nothing in production. It is computed alongside the real
 * path, compared, and logged. `isShadowEnabled()` is off unless
 * `ROUTE_RESOLVER_SHADOW=true`, and even enabled it only records. Promoting it
 * to the real selector is a separate, reviewed change (0524/0525).
 *
 * It emits the RouteDecision v1 contract from 0519, so shadow and production
 * decisions are directly comparable field by field — which is the entire point
 * of having built the contract first.
 */

const {
  REJECTION_REASONS,
  DECISION_MODES,
  buildRouteDecision,
} = require('./routeDecision');

/** Selection modes. `fixed` pins an exact tuple; `model` picks a host for a model; `task` picks both. */
const RESOLVER_MODES = Object.freeze({
  TASK: 'task',
  MODEL: 'model',
  FIXED: 'fixed',
});

/**
 * Hard filters, evaluated in this order.
 *
 * Order matters for the *reason* a candidate is reported under, not for the
 * outcome — a candidate failing several filters is reported under the first,
 * which is deliberately the most fundamental. "Host offline" is a more useful
 * explanation than "context too small" for a host that is not there at all.
 *
 * Each predicate returns true when the candidate MUST be excluded.
 */
const HARD_FILTERS = Object.freeze([
  {
    reason: REJECTION_REASONS.HOST_UNCONFIGURED,
    exclude: (c) => !c.hostUrl,
  },
  {
    reason: REJECTION_REASONS.HOST_OFFLINE,
    exclude: (c) => c.host?.online === false,
  },
  {
    reason: REJECTION_REASONS.HOST_DRAINING,
    exclude: (c) => c.host?.draining === true,
  },
  {
    reason: REJECTION_REASONS.BENCHMARK_CLAIMED,
    // A claim means another run owns the host and will swap models underneath
    // us. Routing into it is what the claim exists to prevent.
    exclude: (c) => c.host?.benchmarkClaimed === true,
  },
  {
    reason: REJECTION_REASONS.MODEL_NOT_INSTALLED,
    exclude: (c) => c.artifact?.installed === false,
  },
  {
    reason: REJECTION_REASONS.CAPABILITY_UNQUALIFIED,
    // Only exclude on an explicit disqualification. `undefined` means "not
    // profiled", which is not evidence of unfitness — treating unknown as
    // failure would empty the candidate set on a fresh host.
    exclude: (c) => c.artifact?.qualified === false,
  },
  {
    reason: REJECTION_REASONS.POLICY_EXCLUDED,
    // Privacy/cloud eligibility comes from the 0521 caller policy.
    exclude: (c, ctx) => c.cloud === true && ctx.cloudEligible === false,
  },
  {
    reason: REJECTION_REASONS.INSUFFICIENT_VRAM,
    exclude: (c) => {
      const need = Number(c.artifact?.requiredVramMiB);
      const free = Number(c.host?.freeVramMiB);
      if (!Number.isFinite(need) || !Number.isFinite(free)) return false;
      return need > free;
    },
  },
  {
    reason: REJECTION_REASONS.CONTEXT_TOO_SMALL,
    exclude: (c, ctx) => {
      const need = Number(ctx.requiredContextTokens);
      const max = Number(c.artifact?.maxContextTokens);
      if (!Number.isFinite(need) || !Number.isFinite(max)) return false;
      return need > max;
    },
  },
]);

/**
 * Scoring weights. Deliberately few and explainable — a score nobody can read
 * is a score nobody can override with evidence.
 */
const SCORE_WEIGHTS = Object.freeze({
  resident: 100,      // already loaded: no runner rebuild, no multi-minute stall
  pinned: 40,         // the operator's declared intent for this host
  hostTier: { primary: 30, secondary: 20, tertiary: 10 },
  contextHeadroom: 20, // scaled 0..1
  local: 15,          // prefer local over cloud when both are eligible
});

/** Single scoring pass. Returns a new array; never mutates the input. */
function scoreCandidates(candidates, context = {}) {
  return candidates.map((candidate) => {
    const breakdown = {};

    if (candidate.artifact?.resident === true) breakdown.resident = SCORE_WEIGHTS.resident;
    if (candidate.artifact?.pinned === true) breakdown.pinned = SCORE_WEIGHTS.pinned;

    const tier = SCORE_WEIGHTS.hostTier[candidate.host?.tier];
    if (Number.isFinite(tier)) breakdown.hostTier = tier;

    const need = Number(context.requiredContextTokens);
    const max = Number(candidate.artifact?.maxContextTokens);
    if (Number.isFinite(need) && Number.isFinite(max) && max > 0 && need >= 0) {
      const headroom = Math.max(0, Math.min(1, (max - need) / max));
      breakdown.contextHeadroom = Math.round(headroom * SCORE_WEIGHTS.contextHeadroom);
    }

    if (candidate.cloud !== true) breakdown.local = SCORE_WEIGHTS.local;

    const score = Object.values(breakdown).reduce((sum, value) => sum + value, 0);
    return { ...candidate, score, scoreBreakdown: breakdown };
  });
}

/**
 * Deterministic ordering. Score descending, then a stable tie-break on the
 * tuple identity so equal scores never depend on input order — otherwise the
 * "same" request can route differently between two identically configured
 * processes, which is indistinguishable from a real routing bug.
 */
function compareScored(left, right) {
  if (right.score !== left.score) return right.score - left.score;
  return `${left.model}@${left.hostUrl}`.localeCompare(`${right.model}@${right.hostUrl}`);
}

/**
 * Resolve a route from explicit candidate tuples.
 *
 * @param {object} request  `{ mode, taskType, requestedModel, candidates: [{model, hostUrl, host, artifact, cloud}] }`
 * @param {object} [context] `{ cloudEligible, requiredContextTokens, caller, correlationId, ... }`
 * @returns {{ selected: object|null, rejected: object[], scored: object[], decision: object }}
 */
function resolveRoute(request = {}, context = {}) {
  const candidates = Array.isArray(request.candidates) ? request.candidates : [];
  const rejected = [];
  const survivors = [];

  for (const candidate of candidates) {
    const failed = HARD_FILTERS.find((filter) => filter.exclude(candidate, context));
    if (failed) {
      rejected.push({
        model: candidate.model,
        host: candidate.host?.key || null,
        hostUrl: candidate.hostUrl || null,
        reason: failed.reason,
      });
      continue;
    }
    survivors.push(candidate);
  }

  const scored = scoreCandidates(survivors, context).sort(compareScored);
  // No fallback to a filtered candidate. Nothing survivable means no route.
  const selected = scored.length ? scored[0] : null;

  const decision = buildRouteDecision({
    ...context,
    mode: request.mode || DECISION_MODES.CHARACTERIZED,
    taskType: request.taskType,
    requestedModel: request.requestedModel,
    primaryModel: candidates[0]?.model,
    primaryHost: candidates[0]?.host?.key,
    primaryHostUrl: candidates[0]?.hostUrl,
    selectedModel: selected?.model,
    selectedHost: selected?.host?.key,
    selectedHostUrl: selected?.hostUrl,
    rejections: rejected,
  });

  return { selected, rejected, scored, decision };
}

/** Shadow evaluation is opt-in and off by default. */
function isShadowEnabled() {
  return String(process.env.ROUTE_RESOLVER_SHADOW || '').toLowerCase() === 'true';
}

/**
 * Compare a shadow decision against what production actually did.
 *
 * Every difference gets a code rather than a boolean, because "the shadow
 * disagreed" is not actionable — knowing it disagreed only on host, while
 * agreeing on model, is. `no_shadow_candidate` is called out separately: the
 * resolver declining to route where production succeeded is the one mismatch
 * that would break traffic if promoted, so it must never look like a routine
 * host disagreement.
 */
function compareToActual(shadow, actual = {}) {
  const mismatches = [];

  if (!shadow?.selected) {
    mismatches.push('no_shadow_candidate');
    return { match: false, mismatches };
  }
  if (actual.model && shadow.selected.model !== actual.model) mismatches.push('model_mismatch');
  if (actual.hostUrl && shadow.selected.hostUrl !== actual.hostUrl) mismatches.push('host_mismatch');

  return { match: mismatches.length === 0, mismatches };
}

module.exports = {
  RESOLVER_MODES,
  HARD_FILTERS,
  SCORE_WEIGHTS,
  scoreCandidates,
  compareScored,
  resolveRoute,
  isShadowEnabled,
  compareToActual,
};
