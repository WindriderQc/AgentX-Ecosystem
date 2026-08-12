const mongoose = require('mongoose');

/**
 * PerformanceSnapshot Schema
 *
 * Stores hourly aggregated performance metrics from request middleware.
 * Used for real-time performance monitoring and trend analysis.
 *
 * Data is collected by request logging middleware and aggregated by hour.
 *
 * @see /src/middleware/performanceTracking.js - Collects raw request metrics
 * @see /routes/performance.js - Queries snapshots for dashboard
 */
const PerformanceSnapshotSchema = new mongoose.Schema({
  // Time bucket (truncated to hour)
  hour: {
    type: Date,
    required: true,
    unique: true,
    index: true,
    description: 'Hour timestamp (truncated, e.g., 2026-01-03T14:00:00Z)'
  },

  // Request volume metrics
  requests_total: {
    type: Number,
    default: 0,
    description: 'Total requests received in this hour'
  },
  requests_successful: {
    type: Number,
    default: 0,
    description: 'Requests with 2xx/3xx status codes'
  },
  requests_failed: {
    type: Number,
    default: 0,
    description: 'Requests with 4xx/5xx status codes'
  },

  // Latency metrics (all in milliseconds)
  latency: {
    min: {
      type: Number,
      description: 'Minimum response time observed (ms)'
    },
    max: {
      type: Number,
      description: 'Maximum response time observed (ms)'
    },
    avg: {
      type: Number,
      description: 'Average response time (ms)'
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

  // Per-endpoint breakdown
  by_endpoint: [{
    path: {
      type: String,
      required: true,
      description: 'API endpoint path (e.g., "/api/chat")'
    },
    method: {
      type: String,
      required: true,
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
      description: 'HTTP method'
    },
    count: {
      type: Number,
      default: 0,
      description: 'Number of requests to this endpoint'
    },
    avg_latency: {
      type: Number,
      description: 'Average latency for this endpoint (ms)'
    },
    error_count: {
      type: Number,
      default: 0,
      description: 'Number of errors for this endpoint'
    }
  }],

  // HTTP status code distribution
  by_status_code: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
    description: 'Status code counts (e.g., {"200": 1234, "500": 5})'
  },

  // Metadata
  created_at: {
    type: Date,
    default: Date.now,
    description: 'When this snapshot was created'
  }
}, {
  timestamps: true,
  collection: 'performance_snapshots'
});

// Indexes for time-series queries
PerformanceSnapshotSchema.index({ hour: -1 });
PerformanceSnapshotSchema.index({ created_at: 1 }, { expireAfterSeconds: 180 * 86400 });
PerformanceSnapshotSchema.index({ 'by_endpoint.path': 1, hour: -1 });

/**
 * Static method: Get snapshots for time range
 *
 * @param {Date} startDate - Start of time range
 * @param {Date} endDate - End of time range
 * @returns {Promise<Array>} Array of snapshot documents
 */
PerformanceSnapshotSchema.statics.getTimeRange = async function(startDate, endDate) {
  return this.find({
    hour: { $gte: startDate, $lte: endDate }
  })
    .sort({ hour: 1 })
    .lean();
};

/**
 * Static method: Get snapshots for last N hours
 *
 * @param {Number} hours - Number of hours to look back
 * @returns {Promise<Array>} Array of snapshot documents
 */
PerformanceSnapshotSchema.statics.getLastHours = async function(hours = 24) {
  const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);
  return this.getTimeRange(startDate, new Date());
};

/**
 * Static method: Get endpoint-specific metrics
 *
 * @param {String} path - Endpoint path to filter by
 * @param {Number} hours - Number of hours to look back
 * @returns {Promise<Array>} Array of endpoint metrics over time
 */
PerformanceSnapshotSchema.statics.getEndpointMetrics = async function(path, hours = 24) {
  const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);

  return this.aggregate([
    {
      $match: {
        hour: { $gte: startDate },
        'by_endpoint.path': path
      }
    },
    { $unwind: '$by_endpoint' },
    {
      $match: {
        'by_endpoint.path': path
      }
    },
    {
      $project: {
        hour: 1,
        path: '$by_endpoint.path',
        method: '$by_endpoint.method',
        count: '$by_endpoint.count',
        avg_latency: '$by_endpoint.avg_latency',
        error_count: '$by_endpoint.error_count'
      }
    },
    { $sort: { hour: 1 } }
  ]);
};

