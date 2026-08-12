'use strict';

/**
 * Caller policy registry — task 0521.
 *
 * One declaration per caller family, covering every dimension the platform
 * currently decides per caller: execution lane, rate bucket, admission,
 * ax/-adaptation, cloud eligibility, routing mode, and telemetry identity.
 *
 * WHY THIS EXISTS
 * ---------------
 * Those dimensions were decided by two independently maintained regex lists
 * that had already drifted apart:
 *
 *   - `inferenceLanePolicy.LANE_RULES` picks the execution lane.
 *   - `rateLimiter.INTERNAL_CALLER_PREFIXES` picks the rate bucket.
 *
 * Nothing kept them in agreement, so four caller families are recognized as
 * first-class by one list and fall through to the tight external bucket in the
 * other (see `rateBucketDrift` below). That is not a hypothetical: `profiler-`
 * is classified `direct` precisely because it is high-volume, and is then rate
 * limited as if it were anonymous public traffic.
 *
 * FAITHFUL, NOT CORRECTIVE
 * ------------------------
 * This registry describes what the platform does **today**, including the
 * mismatches, and marks each one. It deliberately does not change any bucket.
 * Silently widening a rate limit is how a fleet starts 429-ing at 3am, and 0521
 * is explicitly a no-behavior-change card. The manifest test proves the
 * registry matches the live matchers, so the drift becomes reviewable data
 * instead of an accident, and fixing it becomes a decision someone makes on
 * purpose.
 *
 * TRUST MODEL
 * -----------
 * `callerDetail` is caller-supplied and unauthenticated. It selects
 * *performance* policy only, never authorization — the same load-bearing
 * assumption documented in `inferenceLanePolicy`. Nothing here may become an
 * access-control decision without auth in front of it first.
 */

const LANES = Object.freeze(['direct', 'interactive', 'automated']);
const RATE_BUCKETS = Object.freeze(['benchmark', 'internal', 'general']);
const ROUTING_MODES = Object.freeze(['task', 'model', 'fixed', 'passthrough']);

/**
 * Caller families in the order they are matched — most specific first, mirroring
 * how the live matchers evaluate.
 *
 * `rateBucketDrift` records that the lane classification and the rate bucket
 * disagree about whether this caller is first-class. It is documentation of a
 * real inconsistency, not a setting.
 */
