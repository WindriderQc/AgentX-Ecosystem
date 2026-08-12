/**
 * Unit Tests for Cost Calculator Service
 */

const {
  parseModel,
  calculateMessageCost,
  calculateConversationCost,
  formatCost,
  isCostTrackingEnabled,
  clearPricingCache,
  getCacheStats
} = require('../../src/services/costCalculator');

describe('Cost Calculator Service', () => {
  describe('parseModel', () => {
    it('should parse model with provider prefix', () => {
      const result = parseModel('ollama:llama3');
      expect(result).toEqual({
        provider: 'ollama',
        modelName: 'llama3'
      });
    });

    it('should default to ollama provider when no prefix', () => {
      const result = parseModel('qwen2');
      expect(result).toEqual({
        provider: 'ollama',
        modelName: 'qwen2'
      });
    });

    it('should handle openai models', () => {
      const result = parseModel('openai:gpt-4');
      expect(result).toEqual({
        provider: 'openai',
        modelName: 'gpt-4'
      });
    });

    it('should handle anthropic models', () => {
      const result = parseModel('anthropic:claude-3-opus');
      expect(result).toEqual({
        provider: 'anthropic',
        modelName: 'claude-3-opus'
      });
    });

    it('should handle invalid input gracefully', () => {
      expect(parseModel(null)).toEqual({
        provider: 'ollama',
        modelName: 'unknown'
      });

      expect(parseModel('')).toEqual({
        provider: 'ollama',
        modelName: 'unknown'
      });
    });

    it('should handle colons in model name', () => {
      const result = parseModel('ollama:model:variant:v2');
      expect(result).toEqual({
        provider: 'ollama',
        modelName: 'model:variant:v2'
      });
    });
  });

  describe('calculateMessageCost', () => {
    beforeEach(() => {
      // Set test environment variables
      process.env.COST_TRACKING_ENABLED = 'true';
      process.env.OLLAMA_DEFAULT_PROMPT_COST_PER_1M = '0.00';
      process.env.OLLAMA_DEFAULT_COMPLETION_COST_PER_1M = '0.00';
      clearPricingCache();
    });

    it('should calculate cost for message with token usage', async () => {
      const model = 'ollama:llama3';
      const stats = {
        usage: {
          promptTokens: 100,
          completionTokens: 200,
          totalTokens: 300
        }
      };

      const result = await calculateMessageCost(model, stats);

      expect(result).toHaveProperty('promptTokenCost');
      expect(result).toHaveProperty('completionTokenCost');
      expect(result).toHaveProperty('totalCost');
      expect(result).toHaveProperty('currency', 'USD');
      expect(result).toHaveProperty('pricingSource');
      expect(result).toHaveProperty('calculatedAt');
      expect(result.pricingSource).toHaveProperty('provider', 'ollama');
      expect(result.pricingSource).toHaveProperty('modelName', 'llama3');
    });

    it('should handle missing token data gracefully', async () => {
      const model = 'ollama:llama3';
      const stats = { usage: null };

      const result = await calculateMessageCost(model, stats);

      expect(result.totalCost).toBe(0);
      expect(result.pricingSource.source).toBe('unconfigured');
    });

    it('should handle missing stats gracefully', async () => {
      const model = 'ollama:llama3';
      const stats = null;

      const result = await calculateMessageCost(model, stats);

      expect(result.totalCost).toBe(0);
      expect(result.pricingSource.source).toBe('unconfigured');
    });

    it('should respect COST_TRACKING_ENABLED=false', async () => {
      process.env.COST_TRACKING_ENABLED = 'false';

      const model = 'ollama:llama3';
      const stats = {
        usage: {
          promptTokens: 100,
          completionTokens: 200,
          totalTokens: 300
        }
      };

      const result = await calculateMessageCost(model, stats);

      expect(result.totalCost).toBe(0);
      expect(result.pricingSource.source).toBe('disabled');
    });

    it('should calculate correct costs with pricing', async () => {
      // Set pricing: $5 per 1M prompt tokens, $15 per 1M completion tokens
      process.env.OLLAMA_LLAMA3_PROMPT_COST_PER_1M = '5.00';
      process.env.OLLAMA_LLAMA3_COMPLETION_COST_PER_1M = '15.00';

      const model = 'ollama:llama3';
      const stats = {
        usage: {
          promptTokens: 1000000,  // 1M tokens
          completionTokens: 1000000,  // 1M tokens
          totalTokens: 2000000
        }
      };

      const result = await calculateMessageCost(model, stats);

      expect(result.promptTokenCost).toBe(5.00);
      expect(result.completionTokenCost).toBe(15.00);
      expect(result.totalCost).toBe(20.00);
      expect(result.pricingSource.source).toBe('environment');
    });

    it('should round costs to 6 decimal places', async () => {
      process.env.OLLAMA_LLAMA3_PROMPT_COST_PER_1M = '1.00';
      process.env.OLLAMA_LLAMA3_COMPLETION_COST_PER_1M = '3.00';

      const model = 'ollama:llama3';
      const stats = {
        usage: {
          promptTokens: 123,
          completionTokens: 456,
          totalTokens: 579
        }
      };

      const result = await calculateMessageCost(model, stats);

      // 123 / 1_000_000 * 1.00 = 0.000123
      expect(result.promptTokenCost).toBe(0.000123);
      // 456 / 1_000_000 * 3.00 = 0.001368
      expect(result.completionTokenCost).toBe(0.001368);
      // Total = 0.001491
      expect(result.totalCost).toBe(0.001491);
    });
  });

  describe('calculateConversationCost', () => {
    it('should sum costs from all messages', () => {
      const messages = [
        {
          role: 'user',
          content: 'Hello'
        },
        {
          role: 'assistant',
          content: 'Hi there',
          cost: {
            promptTokenCost: 0.001,
            completionTokenCost: 0.002,
            totalCost: 0.003
          }
        },
        {
          role: 'user',
          content: 'How are you?'
        },
        {
          role: 'assistant',
          content: 'I am fine',
          cost: {
            promptTokenCost: 0.0015,
            completionTokenCost: 0.0025,
            totalCost: 0.004
          }
        }
      ];

      const result = calculateConversationCost(messages);

      expect(result.sum).toBe(0.007); // 0.003 + 0.004
      expect(result.breakdown.promptTokens).toBe(0.0025); // 0.001 + 0.0015
      expect(result.breakdown.completionTokens).toBe(0.0045); // 0.002 + 0.0025
      expect(result.currency).toBe('USD');
      expect(result).toHaveProperty('lastUpdated');
    });

    it('should handle empty messages array', () => {
      const result = calculateConversationCost([]);

      expect(result.sum).toBe(0);
      expect(result.breakdown.promptTokens).toBe(0);
      expect(result.breakdown.completionTokens).toBe(0);
    });

    it('should handle messages without cost data', () => {
      const messages = [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi' }
      ];

      const result = calculateConversationCost(messages);

      expect(result.sum).toBe(0);
    });

    it('should handle mixed messages with and without costs', () => {
      const messages = [
        {
          role: 'assistant',
          content: 'Message with cost',
          cost: { totalCost: 0.005, promptTokenCost: 0.002, completionTokenCost: 0.003 }
        },
        {
          role: 'assistant',
          content: 'Message without cost'
        },
        {
          role: 'assistant',
          content: 'Another with cost',
          cost: { totalCost: 0.003, promptTokenCost: 0.001, completionTokenCost: 0.002 }
        }
      ];

      const result = calculateConversationCost(messages);

      expect(result.sum).toBe(0.008);
    });
  });

  describe('formatCost', () => {
    it('should format zero cost', () => {
      expect(formatCost(0)).toBe('USD 0.00');
    });

    it('should format small costs with 6 decimals', () => {
      expect(formatCost(0.000123, 'USD')).toBe('USD 0.000123');
      expect(formatCost(0.005, 'USD')).toBe('USD 0.005000');
    });

    it('should format regular costs with 2 decimals', () => {
      expect(formatCost(1.5, 'USD')).toBe('USD 1.50');
      expect(formatCost(10.99, 'USD')).toBe('USD 10.99');
      expect(formatCost(100, 'USD')).toBe('USD 100.00');
    });

    it('should handle different currencies', () => {
      expect(formatCost(5.25, 'EUR')).toBe('EUR 5.25');
      expect(formatCost(10, 'GBP')).toBe('GBP 10.00');
    });

    it('should handle invalid input gracefully', () => {
      expect(formatCost(NaN)).toBe('USD 0.00');
      expect(formatCost(null)).toBe('USD 0.00');
      expect(formatCost(undefined)).toBe('USD 0.00');
    });
  });

  describe('isCostTrackingEnabled', () => {
    it('should return true when enabled', () => {
      process.env.COST_TRACKING_ENABLED = 'true';
      expect(isCostTrackingEnabled()).toBe(true);
    });

    it('should return false when disabled', () => {
      process.env.COST_TRACKING_ENABLED = 'false';
      expect(isCostTrackingEnabled()).toBe(false);
    });

    it('should default to true when not set', () => {
      delete process.env.COST_TRACKING_ENABLED;
      expect(isCostTrackingEnabled()).toBe(true);
    });
  });

  describe('Cache Management', () => {
    beforeEach(() => {
      clearPricingCache();
    });

    it('should clear cache and return count', () => {
      const count = clearPricingCache();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should return cache statistics', () => {
      const stats = getCacheStats();

      expect(stats).toHaveProperty('totalEntries');
      expect(stats).toHaveProperty('validEntries');
      expect(stats).toHaveProperty('expiredEntries');
      expect(stats).toHaveProperty('cacheTTL');
      expect(typeof stats.totalEntries).toBe('number');
      expect(typeof stats.validEntries).toBe('number');
      expect(typeof stats.expiredEntries).toBe('number');
      expect(typeof stats.cacheTTL).toBe('number');
    });
  });
});
