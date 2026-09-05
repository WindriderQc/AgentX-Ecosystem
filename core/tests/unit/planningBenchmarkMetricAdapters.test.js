const mockBenchmarkClient = {
  getBatch: jest.fn(),
  getBatches: jest.fn(),
  getTrustedGeneralistLeaderboard: jest.fn()
};

jest.mock('../../src/services/benchmarkServiceClient', () => ({
  getBenchmarkServiceClient: () => mockBenchmarkClient
}));

const {
  PlanningMetricSourceError,
  execute
} = require('../../src/services/planningMetricAdapterService');

function item(adapter, params) {
  return { progress: { metric: { adapter, params } } };
}

describe('Planning Benchmark metric adapters', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('reads authoritative batch completion by id', async () => {
    mockBenchmarkClient.getBatch.mockResolvedValue({
      _id: '507f1f77bcf86cd799439011',
      status: 'running',
      completed: 3,
      failed: 1,
      total_tests: 4,
      progress: 75
    });

    const result = await execute('benchmark.batch_completion', item(
      'benchmark.batch_completion',
      { batchId: '507f1f77bcf86cd799439011' }
    ), { now: new Date('2026-07-16T18:00:00.000Z') });

    expect(result.value).toBe(75);
    expect(result.metadata).toMatchObject({
      batchId: '507f1f77bcf86cd799439011',
      status: 'running',
      completed: 3,
      failed: 1,
      total: 4
    });
  });

  test('resolves a Planning tag and computes success among completed results', async () => {
    mockBenchmarkClient.getBatches.mockResolvedValue({
      batches: [{
        _id: '507f191e810c19729de860ea',
        tags: ['planning:agentx:benchmark-capability']
      }],
      total: 1
    });
    mockBenchmarkClient.getBatch.mockResolvedValue({
      _id: '507f191e810c19729de860ea',
      status: 'completed',
      completed: 3,
      failed: 1,
      total_tests: 3
    });

    const result = await execute('benchmark.batch_success_rate', item(
      'benchmark.batch_success_rate',
      { tag: 'planning:agentx:benchmark-capability' }
    ));

    expect(result.value).toBe(66.7);
    expect(result.metadata.tag).toBe('planning:agentx:benchmark-capability');
    expect(mockBenchmarkClient.getBatches).toHaveBeenCalledWith({
      tag: 'planning:agentx:benchmark-capability',
      limit: 1
    });
  });

  test('rejects caller-supplied qualified fields until a verified authority bridge exists', async () => {
    mockBenchmarkClient.getTrustedGeneralistLeaderboard.mockResolvedValue({
      trusted: true,
      trustScope: 'trusted',
      trustVerdict: {
        contract: 'agentx.benchmark-consumer-trust/v1',
        qualified: true,
        highConfidenceAllowed: true,
        claim: 'qualified_winner',
        qualifiedWinner: {
          model: 'qwen3:14b',
          host: 'http://ollama-primary:11434'
        }
      },
      leaderboard: [{
        model: 'qwen3:14b',
        host: 'http://ollama-primary:11434',
        generalistScore: 83.4,
        totalTests: 72,
        fullScopeEligible: true,
        evidenceStatus: 'full_scope'
      }]
    });

    await expect(execute('benchmark.trusted_generalist_score', item(
      'benchmark.trusted_generalist_score',
      { model: 'qwen3:14b', hostScope: 'current' }
    ))).rejects.toMatchObject({
      name: 'PlanningMetricSourceError',
      code: 'PLANNING_METRIC_SOURCE_UNQUALIFIED'
    });
  });

  test('rejects a trusted cohort score that has no qualified winner receipt', async () => {
    mockBenchmarkClient.getTrustedGeneralistLeaderboard.mockResolvedValue({
      trusted: true,
      trustScope: 'trusted',
      trustVerdict: {
        contract: 'agentx.benchmark-consumer-trust/v1',
        qualified: false,
        highConfidenceAllowed: false,
        claim: 'no_qualified_winner',
        qualifiedWinner: null
      },
      leaderboard: [{
        model: 'qwen3:14b',
        host: 'http://ollama-primary:11434',
        generalistScore: 99
      }]
    });

    await expect(execute('benchmark.trusted_generalist_score', item(
      'benchmark.trusted_generalist_score',
      { model: 'qwen3:14b', hostScope: 'current' }
    ))).rejects.toMatchObject({
      name: 'PlanningMetricSourceError',
      code: 'PLANNING_METRIC_SOURCE_UNQUALIFIED'
    });
  });

  test('reports outages without inventing a zero', async () => {
    mockBenchmarkClient.getBatch.mockResolvedValue(null);

    await expect(execute('benchmark.batch_completion', item(
      'benchmark.batch_completion',
      { batchId: '507f1f77bcf86cd799439011' }
    ))).rejects.toMatchObject({
      name: 'PlanningMetricSourceError',
      code: 'PLANNING_METRIC_SOURCE_UNAVAILABLE'
    });
  });

  test('distinguishes missing tagged batches from service outages', async () => {
    mockBenchmarkClient.getBatches.mockResolvedValue({
      batches: [{ _id: '507f191e810c19729de860ea', tags: ['other'] }],
      total: 1
    });

    await expect(execute('benchmark.batch_completion', item(
      'benchmark.batch_completion',
      { tag: 'planning:missing' }
    ))).rejects.toMatchObject({
      name: PlanningMetricSourceError.name,
      code: 'PLANNING_METRIC_SOURCE_EMPTY'
    });
  });
});
