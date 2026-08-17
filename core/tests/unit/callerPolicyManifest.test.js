'use strict';

const {
  LANES,
  RATE_BUCKETS,
  CALLER_POLICIES,
  DEFAULT_POLICY,
  resolveCallerPolicy
} = require('../../src/services/routing/callerPolicy');
const { resolveLane } = require('../../src/services/inferenceLanePolicy');

const SAMPLES = {
  'benchmark-batch': 'benchmark-batch-6a1c80b7c2551d3c75492131',
  'benchmark-warmup': 'benchmark-warmup',
  'benchmark-host-test': 'benchmark-host-test-primary',
  'benchmark-decomposed-judge': 'benchmark-decomposed-judge',
  profiler: 'profiler-host-alpha',
  'benchmark-other': 'benchmark-reference-scorer',
  'chat-exact': 'chat',
  'chat-surface': 'chat-playground',
  'buddy-path': 'buddy/notes',
  'buddy-reaction': 'buddy-reaction',
  nestor: 'nestor/panel/ask',
  'nerve-center': 'nerve-center-intelligence',
  alerts: 'alerts-evaluate',
  openclaw: 'openclaw-ollama'
};

describe('caller policy', () => {
  test('every declared family has a matching sample and valid live policy', () => {
    for (const policy of CALLER_POLICIES) {
      const sample = SAMPLES[policy.id];
      expect(sample).toBeDefined();
      expect(resolveCallerPolicy(sample)).toBe(policy);
      expect(LANES).toContain(policy.lane);
      expect(RATE_BUCKETS).toContain(policy.rateBucket);
      expect(resolveLane(sample).name).toBe(policy.lane);
    }
    expect(Object.keys(SAMPLES).sort()).toEqual(CALLER_POLICIES.map((policy) => policy.id).sort());
  });

  test('known internal families no longer fall into the anonymous rate bucket', () => {
    for (const id of ['profiler', 'chat-exact', 'buddy-reaction', 'openclaw']) {
      expect(resolveCallerPolicy(SAMPLES[id]).rateBucket).not.toBe('general');
    }
  });

  test('unknown callers retain the safe execution and rate defaults', () => {
    const stranger = 'some-new-tool-nobody-registered';
    expect(resolveCallerPolicy(stranger)).toBe(DEFAULT_POLICY);
    expect(resolveLane(stranger).name).toBe('automated');
    expect(DEFAULT_POLICY.rateBucket).toBe('general');
  });

  test.each([null, undefined, '', 123, {}])('resolves defensively for %p', (input) => {
    expect(resolveCallerPolicy(input)).toBe(DEFAULT_POLICY);
  });
});
