/**
 * Unit tests for Ollama Watchdog Service
 */

const { Readable } = require('node:stream');

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn()
}));

jest.mock('../../src/helpers/peerVerifiedNodeFetchTransport', () => ({
  peerVerifiedNodeFetchTransport: async ({ fetchImpl, init, target }) => ({
    response: await fetchImpl(target, init),
    peerVerification: 'connect-time'
  })
}));

jest.mock('../../src/services/runtimeMutationLeaseService', () => ({
  runRuntimeMutation: jest.fn(async (_options, operation) => operation({
    signal: new AbortController().signal,
    assertActive: jest.fn()
  }))
}));
const mockBeginInferenceAdmission = jest.fn(async () => ({
  signal: new AbortController().signal,
  assertActive: jest.fn(),
  markDispatched: jest.fn(),
  complete: jest.fn(async () => ({ released: true })),
  abandon: jest.fn(async () => ({ quarantined: true }))
}));
jest.mock('../../src/services/inferenceAdmissionService', () => ({
  beginInferenceAdmission: (...args) => mockBeginInferenceAdmission(...args)
}));

const { getConfiguredHosts } = require('../../src/helpers/ollamaHostConfig');
const watchdog = require('../../src/services/ollamaWatchdogService');
const hostGate = require('../../src/services/hostGate');

const MOCK_HOST = { id: 'primary', name: 'Host Gamma', url: 'http://192.0.2.99:11434', priority: 1 };

function headers(values = {}) {
  const normalized = new Map(Object.entries(values)
    .map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) ?? null };
}

async function normalizeMockResponse(url, result) {
  const value = result || {};
  let body = value.body;
  if (body === undefined && typeof value.json === 'function') {
    body = JSON.stringify(await value.json());
  } else if (body === undefined && typeof value.text === 'function') {
    body = await value.text();
  }
  return {
    ...value,
    body: body && typeof body !== 'string' && !Buffer.isBuffer(body)
      ? body
      : Readable.from(body ? [body] : []),
    headers: value.headers || headers(),
    redirected: value.redirected === true,
    status: Number.isInteger(value.status) ? value.status : (value.ok === false ? 500 : 200),
    url: value.url || url
  };
}

function makeMockFetch(handlers) {
  return jest.fn(async (url, opts) => {
    for (const [pattern, handler] of Object.entries(handlers)) {
      if (url.includes(pattern)) {
        return normalizeMockResponse(url, await handler(url, opts));
      }
    }
    return normalizeMockResponse(url, { ok: false, status: 500, json: async () => ({}) });
  });
}

beforeEach(() => {
  jest.useRealTimers();
  watchdog.stop();
  getConfiguredHosts.mockReturnValue([MOCK_HOST]);
  mockBeginInferenceAdmission.mockReset();
  mockBeginInferenceAdmission.mockImplementation(async () => ({
    signal: new AbortController().signal,
    assertActive: jest.fn(),
    markDispatched: jest.fn(),
    complete: jest.fn(async () => ({ released: true })),
    abandon: jest.fn(async () => ({ quarantined: true }))
  }));
});

afterAll(() => watchdog.stop());

