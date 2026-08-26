'use strict';

const {
  SCOPED_LANES,
  RETRYABLE_FAILURES,
  APPROVED_5XX,
  REFUSAL_REASONS,
  isEnabled,
  isCrossModelFallbackAllowed,
  classifyFailure,
  isRetryEligible,
  selectRetryCandidate,
  resolveRetryCandidates,
  buildDegradedState,
} = require('../../src/services/routing/degradedFallback');

const ORIGINAL_FLAG = process.env.DEGRADED_FALLBACK;
const enable = () => { process.env.DEGRADED_FALLBACK = 'true'; };
const disable = () => { delete process.env.DEGRADED_FALLBACK; };
afterEach(() => {
  if (ORIGINAL_FLAG === undefined) delete process.env.DEGRADED_FALLBACK;
  else process.env.DEGRADED_FALLBACK = ORIGINAL_FLAG;
});

/** An attempt that would be retried, so each test can violate exactly one invariant. */
function eligibleAttempt(overrides = {}) {
  return {
    lane: 'quick_chat',
    attempt: 1,
    streamStarted: false,
    failure: { kind: 'connection' },
    ...overrides,
  };
}

describe('invariant 1 — never retry after the first stream byte (0523)', () => {
  test('a started stream blocks the retry even when everything else is perfect', () => {
    enable();
    const result = isRetryEligible(eligibleAttempt({ streamStarted: true }));
    // Bytes cannot be un-sent. A retry would splice a second answer onto a
    // partial first one.
    expect(result).toMatchObject({
      eligible: false,
      reason: REFUSAL_REASONS.STREAM_ALREADY_STARTED,
    });
  });

  test('is checked before the feature flag, so it holds in every configuration', () => {
    disable();
    expect(isRetryEligible(eligibleAttempt({ streamStarted: true })).reason)
      .toBe(REFUSAL_REASONS.STREAM_ALREADY_STARTED);
    enable();
    expect(isRetryEligible(eligibleAttempt({ streamStarted: true })).reason)
      .toBe(REFUSAL_REASONS.STREAM_ALREADY_STARTED);
  });

  test('a timeout after streaming began is not a pre-response timeout', () => {
    expect(classifyFailure({ kind: 'timeout', streamStarted: true })).toBeNull();
    expect(classifyFailure({ kind: 'timeout', streamStarted: false }))
      .toBe(RETRYABLE_FAILURES.PRE_RESPONSE_TIMEOUT);
  });
});

describe('invariant 2 — never automatic cloud (0523)', () => {
  const failed = { model: 'local-a', hostUrl: 'http://a:11434' };

  test('cloud candidates are excluded from retry selection', () => {
    const { candidate } = selectRetryCandidate([
      { model: 'cloud-x', hostUrl: 'http://openrouter', cloud: true },
      { model: 'local-b', hostUrl: 'http://b:11434', cloud: false },
    ], failed);
    expect(candidate.model).toBe('local-b');
  });

  test('when only cloud remains the answer is refusal, not escalation', () => {
    const { candidate, reason } = selectRetryCandidate([
      { model: 'cloud-x', hostUrl: 'http://openrouter', cloud: true },
    ], failed);
    // A local failure must not silently become a paid, off-machine request.
    expect(candidate).toBeNull();
    expect(reason).toBe(REFUSAL_REASONS.CLOUD_NOT_AUTOMATIC);
  });

  test('the degraded state never reports an automatic cloud escalation', () => {
    const state = buildDegradedState(RETRYABLE_FAILURES.CONNECTION_FAILURE, {
      model: 'local-b', hostUrl: 'http://b:11434', cloud: false,
    });
    expect(state.cloudEscalated).toBe(false);
  });

  test('no candidates at all is distinguished from cloud-only', () => {
    expect(selectRetryCandidate([], failed).reason).toBe(REFUSAL_REASONS.NO_LOCAL_CANDIDATE);
  });
});

describe('invariant 3 — exactly one retry (0523)', () => {
  test('the second attempt is refused', () => {
    enable();
    expect(isRetryEligible(eligibleAttempt({ attempt: 2 })).reason)
      .toBe(REFUSAL_REASONS.ALREADY_RETRIED);
    expect(isRetryEligible(eligibleAttempt({ attempt: 7 })).reason)
      .toBe(REFUSAL_REASONS.ALREADY_RETRIED);
  });

  test('the first attempt is permitted', () => {
    enable();
    expect(isRetryEligible(eligibleAttempt({ attempt: 1 })).eligible).toBe(true);
  });

  test('the candidate that just failed is never chosen again', () => {
    const failed = { model: 'm', hostUrl: 'http://a:11434' };
    const { candidate } = selectRetryCandidate([
      { model: 'm', hostUrl: 'http://a:11434', cloud: false },
      { model: 'm', hostUrl: 'http://b:11434', cloud: false },
    ], failed);
    expect(candidate.hostUrl).toBe('http://b:11434');
  });

  test('the same model on a different host is a legitimate retry target', () => {
    const { candidate } = selectRetryCandidate(
      [{ model: 'm', hostUrl: 'http://b:11434', cloud: false }],
      { model: 'm', hostUrl: 'http://a:11434' }
    );
    expect(candidate).not.toBeNull();
  });
});

