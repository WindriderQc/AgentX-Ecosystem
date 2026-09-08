'use strict';

const mockModelRegistry = {
  find: jest.fn(),
  schema: {
    path: jest.fn(() => ({ caster: { enumValues: ['coding'] } }))
  }
};

jest.mock('../../models/ModelRegistry', () => mockModelRegistry);

const queries = require('../../src/services/modelRegistryQueries');

function mongoQuery(result = []) {
  const query = {
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    lean: jest.fn(async () => result)
  };
  return query;
}

describe('Model Registry Benchmark Trust boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('category browsing never sorts by legacy composite score', async () => {
    const query = mongoQuery([]);
    mockModelRegistry.find.mockReturnValue(query);

    await queries.findByCategory('coding');

    expect(query.sort).toHaveBeenCalledWith({ displayName: 1, modelName: 1 });
  });

  test('task selection uses explicit routing priority and not legacy composite score', async () => {
    const query = mongoQuery([{ modelName: 'model-a' }]);
    mockModelRegistry.find.mockReturnValue(query);

    await queries.getBestForTask('coding');

    expect(query.sort).toHaveBeenCalledWith({
      'routingRules.priority': -1,
      displayName: 1,
      modelName: 1
    });
  });

  test('category groups are alphabetical even when an observation has a higher score', async () => {
    mockModelRegistry.find.mockReturnValue(mongoQuery([
      { modelName: 'z-model', displayName: 'Zulu', categories: ['coding'], benchmarkStats: { avgCompositeScore: 99 } },
      { modelName: 'a-model', displayName: 'Alpha', categories: ['coding'], benchmarkStats: { avgCompositeScore: 1 } }
    ]));

    const grouped = await queries.getGroupedByCategory();

    expect(grouped.coding.map((model) => model.displayName)).toEqual(['Alpha', 'Zulu']);
  });

  test('category score summaries label legacy values as unqualified observations', async () => {
    mockModelRegistry.find.mockReturnValue(mongoQuery([
      { modelName: 'a-model', categories: ['coding'], benchmarkStats: { avgCompositeScore: 80 } }
    ]));

    const stats = await queries.getCategoryStats();

    expect(stats.coding).toMatchObject({
      avgCompositeScore: 80,
      benchmarkEvidence: {
        state: 'exploratory',
        qualified: false,
        claim: 'legacy_observations'
      }
    });
  });

  test('uncategorized discovered models remain visible in both statistics and groups without invented scores', async () => {
    const models = [
      { modelName: 'current-model', categories: [], benchmarkStats: { avgCompositeScore: 0, totalTests: 0 } },
      { modelName: 'another-model', categories: [] }
    ];
    mockModelRegistry.find.mockReturnValue(mongoQuery(models));
    expect((await queries.getCategoryStats()).uncategorized).toMatchObject({
      count: 2, models: ['current-model', 'another-model'], avgCompositeScore: null, avgLatency: null,
      benchmarkEvidence: { qualified: false }
    });
    expect((await queries.getGroupedByCategory()).uncategorized).toEqual(models.slice().reverse());
  });

  test('unmeasured defaults do not dilute observed averages, including a measured zero score', async () => {
    mockModelRegistry.find.mockReturnValue(mongoQuery([
      { modelName: 'unmeasured', categories: ['coding'], benchmarkStats: { avgCompositeScore: 0, totalTests: 0 } },
      { modelName: 'measured-zero', categories: ['coding'], benchmarkStats: { avgCompositeScore: 0, totalTests: 2 }, capabilities: { avgLatencyMs: 100 } },
      { modelName: 'measured-high', categories: ['coding'], benchmarkStats: { avgCompositeScore: 80, totalTests: 2 }, capabilities: { avgLatencyMs: 300 } }
    ]));
    expect((await queries.getCategoryStats()).coding).toMatchObject({
      count: 3, avgCompositeScore: 40, avgLatency: 200
    });
  });
});
