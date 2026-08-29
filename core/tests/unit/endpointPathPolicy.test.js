'use strict';

const {
  normalizeObservedPath,
  observedPathMatcher,
  coalesceEndpointRows
} = require('../../src/services/endpointPathPolicy');

describe('endpointPathPolicy', () => {
  test('canonicalizes exact nullish path segments without hiding the bad traffic', () => {
    expect(normalizeObservedPath('/api/family/room/undefined'))
      .toBe('/api/family/room/:invalid-id');
    expect(normalizeObservedPath('/api/family/room/null'))
      .toBe('/api/family/room/:invalid-id');
    expect(normalizeObservedPath('/api/jobs/NaN/status'))
      .toBe('/api/jobs/:invalid-id/status');
    expect(normalizeObservedPath('/api/docs/undefined-behavior'))
      .toBe('/api/docs/undefined-behavior');
    expect(normalizeObservedPath('/api/docs/NULL'))
      .toBe('/api/docs/NULL');
  });

  test('keeps the invalid-id dashboard selection inspectable across legacy rows', () => {
    const matcher = observedPathMatcher('/api/family/room/:invalid-id');
    expect(matcher).toBeInstanceOf(RegExp);
    expect(matcher.test('/api/family/room/undefined')).toBe(true);
    expect(matcher.test('/api/family/room/null')).toBe(true);
    expect(matcher.test('/api/family/room/:invalid-id')).toBe(true);
    expect(matcher.test('/api/family/room/real-room')).toBe(false);
    expect(observedPathMatcher('/api/chat')).toBe('/api/chat');
  });

  test('coalesces legacy placeholder rows and preserves their counts, errors, and latency', () => {
    const rows = coalesceEndpointRows([
      { path: '/api/family/room/undefined', method: 'GET', count: 2, error_count: 2, avg_latency: 100 },
      { path: '/api/family/room/null', method: 'GET', count: 3, error_count: 1, avg_latency: 200 }
    ]);

    expect(rows).toEqual([{
      path: '/api/family/room/:invalid-id',
      method: 'GET',
      count: 5,
      error_count: 3,
      error_rate: 60,
      avg_latency: 160
    }]);
  });
});
