'use strict';

const {
  LANES,
  RATE_BUCKETS,
  ROUTING_MODES,
  CALLER_POLICIES,
  DEFAULT_POLICY,
  resolveCallerPolicy,
  driftingCallers,
} = require('../../src/services/routing/callerPolicy');
const { resolveLane } = require('../../src/services/inferenceLanePolicy');
const { INTERNAL_CALLER_PREFIXES } = require('../../src/middleware/rateLimiter');

/**
 * A representative callerDetail per family. The registry declares patterns; the
 * manifest has to exercise them against real strings, because a pattern that
 * matches nothing real would otherwise pass every structural check.
 */
const SAMPLES = {
  'benchmark-batch': 'benchmark-batch-6a1c80b7c2551d3c75492131',
  'benchmark-warmup': 'benchmark-warmup',
  'benchmark-host-test': 'benchmark-host-test-primary',
  'benchmark-decomposed-judge': 'benchmark-decomposed-judge',
  profiler: 'profiler-host-alpha',
  'chat-exact': 'chat',
  'chat-surface': 'chat-playground',
  'buddy-path': 'buddy/notes',
  'buddy-reaction': 'buddy-reaction',
  nestor: 'nestor/panel/ask',
  'nerve-center': 'nerve-center-intelligence',
  alerts: 'alerts-evaluate',
  openclaw: 'openclaw-ollama',
};

/** The live rate-bucket decision, mirroring createInferenceCallerRouter. */
function liveRateBucket(callerDetail) {
  if (typeof callerDetail === 'string' && callerDetail.startsWith('benchmark-')) return 'benchmark';
  if (INTERNAL_CALLER_PREFIXES.some((prefix) => String(callerDetail || '').startsWith(prefix))) {
    return 'internal';
  }
  return 'general';
}

describe('caller policy manifest (0521)', () => {
  test('every declared family has a sample, and every sample matches its family', () => {
    // Guards the manifest itself: adding a family without a sample must fail
    // rather than silently reduce coverage.
    for (const policy of CALLER_POLICIES) {
      const sample = SAMPLES[policy.id];
      expect(sample).toBeDefined();
      expect(resolveCallerPolicy(sample).id).toBe(policy.id);
    }
    expect(Object.keys(SAMPLES).sort()).toEqual(CALLER_POLICIES.map((p) => p.id).sort());
  });

  test('every family declares every policy dimension with a valid value', () => {
    for (const policy of [...CALLER_POLICIES, DEFAULT_POLICY]) {
      expect(LANES).toContain(policy.lane);
      expect(RATE_BUCKETS).toContain(policy.rateBucket);
      expect(ROUTING_MODES).toContain(policy.routingMode);
      expect(typeof policy.admission).toBe('boolean');
      expect(['probe', 'bare']).toContain(policy.adaptation);
      expect(typeof policy.cloudEligible).toBe('boolean');
      expect(typeof policy.telemetryCaller).toBe('string');
    }
  });

  // The point of the whole card: the registry must describe reality, not an
  // idealized version of it. These compare against the live implementations.
  describe('fidelity to the live matchers', () => {
    test.each(Object.entries(SAMPLES))('%s: declared lane matches inferenceLanePolicy', (id, sample) => {
      const declared = CALLER_POLICIES.find((p) => p.id === id);
      expect(resolveLane(sample).name).toBe(declared.lane);
    });

    test.each(Object.entries(SAMPLES))('%s: declared rate bucket matches the limiter', (id, sample) => {
      const declared = CALLER_POLICIES.find((p) => p.id === id);
      expect(liveRateBucket(sample)).toBe(declared.rateBucket);
    });

    test('an unrecognized caller gets the conservative default from both', () => {
      const stranger = 'some-new-tool-nobody-registered';
      expect(resolveCallerPolicy(stranger)).toBe(DEFAULT_POLICY);
      expect(resolveLane(stranger).name).toBe(DEFAULT_POLICY.lane);
      expect(liveRateBucket(stranger)).toBe(DEFAULT_POLICY.rateBucket);
    });
  });

  describe('recorded lane/rate drift', () => {
    test('is exactly the four known families', () => {
      // Pinned deliberately. If this list shrinks someone fixed a bucket — good,
      // but it is a rate-limit change and must be a conscious one. If it grows,
      // a new caller was added to one matcher list and not the other.
      expect(driftingCallers().map((p) => p.id).sort()).toEqual([
        'buddy-reaction', 'chat-exact', 'openclaw', 'profiler',
      ]);
    });

    test('each drift entry explains itself and is a real disagreement', () => {
      for (const policy of driftingCallers()) {
        expect(typeof policy.rateBucketDrift).toBe('string');
        expect(policy.rateBucketDrift.length).toBeGreaterThan(20);
        // Drift means "first-class by lane, general by bucket".
        expect(policy.rateBucket).toBe('general');
        expect(policy.lane).not.toBe('automated_default_placeholder');
      }
    });

    test('non-drifting interactive callers really do get the internal bucket', () => {
      for (const id of ['chat-surface', 'buddy-path', 'nestor', 'nerve-center', 'alerts']) {
        expect(liveRateBucket(SAMPLES[id])).toBe('internal');
      }
    });
  });

  test('unknown callers never inherit a fast path', () => {
    // The safe default must be what you get by forgetting to register.
    expect(DEFAULT_POLICY.admission).toBe(true);
    expect(DEFAULT_POLICY.adaptation).toBe('bare');
    expect(DEFAULT_POLICY.cloudEligible).toBe(false);
    expect(DEFAULT_POLICY.rateBucket).toBe('general');
  });

  test.each([null, undefined, '', 123, {}])('resolves defensively for %p', (input) => {
    expect(resolveCallerPolicy(input)).toBe(DEFAULT_POLICY);
  });
});
