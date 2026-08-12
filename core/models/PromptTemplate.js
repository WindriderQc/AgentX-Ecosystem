const mongoose = require('mongoose');

/**
 * PromptTemplate Model
 * User-created quick prompt templates for chat interface
 * Separate from PromptConfig (which is for system prompts with A/B testing)
 */

const PromptTemplateSchema = new mongoose.Schema({
  // Creator (null for system templates)
  userId: {
    type: String,
    required: false,
    index: true
  },

  // Template identification
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },

  // Template content with {{variable}} placeholders
  template: {
    type: String,
    required: true,
    maxlength: 10000
  },

  // Category for organization
  category: {
    type: String,
    required: true,
    enum: ['code', 'writing', 'analysis', 'general', 'custom'],
    default: 'general',
    index: true
  },

  // Description
  description: {
    type: String,
    default: '',
    maxlength: 500
  },

  // Tags for search
  tags: {
    type: [String],
    default: []
  },

  // System prompt benchmarking metadata (optional)
  targetModels: {
    type: [String],
    default: []
  },

  expectedQualityBoost: {
    type: Number,
    default: null
  },

  variants: [{
    version: Number,
    content: String,
    description: String
  }],

  // Extracted placeholders (auto-generated)
  placeholders: [{
    name: String,
    defaultValue: String,
    description: String
  }],

  // System template flag (cannot be deleted by users)
  isSystem: {
    type: Boolean,
    default: false,
    index: true
  },

  // Usage tracking
  usageCount: {
    type: Number,
    default: 0
  },

  lastUsedAt: {
    type: Date,
    default: null
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Indexes for efficient queries
PromptTemplateSchema.index({ userId: 1, category: 1 });
PromptTemplateSchema.index({ isSystem: 1, category: 1 });
PromptTemplateSchema.index({ tags: 1 });
PromptTemplateSchema.index({ usageCount: -1 }); // For "most used" sorting

// Update timestamp on save
PromptTemplateSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  if (typeof next === 'function') {
    next();
  }
});

/**
 * Static method: Extract placeholders from template
 * Parses {{variable}} syntax and returns array of variable names
 * @param {String} template - Template string with {{variable}} placeholders
 * @returns {Array<String>} - Array of unique placeholder names
 */
PromptTemplateSchema.statics.extractPlaceholders = function(template) {
  if (!template || typeof template !== 'string') {
    return [];
  }

  const regex = /\{\{([\w.]+)\}\}/g;
  const matches = template.matchAll(regex);
  const found = new Set();

  for (const match of matches) {
    const varName = match[1];
    found.add(varName);
  }

  return Array.from(found).sort();
};

/**
 * Instance method: Record usage
 * Increments usage count and updates last used timestamp
 */
PromptTemplateSchema.methods.recordUsage = async function() {
  this.usageCount = (this.usageCount || 0) + 1;
  this.lastUsedAt = new Date();
  await this.save();
};

/**
 * Instance method: Render template with variables
 * Replaces {{variable}} placeholders with provided values
 * @param {Object} variables - Key-value pairs for substitution
 * @returns {String} - Rendered template
 */
PromptTemplateSchema.methods.render = function(variables = {}) {
  let rendered = this.template;

  // Simple variable substitution
  Object.keys(variables).forEach(key => {
    const regex = new RegExp(`\\{\\{${key}\\}\\}`, 'g');
    rendered = rendered.replace(regex, variables[key] || '');
  });

  return rendered;
};

/**
 * Static method: Get templates for user (includes system + user templates)
 * @param {String} userId - User ID
 * @param {Object} filters - Additional filters (category, search, etc.)
 * @returns {Array} - Array of templates
 */
PromptTemplateSchema.statics.getTemplatesForUser = async function(userId, filters = {}) {
  const query = {
    $or: [
      { isSystem: true }, // All system templates
      { userId: userId } // User's personal templates
    ]
  };

  // Category filter
  if (filters.category) {
    query.category = filters.category;
  }

  // Tag filter
  if (filters.tags && filters.tags.length > 0) {
    query.tags = { $in: filters.tags };
  }

  // Search filter (name or description)
  if (filters.search) {
    const searchRegex = new RegExp(filters.search, 'i');
    query.$and = query.$and || [];
    query.$and.push({
      $or: [
        { name: searchRegex },
        { description: searchRegex },
        { tags: searchRegex }
      ]
    });
  }

  const sortBy = filters.sortBy || 'name';
  const sortOrder = filters.sortOrder === 'desc' ? -1 : 1;

  return this.find(query).sort({ [sortBy]: sortOrder });
};

/**
 * Static method: Get category statistics
 * Returns count of templates per category
 * @param {String} userId - User ID
 * @returns {Object} - Category counts
 */
PromptTemplateSchema.statics.getCategoryStats = async function(userId) {
  const query = {
    $or: [
      { isSystem: true },
      { userId: userId }
    ]
  };

  const templates = await this.find(query);

  const stats = {
    total: templates.length,
    byCategory: {
      code: 0,
      writing: 0,
      analysis: 0,
      general: 0,
      custom: 0
    }
  };

  templates.forEach(template => {
    if (stats.byCategory[template.category] !== undefined) {
      stats.byCategory[template.category]++;
    }
  });

  return stats;
};

module.exports = mongoose.model('PromptTemplate', PromptTemplateSchema);
