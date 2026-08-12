'use strict';

const {
  HARD_FILTERS,
  scoreCandidates,
  resolveRoute,
  isShadowEnabled,
  compareToActual,
} = require('../../src/services/routing/routeResolver');
const { REJECTION_REASONS } = require('../../src/services/routing/routeDecision');

/** A candidate that passes every hard filter, so each test can spoil exactly one thing. */
function healthy(overrides = {}) {
  return {
    model: 'ax/gemma4:26b-a4b-it-qat',
    hostUrl: 'http://192.0.2.199:11434',
    cloud: false,
    host: {
      key: 'primary', tier: 'primary', online: true,
      draining: false, benchmarkClaimed: false, freeVramMiB: 40000,
    },
    artifact: {
      installed: true, resident: true, pinned: true,
      qualified: true, requiredVramMiB: 16000, maxContextTokens: 83558,
    },
    ...overrides,
  };
}

const CONTEXT = { cloudEligible: true, requiredContextTokens: 8192, caller: 'chat' };

describe('hard filters exclude the impossible (0522)', () => {
  test.each([
    ['unconfigured host', { hostUrl: null }, REJECTION_REASONS.HOST_UNCONFIGURED],
    ['offline host', { host: { ...healthy().host, online: false } }, REJECTION_REASONS.HOST_OFFLINE],
    ['draining host', { host: { ...healthy().host, draining: true } }, REJECTION_REASONS.HOST_DRAINING],
    ['claimed host', { host: { ...healthy().host, benchmarkClaimed: true } }, REJECTION_REASONS.BENCHMARK_CLAIMED],
    ['missing artifact', { artifact: { ...healthy().artifact, installed: false } }, REJECTION_REASONS.MODEL_NOT_INSTALLED],
    ['disqualified artifact', { artifact: { ...healthy().artifact, qualified: false } }, REJECTION_REASONS.CAPABILITY_UNQUALIFIED],
    ['not enough VRAM', { artifact: { ...healthy().artifact, requiredVramMiB: 99999 } }, REJECTION_REASONS.INSUFFICIENT_VRAM],
    ['context too small', { artifact: { ...healthy().artifact, maxContextTokens: 4096 } }, REJECTION_REASONS.CONTEXT_TOO_SMALL],
  ])('%s is rejected with its own reason code', (_label, spoil, reason) => {
    const { selected, rejected } = resolveRoute(
      { candidates: [healthy(spoil)] }, CONTEXT
    );
    expect(selected).toBeNull();
    expect(rejected).toEqual([expect.objectContaining({ reason })]);
  });

  test('cloud candidates are excluded when the caller is not cloud-eligible', () => {
    const cloud = healthy({ cloud: true, model: 'openrouter/z-ai/glm-5.2' });
    const { selected, rejected } = resolveRoute(
      { candidates: [cloud] }, { ...CONTEXT, cloudEligible: false }
    );
    expect(selected).toBeNull();
    expect(rejected[0].reason).toBe(REJECTION_REASONS.POLICY_EXCLUDED);
  });

  test('unknown facts are not treated as failure', () => {
    // A fresh host with no profile must not be filtered out — "not profiled"
    // is not evidence of unfitness, and treating it as such would empty the
    // candidate set exactly when a new host is added.
    const unprofiled = healthy({
      artifact: { installed: true, resident: false, pinned: false },
    });
    const { selected } = resolveRoute({ candidates: [unprofiled] }, CONTEXT);
    expect(selected).not.toBeNull();
  });

  test('a candidate failing several filters reports the most fundamental one', () => {
    const doomed = healthy({
      host: { ...healthy().host, online: false, benchmarkClaimed: true },
      artifact: { ...healthy().artifact, installed: false },
    });
    const { rejected } = resolveRoute({ candidates: [doomed] }, CONTEXT);
    // "Host offline" explains more than "model not installed" on a host that
    // is not there at all.
    expect(rejected[0].reason).toBe(REJECTION_REASONS.HOST_OFFLINE);
  });

  test('every hard filter declares a reason from the shared enum', () => {
    const valid = new Set(Object.values(REJECTION_REASONS));
    for (const filter of HARD_FILTERS) {
      expect(valid.has(filter.reason)).toBe(true);
      expect(typeof filter.exclude).toBe('function');
    }
  });
});

describe('never returns a failed candidate (0522)', () => {
  test('returns null with reasons when everything is filtered', () => {
    const { selected, rejected, scored } = resolveRoute({
      candidates: [
        healthy({ host: { ...healthy().host, online: false } }),
        healthy({ artifact: { ...healthy().artifact, installed: false } }),
      ],
    }, CONTEXT);

    // There is no "best of the impossible".
    expect(selected).toBeNull();
    expect(scored).toEqual([]);
    expect(rejected).toHaveLength(2);
  });

  test('an empty candidate set is a null route, not a crash', () => {
    expect(resolveRoute({ candidates: [] }, CONTEXT).selected).toBeNull();
    expect(resolveRoute({}, CONTEXT).selected).toBeNull();
  });

  test('the selected candidate is always one that survived filtering', () => {
    const good = healthy();
    const bad = healthy({ model: 'ghost', host: { ...healthy().host, online: false } });
    const { selected, rejected } = resolveRoute({ candidates: [bad, good] }, CONTEXT);

    expect(selected.model).toBe(good.model);
    expect(rejected.map((r) => r.model)).toEqual(['ghost']);
  });
});

