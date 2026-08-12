const {
  sanitizeOptions,
  resolveTarget,
  resolveModelNumCtxDetails
} = require('../../src/helpers/ollamaUtils');

function mockRegistryEntry(entry) {
  const chain = {
    select: jest.fn(() => chain),
    lean: jest.fn(async () => entry)
  };
  return {
    findOne: jest.fn(() => chain)
  };
}

function mockProfileEntry(entry) {
  const chain = {
    select: jest.fn(() => chain),
    lean: jest.fn(async () => entry)
  };
  return {
    findOne: jest.fn(() => chain)
  };
}

describe('utils', () => {
  beforeEach(() => {
    delete process.env.MODEL_CONTEXT_OPERATIONAL_CAP;
    delete process.env.AGENTX_OPERATIONAL_NUM_CTX_CAP;
  });

  describe('sanitizeOptions', () => {
    it('keeps supported native Ollama numeric options', () => {
      expect(sanitizeOptions({
        temperature: '0.7',
        top_k: '40',
        top_p: '0.9',
        min_p: '0.05',
        num_ctx: '8192',
        repeat_last_n: '64',
        repeat_penalty: '1.1',
        seed: '42',
        num_predict: '128',
        typical_p: '0.95',
        tfs_z: '1',
        mirostat: '0',
        mirostat_eta: '0.1',
        mirostat_tau: '5',
        stop: 'END,STOP',
        keep_alive: '-1'
      })).toEqual({
        temperature: 0.7,
        top_k: 40,
        top_p: 0.9,
        min_p: 0.05,
        num_ctx: 8192,
        repeat_last_n: 64,
        repeat_penalty: 1.1,
        seed: 42,
        num_predict: 128,
        typical_p: 0.95,
        tfs_z: 1,
        mirostat: 0,
        mirostat_eta: 0.1,
        mirostat_tau: 5,
        stop: ['END', 'STOP'],
        keep_alive: '-1'
      });
    });

    it('drops OpenAI-style penalties that Ollama native chat does not use', () => {
      expect(sanitizeOptions({
        presence_penalty: '0.8',
        frequency_penalty: '0.4',
        temperature: '0.2'
      })).toEqual({
        temperature: 0.2
      });
    });
  });

  describe('resolveTarget', () => {
    const originalEnv = process.env.OLLAMA_HOST;

    afterEach(() => {
      process.env.OLLAMA_HOST = originalEnv;
    });

    it('normalizes bare host:port targets to http urls', () => {
      expect(resolveTarget('192.0.2.66:11434/')).toBe('http://192.0.2.66:11434');
    });
  });

  describe('resolveModelNumCtxDetails', () => {
    it('caps registry-tested context to the operational runtime ceiling', async () => {
      const result = await resolveModelNumCtxDetails('qwen3.6:35b-a3b-q8_0', {
        deps: {
          ModelRegistry: mockRegistryEntry({
            modelName: 'qwen3.6:35b-a3b-q8_0',
            contextTest: { status: 'completed', testedNumCtx: 202752 }
          })
        }
      });

      expect(result).toEqual(expect.objectContaining({
        num_ctx: 131072,
        source: 'context_test_operational_cap',
        capped: true,
        verified_num_ctx: 202752
      }));
    });

    it('does not cap explicit user overrides', async () => {
      const result = await resolveModelNumCtxDetails('qwen3.6:35b-a3b-q8_0', {
        deps: {
          ModelRegistry: mockRegistryEntry({
            modelName: 'qwen3.6:35b-a3b-q8_0',
            executionOverrides: { num_ctx: 202752 },
            contextTest: { status: 'completed', testedNumCtx: 65536 }
          })
        }
      });

      expect(result).toEqual(expect.objectContaining({
        num_ctx: 202752,
        source: 'override'
      }));
    });

    it('uses host/model context profiles before legacy registry context tests', async () => {
      const result = await resolveModelNumCtxDetails('ax/qwen3.5:9b', {
        targetHost: 'http://host:11434',
        deps: {
          ModelRegistry: mockRegistryEntry({
            modelName: 'ax/qwen3.5:9b',
            sourceHost: 'http://host:11434',
            contextTest: { status: 'completed', testedNumCtx: 32768 },
            executionDefaults: { num_ctx: 8192 }
          }),
          ModelContextProfile: mockProfileEntry({
            modelName: 'ax/qwen3.5:9b',
            hostUrl: 'http://host:11434',
            recommendedContext: 131072,
            verifiedMaxContext: 237568,
            stressCeiling: 237568,
            lastValidatedAt: new Date('2026-06-16T00:00:00Z')
          })
        }
      });

      expect(result).toEqual(expect.objectContaining({
        num_ctx: 131072,
        source: 'model_context_profile',
        targetHost: 'http://host:11434'
      }));
      expect(result.details).toEqual(expect.objectContaining({
        verifiedMaxContext: 237568,
        stressCeiling: 237568,
        matchedName: 'ax/qwen3.5:9b'
      }));
    });
  });
});
