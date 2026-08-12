/**
 * Token Counter Service
 *
 * Provides token estimation and cost calculation for various LLM models.
 * Used for usage tracking and analytics.
 */

const logger = require('../../config/logger');

// Default pricing rates (USD per 1M tokens)
// These can be overridden or extended
const MODEL_COSTS = {
  // OpenAI (reference)
  'gpt-4': { prompt: 30.00, completion: 60.00 },
  'gpt-3.5-turbo': { prompt: 0.50, completion: 1.50 },
  'gpt-4o': { prompt: 5.00, completion: 15.00 },
  'gpt-4o-mini': { prompt: 0.15, completion: 0.60 },

  // Anthropic
  'claude-3-5-sonnet-20240620': { prompt: 3.00, completion: 15.00 },
  'claude-3-opus-20240229': { prompt: 15.00, completion: 75.00 },
  'claude-3-haiku-20240307': { prompt: 0.25, completion: 1.25 },

  // Ollama models (compute cost estimates or cloud equivalent)
  'llama3.1:8b': { prompt: 0.10, completion: 0.20 },
  'llama3.1:70b': { prompt: 0.50, completion: 1.00 },
  'deepseek-r1:70b': { prompt: 0.50, completion: 1.00 },
  'qwen2.5:7b': { prompt: 0.05, completion: 0.10 },
  'mistral:7b': { prompt: 0.10, completion: 0.20 },
  'qwen2.5:72b': { prompt: 0.50, completion: 1.00 },
  'phi3:medium': { prompt: 0.10, completion: 0.20 },

  // Default for unknown models
  'default': { prompt: 0.10, completion: 0.20 }
};

class TokenCounterService {
  constructor() {
    this.CHARS_PER_TOKEN = 4;
    this.modelCosts = { ...MODEL_COSTS };
  }

  /**
   * Estimate token count from text
   * @param {string} text - The text to process
   * @returns {number} Estimated token count
   */
  countTokens(text) {
    if (!text) return 0;
    return Math.ceil(text.length / this.CHARS_PER_TOKEN);
  }

  /**
   * Get pricing info for a model
   * @param {string} model - Model identifier
   * @returns {Object} { prompt: number, completion: number }
   */
  getModelPricing(model) {
    if (!model) return this.modelCosts.default;

    // exact match
    if (this.modelCosts[model]) {
      return this.modelCosts[model];
    }

    // partial match (e.g. gpt-4-0613 matching gpt-4)
    const knownModels = Object.keys(this.modelCosts);
    const match = knownModels.find(m => model.includes(m));

    if (match) {
      return this.modelCosts[match];
    }

    return this.modelCosts.default;
  }

  /**
   * Calculate USD cost for tokens
   * @param {string} model - Model identifier
   * @param {number} promptTokens - Number of prompt tokens
   * @param {number} completionTokens - Number of completion tokens
   * @returns {number} Total cost in USD
   */
  calculateCost(model, promptTokens, completionTokens) {
    const pricing = this.getModelPricing(model);

    const promptCost = (promptTokens / 1000000) * pricing.prompt;
    const completionCost = (completionTokens / 1000000) * pricing.completion;

    return promptCost + completionCost;
  }

  /**
   * Analyze a full conversation to calculate usage stats
   * @param {Object} conversation - The conversation object
   * @returns {Object} { promptTokens, completionTokens, totalTokens, cost, model }
   */
  analyzeConversation(conversation) {
    if (!conversation || !conversation.messages) {
      return {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cost: 0,
        model: conversation.model || 'unknown'
      };
    }

    let promptTokens = 0;
    let completionTokens = 0;

    conversation.messages.forEach(msg => {
      const tokens = this.countTokens(msg.content);

      if (msg.role === 'user' || msg.role === 'system') {
        promptTokens += tokens;
      } else if (msg.role === 'assistant') {
        completionTokens += tokens;
      }
    });

    const totalTokens = promptTokens + completionTokens;
    const cost = this.calculateCost(conversation.model, promptTokens, completionTokens);

    return {
      promptTokens,
      completionTokens,
      totalTokens,
      cost,
      model: conversation.model
    };
  }
}

// Singleton instance
let instance = null;

function getTokenCounter() {
  if (!instance) {
    instance = new TokenCounterService();
  }
  return instance;
}

module.exports = { getTokenCounter };
