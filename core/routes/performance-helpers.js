'use strict';
/**
 * Performance Routes — Pure Utility Helpers
 *
 * Stateless math / classification helpers shared by performance.js
 * and performance-data.js.
 *
 * Exports:
 *   calculateSystemHealth(metrics, baseline) — returns health string
 *   calculateDiff(current, baseline)         — % difference string
 *   buildHistogram(latencies)                — ms-bucket histogram
 */

/**
 * Calculate system health based on metrics and baseline.
 * @param {Object} metrics  - Current aggregated metrics
 * @param {Object} baseline - Active PerformanceBaseline document
 * @returns {string} 'healthy' | 'degraded' | 'unhealthy' | 'unknown'
 */
function calculateSystemHealth(metrics, baseline) {
  if (!metrics) {
    return 'unknown';
  }

  // Check error rate
  if (metrics.error_rate > 5) {
    return 'unhealthy';
  }

  // Check against baseline if available
  if (baseline) {
    if (metrics.avg_p95 > baseline.metrics.p95_latency * 1.5) {
      return 'degraded';
    }

    if (metrics.error_rate > baseline.metrics.error_rate * 2) {
      return 'degraded';
    }
  }

  // Check absolute thresholds
  if (metrics.avg_p95 > 5000) { // 5 seconds
    return 'degraded';
  }

  return 'healthy';
}

/**
 * Calculate percentage difference between current and baseline value.
 * @param {number} current  - Current value
 * @param {number} baseline - Baseline value
 * @returns {string} Percentage difference (e.g. "12.50")
 */
function calculateDiff(current, baseline) {
  if (!baseline || baseline === 0) {
    return '0.00';
  }
  return ((current / baseline - 1) * 100).toFixed(2);
}

/**
 * Build histogram buckets from an array of latency values (ms).
 * @param {number[]} latencies - Array of latency values
 * @returns {Array<{label: string, count: number}>}
 */
function buildHistogram(latencies) {
  if (!latencies || latencies.length === 0) {
    return [];
  }

  const buckets = [
    { label: '0-50ms',     min: 0,    max: 50 },
    { label: '50-100ms',   min: 50,   max: 100 },
    { label: '100-200ms',  min: 100,  max: 200 },
    { label: '200-500ms',  min: 200,  max: 500 },
    { label: '500-1000ms', min: 500,  max: 1000 },
    { label: '1000-2000ms',min: 1000, max: 2000 },
    { label: '2000ms+',    min: 2000, max: Infinity }
  ];

  return buckets.map(bucket => ({
    label: bucket.label,
    count: latencies.filter(l => l >= bucket.min && l < bucket.max).length
  }));
}

module.exports = { calculateSystemHealth, calculateDiff, buildHistogram };
