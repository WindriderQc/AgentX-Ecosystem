const logger = require('../../config/logger');

/**
 * Artillery Report Parser Service
 *
 * Parses Artillery JSON output and extracts key performance metrics.
 * Handles both Artillery v1 and v2 JSON formats.
 *
 * @see https://www.artillery.io/docs/guides/guides/test-script-reference
 * @see /models/PerformanceLoadTest.js - Target schema for parsed data
 * @see /routes/performance.js - Uses this service to import test results
 */

/**
 * Parse Artillery JSON report and extract metrics
 *
 * @param {Object} rawReport - Complete Artillery JSON output
 * @returns {Object} Parsed metrics in PerformanceLoadTest schema format
 * @throws {Error} If report is malformed or missing required fields
 */
function parseArtilleryReport(rawReport) {
  // Validate required fields FIRST
  if (!rawReport || typeof rawReport !== 'object') {
    throw new Error('Invalid Artillery report: must be an object');
  }

  if (!rawReport.aggregate) {
    throw new Error('Invalid Artillery report: missing aggregate field');
  }

  logger.debug('Parsing Artillery report', {
    hasAggregate: !!rawReport.aggregate,
    hasIntermediate: !!rawReport.intermediate
  });

  const aggregate = rawReport.aggregate;

  // Extract summary metrics
  const summary = extractSummary(aggregate);

  // Extract latency metrics
  const latency = extractLatency(aggregate);

  // Extract HTTP codes and error counts
  const codes = extractCodes(aggregate);
  const errorCounts = extractErrors(aggregate);

  // Extract configuration if available
  const config = extractConfig(rawReport);

  logger.info('Artillery report parsed successfully', {
    requests_completed: summary.requests_completed,
    error_rate: summary.error_rate,
    p95_latency: latency.p95
  });

  return {
    summary,
    latency,
    codes,
    error_counts: errorCounts,
    config
  };
}

/**
 * Extract summary metrics from aggregate data
 *
 * @param {Object} aggregate - Artillery aggregate object
 * @returns {Object} Summary metrics
 */
function extractSummary(aggregate) {
  // Safely extract counters
  const counters = aggregate.counters || {};
  const rates = aggregate.rates || {};

  // Calculate error rate
  const scenariosCreated = counters['vusers.created'] || 0;
  const scenariosCompleted = counters['vusers.completed'] || 0;
  const requestsCompleted = counters['http.requests'] || 0;
  const errors = counters['errors.total'] || counters['http.request_rate'] || 0;

  let errorRate = 0;
  if (requestsCompleted > 0) {
    errorRate = ((errors / requestsCompleted) * 100);
  }

  // Extract RPS metrics
  const rpsMean = rates['http.request_rate']?.mean || 0;
  const rpsMax = rates['http.request_rate']?.max || 0;

  // Calculate test duration (in seconds)
  const duration = aggregate.duration ? aggregate.duration / 1000 : 0;

  return {
    duration: Math.round(duration),
    scenarios_completed: scenariosCompleted,
    scenarios_created: scenariosCreated,
    requests_completed: requestsCompleted,
    error_rate: parseFloat(errorRate.toFixed(2)),
    rps_mean: parseFloat(rpsMean.toFixed(2)),
    rps_max: parseFloat(rpsMax.toFixed(2))
  };
}

/**
 * Extract latency metrics from aggregate data
 *
 * @param {Object} aggregate - Artillery aggregate object
 * @returns {Object} Latency metrics (all in milliseconds)
 */
function extractLatency(aggregate) {
  const summaries = aggregate.summaries || {};
  const httpResponseTime = summaries['http.response_time'] || {};

  // Artillery stores latencies in milliseconds
  return {
    min: httpResponseTime.min || 0,
    max: httpResponseTime.max || 0,
    median: httpResponseTime.median || httpResponseTime.p50 || 0,
    p95: httpResponseTime.p95 || 0,
    p99: httpResponseTime.p99 || 0
  };
}

/**
 * Extract HTTP status code distribution
 *
 * @param {Object} aggregate - Artillery aggregate object
 * @returns {Object} Status code counts (e.g., {"200": 1234, "500": 5})
 */
function extractCodes(aggregate) {
  const counters = aggregate.counters || {};
  const codes = {};

  // Artillery stores codes as "http.codes.200", "http.codes.404", etc.
  Object.keys(counters).forEach(key => {
    if (key.startsWith('http.codes.')) {
      const statusCode = key.replace('http.codes.', '');
      codes[statusCode] = counters[key];
    }
  });

  return codes;
}