describe('live candidate boundary — resolver survivors only (0523)', () => {
  const candidate = (host, overrides = {}) => ({
    model: 'm',
    hostUrl: `http://${host}:11434`,
    cloud: false,
    host: { key: host, tier: host, online: true, benchmarkClaimed: false },
    artifact: { resident: true },
    ...overrides,
  });

  test('offline and benchmark-claimed hosts cannot reach retry selection', () => {
    const result = resolveRetryCandidates([
      candidate('primary', { host: { key: 'primary', tier: 'primary', online: false } }),
      candidate('secondary', { host: { key: 'secondary', tier: 'secondary', online: true, benchmarkClaimed: true } }),
    ]);
    expect(result.candidates).toEqual([]);
  });

  test('tertiary and unknown host rows fail closed', () => {
    const result = resolveRetryCandidates([
      candidate('tertiary'),
      candidate('mystery'),
      candidate('secondary'),
    ]);
    expect(result.candidates.map((entry) => entry.host.key)).toEqual(['secondary']);
  });

  test('survivors are deterministically scored before the retry picks the first one', () => {
    const result = resolveRetryCandidates([
      candidate('secondary', { artifact: { resident: false } }),
      candidate('primary', { artifact: { resident: true } }),
    ]);
    expect(result.candidates.map((entry) => entry.host.key)).toEqual(['primary', 'secondary']);
  });
});

describe('invariant 4 — three lanes only (0523)', () => {
  test.each(SCOPED_LANES)('%s is in scope', (lane) => {
    enable();
    expect(isRetryEligible(eligibleAttempt({ lane })).eligible).toBe(true);
  });

  test.each(['benchmark_batch', 'deep_reasoning', 'code_generation', 'daily_operator', undefined])(
    '%s is out of scope — a long or batch generation must not silently double its cost',
    (lane) => {
      enable();
      expect(isRetryEligible(eligibleAttempt({ lane })).reason)
        .toBe(REFUSAL_REASONS.LANE_OUT_OF_SCOPE);
    }
  );
});

describe('explicit cross-model policy', () => {
  test('an unscoped proxy remains ineligible without explicit opt-in', () => {
    enable();
    expect(isRetryEligible(eligibleAttempt({
      lane: null,
      routeManaged: true,
      crossModelOptIn: false,
    }))).toMatchObject({
      eligible: false,
      reason: REFUSAL_REASONS.LANE_OUT_OF_SCOPE,
    });
  });

  test('an opted-in route-managed request may enter qualified candidate selection', () => {
    enable();
    const attempt = eligibleAttempt({
      lane: null,
      routeManaged: true,
      crossModelOptIn: true,
    });
    expect(isCrossModelFallbackAllowed(attempt)).toBe(true);
    expect(isRetryEligible(attempt)).toMatchObject({
      eligible: true,
      failureClass: RETRYABLE_FAILURES.CONNECTION_FAILURE,
    });
  });

  test('opt-in cannot override direct or explicit-host routing ownership', () => {
    enable();
    const attempt = eligibleAttempt({
      lane: null,
      routeManaged: false,
      crossModelOptIn: true,
    });
    expect(isCrossModelFallbackAllowed(attempt)).toBe(false);
    expect(isRetryEligible(attempt)).toMatchObject({
      eligible: false,
      reason: REFUSAL_REASONS.CROSS_MODEL_ROUTE_NOT_MANAGED,
    });
  });
});

