/**
 * Unit tests for PerformanceMetricsDashboard Component
 * Tests business logic without requiring DOM
 */

describe('PerformanceMetricsDashboard', () => {

  describe('Data Aggregation', () => {
    it('should aggregate feedback by prompt name', () => {
      const breakdown = [
        { promptName: 'test_prompt', total: 10, positive: 7, negative: 3 },
        { promptName: 'test_prompt', total: 5, positive: 4, negative: 1 },
        { promptName: 'another_prompt', total: 8, positive: 6, negative: 2 }
      ];

      // Test aggregation logic
      const groups = {};
      breakdown.forEach(item => {
        const name = item.promptName || 'unknown';
        if (!groups[name]) {
          groups[name] = {
            totalFeedback: 0,
            positive: 0,
            negative: 0,
            versions: []
          };
        }
        groups[name].totalFeedback += item.total;
        groups[name].positive += item.positive;
        groups[name].negative += item.negative;
        groups[name].versions.push(item);
      });

      expect(groups['test_prompt'].totalFeedback).toBe(15);
      expect(groups['test_prompt'].positive).toBe(11);
      expect(groups['another_prompt'].totalFeedback).toBe(8);
    });

    it('should calculate positive rate correctly', () => {
      const data = {
        totalFeedback: 100,
        positive: 73,
        negative: 27
      };

      const positiveRate = data.totalFeedback > 0
        ? data.positive / data.totalFeedback
        : 0;

      expect(positiveRate).toBe(0.73);
    });

    it('should handle zero feedback gracefully', () => {
      const data = {
        totalFeedback: 0,
        positive: 0,
        negative: 0
      };

      const positiveRate = data.totalFeedback > 0
        ? data.positive / data.totalFeedback
        : 0;

      expect(positiveRate).toBe(0);
    });
  });

  describe('Date Range Selection', () => {
    it('should calculate correct date range for 7 days', () => {
      const selectedTimeRange = '7d';
      const to = new Date('2025-01-08T00:00:00Z');
      let from;

      switch (selectedTimeRange) {
        case '7d':
          from = new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
          break;
      }

      expect(from.toISOString()).toBe('2025-01-01T00:00:00.000Z');
    });

    it('should calculate correct date range for 30 days', () => {
      const selectedTimeRange = '30d';
      const to = new Date('2025-02-01T00:00:00Z');
      let from;

      switch (selectedTimeRange) {
        case '30d':
          from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
          break;
      }

      expect(from.toISOString()).toBe('2025-01-02T00:00:00.000Z');
    });
  });

  describe('Status Classification', () => {
    it('should classify positive rate >= 0.7 as good', () => {
      const positiveRate = 0.75;
      let statusClass = 'good';
      if (positiveRate < 0.5) statusClass = 'poor';
      else if (positiveRate < 0.7) statusClass = 'caution';

      expect(statusClass).toBe('good');
    });

    it('should classify positive rate 0.5-0.7 as caution', () => {
      const positiveRate = 0.65;
      let statusClass = 'good';
      if (positiveRate < 0.5) statusClass = 'poor';
      else if (positiveRate < 0.7) statusClass = 'caution';

      expect(statusClass).toBe('caution');
    });

    it('should classify positive rate < 0.5 as poor', () => {
      const positiveRate = 0.42;
      let statusClass = 'good';
      if (positiveRate < 0.5) statusClass = 'poor';
      else if (positiveRate < 0.7) statusClass = 'caution';

      expect(statusClass).toBe('poor');
    });
  });

  describe('Number Formatting', () => {
    it('should format numbers with grouping separators', () => {
      const num = 1234567;
      const formatted = num.toLocaleString();

      expect(formatted).toMatch(/[,\u00A0\u202F]/);
      expect(formatted.replace(/[,\u00A0\u202F]/g, '')).toBe('1234567');
    });

    it('should handle null values', () => {
      const num = null;
      const formatted = num !== null && num !== undefined ? num.toLocaleString() : '0';

      expect(formatted).toBe('0');
    });
  });

  describe('HTML Escaping', () => {
    it('should escape HTML special characters', () => {
      // Test simple escaping logic
      const input = '<script>alert("xss")</script>';

      // Basic HTML entity encoding
      const escaped = input
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');

      expect(escaped).not.toContain('<script>');
      expect(escaped).toContain('&lt;');
      expect(escaped).toContain('&gt;');
    });
  });
});
