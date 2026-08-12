const mongoose = require('mongoose');

/**
 * ModelPricingConfig Schema
 *
 * Stores pricing information for different AI models and providers.
 * Supports dynamic pricing updates without code changes.
 *
 * Usage:
 *   - Cost calculation service queries this model for active pricing
 *   - Falls back to environment variables if no DB config exists
 *   - Supports versioning via effectiveDate and expiryDate
 */
const ModelPricingConfigSchema = new mongoose.Schema({
  provider: {
    type: String,
    required: true,
    enum: ['ollama', 'openai', 'anthropic', 'google', 'cohere', 'other'],
    lowercase: true,
    trim: true
  },
  modelName: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    match: /^[a-z0-9\-_:.]+$/,
    maxlength: 100
  },
  displayName: {
    type: String,
    trim: true,
    maxlength: 200
  },

  pricing: {
    promptTokenCost: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 0
    },
    completionTokenCost: {
      type: Number,
      required: true,
      min: 0,
      max: 100,
      default: 0
    },
    embeddingCost: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    }
  },

  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  currency: {
    type: String,
    default: 'USD',
    uppercase: true,
    match: /^[A-Z]{3}$/,
    maxlength: 3
  },
  source: {
    type: String,
    enum: ['environment', 'manual', 'provider-api', 'import'],
    default: 'manual'
  },
  notes: {
    type: String,
    maxlength: 1000
  },

  effectiveDate: {
    type: Date,
    default: Date.now,
    index: true
  },
  expiryDate: {
    type: Date,
    default: null
  },

  createdAt: {
    type: Date,
    default: Date.now,
    immutable: true
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  createdBy: {
    type: String,
    default: 'system',
    maxlength: 100
  }
});

// Compound indexes for efficient queries
ModelPricingConfigSchema.index({ provider: 1, modelName: 1, isActive: 1 });
ModelPricingConfigSchema.index({ isActive: 1, effectiveDate: -1 });
ModelPricingConfigSchema.index({ provider: 1, isActive: 1 });

// Update timestamp on save
ModelPricingConfigSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Static method: Find active pricing for a model
ModelPricingConfigSchema.statics.findActivePrice = async function(provider, modelName) {
  const now = new Date();

  return this.findOne({
    provider: provider.toLowerCase(),
    modelName: modelName.toLowerCase(),
    isActive: true,
    effectiveDate: { $lte: now },
    $or: [
      { expiryDate: null },
      { expiryDate: { $gt: now } }
    ]
  }).sort({ effectiveDate: -1 }).exec();
};

// Static method: Get all active pricing configs
ModelPricingConfigSchema.statics.findAllActive = async function() {
  const now = new Date();

  return this.find({
    isActive: true,
    effectiveDate: { $lte: now },
    $or: [
      { expiryDate: null },
      { expiryDate: { $gt: now } }
    ]
  }).sort({ provider: 1, modelName: 1 }).exec();
};

// Instance method: Check if pricing is currently valid
ModelPricingConfigSchema.methods.isCurrentlyValid = function() {
  const now = new Date();
  return this.isActive &&
         this.effectiveDate <= now &&
         (!this.expiryDate || this.expiryDate > now);
};

// Virtual: Full model identifier
ModelPricingConfigSchema.virtual('fullModelName').get(function() {
  return `${this.provider}:${this.modelName}`;
});

// Ensure virtuals are included in JSON output
ModelPricingConfigSchema.set('toJSON', { virtuals: true });
ModelPricingConfigSchema.set('toObject', { virtuals: true });

module.exports = mongoose.model('ModelPricingConfig', ModelPricingConfigSchema);
