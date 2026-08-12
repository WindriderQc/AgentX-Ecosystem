const mongoose = require('mongoose');

const TrainingDataSchema = new mongoose.Schema({
  source: {
    type: String,
    enum: ['conversations_export', 'external_dataset', 'manual_upload', 'synthetic'],
    required: true
  },
  datasetId: mongoose.Schema.Types.ObjectId,
  recordCount: {
    type: Number,
    default: 0
  },
  trainedAt: {
    type: Date,
    default: Date.now
  },
  trainingConfig: {
    epochs: Number,
    learningRate: Number,
    batchSize: Number,
    maxSeqLength: Number,
    loraRank: Number,
    loraAlpha: Number,
    notes: String
  }
}, { _id: false });

const StatsSchema = new mongoose.Schema({
  totalInferences: {
    type: Number,
    default: 0
  },
  avgResponseTime: {
    type: Number,
    default: 0
  },
  avgTokensPerSecond: {
    type: Number,
    default: 0
  },
  positiveRate: {
    type: Number,
    default: 0
  },
  negativeRate: {
    type: Number,
    default: 0
  },
  costPer1kTokens: {
    type: Number,
    default: 0
  },
  lastInferenceAt: Date
}, { _id: false });

const CustomModelSchema = new mongoose.Schema({
  modelId: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    index: true
  },

  baseModel: {
    type: String,
    required: true,
    trim: true
  },
  displayName: {
    type: String,
    required: true,
    trim: true
  },
  description: {
    type: String,
    default: ''
  },

  // Version tracking
  version: {
    type: String,
    required: true,
    default: '1.0.0'
  },
  previousVersion: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'CustomModel'
  },

  // Training information
  trainingData: TrainingDataSchema,

  // Modelfile
  modelfileContent: {
    type: String,
    default: ''
  },
  modelfileHash: {
    type: String,
    default: ''
  },

  // Model Parameters (Tuning)
  parameters: {
    num_ctx: Number,
    num_gpu: Number,
    num_thread: Number,
    keep_alive: String
  },

  // Deployment
  status: {
    type: String,
    enum: ['training', 'ready', 'deployed', 'deprecated', 'failed', 'archived'],
    default: 'ready',
    index: true
  },
  deployedAt: Date,
  ollamaHost: {
    type: String,
    default: process.env.OLLAMA_HOST || 'http://localhost:11434'
  },

  // Performance tracking
  stats: {
    type: StatsSchema,
    default: () => ({})
  },

  // A/B Testing
  abTestConfig: {
    enabled: {
      type: Boolean,
      default: false
    },
    trafficWeight: {
      type: Number,
      default: 0,
      min: 0,
      max: 100
    },
    comparedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'CustomModel'
    }
  },

  // Metadata
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'UserProfile'
  },
  categories: [{
    type: String,
    trim: true
  }],
  tags: [{
    type: String,
    trim: true
  }],
  notes: {
    type: String,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true,
    index: true
  }
}, {
  timestamps: true
});

// Indexes for common queries
CustomModelSchema.index({ status: 1, isActive: 1 });
CustomModelSchema.index({ baseModel: 1 });
CustomModelSchema.index({ tags: 1 });
CustomModelSchema.index({ 'stats.positiveRate': -1 });
CustomModelSchema.index({ createdAt: -1 });

// Static methods

/**
 * Get all active models
 */
CustomModelSchema.statics.getActive = function(filters = {}) {
  return this.find({
    isActive: true,
    status: { $in: ['ready', 'deployed'] },
    ...filters
  })
  .sort({ createdAt: -1 })
  .lean();
};

/**
 * Get models by base model
 */
CustomModelSchema.statics.getByBaseModel = function(baseModel) {
  return this.find({ baseModel, isActive: true })
    .sort({ version: -1 })
    .lean();
};

/**
 * Get version history for a model
 */
