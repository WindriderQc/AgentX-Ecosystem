'use strict';

const { calculateSystemHealth } = require('../../routes/performance-helpers');

describe('performance headline health', () => {
  test('does not claim healthy when the displayed error rate is amber', () => {
    expect(calculateSystemHealth({ error_rate: 3.64, avg_p95: 200 }, null)).toBe('degraded');
  });

  test('keeps low-error, low-latency evidence healthy', () => {
    expect(calculateSystemHealth({ error_rate: 0.4, avg_p95: 200 }, null)).toBe('healthy');
  });

  test('keeps high error rates unhealthy', () => {
    expect(calculateSystemHealth({ error_rate: 6, avg_p95: 200 }, null)).toBe('unhealthy');
  });
});
