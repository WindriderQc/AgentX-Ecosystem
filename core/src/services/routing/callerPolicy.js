'use strict';

/**
 * Single caller classifier for inference execution and rate limiting.
 *
 * callerDetail is caller-supplied performance metadata, never authorization.
 * Unknown callers keep the fully admitted automated lane and the general rate
 * bucket. Known internal families are declared once here so routing and rate
 * limiting cannot drift through parallel regex lists.
 */

const LANES = Object.freeze(['direct', 'interactive', 'automated']);
const RATE_BUCKETS = Object.freeze(['benchmark', 'internal', 'general']);

const CALLER_POLICIES = Object.freeze([
  // Benchmark operations that own and sequence their target host.
  { id: 'benchmark-batch', pattern: /^benchmark-batch-/, lane: 'direct', rateBucket: 'benchmark' },
  { id: 'benchmark-warmup', pattern: /^benchmark-warmup$/, lane: 'direct', rateBucket: 'benchmark' },
  { id: 'benchmark-host-test', pattern: /^benchmark-host-test-/, lane: 'direct', rateBucket: 'benchmark' },
  { id: 'benchmark-decomposed-judge', pattern: /^benchmark-decomposed-judge$/, lane: 'direct', rateBucket: 'benchmark' },
  { id: 'profiler', pattern: /^profiler-/, lane: 'direct', rateBucket: 'benchmark' },

  // Other benchmark calls retain admission/routing but use the benchmark rate
  // bucket, matching the historical benchmark-* limiter behavior.
  { id: 'benchmark-other', pattern: /^benchmark-/, lane: 'automated', rateBucket: 'benchmark' },

  // Human-driven and companion traffic.
  { id: 'chat-exact', pattern: /^chat$/, lane: 'interactive', rateBucket: 'internal' },
  { id: 'chat-surface', pattern: /^chat-/, lane: 'interactive', rateBucket: 'internal' },
  { id: 'buddy-path', pattern: /^buddy\//, lane: 'interactive', rateBucket: 'internal' },
  { id: 'buddy-reaction', pattern: /^buddy-reaction$/, lane: 'interactive', rateBucket: 'internal' },
  { id: 'nestor', pattern: /^nestor\//, lane: 'interactive', rateBucket: 'internal' },
  { id: 'nerve-center', pattern: /^nerve-center-/, lane: 'interactive', rateBucket: 'internal' },
  { id: 'alerts', pattern: /^alerts-/, lane: 'interactive', rateBucket: 'internal' },

  // Known agent-runtime traffic keeps full inference ceremony but gets the
  // internal caller bucket instead of falling through as anonymous traffic.
  { id: 'openclaw', pattern: /^openclaw-/, lane: 'automated', rateBucket: 'internal' }
]);

const DEFAULT_POLICY = Object.freeze({
  id: 'unknown',
  pattern: null,
  lane: 'automated',
  rateBucket: 'general'
});

function resolveCallerPolicy(callerDetail) {
  if (typeof callerDetail === 'string' && callerDetail.length > 0) {
    for (const policy of CALLER_POLICIES) {
      if (policy.pattern.test(callerDetail)) return policy;
    }
  }
  return DEFAULT_POLICY;
}

module.exports = {
  LANES,
  RATE_BUCKETS,
  CALLER_POLICIES,
  DEFAULT_POLICY,
  resolveCallerPolicy
};
