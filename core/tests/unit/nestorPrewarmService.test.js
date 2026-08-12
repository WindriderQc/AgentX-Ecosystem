jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: jest.fn() }));
jest.mock('../../models/HostPreference', () => ({ findOne: jest.fn() }));
jest.mock('../../src/services/modelRouterConfig', () => ({
  ensureTaskModelOverridesLoaded: jest.fn().mockResolvedValue(undefined),
  getModelForTask: jest.fn()
}));

const HostPreference = require('../../models/HostPreference');
const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const routerConfig = require('../../src/services/modelRouterConfig');
const {
  prewarmFallbackModels,
  getLastRun,
  prewarmOne,
  PREWARM_TASK_TYPE,
  _setFetch
} = require('../../src/services/nestorPrewarmService');

const MODELS = ['ax/gemma4:26b-a4b-it-qat', 'ax/gemma4:e4b', 'qwen2.5:7b-instruct-q5_K_M'];
const HOSTS = [
  { id: 'primary', name: 'Host Alpha', url: 'http://192.0.2.199:11434', vramMb: 49152 },
  { id: 'secondary', name: 'Host Beta', url: 'http://192.0.2.12:11434', vramMb: 16384 },
  { id: 'tertiary', name: 'Host Gamma', url: 'http://192.0.2.99:11434', vramMb: 12288 }
];

function inventory(models = MODELS.map((name) => ({ name, size: 1024 }))) {
  return { ok: true, status: 200, json: async () => ({ models }) };
}

function mockPreference(pref = null) {
  HostPreference.findOne.mockReturnValue({ lean: jest.fn().mockResolvedValue(pref) });
}

beforeEach(() => {
  jest.clearAllMocks();
  getConfiguredHosts.mockReturnValue(HOSTS);
  routerConfig.ensureTaskModelOverridesLoaded.mockResolvedValue(undefined);
  routerConfig.getModelForTask.mockReturnValue({
    model: 'ax/qwen3.5:9b',
    host: 'secondary',
    url: HOSTS[1].url
  });
  mockPreference(null);
});

describe('prewarmOne', () => {
  test('sends a 1-token functional generate ping with the requested keep-alive', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 200 });
    _setFetch(fetchMock);

    const result = await prewarmOne(HOSTS[0], MODELS[0], { keepAlive: -1 });

    expect(result.ok).toBe(true);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body).toMatchObject({ model: MODELS[0], keep_alive: -1, options: { num_predict: 1 } });
  });

  test('reports non-ok HTTP status without throwing', async () => {
    _setFetch(jest.fn().mockResolvedValue({ ok: false, status: 503 }));
    const result = await prewarmOne(HOSTS[0], MODELS[1]);
    expect(result).toMatchObject({ ok: false, error: 'HTTP 503' });
  });

  test('reports network errors without throwing', async () => {
    _setFetch(jest.fn().mockRejectedValue(new Error('ECONNREFUSED')));
    const result = await prewarmOne(HOSTS[0], MODELS[1]);
    expect(result).toMatchObject({ ok: false, error: 'ECONNREFUSED' });
  });
});

