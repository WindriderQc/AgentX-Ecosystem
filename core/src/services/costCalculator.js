/**
 * Cost Calculator Service
 *
 * Handles cost calculation for AI model usage based on token consumption.
 * Implements three-tier pricing resolution:
 *   1. Model-specific environment variables
 *   2. Provider default environment variables
 *   3. Database pricing configuration
 *   4. Global fallback defaults
 *
 * Features:
 *   - Per-token pricing (prompt vs completion)
 *   - In-memory caching with TTL
 *   - Graceful fallbacks
 *   - Multi-provider support (Ollama, OpenAI, Anthropic, Google)
 */

const ModelPricingConfig = require('../../models/ModelPricingConfig');
const logger = require('../../config/logger');

// In-memory pricing cache
const pricingCache = new Map();
const CACHE_TTL = parseInt(process.env.COST_PRICING_CACHE_TTL || '3600', 10) * 1000; // Default: 1 hour

/**
 * Check if cost tracking is enabled
 */
function isCostTrackingEnabled() {
  return process.env.COST_TRACKING_ENABLED !== 'false';
}

/**
 * Parse model string into provider and modelName
 * Examples:
 *   "llama3" -> { provider: "ollama", modelName: "llama3" }
 *   "ollama:qwen2" -> { provider: "ollama", modelName: "qwen2" }
 *   "openai:gpt-4" -> { provider: "openai", modelName: "gpt-4" }
 */
function parseModel(model) {
  if (!model || typeof model !== 'string') {
    return { provider: 'ollama', modelName: 'unknown' };
  }

  const parts = model.split(':');
  if (parts.length >= 2) {
    return {
      provider: parts[0].toLowerCase().trim(),
      modelName: parts.slice(1).join(':').toLowerCase().trim()
    };
  }

  return {
    provider: 'ollama',
    modelName: model.toLowerCase().trim()
  };
}

/**
 * Get pricing from environment variables
 * Tries model-specific first, then provider defaults
 */
function getPricingFromEnv(provider, modelName) {
  // Normalize names for env var lookup
  const providerUpper = provider.toUpperCase().replace(/[^A-Z0-9]/g, '_');
  const modelUpper = modelName.toUpperCase().replace(/[^A-Z0-9]/g, '_');

  // Try model-specific env vars first
  const modelSpecificPromptKey = `${providerUpper}_${modelUpper}_PROMPT_COST_PER_1M`;
  const modelSpecificCompletionKey = `${providerUpper}_${modelUpper}_COMPLETION_COST_PER_1M`;

  if (process.env[modelSpecificPromptKey] !== undefined &&
      process.env[modelSpecificCompletionKey] !== undefined) {
    const promptCost = parseFloat(process.env[modelSpecificPromptKey]);
    const completionCost = parseFloat(process.env[modelSpecificCompletionKey]);
    // Validate parsed values are valid numbers
    if (Number.isNaN(promptCost) || Number.isNaN(completionCost)) {
      logger.warn('Invalid model-specific pricing env vars', {
        provider: providerUpper,
        model: modelUpper,
        promptCost,
        completionCost
      });
      return null; // Fall through to next pricing source
    }
    return {
      promptTokenCost: promptCost,
      completionTokenCost: completionCost,
      source: 'environment',
      sourceDetail: 'model-specific'
    };
  }

  // Try provider defaults
  const providerDefaultPromptKey = `${providerUpper}_DEFAULT_PROMPT_COST_PER_1M`;
  const providerDefaultCompletionKey = `${providerUpper}_DEFAULT_COMPLETION_COST_PER_1M`;

  if (process.env[providerDefaultPromptKey] !== undefined &&
      process.env[providerDefaultCompletionKey] !== undefined) {
    const promptCost = parseFloat(process.env[providerDefaultPromptKey]);
    const completionCost = parseFloat(process.env[providerDefaultCompletionKey]);
    // Validate parsed values are valid numbers
    if (Number.isNaN(promptCost) || Number.isNaN(completionCost)) {
      logger.warn('Invalid provider-default pricing env vars', {
        provider: providerUpper,
        promptCost,
        completionCost
      });
      return null; // Fall through to database/fallback
    }
    return {
      promptTokenCost: promptCost,
      completionTokenCost: completionCost,
      source: 'environment',
      sourceDetail: 'provider-default'
    };
  }

  return null;
}

