'use strict';

jest.mock('../../config/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const breaker = require('../../src/helpers/circuitBreaker');

beforeEach(() => {
  breaker.resetAll();
  jest.clearAllMocks();
});

describe('circuitBreaker', () => {
  const HOST = 'http://192.0.2.66:11434';

  it('starts in CLOSED state and allows requests', () => {
    const result = breaker.canRequest(HOST);
    expect(result.allowed).toBe(true);
    expect(result.state).toBe(breaker.CLOSED);
  });

  it('stays CLOSED after 1-2 failures', () => {
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    const result = breaker.canRequest(HOST);
    expect(result.allowed).toBe(true);
    expect(result.state).toBe(breaker.CLOSED);
  });

  it('opens after 3 consecutive failures', () => {
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);

    const result = breaker.canRequest(HOST);
    expect(result.allowed).toBe(false);
    expect(result.state).toBe(breaker.OPEN);
    expect(result.reason).toMatch(/circuit breaker open/i);
  });

  it('resets to CLOSED on success', () => {
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    breaker.recordSuccess(HOST);

    const state = breaker.getState(HOST);
    expect(state.failures).toBe(0);
    expect(state.state).toBe(breaker.CLOSED);
  });

  it('transitions from OPEN to HALF_OPEN after recovery period', () => {
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);

    // Manually backdating lastFailure to simulate recovery period elapsed
    const state = breaker.getState(HOST);
    expect(state.state).toBe(breaker.OPEN);

    // Simulate passage of time by manipulating the internal state
    // We access _getOrCreate indirectly via getState, then modify via recording
    // Instead: use Date.now mock
    const realNow = Date.now;
    Date.now = () => realNow() + 61000; // 61 seconds in the future

    const result = breaker.canRequest(HOST);
    expect(result.allowed).toBe(true);
    expect(result.state).toBe(breaker.HALF_OPEN);

    Date.now = realNow;
  });

  it('returns to OPEN from HALF_OPEN on failure', () => {
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);

    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    breaker.canRequest(HOST); // transitions to HALF_OPEN
    Date.now = realNow;

    breaker.recordFailure(HOST);
    const state = breaker.getState(HOST);
    expect(state.state).toBe(breaker.OPEN);
  });

  it('returns to CLOSED from HALF_OPEN on success', () => {
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);

    const realNow = Date.now;
    Date.now = () => realNow() + 61000;
    breaker.canRequest(HOST); // transitions to HALF_OPEN
    Date.now = realNow;

    breaker.recordSuccess(HOST);
    const state = breaker.getState(HOST);
    expect(state.state).toBe(breaker.CLOSED);
    expect(state.failures).toBe(0);
  });

  it('resets failure count when outside the 5-minute window', () => {
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);

    // Simulate 6 minutes passing
    const realNow = Date.now;
    Date.now = () => realNow() + 6 * 60 * 1000;

    // This failure should reset the counter (outside window), so only 1 failure
    breaker.recordFailure(HOST);
    const state = breaker.getState(HOST);
    expect(state.failures).toBe(1);
    expect(state.state).toBe(breaker.CLOSED);

    Date.now = realNow;
  });

  it('tracks separate breakers for different hosts', () => {
    const HOST_B = 'http://192.0.2.12:11434';

    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);

    expect(breaker.getState(HOST).state).toBe(breaker.OPEN);
    expect(breaker.canRequest(HOST_B).allowed).toBe(true);
    expect(breaker.getState(HOST_B).state).toBe(breaker.CLOSED);
  });

  it('getState returns defaults for unknown host', () => {
    const state = breaker.getState('http://unknown:11434');
    expect(state).toEqual({ failures: 0, lastFailure: 0, state: breaker.CLOSED });
  });

  it('resetAll clears all breaker state', () => {
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    breaker.recordFailure(HOST);
    expect(breaker.getState(HOST).state).toBe(breaker.OPEN);

    breaker.resetAll();
    expect(breaker.getState(HOST).state).toBe(breaker.CLOSED);
  });
});