describe('prewarmFallbackModels', () => {
  test('follows only the effective quick-chat route by default', async () => {
    mockPreference({ pinnedModels: [{ model: 'ax/qwen3.5:9b', keepAlive: -1 }] });
    const fetchMock = jest.fn((url) => Promise.resolve(
      url.endsWith('/api/tags')
        ? inventory([{ name: 'ax/qwen3.5:9b', size: 6_000_000_000 }])
        : { ok: true, status: 200 }
    ));
    _setFetch(fetchMock);

    const run = await prewarmFallbackModels();

    expect(routerConfig.ensureTaskModelOverridesLoaded).toHaveBeenCalledTimes(1);
    expect(routerConfig.getModelForTask).toHaveBeenCalledWith(PREWARM_TASK_TYPE);
    expect(HostPreference.findOne).toHaveBeenCalledWith({ hostUrl: HOSTS[1].url });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith(HOSTS[1].url))).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).keep_alive).toBe(-1);
    expect(run.summary).toEqual({ warmed: 1, skipped: 0, failed: 0 });
    expect(run.source).toBe('effective_task_route');
    expect(getLastRun()).toBe(run);
  });

  test('refuses a prewarm target that conflicts with a host pin', async () => {
    mockPreference({ pinnedModels: [{ model: 'ax/qwen3.5:9b', keepAlive: -1 }] });
    const fetchMock = jest.fn((url) => Promise.resolve(
      url.endsWith('/api/tags')
        ? inventory([{ name: 'ax/gemma4:e4b', size: 5_000_000_000 }])
        : { ok: true, status: 200 }
    ));
    _setFetch(fetchMock);

    const run = await prewarmFallbackModels({ models: ['ax/gemma4:e4b'], hosts: [HOSTS[1]] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(run.summary).toEqual({ warmed: 0, skipped: 1, failed: 0 });
    expect(run.results[0]).toMatchObject({ skipped: true, reason: 'conflicts_with_pin' });
  });

  test('inventories explicit hosts and warms installed unpinned models that fit', async () => {
    const fetchMock = jest.fn((url) => Promise.resolve(
      url.endsWith('/api/tags') ? inventory() : { ok: true, status: 200 }
    ));
    _setFetch(fetchMock);

    const run = await prewarmFallbackModels({ models: MODELS, hosts: [HOSTS[0], HOSTS[2]] });

    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(run.results).toHaveLength(6);
    expect(run.summary).toEqual({ warmed: 6, skipped: 0, failed: 0 });
  });

  test('skips gracefully with no configured hosts', async () => {
    getConfiguredHosts.mockReturnValue([]);
    const run = await prewarmFallbackModels();
    expect(run.skipped).toBe('no_hosts_configured');
    expect(run.results).toEqual([]);
  });

  test('records mixed functional success and failure', async () => {
    let call = 0;
    _setFetch(jest.fn((url) => {
      if (url.endsWith('/api/tags')) return Promise.resolve(inventory([{ name: 'm1' }, { name: 'm2' }]));
      call += 1;
      return Promise.resolve(call % 2 === 0
        ? { ok: false, status: 500 }
        : { ok: true, status: 200 });
    }));

    const run = await prewarmFallbackModels({ models: ['m1', 'm2'], hosts: [HOSTS[0]] });
    expect(run.results).toHaveLength(2);
    expect(run.results.some((result) => result.ok)).toBe(true);
    expect(run.results.some((result) => !result.ok)).toBe(true);
  });

  test('skips absent models and installed models beyond the VRAM budget', async () => {
    _setFetch(jest.fn((url) => Promise.resolve(
      url.endsWith('/api/tags')
        ? inventory([
          { name: 'large', size: 11 * 1024 * 1024 * 1024 },
          { name: 'small', size: 4 * 1024 * 1024 * 1024 }
        ])
        : { ok: true, status: 200 }
    )));

    const run = await prewarmFallbackModels({
      models: ['large', 'small', 'missing'],
      hosts: [{ ...HOSTS[2], vramMb: 8192 }]
    });

    expect(run.summary).toEqual({ warmed: 1, skipped: 2, failed: 0 });
    expect(run.results).toEqual(expect.arrayContaining([
      expect.objectContaining({ model: 'large', skipped: true, reason: 'vram_budget' }),
      expect.objectContaining({ model: 'missing', skipped: true, reason: 'not_installed' }),
      expect.objectContaining({ model: 'small', ok: true })
    ]));
  });

  test('reports inventory failure without attempting model loads', async () => {
    const fetchMock = jest.fn().mockResolvedValue({ ok: false, status: 503 });
    _setFetch(fetchMock);

    const run = await prewarmFallbackModels({ models: ['m1'], hosts: [HOSTS[0]] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(run.summary).toEqual({ warmed: 0, skipped: 0, failed: 1 });
    expect(run.results[0]).toMatchObject({ phase: 'inventory', ok: false });
  });
});
