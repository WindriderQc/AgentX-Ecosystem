const mongoose = require('mongoose');

/**
 * PerformanceLoadTest Schema
 *
 * Stores Artillery load test run results for performance monitoring.
 * Each document represents a single test execution with detailed metrics.
 *
 * @see /src/services/artilleryParser.js - Parses Artillery JSON output
 * @see /routes/performance.js - API endpoints for load test management
 */
const PerformanceLoadTestSchema = new mongoose.Schema({
  // Test identification
  name: {
    type: String,
    required: true,
    trim: true,
    index: true,
    description: 'Human-readable test name (e.g., "basic-load-2026-01-03")'
  },
  scenario: {
    type: String,
    required: true,
    trim: true,
    index: true,
    description: 'Artillery scenario name (e.g., "basic-load", "stress-test")'
  },

  // Test configuration
  config: {
    type: mongoose.Schema.Types.Mixed,
    description: 'Artillery configuration snapshot (phases, target URL, duration)'
  },

  // Summary metrics
  summary: {
    duration: {
      type: Number,
      description: 'Total test duration in seconds'
    },
    scenarios_completed: {
      type: Number,
      description: 'Number of virtual user scenarios completed'
    },
    scenarios_created: {
      type: Number,
      description: 'Number of virtual user scenarios created'
    },
    requests_completed: {
      type: Number,
      description: 'Total HTTP requests completed successfully'
    },
    error_rate: {
      type: Number,
      min: 0,
      max: 100,
      description: 'Error rate as percentage (0-100)'
    },
    rps_mean: {
      type: Number,
      description: 'Mean requests per second (throughput)'
    },
    rps_max: {
      type: Number,
      description: 'Peak requests per second'
    }
  },

  // Latency metrics (all in milliseconds)
  latency: {
    min: {
      type: Number,
      description: 'Minimum response time (ms)'
    },
    max: {
      type: Number,
      description: 'Maximum response time (ms)'
    },
    median: {
      type: Number,
      description: 'Median response time / p50 (ms)'
    },
    p95: {
      type: Number,
      description: '95th percentile response time (ms)'
    },
    p99: {
      type: Number,
      description: '99th percentile response time (ms)'
    }
  },

  // HTTP status codes and error counts
  codes: {
    type: mongoose.Schema.Types.Mixed,
    description: 'HTTP status code distribution (e.g., {"200": 1234, "500": 5})'
  },
  error_counts: {
    type: mongoose.Schema.Types.Mixed,
    description: 'Error type counts and descriptions'
  },

  // Raw Artillery output for detailed analysis
  raw_report: {
    type: mongoose.Schema.Types.Mixed,
    description: 'Complete Artillery JSON output for reference'
  },

  // Timestamps
  timestamp: {
    type: Date,
    required: true,
    index: true,
    description: 'When the test was executed'
  },
  imported_at: {
    type: Date,
    default: Date.now,
    description: 'When the test results were imported to database'
  }
}, {
  timestamps: true,
  collection: 'performance_load_tests'
});

// Indexes for common queries
PerformanceLoadTestSchema.index({ scenario: 1, timestamp: -1 });
PerformanceLoadTestSchema.index({ timestamp: -1 });
PerformanceLoadTestSchema.index({ 'summary.error_rate': 1 });

/**
 * Static method: Find recent tests by scenario
 *
 * @param {String} scenario - Scenario name to filter by
 * @param {Number} limit - Maximum results to return
 * @returns {Promise<Array>} Array of test documents
 */
PerformanceLoadTestSchema.statics.findRecentByScenario = async function(scenario, limit = 20) {
  const query = scenario ? { scenario } : {};
  return this.find(query)
    .sort({ timestamp: -1 })
    .limit(limit)
    .select('-raw_report') // Exclude large raw_report field
    .lean();
};

/**
 * Static method: Get latest test result
 *
 * @param {String} scenario - Optional scenario filter
 * @returns {Promise<Object|null>} Latest test document or null
 */
PerformanceLoadTestSchema.statics.getLatest = async function(scenario) {
  const query = scenario ? { scenario } : {};
  return this.findOne(query)
    .sort({ timestamp: -1 })
    .lean();
};

/**
 * Static method: Calculate average metrics across time range
 *
 * @param {Date} startDate - Start of time range
 * @param {Date} endDate - End of time range
 * @param {String} scenario - Optional scenario filter
 * @returns {Promise<Object>} Aggregated metrics
 */
PerformanceLoadTestSchema.statics.getAverageMetrics = async function(startDate, endDate, scenario) {
  const match = {
    timestamp: { $gte: startDate, $lte: endDate }
  };
  if (scenario) match.scenario = scenario;

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        avg_latency_median: { $avg: '$latency.median' },
        avg_latency_p95: { $avg: '$latency.p95' },
        avg_latency_p99: { $avg: '$latency.p99' },
        avg_rps: { $avg: '$summary.rps_mean' },
        avg_error_rate: { $avg: '$summary.error_rate' },
        max_error_rate: { $max: '$summary.error_rate' },
        test_count: { $sum: 1 }
      }
    }
  ]);

  return result.length > 0 ? result[0] : null;
};

/**
 * Instance method: Detect performance regression vs baseline
 *
 * @param {Object} baseline - Baseline metrics to compare against
 * @returns {Object} Regression analysis results
 */
PerformanceLoadTestSchema.methods.detectRegression = function(baseline) {
  const regressions = [];

  // Check latency regression (threshold: 20% increase)
  if (this.latency.p95 > baseline.metrics.p95_latency * 1.2) {
    regressions.push({
      metric: 'p95_latency',
      current: this.latency.p95,
      baseline: baseline.metrics.p95_latency,
      increase_percent: ((this.latency.p95 / baseline.metrics.p95_latency - 1) * 100).toFixed(2)
    });
  }

  // Check error rate regression (threshold: 2x increase)
  if (this.summary.error_rate > baseline.metrics.error_rate * 2) {
    regressions.push({
      metric: 'error_rate',
      current: this.summary.error_rate,
      baseline: baseline.metrics.error_rate,
      increase_percent: ((this.summary.error_rate / baseline.metrics.error_rate - 1) * 100).toFixed(2)
    });
  }

  // Check throughput regression (threshold: 20% decrease)
  if (this.summary.rps_mean < baseline.metrics.throughput_rps * 0.8) {
    regressions.push({
      metric: 'throughput_rps',
      current: this.summary.rps_mean,
      baseline: baseline.metrics.throughput_rps,
      decrease_percent: ((1 - this.summary.rps_mean / baseline.metrics.throughput_rps) * 100).toFixed(2)
    });
  }

  return {
    regression_detected: regressions.length > 0,
    regressions
  };
};

module.exports = mongoose.model('PerformanceLoadTest', PerformanceLoadTestSchema);