describe('probeHost', () => {
  it('probes the loaded model so a false-ready worker cannot pass on a sentinel 404', async () => {
    let requestBody;
    watchdog._setFetch(makeMockFetch({
      '/api/generate': (_url, opts) => {
        requestBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ response: 'ok', done: true }) };
      }
    }));

    const result = await watchdog.probeHost(MOCK_HOST, 'gemma4:26b');
    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.mode).toBe('loaded-model');
    expect(requestBody).toMatchObject({
      model: 'gemma4:26b',
      think: false,
      keep_alive: -1,
      options: { num_predict: 1 }
    });
  });

  it('uses the cheap sentinel probe when no model is loaded', async () => {
    let requestBody;
    watchdog._setFetch(makeMockFetch({
      '/api/generate': (_url, opts) => {
        requestBody = JSON.parse(opts.body);
        return { ok: false, status: 404, json: async () => ({ error: 'model not found' }) };
      }
    }));

    const result = await watchdog.probeHost(MOCK_HOST);
    expect(result.ok).toBe(true);
    expect(result.status).toBe(404);
    expect(result.mode).toBe('control-plane');
    expect(requestBody.model).toBe('_');
  });

  it('returns ok:false with reason timeout when request hangs', async () => {
    jest.useFakeTimers();
    watchdog._setFetch(jest.fn(async (_url, opts) => {
      // Simulate hanging request that gets aborted
      return new Promise((_resolve, reject) => {
        if (opts?.signal) {
          opts.signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    }));

    const pending = watchdog.probeHost(MOCK_HOST, 'gemma4:26b');
    await jest.advanceTimersByTimeAsync(watchdog.getStats().config.probeTimeoutMs + 1);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('timeout');
  });

  it('returns ok:false with connection error reason', async () => {
    watchdog._setFetch(jest.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));

    const result = await watchdog.probeHost(MOCK_HOST, 'gemma4:26b');
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('The outbound request failed.');
  });

  it('performs no probe POST when distributed workload or maintenance denies admission', async () => {
    const denied = Object.assign(new Error('workload owns host'), {
      code: 'RUNTIME_INFERENCE_ADMISSION_DENIED'
    });
    mockBeginInferenceAdmission.mockRejectedValueOnce(denied);
    const generate = jest.fn();
    watchdog._setFetch(makeMockFetch({ '/api/generate': generate }));

    await expect(watchdog.probeHost(MOCK_HOST, 'gemma4:26b')).resolves.toEqual({
      ok: false,
      reason: 'coordination_busy'
    });
    expect(hostGate.hostHasInflight(MOCK_HOST.url)).toBe(false);
    expect(generate).not.toHaveBeenCalled();
  });
});

describe('checkMeta', () => {
  it('returns loaded models when /api/ps responds', async () => {
    watchdog._setFetch(makeMockFetch({
      '/api/ps': () => ({
        ok: true,
        json: async () => ({ models: [{ name: 'gemma4:26b' }, { name: 'qwen3:14b' }] })
      })
    }));

    const result = await watchdog.checkMeta(MOCK_HOST);
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['gemma4:26b', 'qwen3:14b']);
  });

  it('returns ok:false when /api/ps is unreachable', async () => {
    watchdog._setFetch(jest.fn(async () => { throw new Error('ECONNREFUSED'); }));

    const result = await watchdog.checkMeta(MOCK_HOST);
    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
  });
});