/**
 * Get pricing from database
 */
async function getPricingFromDatabase(provider, modelName) {
  try {
    const config = await ModelPricingConfig.findActivePrice(provider, modelName);

    if (config && config.isCurrentlyValid()) {
      return {
        promptTokenCost: config.pricing.promptTokenCost,
        completionTokenCost: config.pricing.completionTokenCost,
        source: 'database',
        sourceDetail: config.source,
        configId: config._id
      };
    }
  } catch (err) {
    logger.error('Failed to fetch pricing from database', {
      provider,
      modelName,
      error: err.message
    });
  }

  return null;
}

/**
 * Get global fallback pricing
 */
function getGlobalFallback() {
  const promptCost = parseFloat(process.env.DEFAULT_FALLBACK_PROMPT_COST_PER_1M || '0.00');
  const completionCost = parseFloat(process.env.DEFAULT_FALLBACK_COMPLETION_COST_PER_1M || '0.00');

  return {
    // Default to 0 if parsing failed (NaN)
    promptTokenCost: Number.isNaN(promptCost) ? 0 : promptCost,
    completionTokenCost: Number.isNaN(completionCost) ? 0 : completionCost,
    source: 'default',
    sourceDetail: 'global-fallback'
  };
}

/**
 * Resolve pricing with three-tier fallback
 * 1. Environment variables (model-specific or provider defaults)
 * 2. Database configuration
 * 3. Global fallback
 */
async function resolvePricing(provider, modelName) {
  const cacheKey = `${provider}:${modelName}`;

  // Check cache first
  if (pricingCache.has(cacheKey)) {
    const cached = pricingCache.get(cacheKey);
    if (Date.now() - cached.timestamp < CACHE_TTL) {
      logger.debug('Pricing cache hit', { provider, modelName });
      return cached.pricing;
    }
    pricingCache.delete(cacheKey);
  }

  // Try environment variables first
  const envPricing = getPricingFromEnv(provider, modelName);
  if (envPricing) {
    pricingCache.set(cacheKey, { pricing: envPricing, timestamp: Date.now() });
    logger.debug('Pricing resolved from environment', {
      provider,
      modelName,
      detail: envPricing.sourceDetail
    });
    return envPricing;
  }

  // Try database
  const dbPricing = await getPricingFromDatabase(provider, modelName);
  if (dbPricing) {
    pricingCache.set(cacheKey, { pricing: dbPricing, timestamp: Date.now() });
    logger.debug('Pricing resolved from database', {
      provider,
      modelName,
      detail: dbPricing.sourceDetail
    });
    return dbPricing;
  }

  // Use global fallback
  const fallback = getGlobalFallback();
  pricingCache.set(cacheKey, { pricing: fallback, timestamp: Date.now() });
  logger.debug('Pricing resolved from fallback', { provider, modelName });

  return fallback;
}

/**
 * Calculate cost for a single message
 *
 * @param {string} model - Model identifier (e.g., "llama3", "ollama:qwen2", "openai:gpt-4")
 * @param {object} stats - Message stats object with usage data
 * @param {object} stats.usage - Token usage
 * @param {number} stats.usage.promptTokens - Prompt tokens
 * @param {number} stats.usage.completionTokens - Completion tokens
 * @param {number} stats.usage.totalTokens - Total tokens
 * @returns {object} Cost breakdown
 */
