const { resolveCloudProvider } = require('../../src/services/cloudProviderRouter');

describe('cloudProviderRouter.resolveCloudProvider', () => {
  const ORIGINAL = {
    OPENROUTER_API_KEY: process.env.OPENROUTER_API_KEY,
    OPENROUTER_BASE_URL: process.env.OPENROUTER_BASE_URL,
  };

  beforeEach(() => {
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENROUTER_BASE_URL;
  });

  afterAll(() => {
    for (const [k, v] of Object.entries(ORIGINAL)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('returns null for bare Ollama-style models', () => {
    expect(resolveCloudProvider('ax/gemma4:26b-a4b-it-qat')).toBeNull();
    expect(resolveCloudProvider('qwen2.5:7b-instruct-q5_K_M')).toBeNull();
  });

  it('returns null for non-string / empty / prefix-only input', () => {
    expect(resolveCloudProvider(null)).toBeNull();
    expect(resolveCloudProvider('')).toBeNull();
    expect(resolveCloudProvider('/leading-slash')).toBeNull();
    expect(resolveCloudProvider('openrouter/')).toBeNull();
  });

  it('returns null for an unknown provider namespace', () => {
    expect(resolveCloudProvider('bedrock/anthropic.claude')).toBeNull();
  });

  it('resolves an openrouter/* model, stripping only the routing prefix', () => {
    process.env.OPENROUTER_API_KEY = 'sk-or-test';
    const r = resolveCloudProvider('openrouter/z-ai/glm-5.2');
    expect(r).toEqual({
      provider: 'openrouter',
      baseUrl: 'https://openrouter.ai/api/v1',
      apiKey: 'sk-or-test',
      upstreamModel: 'z-ai/glm-5.2',
      requestedModel: 'openrouter/z-ai/glm-5.2',
    });
  });

  it('reports a null apiKey when the env var is unset (caller decides how to fail)', () => {
    const r = resolveCloudProvider('openrouter/nvidia/nemotron-3-super-120b-a12b:free');
    expect(r.provider).toBe('openrouter');
    expect(r.apiKey).toBeNull();
    expect(r.upstreamModel).toBe('nvidia/nemotron-3-super-120b-a12b:free');
  });

  it('honours OPENROUTER_BASE_URL override and trims trailing slashes', () => {
    process.env.OPENROUTER_BASE_URL = 'https://proxy.example/api/v1/';
    const r = resolveCloudProvider('openrouter/openai/gpt-oss-120b');
    expect(r.baseUrl).toBe('https://proxy.example/api/v1');
  });
});
