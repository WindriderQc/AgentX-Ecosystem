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
});
