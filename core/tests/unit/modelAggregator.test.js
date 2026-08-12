const mockFetch = jest.fn();
const mockCustomFind = jest.fn();
const mockRegistryFind = jest.fn();
const mockBenchmarkAggregate = jest.fn();

jest.mock('node-fetch', () => mockFetch);

jest.mock('../../models/CustomModel', () => ({
  find: (...args) => mockCustomFind(...args)
}));

jest.mock('../../models/ModelRegistry', () => ({
  find: (...args) => mockRegistryFind(...args)
}));

jest.mock('../../models/BenchmarkResult', () => ({
  aggregate: (...args) => mockBenchmarkAggregate(...args)
}), { virtual: true });

jest.mock('../../config/logger', () => ({
  debug: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn()
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getHostUrls: jest.fn(() => ['http://primary:11434', 'http://secondary:11434']),
  getConfiguredHosts: jest.fn(() => [
    { url: 'http://primary:11434', name: 'Primary' },
    { url: 'http://secondary:11434', name: 'Secondary' }
  ]),
  normalizeHostUrl: jest.fn((url) => url)
}));

jest.mock('../../src/services/modelReadinessService', () => {
  const { normalizeModelName } = jest.requireActual('../../src/helpers/modelNameNormalization');
  return {
    getModelReadiness: jest.fn(async () => ({
      readiness: { stage: 'adapted' },
      bestReadiness: { stage: 'adapted' }
    })),
    compareReadiness: jest.fn(() => 0),
    normalizeModelName
  };
});

const modelAggregator = require('../../src/services/modelAggregator');

function leanResult(rows) {
  return { lean: jest.fn().mockResolvedValue(rows) };
}

function ollamaModel(name, size = 100) {
  return {
    name,
    size,
    digest: `${name}-digest`,
    modified_at: '2026-07-03T00:00:00Z',
    details: { family: 'qwen35', parameter_size: '9.7B', quantization_level: 'Q4_K_M' }
  };
}

describe('modelAggregator', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    modelAggregator.clearCache();
    mockCustomFind.mockReturnValue(leanResult([]));
    mockRegistryFind.mockReturnValue(leanResult([
      {
        modelName: 'qwen3.5:9b',
        displayName: 'Retired Qwen3.5 9B',
        categories: [],
        capabilities: { supportsThinking: true, maxContext: 4096 },
        status: 'retired'
      },
      {
        modelName: 'Qwen3.5:9b',
        displayName: 'Qwen3.5 9B',
        categories: ['generalist'],
        capabilities: { supportsThinking: true, maxContext: 8192 },
        status: 'active'
      }
    ]));
    mockBenchmarkAggregate.mockResolvedValue([]);
  });

  it('deduplicates Ollama catalog entries that differ only by model-name case', async () => {
    mockFetch.mockImplementation(async (url) => ({
      ok: true,
      json: async () => ({
        models: url.includes('primary')
          ? [ollamaModel('ax/Qwen3.5:9b', 101)]
          : [ollamaModel('ax/qwen3.5:9b', 102)]
      })
    }));

    const models = await modelAggregator.getAllModels({ useCache: false });
    const qwenModels = models.filter((model) => model.name.toLowerCase() === 'qwen3.5:9b');

    expect(qwenModels).toHaveLength(1);
    expect(qwenModels[0]).toMatchObject({
      name: 'Qwen3.5:9b',
      displayName: 'Qwen3.5 9B',
      deployment: {
        status: 'available',
        resolvedName: 'ax/Qwen3.5:9b'
      },
      registryStatus: 'active'
    });
    expect(qwenModels[0].capabilities).toMatchObject({
      supportsThinking: true,
      thinkingQualified: false,
      thinkingSource: 'model_registry_fallback',
      visibleFinalQualified: false
    });
  });

  it('preserves one actionable row per host when deduplication is disabled', async () => {
    mockRegistryFind.mockReturnValue(leanResult([]));
    mockFetch.mockImplementation(async () => ({
      ok: true,
      json: async () => ({ models: [ollamaModel('qwen2.5:3b')] })
    }));

    const models = await modelAggregator.getAllModels({
      useCache: false,
      deduplicateOllama: false
    });
    const installs = models.filter(model => model.name === 'qwen2.5:3b');

    expect(installs).toHaveLength(2);
    expect(installs.map(model => model.source.url)).toEqual([
      'http://primary:11434',
      'http://secondary:11434'
    ]);
    expect(new Set(installs.map(model => model.id)).size).toBe(2);
  });

  it('does not infer thinking capability from an unprofiled catalog name', async () => {
    mockRegistryFind.mockReturnValue(leanResult([]));
    mockFetch.mockImplementation(async (url) => ({
      ok: true,
      json: async () => ({
        models: url.includes('primary')
          ? [ollamaModel('qwen-mystery-reasoning:1b')]
          : []
      })
    }));

    const models = await modelAggregator.getAllModels({ useCache: false });

    expect(models[0].capabilities).toMatchObject({
      supportsThinking: false,
      thinkingQualified: false,
      thinkingSource: 'unqualified'
    });
  });

  it('surfaces qualified thinking from the deployed host/artifact profile', async () => {
    mockRegistryFind.mockReturnValue(leanResult([]));
    mockFetch.mockImplementation(async (url) => ({
      ok: true,
      json: async () => ({
        models: url.includes('primary')
          ? [ollamaModel('plain-custom-model:8b')]
          : []
      })
    }));

    const models = await modelAggregator.getAllModels({
      useCache: false,
      resolveCapabilityContract: jest.fn(async ({ model, host }) => ({
        version: 'agentx.inference-contract.v1',
        artifact: { model, host, hostId: 'host-alpha' },
        qualification: { state: 'profiled', qualified: true },
        capabilities: {
          thinking: {
            supported: true,
            source: 'benchmark_model_profile',
            visibleFinalAnswer: { qualified: true }
          }
        }
      }))
    });

    expect(models[0].capabilities).toMatchObject({
      supportsThinking: true,
      thinkingQualified: true,
      thinkingSource: 'benchmark_model_profile',
      thinkingQualificationState: 'profiled',
      visibleFinalQualified: true
    });
  });

  it('reports registry source coverage from registry records instead of categories', async () => {
    mockRegistryFind.mockReturnValue(leanResult([
      {
        modelName: 'qwen2.5:7b',
        displayName: 'Qwen2.5 7B',
        categories: [],
        capabilities: { supportsThinking: true, maxContext: 8192 },
        status: 'active',
        isActive: true,
        sourceType: 'ollama'
      },
      {
        modelName: 'retired-model:1b',
        displayName: 'Retired Model',
        categories: ['generalist'],
        status: 'retired',
        isActive: false,
        sourceType: 'ollama'
      }
    ]));
    mockFetch.mockImplementation(async (url) => ({
      ok: true,
      json: async () => ({
        models: url.includes('primary')
          ? [ollamaModel('ax/qwen2.5:7b'), ollamaModel('orphan-model:1b')]
          : []
      })
    }));

    const sources = await modelAggregator.getModelSources();

    expect(sources.ollama).toMatchObject({
      count: 2,
      hosts: [
        { url: 'http://primary:11434', name: 'Primary' },
        { url: 'http://secondary:11434', name: 'Secondary' }
      ]
    });
    expect(sources.registry).toMatchObject({
      count: 1,
      identityCount: 1,
      catalogBackedCount: 1,
      unregisteredAvailableCount: 1,
      missingFromCatalogCount: 0
    });
  });
});
