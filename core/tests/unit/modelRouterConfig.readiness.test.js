process.env.OLLAMA_HOST = 'http://primary:11434';
process.env.OLLAMA_HOST_SECONDARY = 'http://secondary:11434';
process.env.OLLAMA_HOST_TERTIARY = 'http://tertiary:11434';

const mockResolveAdvisoryHost = jest.fn();
const mockGetModelReadiness = jest.fn();
const mockHostPrefGetByHost = jest.fn();
const mockHostPrefGetPinnedEntries = jest.fn((pref) => pref?.pinnedModels || []);
const mockHostPrefGetDefaultModelsMap = jest.fn(async () => new Map());
const mockCompareReadiness = jest.fn((left, right) => {
  const rank = { available: 0, profiled: 1, adapted: 2, benchmarked: 3 };
  return (rank[right?.stage] || 0) - (rank[left?.stage] || 0);
});
const mockIsReadyStage = jest.fn((stage) => ['profiled', 'adapted', 'benchmarked'].includes(stage));

jest.mock('../../src/helpers/schedulerClient', () => ({
  resolveAdvisoryHost: (...args) => mockResolveAdvisoryHost(...args)
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: (...args) => mockGetModelReadiness(...args),
  compareReadiness: (...args) => mockCompareReadiness(...args),
  isReadyStage: (...args) => mockIsReadyStage(...args)
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: (...args) => mockHostPrefGetByHost(...args),
  getPinnedEntries: (...args) => mockHostPrefGetPinnedEntries(...args),
  getDefaultModelsMap: (...args) => mockHostPrefGetDefaultModelsMap(...args)
}));

