const { observedState } = require('../../src/services/failoverStatusService');

describe('failoverStatusService', () => {
  const intent = {
    currentHost: 'http://secondary:11434',
    isFailedOver: true,
    failoverTimestamp: '2026-07-20T00:00:00.000Z',
    reason: 'manual',
    primaryHost: 'http://primary:11434',
    secondaryHost: 'http://secondary:11434',
    tertiaryHost: 'http://tertiary:11434'
  };

  test('uses persisted actual routing instead of process-local intent', () => {
    const latest = {
      _id: 'log-1',
      caller: 'embedding',
      model: 'nomic-embed-text:v1.5',
      host: 'http://primary:11434',
      routedHostUrl: 'http://secondary:11434',
      fallbackUsed: true,
      fallbackReason: 'connection_failure',
      timestamp: new Date('2026-07-23T12:00:00.000Z')
    };

    const state = observedState(intent, latest, 7);

    expect(state).toEqual(expect.objectContaining({
      currentHost: 'http://primary:11434',
      isFailedOver: true,
      reason: 'connection_failure',
      failoverCount: 7,
      authority: 'inference_log',
      statePersisted: true
    }));
    expect(state.requestedIntent).toEqual(expect.objectContaining({
      currentHost: 'http://secondary:11434',
      isFailedOver: true
    }));
    expect(state.observedRequest).toEqual(expect.objectContaining({
      actualHost: 'http://primary:11434',
      requestedHost: 'http://secondary:11434',
      fallbackUsed: true
    }));
  });

  test('does not expose legacy fallback prose through observed status', () => {
    const secret = 'legacy upstream body secret@example.test';
    const state = observedState(intent, {
      _id: 'log-legacy',
      caller: 'proxy',
      model: 'model:1',
      host: 'http://primary:11434',
      fallbackUsed: true,
      fallbackReason: secret,
      timestamp: new Date('2026-07-23T12:00:00.000Z')
    }, 1);

    expect(JSON.stringify(state)).not.toContain(secret);
    expect(state.reason).toBe('actual_route_fallback');
    expect(state.observedRequest.fallbackReason).toBeNull();
  });

  test('reports recovery when the latest trusted route succeeds without fallback', () => {
    const latest = {
      caller: 'proxy',
      model: 'model:1',
      host: 'http://primary:11434',
      routedHostUrl: 'http://primary:11434',
      fallbackUsed: false,
      timestamp: new Date('2026-07-23T12:05:00.000Z')
    };

    const state = observedState(intent, latest, 7);

    expect(state.currentHost).toBe('http://primary:11434');
    expect(state.isFailedOver).toBe(false);
    expect(state.reason).toBeNull();
    expect(state.failoverTimestamp).toBeNull();
  });
});