describe('probeCycle (integration)', () => {
  it('does not trigger unjam on healthy host', async () => {
    let requestBody;
    const mockFetch = makeMockFetch({
      '/api/generate': (_url, opts) => {
        requestBody = JSON.parse(opts.body);
        return { ok: true, status: 200, json: async () => ({ done: true }) };
      },
      '/api/ps': () => ({ ok: true, json: async () => ({ models: [{ name: 'gemma4:26b' }] }) })
    });
    watchdog._setFetch(mockFetch);

    await watchdog.runNow();

    const stats = watchdog.getStats();
    expect(stats.jamsDetected).toBe(0);
    expect(stats.probesOk).toBeGreaterThan(0);
    expect(requestBody.model).toBe('gemma4:26b');
  });

  it('does not queue a synthetic probe behind active AgentX inference', async () => {
    hostGate._resetForTests();
    const release = await hostGate.acquire(MOCK_HOST.url, 'gemma4:26b');
    const generate = jest.fn(() => ({ ok: true, status: 200 }));
    watchdog._setFetch(makeMockFetch({
      '/api/generate': generate,
      '/api/ps': () => ({ ok: true, json: async () => ({ models: [{ name: 'gemma4:26b' }] }) })
    }));

    try {
      await watchdog.runNow();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('does not probe a resident model while a different model is waiting on the host', async () => {
    hostGate._resetForTests();
    const release = await hostGate.acquire(MOCK_HOST.url, 'cold-swap-model');
    const generate = jest.fn(() => ({ ok: true, status: 200 }));
    watchdog._setFetch(makeMockFetch({
      '/api/generate': generate,
      '/api/ps': () => ({ ok: true, json: async () => ({ models: [{ name: 'resident-model' }] }) })
    }));

    try {
      await watchdog.runNow();
      expect(generate).not.toHaveBeenCalled();
    } finally {
      release();
    }
  });

  it('does not trigger on first timeout (requires consecutive fails)', async () => {
    jest.useFakeTimers();
    watchdog._setFetch(makeMockFetch({
      '/api/ps': () => ({
        ok: true,
        json: async () => ({ models: [{ name: 'gemma4:26b' }] })
      }),
      '/api/generate': (_url, opts) => {
        // Simulate timeout on probe
        return new Promise((_resolve, reject) => {
          if (opts?.signal) {
            opts.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }
        });
      }
    }));

    const pending = watchdog.runNow();
    await jest.advanceTimersByTimeAsync(watchdog.getStats().config.probeTimeoutMs + 1);
    await pending;
    const stats = watchdog.getStats();
    // Should NOT unjam on first failure (needs MAX_CONSECUTIVE=2)
    expect(stats.jamsDetected).toBe(0);
    expect(stats.probesFailed).toBeGreaterThan(0);
  });
});

describe('getStats', () => {
  it('returns config and running state', () => {
    const stats = watchdog.getStats();
    expect(stats).toHaveProperty('isRunning');
    expect(stats).toHaveProperty('config');
    expect(stats.config).toHaveProperty('probeIntervalMs');
    expect(stats.config).toHaveProperty('probeTimeoutMs');
    expect(stats.config).toHaveProperty('maxConsecutive');
  });
});

describe('forceUnjam + hostGate in-flight guard', () => {
  beforeEach(() => { hostGate._resetForTests(); });

  it('skips unloading models that have active inference in hostGate', async () => {
    // Hold an active slot for qwen2.5 on the mock host — simulates an in-flight judge call
    const release = await hostGate.acquire(MOCK_HOST.url, 'qwen2.5:7b');

    const generateBodies = [];
    watchdog._setFetch(makeMockFetch({
      '/api/ps': () => ({
        ok: true,
        json: async () => ({ models: [{ name: 'qwen2.5:7b' }, { name: 'idle-model' }] })
      }),
      '/api/generate': (_url, opts) => {
        generateBodies.push(JSON.parse(opts.body));
        return { ok: true, status: 200, json: async () => ({ done: true }) };
      }
    }));

    const result = await watchdog.forceUnjam(MOCK_HOST.url);

    // qwen2.5:7b had in-flight → skipped; idle-model had no in-flight → unloaded
    expect(result.skipped).toEqual(['qwen2.5:7b']);
    expect(result.unloaded).toContain('idle-model');
    expect(result.unloaded).not.toContain('qwen2.5:7b');

    // Confirm no keep_alive:0 was ever sent for the in-flight model
    const unloadCalls = generateBodies.filter(b => b.keep_alive === 0);
    expect(unloadCalls.find(b => b.model === 'qwen2.5:7b')).toBeUndefined();
    expect(unloadCalls.find(b => b.model === 'idle-model')).toBeDefined();

    release();
  });

  it('unloads all models when hostGate shows no active inference', async () => {
    watchdog._setFetch(makeMockFetch({
      '/api/ps': () => ({
        ok: true,
        json: async () => ({ models: [{ name: 'a' }, { name: 'b' }] })
      }),
      '/api/generate': () => ({ ok: true, status: 200, json: async () => ({ done: true }) })
    }));

    const result = await watchdog.forceUnjam(MOCK_HOST.url);
    expect(result.unloaded.sort()).toEqual(['a', 'b']);
    expect(result.skipped).toEqual([]);
  });
});

describe('start/stop', () => {
  it('can start and stop without errors', () => {
    watchdog.start();
    expect(watchdog.getStats().isRunning).toBe(true);
    watchdog.stop();
    expect(watchdog.getStats().isRunning).toBe(false);
  });

  it('start is idempotent', () => {
    watchdog.start();
    watchdog.start(); // second call should not throw
    expect(watchdog.getStats().isRunning).toBe(true);
    watchdog.stop();
  });
});
