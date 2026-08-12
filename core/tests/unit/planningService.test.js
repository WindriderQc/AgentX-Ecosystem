const {
  computeMetricProgress,
  computeTaskProgress
} = require('../../src/services/planningService');

describe('planningService progress calculations', () => {
  test('calculates increasing metric progress from baseline to target', () => {
    expect(computeMetricProgress({
      baseline: 20,
      current: 60,
      target: 100,
      direction: 'increase'
    })).toBe(50);
  });

  test('calculates decreasing metric progress and clamps beyond target', () => {
    expect(computeMetricProgress({
      baseline: 10,
      current: 5,
      target: 0,
      direction: 'decrease'
    })).toBe(50);
    expect(computeMetricProgress({
      baseline: 10,
      current: -2,
      target: 0,
      direction: 'decrease'
    })).toBe(100);
  });

  test('returns zero for incomplete metric data', () => {
    expect(computeMetricProgress({ baseline: 0, current: null, target: 10 })).toBe(0);
  });

  test('weights pipeline states when calculating delivery progress', () => {
    expect(computeTaskProgress([
      { status: 'done' },
      { status: 'review' },
      { status: 'in_progress' },
      { status: 'queued' }
    ])).toBe(59);
  });

  test('returns zero when no tasks are linked', () => {
    expect(computeTaskProgress([])).toBe(0);
  });
});