CustomModelSchema.statics.getVersionHistory = async function(modelId) {
  const versions = [];
  let current = await this.findOne({ modelId });

  while (current) {
    versions.push(current);
    if (current.previousVersion) {
      current = await this.findById(current.previousVersion);
    } else {
      current = null;
    }
  }

  return versions;
};

/**
 * Compare two models
 */
CustomModelSchema.statics.compareModels = async function(modelId1, modelId2) {
  const [model1, model2] = await Promise.all([
    this.findOne({ modelId: modelId1 }),
    this.findOne({ modelId: modelId2 })
  ]);

  if (!model1 || !model2) {
    throw new Error('One or both models not found');
  }

  return {
    model1: {
      modelId: model1.modelId,
      displayName: model1.displayName,
      version: model1.version,
      stats: model1.stats
    },
    model2: {
      modelId: model2.modelId,
      displayName: model2.displayName,
      version: model2.version,
      stats: model2.stats
    },
    comparison: {
      responsTimeImprovement: calculateImprovement(model1.stats.avgResponseTime, model2.stats.avgResponseTime),
      throughputImprovement: calculateImprovement(model1.stats.avgTokensPerSecond, model2.stats.avgTokensPerSecond),
      qualityImprovement: calculateImprovement(model1.stats.positiveRate, model2.stats.positiveRate)
    }
  };
};

/**
 * Get models for A/B testing
 */
CustomModelSchema.statics.getABTestModels = function() {
  return this.find({
    'abTestConfig.enabled': true,
    status: 'deployed',
    isActive: true
  })
  .sort({ 'abTestConfig.trafficWeight': -1 })
  .lean();
};

// Instance methods

/**
 * Deploy model to Ollama
 */
CustomModelSchema.methods.markAsDeployed = function(host) {
  this.status = 'deployed';
  this.deployedAt = new Date();
  if (host) {
    this.ollamaHost = host;
  }
  return this.save();
};

/**
 * Update inference statistics (rollup averages + counters on the model document).
 * Distinct from the per-call InferenceLog writer in modelRouter.
 */
CustomModelSchema.methods.updateInferenceStats = async function(responseTime, tokensPerSecond, feedback) {
  const currentTotal = this.stats.totalInferences;

  // Update averages using incremental average formula
  this.stats.avgResponseTime = ((this.stats.avgResponseTime * currentTotal) + responseTime) / (currentTotal + 1);
  this.stats.avgTokensPerSecond = ((this.stats.avgTokensPerSecond * currentTotal) + tokensPerSecond) / (currentTotal + 1);

  // Fix: Round to prevent floating-point drift when reconstructing counts from rates
  // Without rounding, repeated rate*count calculations accumulate errors
  if (feedback === 'positive') {
    const currentPositive = Math.round(this.stats.positiveRate * currentTotal);
    this.stats.positiveRate = (currentPositive + 1) / (currentTotal + 1);
  } else if (feedback === 'negative') {
    const currentNegative = Math.round(this.stats.negativeRate * currentTotal);
    this.stats.negativeRate = (currentNegative + 1) / (currentTotal + 1);
  }

  this.stats.totalInferences += 1;
  this.stats.lastInferenceAt = new Date();

  return this.save();
};

/**
 * Archive model (soft delete)
 */
CustomModelSchema.methods.archive = function(reason) {
  this.status = 'archived';
  this.isActive = false;
  this.notes += `\n\nArchived: ${new Date().toISOString()} - ${reason}`;
  return this.save();
};

/**
 * Deprecate model
 */
CustomModelSchema.methods.deprecate = function(reason) {
  this.status = 'deprecated';
  this.abTestConfig.enabled = false;
  this.notes += `\n\nDeprecated: ${new Date().toISOString()} - ${reason}`;
  return this.save();
};

// Helper function for comparison
function calculateImprovement(baseline, comparison) {
  if (!baseline || baseline === 0) return 0;
  return ((comparison - baseline) / baseline) * 100;
}

const CustomModel = mongoose.model('CustomModel', CustomModelSchema);

module.exports = CustomModel;