async function calculateMessageCost(model, stats) {
  // Check if cost tracking is enabled
  if (!isCostTrackingEnabled()) {
    return {
      promptTokenCost: 0,
      completionTokenCost: 0,
      totalCost: 0,
      currency: process.env.COST_CURRENCY || 'USD',
      pricingSource: {
        source: 'disabled',
        provider: null,
        modelName: null
      },
      calculatedAt: new Date()
    };
  }

  // Validate input
  if (!stats || !stats.usage || !stats.usage.totalTokens) {
    return {
      promptTokenCost: 0,
      completionTokenCost: 0,
      totalCost: 0,
      currency: process.env.COST_CURRENCY || 'USD',
      pricingSource: {
        source: 'unconfigured',
        provider: null,
        modelName: null
      },
      calculatedAt: new Date()
    };
  }

  // Parse model
  const { provider, modelName } = parseModel(model);

  // Resolve pricing
  const pricing = await resolvePricing(provider, modelName);

  // Calculate costs (pricing is per 1 million tokens)
  const promptTokenCost = (stats.usage.promptTokens / 1_000_000) * pricing.promptTokenCost;
  const completionTokenCost = (stats.usage.completionTokens / 1_000_000) * pricing.completionTokenCost;
  const totalCost = promptTokenCost + completionTokenCost;

  return {
    promptTokenCost: parseFloat(promptTokenCost.toFixed(6)),
    completionTokenCost: parseFloat(completionTokenCost.toFixed(6)),
    totalCost: parseFloat(totalCost.toFixed(6)),
    currency: process.env.COST_CURRENCY || 'USD',
    pricingSource: {
      provider,
      modelName,
      promptCostPer1M: pricing.promptTokenCost,
      completionCostPer1M: pricing.completionTokenCost,
      source: pricing.source,
      sourceDetail: pricing.sourceDetail,
      configId: pricing.configId
    },
    calculatedAt: new Date()
  };
}

/**
 * Calculate total cost for a conversation
 *
 * @param {Array} messages - Array of message objects with stats and cost
 * @returns {object} Total cost breakdown
 */
function calculateConversationCost(messages) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return {
      sum: 0,
      currency: process.env.COST_CURRENCY || 'USD',
      breakdown: {
        promptTokens: 0,
        completionTokens: 0,
        embeddingTokens: 0
      },
      lastUpdated: new Date()
    };
  }

  let totalCost = 0;
  let promptTokenCost = 0;
  let completionTokenCost = 0;

  messages.forEach(msg => {
    if (msg.cost && msg.cost.totalCost) {
      totalCost += msg.cost.totalCost;
      promptTokenCost += msg.cost.promptTokenCost || 0;
      completionTokenCost += msg.cost.completionTokenCost || 0;
    }
  });

  return {
    sum: parseFloat(totalCost.toFixed(6)),
    currency: process.env.COST_CURRENCY || 'USD',
    breakdown: {
      promptTokens: parseFloat(promptTokenCost.toFixed(6)),
      completionTokens: parseFloat(completionTokenCost.toFixed(6)),
      embeddingTokens: 0 // Future: calculate embedding costs
    },
    lastUpdated: new Date()
  };
}

/**
 * Format cost for display
 */
function formatCost(cost, currency = 'USD') {
  if (typeof cost !== 'number' || isNaN(cost)) {
    return `${currency} 0.00`;
  }

  if (cost === 0) {
    return `${currency} 0.00`;
  }

  if (cost < 0.01) {
    return `${currency} ${cost.toFixed(6)}`;
  }

  return `${currency} ${cost.toFixed(2)}`;
}

/**
 * Clear pricing cache (useful for testing or after pricing updates)
 */
function clearPricingCache() {
  const size = pricingCache.size;
  pricingCache.clear();
  logger.info('Pricing cache cleared', { entriesCleared: size });
  return size;
}

/**
 * Get pricing cache statistics
 */
function getCacheStats() {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;

  pricingCache.forEach(entry => {
    if (now - entry.timestamp < CACHE_TTL) {
      validEntries++;
    } else {
      expiredEntries++;
    }
  });

  return {
    totalEntries: pricingCache.size,
    validEntries,
    expiredEntries,
    cacheTTL: CACHE_TTL
  };
}

module.exports = {
  isCostTrackingEnabled,
  parseModel,
  resolvePricing,
  calculateMessageCost,
  calculateConversationCost,
  formatCost,
  clearPricingCache,
  getCacheStats
};
