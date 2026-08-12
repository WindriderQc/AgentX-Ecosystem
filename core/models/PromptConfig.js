const mongoose = require('mongoose');

const PromptConfigSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  systemPrompt: {
    type: String,
    required: true
  },
  isActive: {
    type: Boolean,
    default: false
  },
  version: {
    type: Number,
    default: 1
  },
  description: {
    type: String,
    default: ''
  },
  // A/B Testing support
  trafficWeight: {
    type: Number,
    default: 100,  // 0-100, percentage of traffic for this version
    min: 0,
    max: 100
  },
  abTestGroup: {
    type: String,
    default: null  // Group ID if this is part of an A/B test
  },
  // Performance tracking
  stats: {
    impressions: { type: Number, default: 0 },
    positiveCount: { type: Number, default: 0 },
    negativeCount: { type: Number, default: 0 }
  },
  // UI Configuration (for specialized persona interfaces)
  uiConfig: {
    type: {
      type: String,
      enum: ['chat', 'dashboard', 'gallery', 'hybrid'],
      default: 'chat'
    },
    route: {
      type: String,
      default: '/index.html'
    },
    capabilities: [{
      type: String,
      enum: ['text', 'images', 'charts', 'files', 'realtime', 'code']
    }],
    layoutConfig: {
      type: mongoose.Schema.Types.Mixed,
      default: {}
    }
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for name + version (unique combination)
PromptConfigSchema.index({ name: 1, version: 1 }, { unique: true });

PromptConfigSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  if (typeof next === 'function') {
    next();
  }
});

// Static method to get active prompt by name (random selection for A/B)
PromptConfigSchema.statics.getActive = async function(name = 'default_chat') {
  const query = { name, isActive: true };

  // Find all active versions for this persona
  const activePrompts = await this.find(query).sort({ version: -1 });

  if (activePrompts.length === 0) return null;
  if (activePrompts.length === 1) return activePrompts[0];

  // Weighted random selection for A/B testing
  // Fix: Use ?? instead of || to properly handle trafficWeight=0 (0% traffic)
  // With ||, trafficWeight=0 would fallback to 100 (wrong), ?? only fallbacks for null/undefined
  const totalWeight = activePrompts.reduce((sum, p) => sum + (p.trafficWeight ?? 100), 0);
  let random = Math.random() * totalWeight;

  for (const prompt of activePrompts) {
    random -= prompt.trafficWeight ?? 100;
    if (random <= 0) return prompt;
  }

  return activePrompts[0];  // Fallback
};

// Static method to get all versions for A/B comparison
PromptConfigSchema.statics.getVersions = async function(name) {
  return this.find({ name }).sort({ version: -1 });
};

// Activate a prompt configuration by id.
// - Sets isActive=true for the target
// - Sets isActive=false for other prompts with the same name
// - Also updates legacy `status` field when present in the collection
PromptConfigSchema.statics.activate = async function(id) {
  const prompt = await this.findById(id).lean();
  if (!prompt) {
    const err = new Error('Prompt not found');
    err.status = 404;
    throw err;
  }

  // Use raw collection updates to avoid any schema strictness issues with
  // legacy/unmodeled fields like `status`.
  await this.collection.updateMany(
    { name: prompt.name, _id: { $ne: prompt._id } },
    { $set: { isActive: false, status: 'deprecated' } }
  );

  await this.collection.updateOne(
    { _id: prompt._id },
    { $set: { isActive: true, status: 'active' } }
  );

  return this.findById(prompt._id).lean();
};

// Instance method to increment stats
PromptConfigSchema.methods.recordImpression = async function() {
  this.stats.impressions = (this.stats.impressions || 0) + 1;
  await this.save();
};

PromptConfigSchema.methods.recordFeedback = async function(isPositive) {
  if (isPositive) {
    this.stats.positiveCount = (this.stats.positiveCount || 0) + 1;
  } else {
    this.stats.negativeCount = (this.stats.negativeCount || 0) + 1;
  }
  await this.save();
};

module.exports = mongoose.model('PromptConfig', PromptConfigSchema);
