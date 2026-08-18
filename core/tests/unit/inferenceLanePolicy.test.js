'use strict';

const lanePolicy = require('../../src/services/inferenceLanePolicy');

describe('inferenceLanePolicy', () => {
  it('preserves the direct benchmark lane without artifact rewriting hooks', () => {
    const resolved = lanePolicy.resolveLane('benchmark-batch-abc123');
    expect(resolved.name).toBe('direct');
    expect(resolved.policy).toMatchObject({ route: false, admit: false, recordInferenceSync: false });
    expect(resolved.policy).not.toHaveProperty('probe');
    expect(resolved.policy).not.toHaveProperty('adaptation');
  });

  it.each([
    ['benchmark-warmup', 'direct'],
    ['benchmark-host-test-primary', 'direct'],
    ['benchmark-decomposed-judge', 'direct'],
    ['profiler-host-alpha', 'direct'],
    ['chat', 'interactive'],
    ['chat-user-123', 'interactive'],
    ['buddy/react', 'interactive'],
    ['buddy-reaction', 'interactive'],
    ['nestor/desktop/chat', 'interactive'],
    ['nerve-center-rag', 'interactive'],
    ['alerts-evaluator', 'interactive'],
    ['openclaw-ollama', 'automated'],
    ['some-future-cron', 'automated'],
  ])('classifies %s as %s', (caller, expectedLane) => {
    expect(lanePolicy.resolveLane(caller).name).toBe(expectedLane);
  });

  it('does not overmatch the anchored decomposed judge caller', () => {
    expect(lanePolicy.resolveLane('benchmark-decomposed-judge-suffix').name).toBe('automated');
  });

  it.each([undefined, null, ''])('fails closed for missing callerDetail %p', (caller) => {
    const resolved = lanePolicy.resolveLane(caller);
    expect(resolved.name).toBe('automated');
    expect(resolved.policy).toMatchObject({ route: true, admit: true, recordInferenceSync: true });
  });

  it('uses an authenticated policy supplied by the request boundary', () => {
    const resolved = lanePolicy.resolvePolicyLane({ lane: 'direct', artifactPolicy: 'exact' });
    expect(resolved.name).toBe('direct');
    expect(resolved.policy.admit).toBe(false);
  });

  it('fails closed when the authenticated policy is absent or invalid', () => {
    expect(lanePolicy.resolvePolicyLane().name).toBe('automated');
    expect(lanePolicy.resolvePolicyLane({ lane: 'invented' }).name).toBe('automated');
  });

  it('exports no model-variant probe cache', () => {
    expect(lanePolicy.getProbe).toBeUndefined();
    expect(lanePolicy.setProbe).toBeUndefined();
    expect(lanePolicy.PROBE_CACHE_TTL_MS).toBeUndefined();
  });
});
