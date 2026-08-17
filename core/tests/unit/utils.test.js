const {
  sanitizeOptions,
  resolveTarget
} = require('../../src/helpers/ollamaUtils');

describe('utils', () => {
  beforeEach(() => {
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
});
