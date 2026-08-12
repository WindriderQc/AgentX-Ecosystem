const mongoose = require('mongoose');

/**
 * PerformanceBaseline Schema
 *
 * Defines performance baselines for regression detection.
 * Only one baseline can be active at a time for comparison.
 *
 * @see /routes/performance.js - Baseline management endpoints
 * @see PerformanceLoadTest.detectRegression() - Uses baseline for comparison
 */
const PerformanceBaselineSchema = new mongoose.Schema({
  // Baseline identification
  name: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    description: 'Baseline version identifier (e.g., "v1.0-baseline", "2026-01-production")'
  },
  description: {
    type: String,
    trim: true,
    description: 'Human-readable description of baseline purpose'
  },

  // System-wide metrics
  metrics: {
    avg_response_time: {
      type: Number,
      required: true,
      description: 'Average response time across all endpoints (ms)'
    },
    p95_latency: {
      type: Number,
      required: true,
      description: '95th percentile latency target (ms)'
    },
    error_rate: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      description: 'Acceptable error rate threshold (percentage)'
    },
    throughput_rps: {
      type: Number,
      required: true,
      description: 'Expected throughput in requests per second'
    }
  },

  // Per-endpoint baselines
  endpoints: [{
    path: {
      type: String,
      required: true,
      description: 'API endpoint path (e.g., "/api/chat")'
    },
    method: {
      type: String,
      required: true,
      enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
      description: 'HTTP method'
    },
    avg_latency: {
      type: Number,
      required: true,
      description: 'Expected average latency for this endpoint (ms)'
    },
    p95_latency: {
      type: Number,
      required: true,
      description: '95th percentile latency target for this endpoint (ms)'
    }
  }],

  // Baseline status
  active: {
    type: Boolean,
    default: false,
    index: true,
    description: 'Whether this baseline is currently active for comparisons'
  },

  // Source information
  source: {
    type: String,
    enum: ['manual', 'load_test', 'production_sample'],
    default: 'manual',
    description: 'How this baseline was created'
  },
  source_test_id: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'PerformanceLoadTest',
    description: 'Reference to source load test if created from test results'
  },

  // Timestamps
  created_at: {
    type: Date,
    default: Date.now,
    index: true
  },
  activated_at: {
    type: Date,
    description: 'When this baseline was activated'
  },
  deactivated_at: {
    type: Date,
    description: 'When this baseline was deactivated'
  }
}, {
  timestamps: true,
  collection: 'performance_baselines'
});

// Indexes
PerformanceBaselineSchema.index({ active: 1, created_at: -1 });

/**
 * Static method: Get the currently active baseline
 *
 * @returns {Promise<Object|null>} Active baseline document or null
 */
PerformanceBaselineSchema.statics.getActive = async function() {
  return this.findOne({ active: true }).lean();
};

/**
 * Static method: Set a baseline as active (deactivates others)
 *
 * @param {String} baselineId - ID of baseline to activate
 * @returns {Promise<Object>} Activated baseline document
 */
PerformanceBaselineSchema.statics.setActive = async function(baselineId) {
  // Deactivate all existing baselines
  await this.updateMany(
    { active: true },
    {
      $set: {
        active: false,
        deactivated_at: new Date()
      }
    }
  );

  // Activate the specified baseline
  const baseline = await this.findByIdAndUpdate(
    baselineId,
    {
      $set: {
        active: true,
        activated_at: new Date(),
        deactivated_at: null
      }
    },
    { new: true }
  );

  return baseline;
};

/**
 * Static method: Create baseline from load test results
 *
 * @param {String} name - Baseline name
 * @param {Object} loadTest - PerformanceLoadTest document
 * @param {String} description - Optional description
 * @returns {Promise<Object>} Created baseline document
 */
PerformanceBaselineSchema.statics.createFromLoadTest = async function(name, loadTest, description) {
  const baseline = new this({
    name,
    description: description || `Baseline created from test: ${loadTest.name}`,
    metrics: {
      avg_response_time: loadTest.latency.median,
      p95_latency: loadTest.latency.p95,
      error_rate: loadTest.summary.error_rate,
      throughput_rps: loadTest.summary.rps_mean
    },
    source: 'load_test',
    source_test_id: loadTest._id
  });

  await baseline.save();
  return baseline;
};

/**
 * Static method: List all baselines with metadata
 *
 * @param {Number} limit - Maximum results to return
 * @returns {Promise<Array>} Array of baseline documents
 */
PerformanceBaselineSchema.statics.listAll = async function(limit = 50) {
  return this.find({})
    .sort({ created_at: -1 })
    .limit(limit)
    .lean();
};

/**
 * Instance method: Compare metrics against another baseline
 *
 * @param {Object} other - Other baseline to compare against
 * @returns {Object} Comparison results with percentage differences
 */
PerformanceBaselineSchema.methods.compareWith = function(other) {
  const calculateDiff = (current, baseline) => {
    if (!baseline || baseline === 0) return 0;
    return ((current / baseline - 1) * 100).toFixed(2);
  };

  return {
    avg_response_time: {
      current: this.metrics.avg_response_time,
      baseline: other.metrics.avg_response_time,
      diff_percent: calculateDiff(this.metrics.avg_response_time, other.metrics.avg_response_time)
    },
    p95_latency: {
      current: this.metrics.p95_latency,
      baseline: other.metrics.p95_latency,
      diff_percent: calculateDiff(this.metrics.p95_latency, other.metrics.p95_latency)
    },
    error_rate: {
      current: this.metrics.error_rate,
      baseline: other.metrics.error_rate,
      diff_percent: calculateDiff(this.metrics.error_rate, other.metrics.error_rate)
    },
    throughput_rps: {
      current: this.metrics.throughput_rps,
      baseline: other.metrics.throughput_rps,
      diff_percent: calculateDiff(this.metrics.throughput_rps, other.metrics.throughput_rps)
    }
  };
};

/**
 * Instance method: Get endpoint-specific baseline
 *
 * @param {String} path - Endpoint path
 * @param {String} method - HTTP method
 * @returns {Object|null} Endpoint baseline or null if not found
 */
PerformanceBaselineSchema.methods.getEndpointBaseline = function(path, method) {
  return this.endpoints.find(e => e.path === path && e.method === method) || null;
};

module.exports = mongoose.model('PerformanceBaseline', PerformanceBaselineSchema);
