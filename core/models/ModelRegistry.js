/**
 * ModelRegistry Model
 *
 * Single source of truth for model metadata, capabilities, and categorization.
 * Enables intelligent routing, benchmark filtering, and capability-based selection.
 *
 * @see /docs/planning/BENCHMARK_ENHANCEMENT_PLAN.md
 */

const mongoose = require('mongoose');
const { TASK_CATEGORY_MAP } = require('../config/categories');

const CapabilitiesSchema = new mongoose.Schema({
  maxContext: {
    type: Number,
    default: null,
    min: 512
  },
  supportsThinking: {
    type: Boolean,
    default: false
  },
  supportsVision: {
    type: Boolean,
    default: false
  },
  avgLatencyMs: {
    type: Number,
    default: null
  },
  p95LatencyMs: {
    type: Number,
    default: null
  },
  avgTokensPerSec: {
    type: Number,
    default: null,
    min: 0
  },
  targetUseCase: {
    type: String,
    default: ''
  },
  optimalBatchSize: {
    type: Number,
    default: 1,
    min: 1
  },

  // DEPRECATED: use curatedJudgeTier. Retained for legacy courthouse reads
  // and display in models-unified.js / models-comparison.js.
  // New curation should prefer curatedJudgeTier so manual edits stay distinct
  // from calibration output.
  judgeTier: {
    type: String,
    enum: ['basic', 'standard', 'advanced', 'premium', null],
    default: null
  },

  // Canonical human-curated tier.
  curatedJudgeTier: {
    type: String,
    enum: ['basic', 'standard', 'advanced', 'premium', null],
    default: null
  },

  // Raw machine calibration output.
  calibratedJudgeTier: {
    type: String,
    enum: ['basic', 'standard', 'advanced', 'premium', null],
    default: null
  },

  calibratedAt: {
    type: Date,
    default: null
  },

  // Judge reliability score (0-1), populated by judge validation tests.
  // Tracks JSON reliability and scoring consistency.
  judgeReliability: {
    type: Number,
    default: null,
    min: 0,
    max: 1
  },

  // Average judge latency in ms (from validation or live benchmarks)
  avgJudgeLatencyMs: {
    type: Number,
    default: null,
    min: 0
  }
}, { _id: false });

const BenchmarkStatsSchema = new mongoose.Schema({
  avgCompositeScore: {
    type: Number,
    default: null,
    min: 0,
    max: 100
  },
  avgQualityScore: {
    type: Number,
    default: null,
    min: 0,
    max: 100
  },
  bestCategory: {
    type: String,
    default: null
  },
  worstCategory: {
    type: String,
    default: null
  },
  totalTests: {
    type: Number,
    default: 0,
    min: 0
  },
  lastBenchmarked: {
    type: Date,
    default: null
  }
}, { _id: false });

const BenchmarkEligibilitySchema = new mongoose.Schema({
  eligible: {
    type: Boolean,
    default: null
  },
  blockedReason: {
    type: String,
    default: null
  },
  reviewedAt: {
    type: Date,
    default: null
  },
  reviewedBy: {
    type: String,
    default: null
  }
}, { _id: false });

const RoutingRulesSchema = new mongoose.Schema({
  preferredFor: [{
    type: String
    // Allow any task type string for flexibility
  }],
  avoidFor: [{
    type: String
    // Allow any task type string for flexibility
  }],
  priority: {
    type: Number,
    default: 5,
    min: 1,
    max: 10
  }
}, { _id: false });

const ExecutionConfigSchema = new mongoose.Schema({
  num_ctx: { type: Number, default: null, min: 512 },
  temperature: { type: Number, default: null, min: 0, max: 2 },
  _source: { type: String, enum: ['auto', 'user', 'system'], default: 'system' },
  _reason: { type: String, default: null },
  _detectedAt: { type: Date, default: null }
}, { _id: false });

const ExecutionOverridesSchema = new mongoose.Schema({
  num_ctx: { type: Number, default: null, min: 512 },
  temperature: { type: Number, default: null, min: 0, max: 2 },
  _overriddenAt: { type: Date, default: null }
}, { _id: false });

const HostPerformanceStepSchema = new mongoose.Schema({
  hostUrl: { type: String, required: true },
  hostId: { type: String },
  tokensPerSec: { type: Number, required: true },
  promptEvalTokensPerSec: { type: Number, default: null },
  latencyMs: { type: Number, required: true },
  timeToFirstTokenMs: { type: Number, default: null },
  promptTokens: { type: Number, default: null },
  completionTokens: { type: Number, default: null },
  vramUsedMiB: { type: Number, default: null },
  vramTotalMiB: { type: Number, default: null },
  numCtx: { type: Number, default: null },
  testedAt: { type: Date, default: Date.now },
  status: { type: String, enum: ['pass', 'fail', 'timeout', 'error'], default: 'pass' },
  error: { type: String, default: null }
}, { _id: false });

