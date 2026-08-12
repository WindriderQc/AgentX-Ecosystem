'use strict';

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../models/ModelRegistry', () => ({
  find: jest.fn()
}));

jest.mock('../../src/services/inferenceContractService', () => {
  const actual = jest.requireActual('../../src/services/inferenceContractService');
  return {
    ...actual,
    resolveCapabilityContract: jest.fn()
  };
});

const ModelRegistry = require('../../models/ModelRegistry');
const { resolveCapabilityContract } = require('../../src/services/inferenceContractService');
const {
  buildExport,
  toOpenClawModel,
  suggestProviderId,
  shortName
} = require('../../src/services/openclawExportService');

function mockFindReturning(docs) {
  // Chain: find().select().sort().lean()
  const chain = {
    select: jest.fn(() => chain),
    sort: jest.fn(() => chain),
    lean: jest.fn(() => Promise.resolve(docs))
  };
  ModelRegistry.find.mockReturnValue(chain);
}

describe('openclawExportService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.MODEL_CONTEXT_OPERATIONAL_CAP;
    delete process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP;
    resolveCapabilityContract.mockImplementation(async ({ model, host }, deps = {}) => ({
      version: 'agentx.inference-contract.v1',
      artifact: { model, host, hostId: null },
      qualification: { state: 'unknown', qualified: false },
      capabilities: {
        thinking: {
          supported: deps.registryEntry?.capabilities?.supportsThinking ?? null,
          source: deps.registryEntry?.capabilities?.supportsThinking == null
            ? 'unqualified'
            : 'model_registry_fallback',
          visibleFinalAnswer: { qualified: false }
        }
      }
    }));
  });

  describe('suggestProviderId', () => {
    it('maps known host IPs to named providers', () => {
      expect(suggestProviderId('http://192.0.2.66:11434')).toBe('agentx-host-delta');
      expect(suggestProviderId('http://192.0.2.12:11434')).toBe('agentx-host-beta');
      expect(suggestProviderId('http://192.0.2.99:11434')).toBe('agentx-host-gamma');
      expect(suggestProviderId('http://192.0.2.105:11434')).toBe('agentx-host-alpha');
    });

    it('handles unknown hosts with a sanitised id', () => {
      expect(suggestProviderId('http://10.0.0.5:11434')).toBe('agentx-10-0-0-5-11434');
    });

    it('returns unknown for null/empty', () => {
      expect(suggestProviderId(null)).toBe('agentx-unknown');
      expect(suggestProviderId('')).toBe('agentx-unknown');
    });
  });

  describe('shortName', () => {
    it('produces OpenClaw-style kebab names', () => {
      expect(shortName('gemma4:26b')).toBe('gemma4-26b');
      expect(shortName('qwen2.5:7b-instruct-q5_K_M')).toBe('qwen25-7b');
      expect(shortName('nomic-embed-text:v1.5')).toBe('nomic-embed-text-v15');
    });
  });

  describe('toOpenClawModel', () => {
    it('uses contextTest.testedNumCtx as contextWindow when profiled', () => {
      const entry = {
        modelName: 'qwen2.5:7b-instruct-q5_K_M',
        contextTest: { status: 'completed', testedNumCtx: 32768 },
        executionDefaults: { num_ctx: 8192 },
        capabilities: { maxContext: 200000 },
        sourceHost: 'http://192.0.2.99:11434'
      };
      const m = toOpenClawModel(entry);
      expect(m.contextWindow).toBe(32768);
      expect(m.params.num_ctx).toBe(32768);
      expect(m._source.contextTestStatus).toBe('completed');
      expect(m._source.contextWindowSource).toBe('context_test');
      expect(m._source.runtimeNumCtx).toBe(32768);
    });

    it('uses executionOverrides.num_ctx before profiled/default context', () => {
      const entry = {
        modelName: 'qwen3:14b',
        executionOverrides: { num_ctx: 16384 },
        _contextProbe: { status: 'completed', testedNumCtx: 65536, testedAt: new Date('2026-06-01T00:00:00Z') },
        contextTest: { status: 'completed', testedNumCtx: 32768 },
        executionDefaults: { num_ctx: 8192 }
      };
      const m = toOpenClawModel(entry);
      expect(m.contextWindow).toBe(16384);
      expect(m.params.num_ctx).toBe(16384);
      expect(m._source.contextWindowSource).toBe('user_override');
    });

    it('uses benchmark context probe snapshots before legacy context/defaults', () => {
      const entry = {
        modelName: 'ax/qwen3.6:35b-a3b-q8_0',
        _contextProbe: { status: 'completed', testedNumCtx: 202752, testedAt: new Date('2026-05-31T16:36:43Z') },
        contextTest: { status: 'completed', testedNumCtx: 32768 },
        executionDefaults: { num_ctx: 4096 }
      };
      const m = toOpenClawModel(entry);
      expect(m.contextWindow).toBe(131072);
      expect(m.params.num_ctx).toBe(131072);
      expect(m._source.contextWindowSource).toBe('benchmark_context_probe_operational_cap');
      expect(m._source.contextMaxVerified).toBe(202752);
      expect(m._source.contextOperationalCap).toBe(131072);
      expect(m._source.contextProbeStatus).toBe('completed');
      expect(m._source.profiledAt).toEqual(new Date('2026-05-31T16:36:43Z'));
    });

    it('uses materialized context profiles before raw probe snapshots', () => {
      const entry = {
        modelName: 'ax/qwen3.5:9b',
        _contextProfile: {
          stale: false,
          recommendedContext: 131072,
          verifiedMaxContext: 237568,
          stressCeiling: 237568,
          lastValidatedAt: new Date('2026-06-16T00:00:00Z')
        },
        _contextProbe: { status: 'completed', testedNumCtx: 65536, testedAt: new Date('2026-06-15T00:00:00Z') },
        contextTest: { status: 'completed', testedNumCtx: 32768 },
        executionDefaults: { num_ctx: 8192 }
      };

      const m = toOpenClawModel(entry);

      expect(m.contextWindow).toBe(131072);
      expect(m.params.num_ctx).toBe(131072);
      expect(m._source.contextWindowSource).toBe('model_context_profile');
      expect(m._source.contextMaxVerified).toBe(237568);
      expect(m._source.contextStressCeiling).toBe(237568);
      expect(m._source.contextProfileStatus).toBe('active');
      expect(m._source.contextProbeStatus).toBe('completed');
      expect(m._source.profiledAt).toEqual(new Date('2026-06-16T00:00:00Z'));
    });

    it('still lets executionOverrides.num_ctx beat context profiles', () => {
      const entry = {
        modelName: 'ax/qwen3.5:9b',
        executionOverrides: { num_ctx: 65536 },
        _contextProfile: {
          recommendedContext: 131072,
          verifiedMaxContext: 237568
        }
      };

      const m = toOpenClawModel(entry);

      expect(m.contextWindow).toBe(65536);
      expect(m.params.num_ctx).toBe(65536);
      expect(m._source.contextWindowSource).toBe('user_override');
    });

    it('falls back to executionDefaults.num_ctx when no contextTest', () => {
      const entry = {
        modelName: 'gemma4:26b',
        executionDefaults: { num_ctx: 131072 },
        sourceHost: 'http://192.0.2.66:11434'
      };
      const m = toOpenClawModel(entry);
      expect(m.contextWindow).toBe(131072);
      expect(m.params.num_ctx).toBe(131072);
      expect(m._source.contextWindowSource).toBe('execution_default');
      expect(m._source.contextMaxVerified).toBeNull();
    });

    it('flags embedding models with tight maxTokens', () => {
      const entry = {
        modelName: 'nomic-embed-text:v1.5',
        categories: ['embedding'],
        executionDefaults: { num_ctx: 2048 }
      };
      const m = toOpenClawModel(entry);
      expect(m.maxTokens).toBe(512);
      expect(m.contextWindow).toBe(2048);
      expect(m.params).toBeUndefined();
    });

    it('does not detect reasoning models from artifact names', () => {
      expect(toOpenClawModel({ modelName: 'qwen3:8b' }).reasoning).toBe(false);
      expect(toOpenClawModel({ modelName: 'deepseek-r1:7b' }).reasoning).toBe(false);
      expect(toOpenClawModel({ modelName: 'gemma4:26b' }).reasoning).toBe(false);
    });

    it('respects explicit supportsThinking capability', () => {
      const entry = {
        modelName: 'gemma4:26b',
        capabilities: { supportsThinking: true }
      };
      expect(toOpenClawModel(entry).reasoning).toBe(true);
      expect(toOpenClawModel(entry)._source).toMatchObject({
        thinkingSource: 'model_registry_fallback',
        thinkingQualified: false
      });
    });

    it('prefers a qualified host/artifact profile over the model name', () => {
      const entry = {
        modelName: 'plain-custom-model:8b',
        capabilities: { supportsThinking: false }
      };
      const contract = {
        qualification: { state: 'profiled', qualified: true },
        capabilities: {
          thinking: {
            supported: true,
            source: 'benchmark_model_profile',
            visibleFinalAnswer: { qualified: true }
          }
        }
      };

      expect(toOpenClawModel(entry, contract)).toMatchObject({
        reasoning: true,
        _source: {
          thinkingSource: 'benchmark_model_profile',
          thinkingQualified: true,
          visibleFinalQualified: true
        }
      });
    });
  });

  describe('buildExport', () => {
    it('groups models by sourceHost and emits one provider per host', async () => {
      mockFindReturning([
        {
          modelName: 'gemma4:26b',
          sourceHost: 'http://192.0.2.66:11434',
          contextTest: { status: 'completed', testedNumCtx: 131072 },
          executionDefaults: { num_ctx: 131072 }
        },
        {
          modelName: 'qwen2.5:7b-instruct-q5_K_M',
          sourceHost: 'http://192.0.2.99:11434',
          contextTest: { status: 'completed', testedNumCtx: 32768 }
        },
        {
          modelName: 'nomic-embed-text:v1.5',
          sourceHost: 'http://192.0.2.99:11434',
          categories: ['embedding'],
          executionDefaults: { num_ctx: 2048 }
        }
      ]);

      const data = await buildExport();
      expect(data.registryCount).toBe(3);
      expect(Object.keys(data.providers).sort()).toEqual([
        'agentx-host-delta',
        'agentx-host-gamma'
      ]);
      expect(data.providers['agentx-host-delta'].models).toHaveLength(1);
      expect(data.providers['agentx-host-gamma'].models).toHaveLength(2);

      const qwen = data.providers['agentx-host-gamma'].models.find(m => m.id === 'qwen2.5:7b-instruct-q5_K_M');
      expect(qwen.contextWindow).toBe(32768);
      expect(qwen.params.num_ctx).toBe(32768);
      expect(qwen._source.host).toBe('http://192.0.2.99:11434');
      expect(qwen.reasoning).toBe(false);
      expect(qwen._source.thinkingSource).toBe('unqualified');
    });

    it('handles entries with no sourceHost by bucketing them as unknown', async () => {
      mockFindReturning([
        { modelName: 'orphan:1b', executionDefaults: { num_ctx: 4096 } }
      ]);
      const data = await buildExport();
      expect(data.providers['agentx-unknown']).toBeDefined();
      expect(data.providers['agentx-unknown'].models[0].id).toBe('orphan:1b');
    });

    it('returns an empty providers map when registry is empty', async () => {
      mockFindReturning([]);
      const data = await buildExport();
      expect(data.registryCount).toBe(0);
      expect(data.providers).toEqual({});
    });
  });
});