describe('modelRouterConfig readiness preference', () => {
  beforeEach(() => {
    jest.resetModules();
    delete process.env.AGENTX_DEFAULT_CHAT_MODEL;
    delete process.env.AGENTX_GENERAL_CHAT_MODEL;
    delete process.env.AGENTX_LIGHTWEIGHT_MODEL;
    delete process.env.AGENTX_UTILITY_MODEL;
    delete process.env.AGENTX_CODING_SPECIALIST_MODEL;
    delete process.env.AGENTX_DEEP_REASONING_MODEL;
    delete process.env.AGENTX_MASTER_BRAIN_MODEL;
    delete process.env.AGENTX_ANALYSIS_MODEL;
    delete process.env.AGENTX_DAILY_OPERATOR_MODEL;
    delete process.env.AGENTX_ROUTER_EMBEDDING_MODEL;
    delete process.env.AGENTX_ROUTER_EMBEDDING_HOST;
    delete process.env.AGENTX_EMBEDDING_HOST;
    delete process.env.AGENTX_CLASSIFIER_HOST;
    delete process.env.AGENTX_CLASSIFIER_MODEL;
    delete process.env.AGENTX_CLASSIFIER_RESPECT_PRIMARY_PIN;
    delete process.env.AGENTX_DEFAULT_CHAT_HOST;
    delete process.env.AGENTX_GENERAL_CHAT_HOST;
    delete process.env.AGENTX_LIGHTWEIGHT_HOST;
    delete process.env.AGENTX_UTILITY_HOST;
    delete process.env.AGENTX_CODING_SPECIALIST_HOST;
    delete process.env.AGENTX_DEEP_REASONING_HOST;
    delete process.env.AGENTX_MASTER_BRAIN_HOST;
    delete process.env.AGENTX_ANALYSIS_HOST;
    delete process.env.AGENTX_DAILY_OPERATOR_HOST;
    mockResolveAdvisoryHost.mockReset();
    mockGetModelReadiness.mockReset();
    mockHostPrefGetByHost.mockReset();
    mockHostPrefGetPinnedEntries.mockReset();
    mockHostPrefGetDefaultModelsMap.mockReset();
    mockHostPrefGetPinnedEntries.mockImplementation((pref) => pref?.pinnedModels || []);
    mockHostPrefGetDefaultModelsMap.mockResolvedValue(new Map());
    mockCompareReadiness.mockClear();
    mockIsReadyStage.mockClear();

    mockResolveAdvisoryHost.mockImplementation(async ({ fallbackHostId, fallbackHostUrl }) => ({
      source: 'fallback',
      hostId: fallbackHostId,
      hostUrl: fallbackHostUrl,
      reason: 'test fallback',
      claimId: null,
      claimExpiresAt: null,
      recommendation: null
    }));
  });

  it('prefers a profiled host for the configured task model', async () => {
    process.env.AGENTX_CODING_SPECIALIST_MODEL = 'ax/qwen3-coder:30b';
    mockGetModelReadiness.mockImplementation(async (_model, hostUrl) => ({
      readiness: {
        stage: hostUrl.includes('secondary') ? 'adapted' : 'available'
      }
    }));

    const config = require('../../src/services/modelRouterConfig');
    const result = await config.getAdvisoryModelForTask('code_generation', { caller: 'unit-test' });

    expect(result.model).toBe('ax/qwen3-coder:30b');
    expect(result.host).toBe('secondary');
    expect(result.url).toBe('http://secondary:11434');
    expect(result.readiness.stage).toBe('adapted');
  });

  it('keeps the configured host when no profiled alternative exists', async () => {
    process.env.AGENTX_CODING_SPECIALIST_MODEL = 'ax/qwen3-coder:30b';
    mockGetModelReadiness.mockResolvedValue({
      readiness: { stage: 'available' }
    });

    const config = require('../../src/services/modelRouterConfig');
    const result = await config.getAdvisoryModelForTask('code_generation', { caller: 'unit-test' });

    expect(result.model).toBe('ax/qwen3-coder:30b');
    expect(result.host).toBe('primary');
    expect(result.url).toBe('http://primary:11434');
    expect(result.readiness).toBeNull();
  });

  it('keeps lightweight tasks on their configured host to avoid swaps', async () => {
    process.env.AGENTX_LIGHTWEIGHT_MODEL = 'ax/qwen3.5:9b';
    mockGetModelReadiness.mockImplementation(async (_model, hostUrl) => ({
      readiness: {
        stage: hostUrl.includes('primary') ? 'adapted' : 'available'
      }
    }));

    const config = require('../../src/services/modelRouterConfig');
    const result = await config.getAdvisoryModelForTask('buddy_reaction', { caller: 'unit-test' });

    expect(result.model).toBe('ax/qwen3.5:9b');
    expect(result.host).toBe('secondary');
    expect(result.url).toBe('http://secondary:11434');
    expect(result.source).toBe('configured_host');
    expect(mockResolveAdvisoryHost).not.toHaveBeenCalled();
    expect(mockGetModelReadiness).not.toHaveBeenCalled();
  });

  it('reports the primary host pin as the effective classifier model', async () => {
    process.env.AGENTX_LIGHTWEIGHT_HOST = 'primary';
    process.env.AGENTX_LIGHTWEIGHT_MODEL = 'ax/gemma4:e4b';
    process.env.AGENTX_CLASSIFIER_HOST = 'primary';
    process.env.AGENTX_CLASSIFIER_MODEL = 'ax/gemma4:e4b';

    mockHostPrefGetByHost.mockResolvedValue({
      hostUrl: 'http://primary:11434',
      pinnedModels: [{ model: 'ax/gemma4:26b-a4b-it-qat' }]
    });

    const config = require('../../src/services/modelRouterConfig');
    const result = await config.resolveClassificationConfig();

    expect(result).toEqual(expect.objectContaining({
      model: 'ax/gemma4:26b-a4b-it-qat',
      configuredModel: 'ax/gemma4:e4b',
      host: 'primary',
      hostUrl: 'http://primary:11434',
      source: 'host_preference_pin'
    }));
  });

  it('separates user general_chat from the direct daily operator lane', () => {
    process.env.AGENTX_DEFAULT_CHAT_MODEL = 'ax/qwen3-coder:30b';
    process.env.AGENTX_LIGHTWEIGHT_MODEL = 'ax/gemma4:e4b';
    process.env.AGENTX_DAILY_OPERATOR_MODEL = 'ax/qwen3-coder:30b';
    process.env.AGENTX_DEFAULT_CHAT_HOST = 'primary';
    process.env.AGENTX_LIGHTWEIGHT_HOST = 'primary';
    process.env.AGENTX_DAILY_OPERATOR_HOST = 'primary';

    const config = require('../../src/services/modelRouterConfig');

    expect(config.TASK_MODELS.general_chat).toEqual({
      model: 'ax/gemma4:e4b',
      host: 'primary'
    });
    expect(config.TASK_MODELS.daily_operator).toEqual({
      model: 'ax/qwen3-coder:30b',
      host: 'primary'
    });
    expect(config.isClassifiableTask('general_chat')).toBe(true);
    expect(config.isClassifiableTask('daily_operator')).toBe(false);
    expect(config.isDirectInvokeTask('daily_operator')).toBe(true);
  });

  it('can express the live family, deep, and coder defaults without persisted overrides (0514)', () => {
    const familyModel = 'ax/gemma4:26b-a4b-it-qat';
    const deepModel = 'ax/gemma4:31b-it-qat';
    process.env.AGENTX_DEFAULT_CHAT_MODEL = familyModel;
    process.env.AGENTX_GENERAL_CHAT_MODEL = familyModel;
    process.env.AGENTX_LIGHTWEIGHT_MODEL = familyModel;
    process.env.AGENTX_UTILITY_MODEL = familyModel;
    process.env.AGENTX_DAILY_OPERATOR_MODEL = familyModel;
    process.env.AGENTX_CODING_SPECIALIST_MODEL = deepModel;
    process.env.AGENTX_DEEP_REASONING_MODEL = deepModel;
    process.env.AGENTX_MASTER_BRAIN_MODEL = deepModel;
    process.env.AGENTX_ANALYSIS_MODEL = familyModel;
    process.env.AGENTX_ROUTER_EMBEDDING_MODEL = 'nomic-embed-text:v1.5';
    process.env.AGENTX_CLASSIFIER_MODEL = familyModel;
    process.env.AGENTX_DEFAULT_CHAT_HOST = 'primary';
    process.env.AGENTX_GENERAL_CHAT_HOST = 'primary';
    process.env.AGENTX_LIGHTWEIGHT_HOST = 'primary';
    process.env.AGENTX_UTILITY_HOST = 'primary';
    process.env.AGENTX_DAILY_OPERATOR_HOST = 'primary';
    process.env.AGENTX_CODING_SPECIALIST_HOST = 'primary';
    process.env.AGENTX_DEEP_REASONING_HOST = 'primary';
    process.env.AGENTX_MASTER_BRAIN_HOST = 'primary';
    process.env.AGENTX_ANALYSIS_HOST = 'primary';
    process.env.AGENTX_ROUTER_EMBEDDING_HOST = 'tertiary';
    process.env.AGENTX_CLASSIFIER_HOST = 'primary';

    const config = require('../../src/services/modelRouterConfig');

    expect(config.getDefaultTaskModels()).toMatchObject({
      quick_chat: { model: familyModel, host: 'primary' },
      general_chat: { model: familyModel, host: 'primary' },
      code_generation: { model: deepModel, host: 'primary' },
      code_review: { model: deepModel, host: 'primary' },
      deep_reasoning: { model: deepModel, host: 'primary' },
      master_brain: { model: deepModel, host: 'primary' },
      analysis: { model: familyModel, host: 'primary' },
      daily_operator: { model: familyModel, host: 'primary' },
      embeddings: { model: 'nomic-embed-text:v1.5', host: 'tertiary' }
    });
    expect(config.CLASSIFICATION_MODEL).toBe(familyModel);
    expect(config.CLASSIFICATION_HOST).toBe('primary');
  });
});