const ContextTestStepSchema = new mongoose.Schema({
  numCtx: Number,
  tokensPerSec: Number,
  promptTokens: Number,
  completionTokens: Number,
  vramUsedMiB: Number,
  vramTotalMiB: Number,
  latencyMs: Number,
  passed: Boolean,
  reason: String
}, { _id: false });

const ContextTestSchema = new mongoose.Schema({
  testedNumCtx: { type: Number, default: null },
  baselineTokensPerSec: { type: Number, default: null },
  atLimitTokensPerSec: { type: Number, default: null },
  degradationPct: { type: Number, default: null },
  vramAtLimitMiB: { type: Number, default: null },
  modelTheoreticalMax: { type: Number, default: null },
  degradationThreshold: { type: Number, default: null },
  testedAt: { type: Date, default: null },
  testDurationMs: { type: Number, default: null },
  hostUrl: { type: String, default: null },
  status: { type: String, enum: ['pending', 'running', 'completed', 'failed'], default: null },
  error: { type: String, default: null },
  steps: [ContextTestStepSchema]
}, { _id: false });

const ModelRegistrySchema = new mongoose.Schema({
  // Identity
  modelName: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  vendor: {
    type: String,
    trim: true,
    default: 'unknown',
    enum: ['meta', 'alibaba', 'deepseek', 'mistral', 'google', 'microsoft', 'anthropic', 'openai', 'community', 'unknown']
  },
  description: {
    type: String,
    default: ''
  },

  // User comments/notes
  userNote: {
    type: String,
    default: ''
  },

  // Categorization (Multi-select)
  categories: [{
    type: String,
    enum: [
      'ops',           // Operations/glue logic
      'coding',        // Code generation
      'reasoning',     // Deep thinking
      'specialist',    // Fine-tuned for specific domain
      'generalist',    // General-purpose
      'embedding',     // Vector embeddings only
      'judge'          // Quality scoring
    ],
    index: true
  }],

  // Freeform tags
  tags: {
    type: [String],
    default: [],
    index: true
  },

  // Capabilities
  capabilities: {
    type: CapabilitiesSchema,
    default: () => ({})
  },

  // Deployment
  host: {
    type: String,
    default: process.env.OLLAMA_HOST || 'http://localhost:11434'
  },

  // Source tracking (populated by auto-sync)
  sourceType: {
    type: String,
    enum: ['ollama', 'manual'],
    default: 'manual',
    index: true
  },
  sourceHost: { type: String, default: null },
  ollamaDigest: { type: String, default: null },
  lastSeenAt: { type: Date, default: null },
  modelSizeBytes: { type: Number, default: null },
  parameterSize: { type: String, default: null },
  quantization: { type: String, default: null },
  family: { type: String, default: null },

  // Per-model execution config (auto-detected or system defaults)
  executionDefaults: {
    type: ExecutionConfigSchema,
    default: () => ({})
  },
  // User overrides (separate so original defaults always visible)
  executionOverrides: {
    type: ExecutionOverridesSchema,
    default: () => ({})
  },
  // DEPRECATED: Legacy context test data. Superseded by ModelContextProbeSnapshot
  // in benchmark service. Retained as measured legacy evidence.
  // See benchmark/src/services/modelContextResolver.js for the current resolution chain.
  contextTest: {
    type: ContextTestSchema,
    default: () => ({})
  },

  // Per-host performance test snapshots (capped at 50, pruned on write).
  // Written by agentx-benchmark (host-test); core reads only for display/routing.
  hostPerformance: {
    type: [HostPerformanceStepSchema],
    default: []
  },

  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  status: {
    type: String,
    enum: ['active', 'deprecated', 'experimental', 'retired'],
    default: 'active',
    index: true
  },

  // Performance Tracking (Auto-updated from benchmarks)
  benchmarkStats: {
    type: BenchmarkStatsSchema,
    default: () => ({})
  },

  benchmarkEligibility: {
    type: BenchmarkEligibilitySchema,
    default: () => ({})
  },

  // Routing Hints
  routingRules: {
    type: RoutingRulesSchema,
    default: () => ({})
  },

  // Metadata
  createdBy: {
    type: String,
    default: 'system'
  },
  lastUpdated: {
    type: Date,
    default: Date.now
  },
  notes: {
    type: String,
    default: ''
  }
}, {
  timestamps: true
});

// Compound indexes for common queries
ModelRegistrySchema.index({ categories: 1, isActive: 1 });
ModelRegistrySchema.index({ tags: 1, isActive: 1 });
ModelRegistrySchema.index({ status: 1, isActive: 1 });
ModelRegistrySchema.index({ vendor: 1, categories: 1 });
ModelRegistrySchema.index({ 'capabilities.maxContext': 1 });
ModelRegistrySchema.index({ 'benchmarkStats.avgCompositeScore': -1 });
ModelRegistrySchema.index({ sourceType: 1, isActive: 1 });

// Virtual for full capability description
ModelRegistrySchema.virtual('fullDescription').get(function() {
  return `${this.displayName} (${this.vendor}) - ${this.description}`;
});