/**
 * Static method: Calculate percentiles from latency array
 *
 * @param {Array<Number>} latencies - Array of latency values
 * @returns {Object} Percentile breakdown
 */
PerformanceSnapshotSchema.statics.calculatePercentiles = function(latencies) {
  if (!latencies || latencies.length === 0) {
    return { p50: 0, p75: 0, p90: 0, p95: 0, p99: 0, p999: 0 };
  }

  const sorted = [...latencies].sort((a, b) => a - b);
  const getPercentile = (p) => {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, index)];
  };

  return {
    p50: getPercentile(50),
    p75: getPercentile(75),
    p90: getPercentile(90),
    p95: getPercentile(95),
    p99: getPercentile(99),
    p999: getPercentile(99.9)
  };
};

/**
 * Static method: Get aggregated metrics for time range
 *
 * @param {Date} startDate - Start of time range
 * @param {Date} endDate - End of time range
 * @returns {Promise<Object>} Aggregated metrics
 */
PerformanceSnapshotSchema.statics.getAggregatedMetrics = async function(startDate, endDate) {
  const result = await this.aggregate([
    {
      $match: {
        hour: { $gte: startDate, $lte: endDate }
      }
    },
    {
      $group: {
        _id: null,
        total_requests: { $sum: '$requests_total' },
        total_successful: { $sum: '$requests_successful' },
        total_failed: { $sum: '$requests_failed' },
        avg_latency: { $avg: '$latency.avg' },
        avg_p95: { $avg: '$latency.p95' },
        avg_p99: { $avg: '$latency.p99' },
        max_latency: { $max: '$latency.max' },
        min_latency: { $min: '$latency.min' }
      }
    }
  ]);

  if (result.length === 0) {
    return null;
  }

  const metrics = result[0];
  const errorRate = metrics.total_requests > 0
    ? (metrics.total_failed / metrics.total_requests * 100).toFixed(2)
    : 0;

  return {
    total_requests: metrics.total_requests,
    total_successful: metrics.total_successful,
    total_failed: metrics.total_failed,
    error_rate: parseFloat(errorRate),
    avg_latency: Math.round(metrics.avg_latency),
    avg_p95: Math.round(metrics.avg_p95),
    avg_p99: Math.round(metrics.avg_p99),
    max_latency: metrics.max_latency,
    min_latency: metrics.min_latency
  };
};

/**
 * Static method: Get throughput trend (requests per hour)
 *
 * @param {Number} hours - Number of hours to look back
 * @returns {Promise<Array>} Array of { hour, requests_total, rps }
 */
PerformanceSnapshotSchema.statics.getThroughputTrend = async function(hours = 24) {
  const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);

  const snapshots = await this.find({
    hour: { $gte: startDate }
  })
    .sort({ hour: 1 })
    .select('hour requests_total')
    .lean();

  return snapshots.map(s => ({
    timestamp: s.hour,
    requests_total: s.requests_total,
    rps: (s.requests_total / 3600).toFixed(2) // Requests per second (avg over hour)
  }));
};

/**
 * Static method: Get latency trend over time
 *
 * @param {Number} hours - Number of hours to look back
 * @param {String} endpoint - Optional endpoint filter
 * @returns {Promise<Array>} Array of { timestamp, p50, p95, p99 }
 */
PerformanceSnapshotSchema.statics.getLatencyTrend = async function(hours = 24, endpoint = null) {
  const startDate = new Date(Date.now() - hours * 60 * 60 * 1000);

  if (endpoint) {
    // Endpoint-specific latency
    const metrics = await this.getEndpointMetrics(endpoint, hours);
    return metrics.map(m => ({
      timestamp: m.hour,
      // We only store avg_latency per-endpoint in snapshots; mirror it into p50/p95/p99
      // so the UI and percentile aggregation can treat endpoint/system trends uniformly.
      p50: m.avg_latency || 0,
      p95: m.avg_latency || 0,
      p99: m.avg_latency || 0,
      error_count: m.error_count || 0
    }));
  }

  // System-wide latency
  const snapshots = await this.find({
    hour: { $gte: startDate }
  })
    .sort({ hour: 1 })
    .select('hour latency')
    .lean();

  return snapshots.map(s => ({
    timestamp: s.hour,
    p50: s.latency.avg || 0,
    p95: s.latency.p95 || 0,
    p99: s.latency.p99 || 0
  }));
};

module.exports = mongoose.model('PerformanceSnapshot', PerformanceSnapshotSchema);
