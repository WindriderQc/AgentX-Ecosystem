/**
 * Unit test for benchmark → Buddy surface events (task 0266).
 *
 * Asserts that each benchmark lifecycle point emits the mapped intent +
 * surfaceScope:'benchmark', and that the quiet-during-critical rule (silent
 * during judge/scoring unless warning/blocked) holds. The buddy event client
 * is mocked so no real network call is made.
 */

jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockEmitBuddyEvent = jest.fn();
jest.mock('../../../src/clients/buddyEventClient', () => ({
  emitBuddyEvent: (...args) => mockEmitBuddyEvent(...args),
}));

const buddySurface = require('../../../src/services/benchmark/buddySurfaceEvents');

// Decode the positional emitBuddyEvent(type, class, summary, significance, opts)
// signature into an object for readable assertions.
function lastEmit() {
  const call = mockEmitBuddyEvent.mock.calls[mockEmitBuddyEvent.mock.calls.length - 1];
  if (!call) return null;
  const [type, eventClass, summary, significance, opts] = call;
  return { type, eventClass, summary, significance, opts };
}

function allEmits() {
  return mockEmitBuddyEvent.mock.calls.map(([type, eventClass, summary, significance, opts]) => ({
    type, eventClass, summary, significance, opts,
  }));
}

beforeEach(() => {
  jest.clearAllMocks();
  buddySurface._resetJudgePhase();
});

describe('buddySurfaceEvents lifecycle → intent/scope mapping', () => {
  // [lifecycle point, expected type, expected intent, expected significance]
  const cases = [
    ['preflight_start',   'preflight_start',   'watching',   'low'],
    ['preflight_blocked', 'preflight_blocked', 'blocked',    'high'],
    ['preflight_ok',      'preflight_ok',      'suggesting', 'normal'],
    ['run_phase',         'run_phase',         'watching',   'low'],
    ['judge_start',       'judge_start',       'watching',   'low'],
    ['judge_done',        'judge_done',        'watching',   'low'],
    ['run_blocked',       'run_blocked',       'blocked',    'high'],
    ['run_warning',       'run_blocked',       'warning',    'high'],
  ];

  it.each(cases)(
    "emits '%s' as type=%s intent=%s with surfaceScope=benchmark",
    (point, expectedType, expectedIntent, expectedSignificance) => {
      const returned = buddySurface.emitLifecycle(point, `summary for ${point}`);

      expect(mockEmitBuddyEvent).toHaveBeenCalledTimes(1);
      const emit = lastEmit();
      expect(emit.type).toBe(expectedType);
      expect(emit.eventClass).toBe('benchmark');
      expect(emit.significance).toBe(expectedSignificance);
      expect(emit.opts).toEqual({ intent: expectedIntent, surfaceScope: 'benchmark' });
      // emitLifecycle returns the emitted intent for callers/tests.
      expect(returned).toBe(expectedIntent);
    }
  );

  it('every lifecycle point carries surfaceScope benchmark', () => {
    for (const key of Object.keys(buddySurface.LIFECYCLE)) {
      mockEmitBuddyEvent.mockClear();
      buddySurface._resetJudgePhase();
      buddySurface.emitLifecycle(key, 'x');
      // run_warning is suppressed only mid-critical; here no phase is active so all fire.
      expect(lastEmit().opts.surfaceScope).toBe('benchmark');
    }
  });

  it('falls back to the type as summary when none is provided', () => {
    buddySurface.emitLifecycle('judge_start');
    expect(lastEmit().summary).toBe('judge_start');
  });

  it('is a no-op for an unknown lifecycle point', () => {
    const returned = buddySurface.emitLifecycle('not_a_real_point', 'nope');
    expect(mockEmitBuddyEvent).not.toHaveBeenCalled();
    expect(returned).toBeNull();
  });
});

