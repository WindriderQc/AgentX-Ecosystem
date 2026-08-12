const {
  catalog,
  validateBinding,
  validateParams
} = require('../../src/services/planningMetricRegistry');

describe('planningMetricRegistry', () => {
  test('publishes only the allowlisted initial adapter catalog', () => {
    expect(catalog().map((entry) => entry.adapter)).toEqual([
      'pipeline.progress',
      'pipeline.done_ratio',
      'alerts.active_count',
      'schedule.success_rate',
      'schedule.consecutive_errors',
      'benchmark.batch_completion',
      'benchmark.batch_success_rate',
      'benchmark.trusted_generalist_score'
    ]);
  });

  test('rejects unknown adapters and arbitrary parameters', () => {
    expect(() => validateBinding('https://example.com/metric', {}))
      .toThrow('Unknown Planning metric adapter');
    expect(() => validateParams('alerts.active_count', { url: 'https://example.com' }))
      .toThrow('Unsupported alerts.active_count parameter');
  });

  test('normalizes bounded alert filters', () => {
    expect(validateBinding('alerts.active_count', {
      status: 'active',
      severity: 'critical',
      component: 'ollama-primary',
      olderThanMs: 86400000
    })).toEqual({
      adapter: 'alerts.active_count',
      params: {
        status: 'active',
        severity: 'critical',
        component: 'ollama-primary',
        olderThanMs: 86400000
      }
    });
  });

  test('requires one safe Benchmark batch selector', () => {
    expect(validateBinding('benchmark.batch_completion', {
      batchId: '507f1f77bcf86cd799439011'
    })).toEqual({
      adapter: 'benchmark.batch_completion',
      params: { batchId: '507f1f77bcf86cd799439011' }
    });
    expect(validateBinding('benchmark.batch_success_rate', {
      tag: 'planning:agentx:benchmark-capability'
    })).toEqual({
      adapter: 'benchmark.batch_success_rate',
      params: { tag: 'planning:agentx:benchmark-capability' }
    });
    expect(() => validateBinding('benchmark.batch_completion', {}))
      .toThrow('Exactly one of batchId|tag is required');
    expect(() => validateBinding('benchmark.batch_completion', {
      batchId: '507f1f77bcf86cd799439011',
      tag: 'planning:agentx:benchmark-capability'
    })).toThrow('Exactly one of batchId|tag is required');
    expect(() => validateBinding('benchmark.batch_completion', { tag: 'https://example.com' }))
      .toThrow('tag has an invalid format');
  });

  test('requires a model for trusted generalist scores', () => {
    expect(validateBinding('benchmark.trusted_generalist_score', { model: 'qwen3:14b' }))
      .toEqual({
        adapter: 'benchmark.trusted_generalist_score',
        params: { model: 'qwen3:14b', hostScope: 'current' }
      });
    expect(() => validateBinding('benchmark.trusted_generalist_score', {}))
      .toThrow('model is required');
  });
});
