const artilleryParser = require('../../src/services/artilleryParser');

/**
 * Artillery Parser Service Tests
 *
 * Tests for parsing Artillery JSON output and extracting performance metrics.
 * Covers happy paths, edge cases, and error handling.
 *
 * @see /src/services/artilleryParser.js
 */

describe('Artillery Parser Service', () => {
  // Sample valid Artillery report
  const validReport = {
    aggregate: {
      duration: 120000, // 2 minutes in milliseconds
      counters: {
        'vusers.created': 100,
        'vusers.completed': 95,
        'http.requests': 500,
        'errors.total': 5,
        'http.codes.200': 450,
        'http.codes.404': 10,
        'http.codes.500': 5
      },
      rates: {
        'http.request_rate': {
          mean: 4.16,
          max: 10.5
        }
      },
      summaries: {
        'http.response_time': {
          min: 10,
          max: 1500,
          median: 250,
          p50: 250,
          p95: 800,
          p99: 1200
        }
      }
    },
    config: {
      target: 'http://localhost:3080',
      phases: [
        { duration: 60, arrivalRate: 5 },
        { duration: 60, arrivalRate: 10 }
      ]
    }
  };

  describe('parseArtilleryReport', () => {
    it('should parse valid Artillery report successfully', () => {
      const result = artilleryParser.parseArtilleryReport(validReport);

      expect(result).toHaveProperty('summary');
      expect(result).toHaveProperty('latency');
      expect(result).toHaveProperty('codes');
      expect(result).toHaveProperty('error_counts');
      expect(result).toHaveProperty('config');
    });

    it('should extract correct summary metrics', () => {
      const result = artilleryParser.parseArtilleryReport(validReport);

      expect(result.summary.duration).toBe(120); // Converted to seconds
      expect(result.summary.scenarios_created).toBe(100);
      expect(result.summary.scenarios_completed).toBe(95);
      expect(result.summary.requests_completed).toBe(500);
      expect(result.summary.rps_mean).toBe(4.16);
      expect(result.summary.rps_max).toBe(10.5);
    });

    it('should calculate error rate correctly', () => {
      const result = artilleryParser.parseArtilleryReport(validReport);

      // 5 errors out of 500 requests = 1%
      expect(result.summary.error_rate).toBe(1.00);
    });

    it('should extract latency metrics', () => {
      const result = artilleryParser.parseArtilleryReport(validReport);

      expect(result.latency.min).toBe(10);
      expect(result.latency.max).toBe(1500);
      expect(result.latency.median).toBe(250);
      expect(result.latency.p95).toBe(800);
      expect(result.latency.p99).toBe(1200);
    });

    it('should extract HTTP status codes', () => {
      const result = artilleryParser.parseArtilleryReport(validReport);

      expect(result.codes).toEqual({
        '200': 450,
        '404': 10,
        '500': 5
      });
    });

    it('should extract configuration', () => {
      const result = artilleryParser.parseArtilleryReport(validReport);

      expect(result.config).toHaveProperty('target');
      expect(result.config.target).toBe('http://localhost:3080');
      expect(result.config.phases).toHaveLength(2);
    });

    it('should throw error for null report', () => {
      expect(() => {
        artilleryParser.parseArtilleryReport(null);
      }).toThrow('Invalid Artillery report: must be an object');
    });

    it('should throw error for report without aggregate', () => {
      expect(() => {
        artilleryParser.parseArtilleryReport({ some: 'data' });
      }).toThrow('Invalid Artillery report: missing aggregate field');
    });

    it('should handle missing optional fields gracefully', () => {
      const minimalReport = {
        aggregate: {
          counters: {},
          rates: {},
          summaries: {}
        }
      };

      const result = artilleryParser.parseArtilleryReport(minimalReport);

      expect(result.summary.duration).toBe(0);
      expect(result.summary.requests_completed).toBe(0);
      expect(result.summary.error_rate).toBe(0);
      expect(result.latency.min).toBe(0);
      expect(result.codes).toEqual({});
    });
  });

  describe('validateReport', () => {
    it('should validate correct report', () => {
      const validation = artilleryParser.validateReport(validReport);

      expect(validation.valid).toBe(true);
      expect(validation.errors).toHaveLength(0);
    });

    it('should reject null report', () => {
      const validation = artilleryParser.validateReport(null);

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Report must be a valid JSON object');
    });

    it('should reject report without aggregate', () => {
      const validation = artilleryParser.validateReport({});

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing required field: aggregate');
    });

    it('should reject report without counters', () => {
      const validation = artilleryParser.validateReport({
        aggregate: {
          summaries: {}
        }
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing required field: aggregate.counters');
    });

    it('should reject report without summaries', () => {
      const validation = artilleryParser.validateReport({
        aggregate: {
          counters: {}
        }
      });

      expect(validation.valid).toBe(false);
      expect(validation.errors).toContain('Missing required field: aggregate.summaries');
    });
  });

  describe('calculatePercentile', () => {
    it('should calculate median correctly', () => {
      const latencies = [100, 200, 300, 400, 500];
      const p50 = artilleryParser.calculatePercentile(latencies, 50);

      expect(p50).toBe(300);
    });

    it('should calculate p95 correctly', () => {
      const latencies = Array.from({ length: 100 }, (_, i) => i + 1);
      const p95 = artilleryParser.calculatePercentile(latencies, 95);

      expect(p95).toBe(95);
    });

    it('should handle empty array', () => {
      const p50 = artilleryParser.calculatePercentile([], 50);

      expect(p50).toBe(0);
    });

    it('should handle single value', () => {
      const p95 = artilleryParser.calculatePercentile([100], 95);

      expect(p95).toBe(100);
    });

    it('should not mutate input array', () => {
      const latencies = [500, 100, 300, 200, 400];
      const original = [...latencies];

      artilleryParser.calculatePercentile(latencies, 50);

      expect(latencies).toEqual(original);
    });
  });

  describe('extractScenarioMetrics', () => {
    it('should extract scenario metrics from intermediate data', () => {
      const reportWithIntermediate = {
        ...validReport,
        intermediate: [
          {
            timestamp: 1704283200000,
            counters: {
              'http.requests': 50,
              'errors.total': 1
            },
            summaries: {
              'http.response_time': {
                p95: 300
              }
            }
          },
          {
            timestamp: 1704283260000,
            counters: {
              'http.requests': 75,
              'errors.total': 2
            },
            summaries: {
              'http.response_time': {
                p95: 450
              }
            }
          }
        ]
      };

      const scenarios = artilleryParser.extractScenarioMetrics(reportWithIntermediate);

      expect(scenarios).toHaveLength(2);
      expect(scenarios[0]).toMatchObject({
        interval: 0,
        requests: 50,
        latency_p95: 300,
        errors: 1
      });
      expect(scenarios[1]).toMatchObject({
        interval: 1,
        requests: 75,
        latency_p95: 450,
        errors: 2
      });
    });

    it('should return empty array if no intermediate data', () => {
      const scenarios = artilleryParser.extractScenarioMetrics(validReport);

      expect(scenarios).toEqual([]);
    });
  });

  describe('generateSummary', () => {
    it('should generate human-readable summary', () => {
      const parsed = artilleryParser.parseArtilleryReport(validReport);
      const summary = artilleryParser.generateSummary(parsed);

      expect(summary).toContain('Test Duration: 120s');
      expect(summary).toContain('Requests Completed: 500');
      expect(summary).toContain('Error Rate: 1%');
      expect(summary).toContain('Median (p50): 250ms');
      expect(summary).toContain('p95: 800ms');
      expect(summary).toContain('p99: 1200ms');
    });

    it('should include HTTP codes in summary', () => {
      const parsed = artilleryParser.parseArtilleryReport(validReport);
      const summary = artilleryParser.generateSummary(parsed);

      expect(summary).toContain('HTTP Status Codes');
      expect(summary).toContain('200');
    });

    it('should include error count', () => {
      const parsed = artilleryParser.parseArtilleryReport(validReport);
      const summary = artilleryParser.generateSummary(parsed);

      expect(summary).toContain('Total Errors: 5');
    });
  });

  describe('Edge Cases', () => {
    it('should handle report with zero requests', () => {
      const zeroRequestsReport = {
        aggregate: {
          counters: {
            'vusers.created': 0,
            'vusers.completed': 0,
            'http.requests': 0
          },
          rates: {},
          summaries: {
            'http.response_time': {}
          }
        }
      };

      const result = artilleryParser.parseArtilleryReport(zeroRequestsReport);

      expect(result.summary.requests_completed).toBe(0);
      expect(result.summary.error_rate).toBe(0);
    });

    it('should handle report with 100% error rate', () => {
      const allErrorsReport = {
        aggregate: {
          counters: {
            'http.requests': 100,
            'errors.total': 100
          },
          rates: {},
          summaries: {
            'http.response_time': {}
          }
        }
      };

      const result = artilleryParser.parseArtilleryReport(allErrorsReport);

      expect(result.summary.error_rate).toBe(100);
    });

    it('should handle missing p50 fallback to median', () => {
      const noP50Report = {
        aggregate: {
          counters: {},
          rates: {},
          summaries: {
            'http.response_time': {
              median: 350
              // p50 missing
            }
          }
        }
      };

      const result = artilleryParser.parseArtilleryReport(noP50Report);

      expect(result.latency.median).toBe(350);
    });

    it('should handle extremely large latency values', () => {
      const largeLatencyReport = {
        aggregate: {
          counters: {},
          rates: {},
          summaries: {
            'http.response_time': {
              min: 50000,
              max: 500000,
              median: 250000,
              p95: 450000,
              p99: 490000
            }
          }
        }
      };

      const result = artilleryParser.parseArtilleryReport(largeLatencyReport);

      expect(result.latency.max).toBe(500000);
      expect(result.latency.p99).toBe(490000);
    });

    it('should handle multiple error types', () => {
      const multiErrorReport = {
        aggregate: {
          counters: {
            'errors.total': 25,
            'errors.ECONNREFUSED': 10,
            'errors.ETIMEDOUT': 8,
            'errors.ENOTFOUND': 7
          },
          rates: {},
          summaries: {}
        }
      };

      const result = artilleryParser.parseArtilleryReport(multiErrorReport);

      expect(result.error_counts.total).toBe(25);
      expect(result.error_counts.ECONNREFUSED).toBe(10);
      expect(result.error_counts.ETIMEDOUT).toBe(8);
      expect(result.error_counts.ENOTFOUND).toBe(7);
    });
  });

  describe('Internal Extraction Functions', () => {
    describe('extractSummary', () => {
      it('should extract all summary fields', () => {
        const summary = artilleryParser.extractSummary(validReport.aggregate);

        expect(summary).toHaveProperty('duration');
        expect(summary).toHaveProperty('scenarios_completed');
        expect(summary).toHaveProperty('scenarios_created');
        expect(summary).toHaveProperty('requests_completed');
        expect(summary).toHaveProperty('error_rate');
        expect(summary).toHaveProperty('rps_mean');
        expect(summary).toHaveProperty('rps_max');
      });

      it('should handle missing rates', () => {
        const aggregateNoRates = {
          counters: { 'http.requests': 100 },
          summaries: {}
        };

        const summary = artilleryParser.extractSummary(aggregateNoRates);

        expect(summary.rps_mean).toBe(0);
        expect(summary.rps_max).toBe(0);
      });
    });

    describe('extractLatency', () => {
      it('should extract all latency percentiles', () => {
        const latency = artilleryParser.extractLatency(validReport.aggregate);

        expect(latency.min).toBeDefined();
        expect(latency.max).toBeDefined();
        expect(latency.median).toBeDefined();
        expect(latency.p95).toBeDefined();
        expect(latency.p99).toBeDefined();
      });

      it('should default to 0 for missing latency values', () => {
        const aggregateNoLatency = {
          summaries: {}
        };

        const latency = artilleryParser.extractLatency(aggregateNoLatency);

        expect(latency.min).toBe(0);
        expect(latency.max).toBe(0);
        expect(latency.median).toBe(0);
      });
    });

    describe('extractCodes', () => {
      it('should extract only HTTP status codes', () => {
        const codes = artilleryParser.extractCodes(validReport.aggregate);

        expect(codes).toHaveProperty('200');
        expect(codes).toHaveProperty('404');
        expect(codes).toHaveProperty('500');
        expect(codes).not.toHaveProperty('vusers.created');
      });
    });

    describe('extractErrors', () => {
      it('should extract error total and types', () => {
        const aggregate = {
          counters: {
            'errors.total': 15,
            'errors.TIMEOUT': 10,
            'errors.CONNECTION': 5
          }
        };

        const errors = artilleryParser.extractErrors(aggregate);

        expect(errors.total).toBe(15);
        expect(errors.TIMEOUT).toBe(10);
        expect(errors.CONNECTION).toBe(5);
      });
    });

    describe('extractConfig', () => {
      it('should extract configuration when present', () => {
        const config = artilleryParser.extractConfig(validReport);

        expect(config.target).toBe('http://localhost:3080');
        expect(config.phases).toHaveLength(2);
      });

      it('should return null when config missing', () => {
        const config = artilleryParser.extractConfig({ aggregate: {} });

        expect(config).toBeNull();
      });
    });
  });
});