/**
 * Extract error counts
 *
 * @param {Object} aggregate - Artillery aggregate object
 * @returns {Object} Error counts and descriptions
 */
function extractErrors(aggregate) {
  const counters = aggregate.counters || {};
  const errors = {};

  // Extract total error count
  errors.total = counters['errors.total'] || 0;

  // Extract error types
  Object.keys(counters).forEach(key => {
    if (key.startsWith('errors.') && key !== 'errors.total') {
      const errorType = key.replace('errors.', '');
      errors[errorType] = counters[key];
    }
  });

  return errors;
}

/**
 * Extract test configuration from report
 *
 * @param {Object} rawReport - Complete Artillery report
 * @returns {Object|null} Test configuration or null if not available
 */
function extractConfig(rawReport) {
  if (!rawReport.config) {
    return null;
  }

  const config = rawReport.config;

  return {
    target: config.target,
    phases: config.phases || [],
    payload: config.payload || null,
    plugins: config.plugins ? Object.keys(config.plugins) : []
  };
}

/**
 * Validate Artillery report structure
 *
 * @param {Object} rawReport - Artillery JSON to validate
 * @returns {Object} Validation result { valid: boolean, errors: Array<string> }
 */
function validateReport(rawReport) {
  const errors = [];

  if (!rawReport || typeof rawReport !== 'object') {
    errors.push('Report must be a valid JSON object');
    return { valid: false, errors };
  }

  if (!rawReport.aggregate) {
    errors.push('Missing required field: aggregate');
  }

  if (rawReport.aggregate && !rawReport.aggregate.counters) {
    errors.push('Missing required field: aggregate.counters');
  }

  if (rawReport.aggregate && !rawReport.aggregate.summaries) {
    errors.push('Missing required field: aggregate.summaries');
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Calculate percentile from latency distribution
 * (Used for custom percentile calculations if needed)
 *
 * @param {Array<Number>} latencies - Array of latency values
 * @param {Number} percentile - Percentile to calculate (0-100)
 * @returns {Number} Latency at percentile
 */
function calculatePercentile(latencies, percentile) {
  if (!latencies || latencies.length === 0) {
    return 0;
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * Extract scenario-specific metrics if available
 *
 * @param {Object} rawReport - Complete Artillery report
 * @returns {Array} Array of scenario metrics
 */
function extractScenarioMetrics(rawReport) {
  const scenarios = [];

  if (!rawReport.intermediate || !Array.isArray(rawReport.intermediate)) {
    return scenarios;
  }

  // Artillery intermediate data contains per-interval metrics
  // We can aggregate by scenario name if available
  rawReport.intermediate.forEach((interval, index) => {
    if (interval.counters && interval.summaries) {
      scenarios.push({
        interval: index,
        timestamp: interval.timestamp,
        requests: interval.counters['http.requests'] || 0,
        latency_p95: interval.summaries['http.response_time']?.p95 || 0,
        errors: interval.counters['errors.total'] || 0
      });
    }
  });

  return scenarios;
}

/**
 * Generate human-readable summary from parsed metrics
 *
 * @param {Object} parsedMetrics - Output from parseArtilleryReport()
 * @returns {String} Formatted summary text
 */
function generateSummary(parsedMetrics) {
  const errorCounts = parsedMetrics.error_counts || parsedMetrics.errors || {};
  const { summary, latency, codes } = parsedMetrics;

  const lines = [
    `Test Duration: ${summary.duration}s`,
    `Requests Completed: ${summary.requests_completed}`,
    `Throughput: ${summary.rps_mean} req/s (avg), ${summary.rps_max} req/s (max)`,
    `Error Rate: ${summary.error_rate}%`,
    '',
    'Latency:',
    `  Min: ${latency.min}ms`,
    `  Median (p50): ${latency.median}ms`,
    `  p95: ${latency.p95}ms`,
    `  p99: ${latency.p99}ms`,
    `  Max: ${latency.max}ms`,
    '',
    `HTTP Status Codes: ${Object.keys(codes).length > 0 ? JSON.stringify(codes) : 'None'}`,
    `Total Errors: ${errorCounts.total || 0}`
  ];

  return lines.join('\n');
}

module.exports = {
  parseArtilleryReport,
  validateReport,
  calculatePercentile,
  extractScenarioMetrics,
  generateSummary,
  // Exported for testing
  extractSummary,
  extractLatency,
  extractCodes,
  extractErrors,
  extractConfig
};