const CALLER_POLICIES = Object.freeze([
  // ── benchmark corpus + profiling: self-sequencing, owns the host ──────────
  {
    id: 'benchmark-batch',
    pattern: /^benchmark-batch-/,
    lane: 'direct',
    rateBucket: 'benchmark',
    admission: false,
    adaptation: 'probe',
    cloudEligible: false,
    routingMode: 'fixed',
    telemetryCaller: 'benchmark',
  },
  {
    id: 'benchmark-warmup',
    pattern: /^benchmark-warmup$/,
    lane: 'direct',
    rateBucket: 'benchmark',
    admission: false,
    adaptation: 'probe',
    cloudEligible: false,
    routingMode: 'fixed',
    telemetryCaller: 'benchmark',
  },
  {
    id: 'benchmark-host-test',
    pattern: /^benchmark-host-test-/,
    lane: 'direct',
    rateBucket: 'benchmark',
    admission: false,
    adaptation: 'probe',
    cloudEligible: false,
    routingMode: 'fixed',
    telemetryCaller: 'benchmark',
  },
  {
    id: 'benchmark-decomposed-judge',
    pattern: /^benchmark-decomposed-judge$/,
    lane: 'direct',
    rateBucket: 'benchmark',
    admission: false,
    adaptation: 'probe',
    cloudEligible: false,
    routingMode: 'fixed',
    telemetryCaller: 'benchmark',
  },
  {
    id: 'profiler',
    pattern: /^profiler-/,
    lane: 'direct',
    // DRIFT: `direct` means high-volume and self-sequencing, yet the rate
    // limiter has no `profiler-` prefix, so profiling traffic lands in the
    // tight general bucket — the opposite of the intent behind its lane.
    rateBucket: 'general',
    rateBucketDrift: 'lane=direct but no rate-limiter prefix; falls to general',
    admission: false,
    adaptation: 'bare',
    cloudEligible: false,
    routingMode: 'fixed',
    telemetryCaller: 'benchmark',
  },

  // ── interactive: human-driven or companion surfaces ───────────────────────
  {
    id: 'chat-exact',
    pattern: /^chat$/,
    lane: 'interactive',
    // DRIFT: the rate limiter lists `chat-` (with the hyphen), so the plain
    // `chat` caller misses the internal bucket by one character.
    rateBucket: 'general',
    rateBucketDrift: "lane=interactive but rate prefix is 'chat-'; bare 'chat' falls to general",
    admission: true,
    adaptation: 'probe',
    cloudEligible: true,
    routingMode: 'task',
    telemetryCaller: 'chat',
  },
  {
    id: 'chat-surface',
    pattern: /^chat-/,
    lane: 'interactive',
    rateBucket: 'internal',
    admission: true,
    adaptation: 'probe',
    cloudEligible: true,
    routingMode: 'task',
    telemetryCaller: 'chat',
  },
  {
    id: 'buddy-path',
    pattern: /^buddy\//,
    lane: 'interactive',
    rateBucket: 'internal',
    admission: true,
    adaptation: 'probe',
    cloudEligible: true,
    routingMode: 'task',
    telemetryCaller: 'chat',
  },
  {
    id: 'buddy-reaction',
    pattern: /^buddy-reaction$/,
    lane: 'interactive',
    // DRIFT: the rate limiter prefix is `buddy/`, so `buddy-reaction` misses it.
    rateBucket: 'general',
    rateBucketDrift: "lane=interactive but rate prefix is 'buddy/'; 'buddy-reaction' falls to general",
    admission: true,
    adaptation: 'probe',
    cloudEligible: true,
    routingMode: 'task',
    telemetryCaller: 'chat',
  },
  {
    id: 'nestor',
    pattern: /^nestor\//,
    lane: 'interactive',
    rateBucket: 'internal',
    admission: true,
    adaptation: 'probe',
    cloudEligible: true,
    routingMode: 'task',
    telemetryCaller: 'chat',
  },
  {
    id: 'nerve-center',
    pattern: /^nerve-center-/,
    lane: 'interactive',
    rateBucket: 'internal',
    admission: true,
    adaptation: 'probe',
    cloudEligible: false,
    routingMode: 'task',
    telemetryCaller: 'chat',
  },
  {
    id: 'alerts',
    pattern: /^alerts-/,
    lane: 'interactive',
    rateBucket: 'internal',
    admission: true,
    adaptation: 'probe',
    cloudEligible: false,
    routingMode: 'task',
    telemetryCaller: 'chat',
  },

  // ── automated: agent runtimes through core's proxies ──────────────────────
  {
    id: 'openclaw',
    pattern: /^openclaw-/,
    lane: 'automated',
    // DRIFT: OpenClaw runtime traffic is a known internal caller by every other
    // measure, but has no rate-limiter prefix.
    rateBucket: 'general',
    rateBucketDrift: 'lane=automated (explicit rule) but no rate-limiter prefix; falls to general',
    admission: true,
    adaptation: 'bare',
    cloudEligible: true,
    routingMode: 'passthrough',
    telemetryCaller: 'proxy',
  },
]);

/**
 * The policy for any caller that matches no family.
 *
 * `automated` + `general` is the conservative pair: full ceremony, tightest
 * limit. An unrecognized caller must never inherit a fast path by default.
 */
const DEFAULT_POLICY = Object.freeze({
  id: 'unknown',
  pattern: null,
  lane: 'automated',
  rateBucket: 'general',
  admission: true,
  adaptation: 'bare',
  cloudEligible: false,
  routingMode: 'task',
  telemetryCaller: 'unknown',
});

/** Resolve the full policy for a callerDetail. Never returns null. */
function resolveCallerPolicy(callerDetail) {
  if (typeof callerDetail === 'string' && callerDetail.length > 0) {
    for (const policy of CALLER_POLICIES) {
      if (policy.pattern.test(callerDetail)) return policy;
    }
  }
  return DEFAULT_POLICY;
}

/** Every family whose lane and rate bucket disagree. Reviewable, not silently fixed. */
function driftingCallers() {
  return CALLER_POLICIES.filter((policy) => Boolean(policy.rateBucketDrift));
}

module.exports = {
  LANES,
  RATE_BUCKETS,
  ROUTING_MODES,
  CALLER_POLICIES,
  DEFAULT_POLICY,
  resolveCallerPolicy,
  driftingCallers,
};
