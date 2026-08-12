'use strict';

jest.mock('../../models/ModelRegistry', () => ({
  find: jest.fn()
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getAll: jest.fn(),
  getPinnedEntries: jest.fn((pref) => pref?.pinnedModels || [])
}));

jest.mock('../../src/services/modelRouterConfig', () => ({
  buildRouterConfigPayload: jest.fn()
}));

jest.mock('../../src/services/modelContextInfoService', () => ({
  getContextInfo: jest.fn()
}));

jest.mock('../../src/services/inferenceContractService', () => {
  const actual = jest.requireActual('../../src/services/inferenceContractService');
  return {
    ...actual,
    resolveInferenceContract: jest.fn()
  };
});

const ModelRegistry = require('../../models/ModelRegistry');
const hostPrefService = require('../../src/services/hostPreferenceService');
const { buildRouterConfigPayload } = require('../../src/services/modelRouterConfig');
const { getContextInfo } = require('../../src/services/modelContextInfoService');
const { resolveInferenceContract } = require('../../src/services/inferenceContractService');
const {
  buildAgentRuntimeConfigExport,
  validateRuntimeConfigs,
  compareHermesConfig,
  compareOpenClawConfig,
  parseParameterB
} = require('../../src/services/agentRuntimeConfigService');

function mockModelRegistryReturning(docs) {
  const chain = {
    select: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve(docs))
  };
  ModelRegistry.find.mockReturnValue(chain);
}