describe('single scoring pass (0522)', () => {
  test('prefers a resident model over a cold one', () => {
    const cold = healthy({ hostUrl: 'http://cold:11434', artifact: { ...healthy().artifact, resident: false, pinned: false } });
    const warm = healthy();
    const { selected } = resolveRoute({ candidates: [cold, warm] }, CONTEXT);
    // Residency dominates: a cold start means a runner rebuild and a stall.
    expect(selected.hostUrl).toBe(warm.hostUrl);
  });

  test('scores are explainable — every contribution is itemized', () => {
    const [scored] = scoreCandidates([healthy()], CONTEXT);
    expect(scored.scoreBreakdown).toMatchObject({
      resident: expect.any(Number),
      pinned: expect.any(Number),
      hostTier: expect.any(Number),
      local: expect.any(Number),
    });
    const sum = Object.values(scored.scoreBreakdown).reduce((a, b) => a + b, 0);
    expect(scored.score).toBe(sum);
  });

  test('does not mutate the candidates it scores', () => {
    const candidate = healthy();
    const snapshot = JSON.stringify(candidate);
    scoreCandidates([candidate], CONTEXT);
    expect(JSON.stringify(candidate)).toBe(snapshot);
  });

  test('equal scores break ties deterministically, not by input order', () => {
    // Two identically-configured processes must route the same way, or the
    // difference is indistinguishable from a real routing bug.
    const a = healthy({ model: 'aaa', hostUrl: 'http://a:11434' });
    const b = healthy({ model: 'bbb', hostUrl: 'http://b:11434' });

    const forward = resolveRoute({ candidates: [a, b] }, CONTEXT).selected;
    const reversed = resolveRoute({ candidates: [b, a] }, CONTEXT).selected;
    expect(forward.model).toBe(reversed.model);
  });
});

describe('shadow mode is inert by default (0522)', () => {
  const original = process.env.ROUTE_RESOLVER_SHADOW;
  afterEach(() => {
    if (original === undefined) delete process.env.ROUTE_RESOLVER_SHADOW;
    else process.env.ROUTE_RESOLVER_SHADOW = original;
  });

  test('is off unless explicitly enabled', () => {
    delete process.env.ROUTE_RESOLVER_SHADOW;
    expect(isShadowEnabled()).toBe(false);
    process.env.ROUTE_RESOLVER_SHADOW = 'yes';
    expect(isShadowEnabled()).toBe(false); // only the literal "true"
    process.env.ROUTE_RESOLVER_SHADOW = 'true';
    expect(isShadowEnabled()).toBe(true);
  });

  test('emits a RouteDecision v1 so shadow and production compare field by field', () => {
    const { decision } = resolveRoute(
      { candidates: [healthy()], taskType: 'daily_operator' },
      { ...CONTEXT, correlationId: 'corr-shadow-1' }
    );
    expect(decision.decisionVersion).toBe(1);
    expect(decision.correlationId).toBe('corr-shadow-1');
    expect(decision.selected.model).toBe(healthy().model);
    expect(decision.intent.taskType).toBe('daily_operator');
  });
});

describe('shadow-vs-production comparison (0522)', () => {
  const shadow = { selected: { model: 'm1', hostUrl: 'http://h1:11434' } };

  test('agreement is a clean match', () => {
    expect(compareToActual(shadow, { model: 'm1', hostUrl: 'http://h1:11434' }))
      .toEqual({ match: true, mismatches: [] });
  });

  test('reason-codes each dimension separately', () => {
    expect(compareToActual(shadow, { model: 'm2', hostUrl: 'http://h1:11434' }).mismatches)
      .toEqual(['model_mismatch']);
    expect(compareToActual(shadow, { model: 'm1', hostUrl: 'http://h2:11434' }).mismatches)
      .toEqual(['host_mismatch']);
    expect(compareToActual(shadow, { model: 'm2', hostUrl: 'http://h2:11434' }).mismatches)
      .toEqual(['model_mismatch', 'host_mismatch']);
  });

  test('declining to route where production succeeded is its own signal', () => {
    // The one mismatch that would break traffic if promoted — it must never
    // look like a routine host disagreement.
    expect(compareToActual({ selected: null }, { model: 'm1' }))
      .toEqual({ match: false, mismatches: ['no_shadow_candidate'] });
  });
});