describe('quiet-during-critical (silent during judge/scoring)', () => {
  it('suppresses suggesting/idle intents while a judge phase is active', () => {
    buddySurface.beginJudgePhase();
    expect(buddySurface.isJudgePhaseActive()).toBe(true);

    // preflight_ok maps to suggesting → must be suppressed mid-critical.
    const returned = buddySurface.emitLifecycle('preflight_ok', 'should be silent');
    expect(returned).toBeNull();
    expect(mockEmitBuddyEvent).not.toHaveBeenCalled();
  });

  it('still allows watching intents (terse) while a judge phase is active', () => {
    buddySurface.beginJudgePhase();
    const returned = buddySurface.emitLifecycle('judge_start', 'judging');
    expect(returned).toBe('watching');
    expect(mockEmitBuddyEvent).toHaveBeenCalledTimes(1);
    expect(lastEmit().opts.intent).toBe('watching');
  });

  it('still fires warning and blocked while a judge phase is active (safety invariant)', () => {
    buddySurface.beginJudgePhase();

    const warned = buddySurface.emitLifecycle('run_warning', 'host failure mid-judge');
    const blocked = buddySurface.emitLifecycle('run_blocked', 'host down mid-judge');

    expect(warned).toBe('warning');
    expect(blocked).toBe('blocked');
    const intents = allEmits().map((e) => e.opts.intent);
    expect(intents).toEqual(['warning', 'blocked']);
  });

  it('honors an explicit duringJudge flag even if the module flag is unset', () => {
    expect(buddySurface.isJudgePhaseActive()).toBe(false);
    const returned = buddySurface.emitLifecycle('preflight_ok', 'silent', { duringJudge: true });
    expect(returned).toBeNull();
    expect(mockEmitBuddyEvent).not.toHaveBeenCalled();
  });

  it('re-enables suggesting once the judge phase ends', () => {
    buddySurface.beginJudgePhase();
    buddySurface.endJudgePhase();
    expect(buddySurface.isJudgePhaseActive()).toBe(false);

    const returned = buddySurface.emitLifecycle('preflight_ok', 'now allowed');
    expect(returned).toBe('suggesting');
    expect(mockEmitBuddyEvent).toHaveBeenCalledTimes(1);
  });

  it('balances nested judge phases via a depth counter', () => {
    buddySurface.beginJudgePhase();
    buddySurface.beginJudgePhase();
    buddySurface.endJudgePhase();
    // Still critical after one of two ends.
    expect(buddySurface.isJudgePhaseActive()).toBe(true);
    expect(buddySurface.emitLifecycle('preflight_ok', 'still silent')).toBeNull();

    buddySurface.endJudgePhase();
    expect(buddySurface.isJudgePhaseActive()).toBe(false);
    expect(buddySurface.emitLifecycle('preflight_ok', 'allowed now')).toBe('suggesting');
  });

  it('never lets endJudgePhase drop the depth below zero', () => {
    buddySurface.endJudgePhase();
    buddySurface.endJudgePhase();
    expect(buddySurface.isJudgePhaseActive()).toBe(false);
    // A single begin should still flip to critical.
    buddySurface.beginJudgePhase();
    expect(buddySurface.isJudgePhaseActive()).toBe(true);
  });
});

describe('fire-and-forget resilience (bus down / failures never break a batch)', () => {
  it('does not throw when the underlying emit throws (e.g. bus endpoint down)', () => {
    mockEmitBuddyEvent.mockImplementation(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:3080');
    });
    expect(() => buddySurface.emitLifecycle('run_phase', 'running')).not.toThrow();
    // The mapping still attempted the emit exactly once before swallowing.
    expect(mockEmitBuddyEvent).toHaveBeenCalledTimes(1);
  });

  it('returns synchronously (does not await the emit)', () => {
    // emitBuddyEvent is itself fire-and-forget; emitLifecycle must not return a promise.
    const result = buddySurface.emitLifecycle('judge_start', 'judging');
    expect(result).not.toBeInstanceOf(Promise);
  });
});
