/**
 * Unit tests for hostPinPrimitives embedding-model detection (task 0508).
 *
 * Regression context: pinning `qllama/bge-m3:f16` on Host Gamma stored fine but
 * every warm attempt hit `/api/generate` and was refused with
 * `"qllama/bge-m3:f16" does not support generate` — the name matcher knew
 * `embed`/`embedding`/`nomic` but not the BAAI `bge` family.
 */

const {
  isEmbeddingModelName,
  getWarmOrder,
  resolvePinnedRuntimeOptions,
  getLoadedEntryStatus,
  entrySatisfiedByLoadedModel
} = require('../../src/services/hostPinPrimitives');

describe('isEmbeddingModelName (0508)', () => {
  it.each([
    'qllama/bge-m3:f16',
    'bge-m3:f16',
    'bge-large:latest',
    'nomic-embed-text:v1.5',
    'qwen3-embedding:8b',
    'all-minilm:l6-v2',
    'mxbai-embed-large'
  ])('detects %s as an embedding model', (name) => {
    expect(isEmbeddingModelName(name)).toBe(true);
  });

  it.each([
    'ax/gemma4:26b-a4b-it-qat',
    'ax/gemma4:31b-it-qat',
    'ax/qwen3.5:9b',
    'ax/Qwen3.5:35b-a3b-q8_0',
    'qwen3-coder:30b',
    'ax/qwen3.6:27b-mtp-q8_0',
    'llama3.2:3b'
  ])('does not flag generative model %s', (name) => {
    expect(isEmbeddingModelName(name)).toBe(false);
  });

  it('handles null/empty safely', () => {
    expect(isEmbeddingModelName(null)).toBe(false);
    expect(isEmbeddingModelName('')).toBe(false);
    expect(isEmbeddingModelName(undefined)).toBe(false);
  });
});

describe('getWarmOrder with bge pins (0508)', () => {
  it('warms the generative model before the bge embedder', () => {
    const order = getWarmOrder([
      { model: 'qllama/bge-m3:f16' },
      { model: 'ax/gemma4:26b-a4b-it-qat' }
    ]);
    expect(order.map((e) => e.model)).toEqual([
      'ax/gemma4:26b-a4b-it-qat',
      'qllama/bge-m3:f16'
    ]);
  });
});

describe('resolvePinnedRuntimeOptions (0512)', () => {
  const pref = {
    pinnedModels: [{
      model: 'ax/gemma4:31b-it-qat',
      keepAlive: -1,
      contextSize: 49152,
      autoRestore: true
    }]
  };

  it('applies the warm pin context and keep-alive to a chat request', () => {
    expect(resolvePinnedRuntimeOptions(pref, 'ax/gemma4:31b-it-qat', {})).toMatchObject({
      options: { num_ctx: 49152 },
      keepAlive: -1,
      numCtxSource: 'host_preference_pin',
      pinnedEntry: { model: 'ax/gemma4:31b-it-qat' }
    });
  });

  it('keeps namespace and tag identity exact when applying pin options', () => {
    expect(resolvePinnedRuntimeOptions(pref, 'gemma4:31b-it-qat', {}).pinnedEntry).toBeNull();
    expect(resolvePinnedRuntimeOptions(pref, 'gemma4:26b-a4b-it-qat', {}).pinnedEntry).toBeNull();
  });

  it('preserves explicit caller context and keep-alive', () => {
    expect(resolvePinnedRuntimeOptions(
      pref,
      'ax/gemma4:31b-it-qat',
      { num_ctx: 32768, keep_alive: '5m', temperature: 0.2 }
    )).toMatchObject({
      options: { num_ctx: 32768, temperature: 0.2 },
      keepAlive: '5m',
      numCtxSource: 'caller'
    });
  });

  it('leaves an unpinned model on its Modelfile runtime options', () => {
    expect(resolvePinnedRuntimeOptions(pref, 'ax/qwen3.5:9b', { temperature: 0.3 })).toEqual({
      options: { temperature: 0.3 },
      keepAlive: undefined,
      numCtxSource: 'modelfile',
      pinnedEntry: null
    });
  });
});

describe('loaded pin residency', () => {
  const now = Date.parse('2026-08-06T00:00:00Z');
  const pin = {
    model: 'nomic-embed-text:v1.5',
    keepAlive: -1,
    contextSize: 0,
    autoRestore: true
  };

  it('does not accept a five-minute Ollama TTL as an infinite pin', () => {
    const running = [{
      name: pin.model,
      context_length: 2048,
      expires_at: '2026-08-06T00:05:00Z'
    }];

    expect(getLoadedEntryStatus(pin, running, now)).toMatchObject({
      loaded: true,
      contextMismatch: false,
      residencyMismatch: true,
      expectedKeepAlive: -1
    });
    expect(entrySatisfiedByLoadedModel(pin, running)).toBe(false);
  });

  it('accepts the far-future expiry returned for a real infinite pin', () => {
    const running = [{
      name: pin.model,
      context_length: 2048,
      expires_at: '2318-11-16T00:00:00Z'
    }];

    expect(getLoadedEntryStatus(pin, running, now)).toMatchObject({
      loaded: true,
      contextMismatch: false,
      residencyMismatch: false
    });
  });

  it('fails open when an Ollama version omits expiry metadata', () => {
    expect(getLoadedEntryStatus(pin, [{ name: pin.model }], now).residencyMismatch).toBe(false);
  });
});
