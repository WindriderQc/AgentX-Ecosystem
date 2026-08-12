'use strict';

/**
 * Unit tests for the inference lane policy module (task 0168).
 *
 * Covers:
 *   - resolveLane() classification for direct / interactive / automated callers
 *   - Unknown / undefined caller falls through to automated
 *   - Probe cache hit/miss + TTL expiry behavior
 */

const lanePolicy = require('../../src/services/inferenceLanePolicy');

describe('inferenceLanePolicy.resolveLane', () => {
  it('classifies benchmark-batch-* as the direct lane', () => {
    const result = lanePolicy.resolveLane('benchmark-batch-abc123');
    expect(result.name).toBe('direct');
    expect(result.policy.admit).toBe(false);
    expect(result.policy.probe).toBe(false);
    expect(result.policy.recordInferenceSync).toBe(false);
  });

  it('classifies benchmark-warmup as the direct lane', () => {
    const result = lanePolicy.resolveLane('benchmark-warmup');
    expect(result.name).toBe('direct');
    expect(result.policy.admit).toBe(false);
  });

  it('classifies benchmark-host-test-* as the direct lane', () => {
    const result = lanePolicy.resolveLane('benchmark-host-test-gemma4:26b');
    expect(result.name).toBe('direct');
  });

  it('classifies benchmark-decomposed-judge as the direct lane (task 0173)', () => {
    // Judge calls run on dedicated judge hosts with no contention; full
    // safe-path probe + gate + Mongo + sync telemetry was wasted overhead
    // (~458 calls per 59-prompt batch). Direct lane removes it.
    const result = lanePolicy.resolveLane('benchmark-decomposed-judge');
    expect(result.name).toBe('direct');
    expect(result.policy.recordInferenceSync).toBe(false);
    expect(result.policy.admit).toBe(false);
  });

  it('does NOT match benchmark-decomposed-judge-suffix (rule is anchored)', () => {
    const result = lanePolicy.resolveLane('benchmark-decomposed-judge-foo');
    expect(result.name).toBe('automated');
  });

  it('classifies "chat" as the interactive lane (admit kept, recordInference async)', () => {
    const result = lanePolicy.resolveLane('chat');
    expect(result.name).toBe('interactive');
    // Load-bearing: interactive lane MUST keep admission so chat/buddy
    // cannot cut in line on a cron job mid-call.
    expect(result.policy.admit).toBe(true);
    expect(result.policy.probe).toBe(true);
    expect(result.policy.recordInferenceSync).toBe(false);
    expect(result.policy.alert).toBe(true);
  });

  it('classifies buddy/* and nerve-center-* and alerts-* as interactive', () => {
    expect(lanePolicy.resolveLane('buddy/react').name).toBe('interactive');
    expect(lanePolicy.resolveLane('nestor/desktop/chat').name).toBe('interactive');
    expect(lanePolicy.resolveLane('nestor/lens/react').name).toBe('interactive');
    expect(lanePolicy.resolveLane('nerve-center-trigger').name).toBe('interactive');
    expect(lanePolicy.resolveLane('alerts-evaluator').name).toBe('interactive');
  });

  it('classifies unknown future cron caller as automated (default)', () => {
    const result = lanePolicy.resolveLane('some-future-cron');
    expect(result.name).toBe('automated');
    expect(result.policy.admit).toBe(true);
    expect(result.policy.probe).toBe(true);
    expect(result.policy.recordInferenceSync).toBe(true);
    expect(result.policy.alert).toBe(true);
  });

  it('classifies undefined / null / empty callerDetail as automated (safe default)', () => {
    expect(lanePolicy.resolveLane(undefined).name).toBe('automated');
    expect(lanePolicy.resolveLane(null).name).toBe('automated');
    expect(lanePolicy.resolveLane('').name).toBe('automated');
  });

  // Task 0169 — actual strings the codebase sends after the chat cutover.
  // Locks in the lane resolution for the values that chatService and
  // chatServiceStream now produce.
  it('classifies real chat callerDetail values (task 0169)', () => {
    expect(lanePolicy.resolveLane('chat-user-123').name).toBe('interactive');
    expect(lanePolicy.resolveLane('chat-anon').name).toBe('interactive');
    expect(lanePolicy.resolveLane('chat').name).toBe('interactive');
    expect(lanePolicy.resolveLane('buddy/react').name).toBe('interactive');
    expect(lanePolicy.resolveLane('nerve-center-rag').name).toBe('interactive');
    expect(lanePolicy.resolveLane('alerts-evaluator').name).toBe('interactive');
  });
});

describe('inferenceLanePolicy probe cache', () => {
  beforeEach(() => {
    lanePolicy._resetProbeCacheForTests();
  });

  it('returns null on cold lookup, then a cached value within the TTL window', () => {
    const host = 'http://h1';
    const model = 'gemma4:26b';

    expect(lanePolicy.getProbe(host, model)).toBeNull();

    lanePolicy.setProbe(host, model, 'ax/gemma4:26b');
    // Second call within TTL — should hit cache (no fetch needed).
    expect(lanePolicy.getProbe(host, model)).toBe('ax/gemma4:26b');
  });

  it('expires entries past PROBE_CACHE_TTL_MS and forces refetch', () => {
    const host = 'http://h1';
    const model = 'gemma4:26b';

    const t0 = 1_000_000;
    lanePolicy.setProbe(host, model, 'ax/gemma4:26b', t0);
    // Just before TTL expiry → still hits cache.
    expect(lanePolicy.getProbe(host, model, t0 + lanePolicy.PROBE_CACHE_TTL_MS - 1))
      .toBe('ax/gemma4:26b');
    // Past TTL → cache miss, caller must refetch.
    expect(lanePolicy.getProbe(host, model, t0 + lanePolicy.PROBE_CACHE_TTL_MS + 1))
      .toBeNull();
  });

  it('keys cache by (host, model) — different hosts do not share state', () => {
    lanePolicy.setProbe('http://h1', 'gemma4:26b', 'ax/gemma4:26b');
    expect(lanePolicy.getProbe('http://h2', 'gemma4:26b')).toBeNull();
    expect(lanePolicy.getProbe('http://h1', 'gemma4:26b')).toBe('ax/gemma4:26b');
  });
});
