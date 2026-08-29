'use strict';

const PerformanceSnapshot = require('../../models/PerformanceSnapshot');

describe('PerformanceSnapshot endpoint path policy', () => {
  afterEach(() => jest.restoreAllMocks());

  test('queries canonical invalid-id selections across legacy placeholder spellings', async () => {
    const aggregate = jest.spyOn(PerformanceSnapshot, 'aggregate').mockResolvedValue([]);

    await PerformanceSnapshot.getEndpointMetrics('/api/family/room/:invalid-id', 24);

    const pipeline = aggregate.mock.calls[0][0];
    const firstMatcher = pipeline[0].$match['by_endpoint.path'];
    const rowMatcher = pipeline[2].$match['by_endpoint.path'];
    expect(firstMatcher).toBeInstanceOf(RegExp);
    expect(rowMatcher).toBe(firstMatcher);
    expect(firstMatcher.test('/api/family/room/undefined')).toBe(true);
    expect(firstMatcher.test('/api/family/room/null')).toBe(true);
    expect(firstMatcher.test('/api/family/room/real-room')).toBe(false);
  });
});
