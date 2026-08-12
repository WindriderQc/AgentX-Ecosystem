'use strict';

const mockAggregate = jest.fn();

jest.mock('../../models/InferenceLog', () => ({
  aggregate: (...args) => mockAggregate(...args),
}));

const { getNestorMetrics } = require('../../src/services/nestorConsumerMetricsService');

describe('Nestor consumer telemetry aggregate', () => {
  beforeEach(() => jest.clearAllMocks());

  it('filters by nestor/* and reports latency, tokens, routing, and fallbacks', async () => {
    mockAggregate.mockResolvedValue([
      {
        status: 'success', tokensIn: 10, tokensOut: 4, durationMs: 100,
        model: 'm1', routedHost: 'primary', taskType: 'buddy_chat', routingSource: 'task_router',
      },
      {
        status: 'error', tokensIn: 3, tokensOut: 0, durationMs: 900,
        model: 'm2', host: 'secondary', taskType: 'analysis', routingSource: 'fallback', fallbackUsed: true,
      },
      {
        status: 'success', tokensIn: 5, tokensOut: 2, durationMs: 300,
        model: 'm1', routedHost: 'primary', taskType: 'buddy_chat', routingSource: 'task_router',
      },
    ]);

    const result = await getNestorMetrics({ hours: 6, taskType: 'buddy_chat' });
    const pipeline = mockAggregate.mock.calls[0][0];
    expect(pipeline[0].$match.consumerContract).toBe('nestor-v1');
    expect(String(pipeline[0].$match.callerDetail)).toBe('/^nestor\\//');
    expect(pipeline[0].$match.taskType).toBe('buddy_chat');
    expect(result).toEqual(expect.objectContaining({
      calls: 3,
      successes: 2,
      errors: 1,
      errorRate: 33.33,
      fallbacks: 1,
    }));
    expect(result.tokens).toEqual({ in: 18, out: 6, total: 24 });
    expect(result.latencyMs).toEqual({ average: 433, p50: 300, p95: 900 });
    expect(result.distributions.operations).toEqual({ chat: 2, analyze: 1 });
  });

  it('rejects unknown task filters instead of silently broadening the query', async () => {
    await expect(getNestorMetrics({ taskType: 'untrusted-task' })).rejects.toMatchObject({
      statusCode: 400,
      code: 'UNKNOWN_NESTOR_TASK_TYPE',
    });
    expect(mockAggregate).not.toHaveBeenCalled();
  });
});