// Ensure virtuals are included in JSON
ModelRegistrySchema.set('toJSON', { virtuals: true });
ModelRegistrySchema.set('toObject', { virtuals: true });

/* ============================================================================
 * STATIC METHODS — thin delegations to src/services/modelRegistryQueries.js
 * Keeps ModelRegistry.getActive() etc. working without changing every caller.
 * ========================================================================= */

const queries = require('../src/services/modelRegistryQueries');

ModelRegistrySchema.statics.getActive                        = function(f) { return queries.getActive(f); };
ModelRegistrySchema.statics.findByCategory                   = function(c) { return queries.findByCategory(c); };
ModelRegistrySchema.statics.findByTag                        = function(t) { return queries.findByTag(t); };
ModelRegistrySchema.statics.findByMinContext                  = function(m) { return queries.findByMinContext(m); };
ModelRegistrySchema.statics.getBestForTask                    = function(t, c) { return queries.getBestForTask(t, c); };
ModelRegistrySchema.statics.getGroupedByCategory              = function() { return queries.getGroupedByCategory(); };
ModelRegistrySchema.statics.getCategoryStats                  = function() { return queries.getCategoryStats(); };
ModelRegistrySchema.statics.updateHostPerformance             = function(n, s) { return queries.updateHostPerformance(n, s); };
ModelRegistrySchema.statics.summarizeHostPerformance          = function(d) { return queries.summarizeHostPerformance(d); };
ModelRegistrySchema.statics.getLatestHostPerformanceForModels = function(n) { return queries.getLatestHostPerformanceForModels(n); };

/* ============================================================================
 * INSTANCE METHODS
 * ========================================================================= */

/**
 * Add category to model
 */
ModelRegistrySchema.methods.addCategory = function(category) {
  if (!this.categories.includes(category)) {
    this.categories.push(category);
    this.lastUpdated = new Date();
  }
  return this.save();
};

/**
 * Remove category from model
 */
ModelRegistrySchema.methods.removeCategory = function(category) {
  this.categories = this.categories.filter(c => c !== category);
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Add tag to model
 */
ModelRegistrySchema.methods.addTag = function(tag) {
  if (!this.tags.includes(tag)) {
    this.tags.push(tag);
    this.lastUpdated = new Date();
  }
  return this.save();
};

/**
 * Remove tag from model
 */
ModelRegistrySchema.methods.removeTag = function(tag) {
  this.tags = this.tags.filter(t => t !== tag);
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Mark model as deprecated
 */
ModelRegistrySchema.methods.deprecate = function(reason) {
  this.status = 'deprecated';
  this.notes += `\n\nDeprecated: ${new Date().toISOString()} - ${reason}`;
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Mark model as retired
 */
ModelRegistrySchema.methods.retire = function(reason) {
  this.status = 'retired';
  this.isActive = false;
  this.notes += `\n\nRetired: ${new Date().toISOString()} - ${reason}`;
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Update capabilities from external source
 */
ModelRegistrySchema.methods.updateCapabilities = function(capabilities) {
  Object.assign(this.capabilities, capabilities);
  this.lastUpdated = new Date();
  return this.save();
};

/**
 * Check if model is suitable for task
 */
ModelRegistrySchema.methods.isSuitableFor = function(taskType, constraints = {}) {
  // Check if task is in avoid list
  if (this.routingRules.avoidFor.includes(taskType)) {
    return false;
  }

  // Check constraints
  if (constraints.maxLatency && this.capabilities.p95LatencyMs > constraints.maxLatency) {
    return false;
  }
  if (constraints.minContext && this.capabilities.maxContext < constraints.minContext) {
    return false;
  }

  // Preferred task?
  if (this.routingRules.preferredFor.includes(taskType)) {
    return true;
  }

  // Check category alignment
  const alignedCategory = TASK_CATEGORY_MAP[taskType];
  if (alignedCategory && this.categories.includes(alignedCategory)) {
    return true;
  }

  // Default: generalists can handle most tasks
  return this.categories.includes('generalist');
};

/**
 * Get effective execution config merging defaults → overrides
 * Returns object with { value, source } for each config key
 */
ModelRegistrySchema.methods.getEffectiveConfig = function() {
  const defaults = this.executionDefaults || {};
  const overrides = this.executionOverrides || {};
  const contextTest = this.contextTest || {};

  const result = {
    num_ctx: overrides.num_ctx != null
      ? { value: overrides.num_ctx, source: 'user' }
      : contextTest.testedNumCtx != null && contextTest.status === 'completed'
        ? { value: contextTest.testedNumCtx, source: 'tested' }
        : { value: null, source: 'unresolved' },
    temperature: overrides.temperature != null
      ? { value: overrides.temperature, source: 'user' }
      : defaults.temperature != null
        ? { value: defaults.temperature, source: defaults._source || 'system' }
        : { value: 0.7, source: 'system' }
  };
  result._reason = defaults._reason || null;
  return result;
};

module.exports = mongoose.model('ModelRegistry', ModelRegistrySchema);
