'use strict';

const mockFindOne = jest.fn();
const mockGetAllModels = jest.fn();

jest.mock('../../models/RouterTaskConfig', () => ({
  findOne: (...args) => mockFindOne(...args)
}));

jest.mock('../../src/services/modelAggregator', () => ({
  getAllModels: (...args) => mockGetAllModels(...args)
}));

const {
  resolveConfiguredModel,
  resolveCouncilDefaults
} = require('../../src/services/roundtable/defaultResolver');

function lean(value) {
  return { lean: jest.fn().mockResolvedValue(value) };
}

describe('Council default resolver', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFindOne.mockReturnValue(lean(null));
    mockGetAllModels.mockResolvedValue([]);
  });

  test('prefers the Council-specific environment setting without consulting generic fallbacks', async () => {
    await expect(resolveConfiguredModel({
      ROUNDTABLE_MODEL: 'council/model',
      AGENTX_DEFAULT_CHAT_MODEL: 'generic/model'
    })).resolves.toEqual({
      model: 'council/model',
      source: 'environment:ROUNDTABLE_MODEL'
    });
    expect(mockFindOne).not.toHaveBeenCalled();
  });

  test('uses an operator-persisted general-chat override before deployment defaults', async () => {
    mockFindOne.mockReturnValue(lean({ model: 'persisted/model' }));

    await expect(resolveConfiguredModel({
      AGENTX_DEFAULT_CHAT_MODEL: 'environment/model'
    })).resolves.toEqual({
      model: 'persisted/model',
      source: 'routertaskconfigs:general_chat'
    });
  });

  test('discovers only the live runtime catalog and returns an honest empty state', async () => {
    const empty = await resolveCouncilDefaults({ env: {} });
    expect(empty.readiness).toMatchObject({ canStart: false, selectedModel: null });
    expect(mockGetAllModels).toHaveBeenCalledWith(expect.objectContaining({
      includeOllama: true,
      includeCustom: false,
      includeRegistry: false,
      includeEvidence: false,
      useCache: false
    }));

    mockGetAllModels.mockResolvedValueOnce([
      { name: 'live/model', deployment: { status: 'available' } }
    ]);
    const discovered = await resolveCouncilDefaults({ env: {} });
    expect(discovered.readiness).toMatchObject({
      canStart: true,
      selectedModel: 'live/model',
      selectedSource: 'runtime-discovery'
    });
  });
});