describe('agentRuntimeConfigService', () => {
  beforeEach(() => {
    jest.clearAllMocks();

    buildRouterConfigPayload.mockResolvedValue({
      taskModels: {
        general_chat: { model: 'ax/gemma4:e4b', host: 'secondary' },
        daily_operator: { model: 'ax/gemma4:26b-a4b-it-qat', host: 'primary' },
        code_generation: { model: 'ax/qwen3-coder:30b', host: 'primary' },
        master_brain: { model: 'ax/gemma4:31b-it-qat', host: 'primary' }
      },
      defaults: {
        taskModels: {
          general_chat: { model: 'ax/gemma4:e4b', host: 'secondary' },
          daily_operator: { model: 'ax/gemma4:26b-a4b-it-qat', host: 'primary' },
          code_generation: { model: 'ax/qwen3-coder:30b', host: 'primary' },
          master_brain: { model: 'ax/gemma4:31b-it-qat', host: 'primary' }
        }
      },
      hosts: {
        primary: 'http://192.0.2.105:11434',
        secondary: 'http://192.0.2.12:11434',
        tertiary: 'http://192.0.2.99:11434'
      }
    });

    hostPrefService.getAll.mockResolvedValue([
      {
        hostUrl: 'http://192.0.2.105:11434',
        displayName: 'Host Alpha',
        status: 'ready',
        loadedModel: 'ax/gemma4:26b-a4b-it-qat',
        loadedModels: ['ax/gemma4:26b-a4b-it-qat'],
        maxConcurrentModels: 1,
        vramTotalMiB: 49152,
        pinnedModels: [
          {
            model: 'ax/gemma4:26b-a4b-it-qat',
            keepAlive: -1,
            contextSize: 65536,
            autoRestore: true
          }
        ]
      }
    ]);

    getContextInfo.mockImplementation(async (model) => ({
      model,
      host: 'http://192.0.2.105:11434',
      num_ctx: model === 'ax/qwen3-coder:30b' ? 16384 : 65536,
      source: 'benchmark_model_profile'
    }));
    resolveInferenceContract.mockImplementation(async ({ model, host }) => ({
      version: 'agentx.inference-contract.v1',
      artifact: { model, host, hostId: 'host-alpha' },
      qualification: { state: 'profiled', qualified: true },
      contextBudget: {
        windowTokens: model === 'ax/qwen3-coder:30b' ? 16384 : 65536,
        validatedWindowTokens: model === 'ax/qwen3-coder:30b' ? 16384 : 65536,
        resolvedSource: 'benchmark_model_profile',
        warnings: [],
        transformations: {
          condensation: { applied: false, removedTokens: 0 },
          truncation: { applied: false, removedTokens: 0 }
        }
      },
      capabilities: {
        thinking: {
          supported: true,
          source: 'benchmark_model_profile',
          visibleFinalAnswer: { qualified: true }
        }
      }
    }));

    mockModelRegistryReturning([
      {
        modelName: 'ax/qwen3-coder:30b',
        sourceHost: 'http://192.0.2.105:11434',
        parameterSize: '30B'
      },
      {
        modelName: 'ax/gemma4:31b-it-qat',
        sourceHost: 'http://192.0.2.105:11434',
        parameterSize: '31B',
        quantization: 'QAT'
      },
      {
        modelName: 'qwen3.6:72b-q4_K_M',
        sourceHost: 'http://192.0.2.105:11434',
        parameterSize: '72B',
        quantization: 'Q4_K_M'
      }
    ]);
  });

  it('exports general, coding-specialist, and quality-max lanes from router + host profiles', async () => {
    const data = await buildAgentRuntimeConfigExport({
      coreBaseUrl: 'http://192.0.2.99:3080'
    });

    expect(data.coreBaseUrl).toBe('http://192.0.2.99:3080');
    expect(data.lanes.daily).toEqual(expect.objectContaining({
      role: 'daily',
      taskType: 'daily_operator',
      taskModel: 'ax/gemma4:26b-a4b-it-qat',
      model: 'ax/gemma4:26b-a4b-it-qat',
      hostUrl: 'http://192.0.2.105:11434',
      contextSize: 65536,
      contextSource: 'host_preference_pin',
      pinAligned: true
    }));

    expect(data.lanes.codingSpecialist).toEqual(expect.objectContaining({
      role: 'codingSpecialist',
      taskType: 'code_generation',
      taskModel: 'ax/qwen3-coder:30b',
      model: 'ax/qwen3-coder:30b',
      contextSize: 16384,
      contextSource: 'benchmark_model_profile',
      pinAligned: false,
      executionPolicy: {
        responseMode: 'final_only',
        thinkingMode: 'off',
        visibleFinalRequired: true,
        recommendedOutputTokens: 4096
      }
    }));

    expect(data.lanes.masterBrain).toEqual(expect.objectContaining({
      role: 'masterBrain',
      taskModel: 'ax/gemma4:31b-it-qat',
      model: 'ax/gemma4:31b-it-qat',
      contextSize: 65536,
      contextSource: 'benchmark_model_profile',
      pinAligned: false
    }));
    expect(data.warnings[0]).toMatch(/not pinned/);
    expect(data.warnings[1]).toMatch(/not pinned/);

    expect(data.hermes.defaultModelConfig).toEqual({
      default: 'openrouter/z-ai/glm-5.2',
      provider: 'custom',
      base_url: 'http://192.0.2.99:3080/api/hermes-openai/v1',
      context_length: 131072,
      api_key: 'no-key-required'
    });
    expect(data.hermes.localFallbackModelConfig).toEqual({
      default: 'ax/gemma4:26b-a4b-it-qat',
      provider: 'custom',
      base_url: 'http://192.0.2.99:3080/api/hermes-openai/v1',
      context_length: 65536,
      api_key: 'no-key-required',
      ollama_num_ctx: 65536
    });
    expect(data.hermes.codingSpecialistModelConfig).toEqual({
      default: 'ax/qwen3-coder:30b',
      provider: 'custom',
      base_url: 'http://192.0.2.99:3080/api/hermes-openai/v1',
      context_length: 16384,
      api_key: 'no-key-required',
      ollama_num_ctx: 16384
    });
    expect(data.hermes.authority).toEqual(expect.objectContaining({
      policy: 'cloud_first_via_agentx_proxy',
      decisionDate: '2026-07-02',
      expectedModel: 'openrouter/z-ai/glm-5.2',
      localFallbackModel: 'ax/gemma4:26b-a4b-it-qat',
      directRuntimeBypass: 'pending_drift_until_classified'
    }));

    expect(data.openclaw.provider.apiBase).toBe('http://192.0.2.99:3080/api/openclaw-ollama');
    expect(data.openclaw.providerAliases).toEqual([
      expect.objectContaining({
        id: 'host-alpha-ollama',
        aliasOf: 'ollama',
        status: 'intentional_compatibility_alias'
      }),
      expect.objectContaining({
        id: 'host-gamma-ollama',
        aliasOf: 'host-alpha-ollama',
        status: 'legacy_live_session_alias'
      })
    ]);
    expect(data.openclaw.contextOverrides).toEqual([]);
    expect(data.openclaw.defaults).toEqual({
      primary: 'ollama/ax/gemma4:26b-a4b-it-qat',
      codingSpecialist: 'ollama/ax/qwen3-coder:30b',
      masterBrain: 'ollama/ax/gemma4:31b-it-qat'
    });
    expect(data.openclaw.provider.models.map((m) => m.id)).toEqual([
      'ax/gemma4:26b-a4b-it-qat',
      'ax/qwen3-coder:30b',
      'ax/gemma4:31b-it-qat'
    ]);
    expect(data.openclaw.provider.models[0].params.num_ctx).toBe(65536);
    expect(data.openclaw.provider.models[1].params.num_ctx).toBe(16384);
    expect(data.openclaw.provider.models[2].params.num_ctx).toBe(65536);
    expect(data.openclaw.provider.models[1]).toMatchObject({
      maxTokens: 4096,
      reasoning: true,
      _source: {
        role: 'codingSpecialist',
        thinkingSource: 'benchmark_model_profile',
        thinkingQualified: true,
        executionPolicy: expect.objectContaining({ responseMode: 'final_only' })
      }
    });
    expect(data.lanes.daily.capabilityContract).toMatchObject({
      version: 'agentx.inference-contract.v1',
      artifact: {
        model: 'ax/gemma4:26b-a4b-it-qat',
        host: 'http://192.0.2.105:11434'
      }
    });
  });

  it('does not export reasoning from a model name when the artifact is unqualified', async () => {
    resolveInferenceContract.mockResolvedValue({
      version: 'agentx.inference-contract.v1',
      qualification: { state: 'available', qualified: false },
      capabilities: {
        thinking: {
          supported: true,
          source: 'model_registry_fallback',
          visibleFinalAnswer: { qualified: false }
        }
      }
    });

    const data = await buildAgentRuntimeConfigExport({
      coreBaseUrl: 'http://192.0.2.99:3080',
      includeCandidates: false
    });

    expect(data.openclaw.provider.models.every((model) => model.reasoning === false)).toBe(true);
    expect(data.openclaw.provider.models[0]._source).toMatchObject({
      thinkingSource: 'model_registry_fallback',
      thinkingQualified: false
    });
  });

  it('caps unpinned exported context to the validated inference-contract window', async () => {
    getContextInfo.mockImplementation(async (model) => ({
      model,
      host: 'http://192.0.2.105:11434',
      num_ctx: 65536,
      source: 'modelfile'
    }));

    const data = await buildAgentRuntimeConfigExport({
      coreBaseUrl: 'http://192.0.2.99:3080',
      includeCandidates: false
    });

    expect(data.lanes.codingSpecialist).toMatchObject({
      model: 'ax/qwen3-coder:30b',
      discoveredContextSize: 65536,
      contextSize: 16384,
      contextSource: 'inference_contract_benchmark_model_profile',
      contextBudget: {
        validatedWindowTokens: 16384
      }
    });
    expect(data.lanes.codingSpecialist.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/Using inference-contract context 16384/)
    ]));
    expect(data.openclaw.provider.models.find((model) => model.id === 'ax/qwen3-coder:30b')).toMatchObject({
      contextWindow: 16384,
      params: { num_ctx: 16384 }
    });
  });

  it('reports a validated-budget mismatch without silently changing a resident operator pin', async () => {
    hostPrefService.getAll.mockResolvedValue([{
      hostUrl: 'http://192.0.2.105:11434',
      displayName: 'Host Alpha',
      status: 'ready',
      loadedModel: 'ax/gemma4:26b-a4b-it-qat',
      loadedModels: ['ax/gemma4:26b-a4b-it-qat'],
      maxConcurrentModels: 1,
      vramTotalMiB: 49152,
      pinnedModels: [{
        model: 'ax/gemma4:26b-a4b-it-qat',
        keepAlive: -1,
        contextSize: 83558,
        autoRestore: true
      }]
    }]);

    const data = await buildAgentRuntimeConfigExport({
      coreBaseUrl: 'http://192.0.2.99:3080',
      includeCandidates: false
    });

    expect(data.lanes.daily).toMatchObject({
      contextSize: 83558,
      contextSource: 'host_preference_pin',
      pinAligned: true,
      contextBudget: { validatedWindowTokens: 65536 }
    });
    expect(data.lanes.daily.warnings).toEqual(expect.arrayContaining([
      expect.stringMatching(/preserving the operator pin/)
    ]));
  });

  it('surfaces installed master-brain candidates larger than the daily model', async () => {
    const data = await buildAgentRuntimeConfigExport({
      coreBaseUrl: 'http://agentx.test:3080'
    });

    expect(data.masterBrainCandidates.map((candidate) => candidate.model)).toEqual([
      'ax/gemma4:31b-it-qat',
      'qwen3.6:72b-q4_K_M',
      'ax/qwen3-coder:30b'
    ]);
    expect(data.masterBrainCandidates.find((candidate) => candidate.model.includes('72b')).parameterB).toBe(72);
  });

  it('validates matching Hermes and OpenClaw configs', async () => {
    const expected = await buildAgentRuntimeConfigExport({
      coreBaseUrl: 'http://192.0.2.99:3080',
      includeCandidates: false
    });

    const validation = validateRuntimeConfigs(expected, {
      hermesConfig: {
        model: {
          default: 'openrouter/z-ai/glm-5.2',
          provider: 'custom',
          base_url: 'http://192.0.2.99:3080/api/hermes-openai/v1',
          context_length: 131072
        }
      },
      openclawConfig: {
        models: {
          providers: {
            ollama: {
              apiBase: 'http://192.0.2.99:3080/api/openclaw-ollama',
              models: [
                {
                  id: 'ax/gemma4:26b-a4b-it-qat',
                  contextWindow: 65536,
                  params: { num_ctx: 65536 }
                },
                {
                  id: 'ax/qwen3-coder:30b',
                  contextWindow: 16384,
                  params: { num_ctx: 16384 }
                },
                {
                  id: 'ax/gemma4:31b-it-qat',
                  contextWindow: 65536,
                  params: { num_ctx: 65536 }
                }
              ]
            }
          }
        }
      }
    });

    expect(validation.hermes.status).toBe('ok');
    expect(validation.openclaw.status).toBe('ok');
  });

  it('accepts documented OpenClaw provider aliases at the resolved lane context', async () => {
    const expected = await buildAgentRuntimeConfigExport({
      coreBaseUrl: 'http://192.0.2.99:3080',
      includeCandidates: false
    });
    expected.openclaw.provider.models = [{
      id: 'ax/qwen3-coder:30b',
      contextWindow: 16384,
      params: { num_ctx: 16384 }
    }];

    const validation = validateRuntimeConfigs(expected, {
      openclawConfig: {
        models: {
          providers: {
            ollama: {
              apiBase: 'http://192.0.2.99:3080/api/openclaw-ollama',
              models: []
            },
            'host-alpha-ollama': {
              apiBase: 'http://192.0.2.99:3080/api/openclaw-ollama',
              models: [
                {
                  id: 'ax/qwen3-coder:30b',
                  contextWindow: 16384,
                  params: { num_ctx: 16384 }
                }
              ]
            }
          }
        }
      }
    });

    expect(validation.openclaw.status).toBe('ok');
  });

  it('reports Hermes and OpenClaw drift with concrete paths', () => {
    const expectedHermes = {
      defaultModelConfig: {
        default: 'ax/gemma4:26b-a4b-it-qat',
        provider: 'custom',
        base_url: 'http://agentx/api/hermes-openai/v1',
        context_length: 65536,
        ollama_num_ctx: 65536
      }
    };
    const expectedOpenClaw = {
      providerId: 'ollama',
      provider: {
        apiBase: 'http://agentx/api/openclaw-ollama',
        models: [{
          id: 'ax/gemma4:26b-a4b-it-qat',
          contextWindow: 65536,
          params: { num_ctx: 65536 }
        }]
      }
    };

    expect(compareHermesConfig({
      model: {
        default: 'ax/qwen2.5:7b-instruct-q5_K_M',
        provider: 'custom',
        base_url: 'http://ollama/v1',
        context_length: 18432,
        ollama_num_ctx: 65536
      }
    }, expectedHermes)).toEqual(expect.objectContaining({
      status: 'drift',
      drift: expect.arrayContaining([
        expect.objectContaining({ path: 'model.default' }),
        expect.objectContaining({ path: 'model.base_url' }),
        expect.objectContaining({ path: 'model.context_length' })
      ])
    }));

    expect(compareOpenClawConfig({
      models: {
        providers: {
          ollama: {
            apiBase: 'http://direct-ollama',
            models: [{
              id: 'ax/gemma4:26b-a4b-it-qat',
              contextWindow: 32768,
              params: { num_ctx: 32768 }
            }]
          }
        }
      }
    }, expectedOpenClaw)).toEqual(expect.objectContaining({
      status: 'drift',
      drift: expect.arrayContaining([
        expect.objectContaining({ path: 'models.providers.ollama.apiBase' }),
        expect.objectContaining({ path: 'models.providers.ollama.models[ax/gemma4:26b-a4b-it-qat].contextWindow' }),
        expect.objectContaining({ path: 'models.providers.ollama.models[ax/gemma4:26b-a4b-it-qat].params.num_ctx' })
      ])
    }));
  });

  it('parses parameter sizes from model names and metadata', () => {
    expect(parseParameterB('qwen3.6:72b-q4_K_M')).toBe(72);
    expect(parseParameterB('gemma4:31b-it-q8_0')).toBe(31);
    expect(parseParameterB('custom:model', '35.5B')).toBe(35.5);
  });
});
