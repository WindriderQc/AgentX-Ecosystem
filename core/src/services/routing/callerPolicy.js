'use strict';

/**
 * Single caller classifier for inference execution and rate limiting.
 *
 * callerDetail is caller-supplied performance metadata, never authorization.
 * Unknown callers retain the fully admitted automated lane and general rate
 * bucket. Artifact identity is exact for every caller policy.
 */

const LANES = Object.freeze(['direct', 'interactive', 'automated']);
const RATE_BUCKETS = Object.freeze(['benchmark', 'internal', 'general']);
const ROUTING_MODES = Object.freeze(['fixed', 'task', 'passthrough']);

function definePolicy({
  id,
  pattern,
  lane,
  rateBucket,
  cloudEligible = false,
  routingMode = 'task',
  telemetryCaller = 'unknown',
}) {
  return Object.freeze({
    id,
    pattern,
    lane,
    rateBucket,
    admission: lane !== 'direct',
    artifactPolicy: 'exact',
    cloudEligible,
    routingMode,
    telemetryCaller,
  });
}

const CALLER_POLICIES = Object.freeze([
  // Benchmark operations that own and sequence their target host.
  definePolicy({ id: 'benchmark-batch', pattern: /^benchmark-batch-/, lane: 'direct', rateBucket: 'benchmark', routingMode: 'fixed', telemetryCaller: 'benchmark' }),
  definePolicy({ id: 'benchmark-warmup', pattern: /^benchmark-warmup$/, lane: 'direct', rateBucket: 'benchmark', routingMode: 'fixed', telemetryCaller: 'benchmark' }),
  definePolicy({ id: 'benchmark-host-test', pattern: /^benchmark-host-test-/, lane: 'direct', rateBucket: 'benchmark', routingMode: 'fixed', telemetryCaller: 'benchmark' }),
  definePolicy({ id: 'benchmark-decomposed-judge', pattern: /^benchmark-decomposed-judge$/, lane: 'direct', rateBucket: 'benchmark', routingMode: 'fixed', telemetryCaller: 'benchmark' }),
  definePolicy({ id: 'profiler', pattern: /^profiler-/, lane: 'direct', rateBucket: 'benchmark', routingMode: 'fixed', telemetryCaller: 'benchmark' }),

  // Other benchmark calls keep full routing/admission but use the benchmark bucket.
  definePolicy({ id: 'benchmark-other', pattern: /^benchmark-/, lane: 'automated', rateBucket: 'benchmark', telemetryCaller: 'benchmark' }),

  // Human-driven and companion traffic.
  definePolicy({ id: 'chat-exact', pattern: /^chat$/, lane: 'interactive', rateBucket: 'internal', cloudEligible: true, telemetryCaller: 'chat' }),
  definePolicy({ id: 'chat-surface', pattern: /^chat-/, lane: 'interactive', rateBucket: 'internal', cloudEligible: true, telemetryCaller: 'chat' }),
  definePolicy({ id: 'buddy-path', pattern: /^buddy\//, lane: 'interactive', rateBucket: 'internal', cloudEligible: true, telemetryCaller: 'chat' }),
  definePolicy({ id: 'buddy-reaction', pattern: /^buddy-reaction$/, lane: 'interactive', rateBucket: 'internal', cloudEligible: true, telemetryCaller: 'chat' }),
  definePolicy({ id: 'nestor', pattern: /^nestor\//, lane: 'interactive', rateBucket: 'internal', cloudEligible: true, telemetryCaller: 'chat' }),
  definePolicy({ id: 'nerve-center', pattern: /^nerve-center-/, lane: 'interactive', rateBucket: 'internal', telemetryCaller: 'chat' }),
  definePolicy({ id: 'alerts', pattern: /^alerts-/, lane: 'interactive', rateBucket: 'internal', telemetryCaller: 'chat' }),
]);

const DEFAULT_POLICY = definePolicy({
  id: 'unknown',
  pattern: null,
  lane: 'automated',
  rateBucket: 'general',
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
  ROUTING_MODES,
  CALLER_POLICIES,
  DEFAULT_POLICY,
  resolveCallerPolicy,
};