describe('fault injection — failure classification (0523)', () => {
  test.each([
    ['connection refused', { kind: 'connection' }, RETRYABLE_FAILURES.CONNECTION_FAILURE],
    ['pre-response timeout', { kind: 'timeout', streamStarted: false }, RETRYABLE_FAILURES.PRE_RESPONSE_TIMEOUT],
    ['502 bad gateway', { kind: 'http', status: 502 }, RETRYABLE_FAILURES.UPSTREAM_UNAVAILABLE],
    ['503 unavailable', { kind: 'http', status: 503 }, RETRYABLE_FAILURES.UPSTREAM_UNAVAILABLE],
    ['504 gateway timeout', { kind: 'http', status: 504 }, RETRYABLE_FAILURES.UPSTREAM_UNAVAILABLE],
    ['verified missing model', { kind: 'missing_artifact', verified: true }, RETRYABLE_FAILURES.MISSING_ARTIFACT_VERIFIED],
  ])('%s is retryable', (_label, failure, expected) => {
    expect(classifyFailure(failure)).toBe(expected);
  });

  test('500 is NOT retryable', () => {
    // The generic "something went wrong inside" is usually a real generation
    // error — bad options, an OOM on this exact prompt — which reproduces
    // identically elsewhere. Retrying only doubles the wait to the same failure.
    expect(classifyFailure({ kind: 'http', status: 500 })).toBeNull();
    expect(APPROVED_5XX).not.toContain(500);

    enable();
    expect(isRetryEligible(eligibleAttempt({ failure: { kind: 'http', status: 500 } })).reason)
      .toBe(REFUSAL_REASONS.STATUS_NOT_APPROVED);
  });

  test('an unverified missing artifact is not evidence', () => {
    // Guessing here would retry away from a host that actually had the model,
    // which is how a fallback path quietly becomes the normal path.
    expect(classifyFailure({ kind: 'missing_artifact', verified: false })).toBeNull();
    expect(classifyFailure({ kind: 'missing_artifact' })).toBeNull();

    enable();
    expect(isRetryEligible(eligibleAttempt({ failure: { kind: 'missing_artifact' } })).reason)
      .toBe(REFUSAL_REASONS.ARTIFACT_NOT_VERIFIED);
  });

  test.each([
    ['4xx', { kind: 'http', status: 400 }],
    ['malformed request', { kind: 'invalid_request' }],
    ['unknown', {}],
    ['nothing', undefined],
  ])('%s is not retryable — it would fail identically on another host', (_label, failure) => {
    enable();
    expect(isRetryEligible(eligibleAttempt({ failure })).eligible).toBe(false);
  });
});

describe('flag rollback restores exact prior behaviour (0523)', () => {
  test('disabled refuses every retry, whatever the failure', () => {
    disable();
    expect(isEnabled()).toBe(false);
    for (const failure of [
      { kind: 'connection' },
      { kind: 'timeout', streamStarted: false },
      { kind: 'http', status: 503 },
      { kind: 'missing_artifact', verified: true },
    ]) {
      expect(isRetryEligible(eligibleAttempt({ failure })))
        .toMatchObject({ eligible: false, reason: REFUSAL_REASONS.DISABLED });
    }
  });

  test('only the literal "true" enables it', () => {
    for (const value of ['1', 'yes', 'on', 'TRUE ', '']) {
      process.env.DEGRADED_FALLBACK = value;
      expect(isEnabled()).toBe(false);
    }
    process.env.DEGRADED_FALLBACK = 'true';
    expect(isEnabled()).toBe(true);
  });
});

describe('degraded state (0523)', () => {
  test('carries a user cue, the retry target, and recalculated pin options', () => {
    const state = buildDegradedState(RETRYABLE_FAILURES.UPSTREAM_UNAVAILABLE, {
      model: 'ax/gemma4:e4b',
      hostUrl: 'http://192.0.2.12:11434',
      host: { key: 'secondary' },
      artifact: { pinOptions: { num_ctx: 8192 } },
    });

    expect(state).toMatchObject({
      degraded: true,
      degradedReason: 'upstream_unavailable',
      userCue: 'mode dégradé',
      cloudEscalated: false,
    });
    expect(state.retriedTo).toEqual({
      model: 'ax/gemma4:e4b', hostUrl: 'http://192.0.2.12:11434', host: 'secondary',
    });
    // Recalculated from the retry target — carrying the dead host's pin context
    // over is how a request asks for a window the new host never loaded.
    expect(state.pinOptions).toEqual({ num_ctx: 8192 });
  });

  test('labels a model substitution with requested, primary, and actual targets', () => {
    const state = buildDegradedState(RETRYABLE_FAILURES.CONNECTION_FAILURE, {
      model: 'small-model:latest',
      hostUrl: 'http://secondary:11434',
      host: { key: 'secondary' },
      artifact: { pinOptions: { num_ctx: 8192 } },
    }, {
      requestedModel: 'large-model:latest',
      failedCandidate: {
        model: 'large-model:latest',
        hostUrl: 'http://primary:11434',
      },
    });

    expect(state).toMatchObject({
      fallbackType: 'cross_model',
      selectionPolicy: 'operator_pinned_exact_artifact',
      modelChanged: true,
      requested: { model: 'large-model:latest' },
      primary: { model: 'large-model:latest', hostUrl: 'http://primary:11434' },
      actual: {
        model: 'small-model:latest',
        hostUrl: 'http://secondary:11434',
        host: 'secondary',
      },
    });
  });

  test('a refused retry still produces a reportable degraded state', () => {
    const state = buildDegradedState(RETRYABLE_FAILURES.CONNECTION_FAILURE, null);
    expect(state.retriedTo).toBeNull();
    expect(state.pinOptions).toBeNull();
    expect(state.degraded).toBe(true);
  });
});
