'use strict';

const { Readable } = require('node:stream');

jest.mock('../../models/HostPerformanceSnapshot', () => ({
  create: jest.fn()
}));
jest.mock('../../src/services/ollamaVramService', () => ({
  getHostVram: jest.fn()
}));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => []),
  normalizeHostUrl: jest.fn((url) => url)
}));
jest.mock('../../src/helpers/ollamaModelIdentity', () => ({
  isSameOllamaModel: jest.fn(() => false)
}));
jest.mock('../../src/services/modelContextResolver', () => ({
  resolveModelNumCtxDetails: jest.fn(),
  normalizeModelName: jest.fn((name) => String(name || '').replace(/:latest$/i, ''))
}));
jest.mock('../../src/helpers/circuitBreaker', () => ({
  canRequest: jest.fn(() => ({ allowed: true })),
  recordSuccess: jest.fn(),
  recordFailure: jest.fn()
}));
jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const { isSameOllamaModel } = require('../../src/helpers/ollamaModelIdentity');
const {
  checkHost,
  HOST_TEST_OPERATIONS,
  _internal: {
    HOST_TEST_OPERATION_SPECS,
    configuredCoreOrigin,
    createHostTestExecutor,
    hostTestRequest,
    operationMatches,
    readExactGenerateTerminal,
    warmUp,
    verifyAppliedContext
  }
} = require('../../src/services/hostTestService');
const { readBoundedJson } = require('../../../shared/outboundHttpExecutor');

function headers(values = {}) {
  const normalized = new Map(Object.entries(values)
    .map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) ?? null };
}

function response(url, {
  body = '',
  headerValues = {},
  redirected = false,
  status = 200
} = {}) {
  return {
    body: Readable.from(body ? [body] : []),
    headers: headers(headerValues),
    redirected,
    status,
    url
  };
}

function passthroughTransport() {
  return async ({ fetchImpl, init, target }) => ({
    response: await fetchImpl(target, init),
    peerVerification: 'connect-time'
  });
}

function createTestExecutor(fetchImpl, options = {}) {
  return createHostTestExecutor({
    admitOllamaTargetResolved: async (target) => new URL(target).origin,
    coreUrl: options.coreUrl || configuredCoreOrigin(),
    fetchImpl,
    getConfiguredHosts: () => [],
    transportAdapter: passthroughTransport()
  });
}

describe('hostTestService governed outbound operations', () => {
  const originalToken = process.env.AGENTX_BENCHMARK_TOKEN;

  afterEach(() => {
    jest.useRealTimers();
    isSameOllamaModel.mockReset();
    if (originalToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = originalToken;
  });

  test('closes all seven operation IDs over exact method, path, and search rules', () => {
    expect(Object.keys(HOST_TEST_OPERATION_SPECS).sort())
      .toEqual(Object.values(HOST_TEST_OPERATIONS).sort());
    expect([
      ['GET', '/api/tags', HOST_TEST_OPERATIONS.TAGS],
      ['GET', '/api/ps', HOST_TEST_OPERATIONS.LOADED_PS],
      ['GET', '/api/ps', HOST_TEST_OPERATIONS.UNLOAD_PS],
      ['POST', '/api/generate', HOST_TEST_OPERATIONS.UNLOAD_CURRENT],
      ['POST', '/api/generate', HOST_TEST_OPERATIONS.UNLOAD_ONE],
      ['POST', '/api/inference/generate', HOST_TEST_OPERATIONS.WARMUP],
      ['POST', '/api/generate', HOST_TEST_OPERATIONS.PROBE]
    ].every(([method, path, operationId]) => operationMatches(
      HOST_TEST_OPERATION_SPECS[operationId],
      method,
      new URL(path, 'http://service.test')
    ))).toBe(true);

    expect(operationMatches(
      HOST_TEST_OPERATION_SPECS[HOST_TEST_OPERATIONS.TAGS],
      'POST',
      new URL('http://ollama:11434/api/tags')
    )).toBe(false);
    expect(operationMatches(
      HOST_TEST_OPERATION_SPECS[HOST_TEST_OPERATIONS.TAGS],
      'GET',
      new URL('http://ollama:11434/api/tags?next=/api/ps')
    )).toBe(false);
  });

  test('rejects operation/path mismatches and an unconfigured Core authority before dispatch', async () => {
    const fetchImpl = jest.fn();
    const executor = createTestExecutor(fetchImpl, { coreUrl: 'http://core.test:3080' });

    await expect(hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama:11434/api/ps',
      { method: 'GET' },
      executor
    )).rejects.toThrow('not registered');
    await expect(hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama:11434/api/tags',
      { method: 'POST' },
      executor
    )).rejects.toThrow('not registered');
    await expect(hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama:11434/api/tags?redirect=/api/ps',
      { method: 'GET' },
      executor
    )).rejects.toThrow('not registered');
    await expect(hostTestRequest(
      HOST_TEST_OPERATIONS.WARMUP,
      'http://attacker.test:3080/api/inference/generate',
      { method: 'POST', body: '{}' },
      executor
    )).rejects.toMatchObject({
      code: 'OUTBOUND_TARGET_REJECTED',
      sinkId: HOST_TEST_OPERATIONS.WARMUP
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('rejects redirects without following them', async () => {
    const fetchImpl = jest.fn(async (url) => response(url, {
      body: 'redirect',
      headerValues: { location: 'http://attacker.test/private' },
      status: 307
    }));
    const executor = createTestExecutor(fetchImpl);

    await expect(hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama:11434/api/tags',
      { method: 'GET' },
      executor
    )).rejects.toMatchObject({
      code: 'OUTBOUND_REDIRECT_REJECTED',
      sinkId: HOST_TEST_OPERATIONS.TAGS,
      status: 307
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('preserves an HTTP connectivity status without draining its error body', async () => {
    const destroy = jest.fn();
    const target = 'http://ollama:11434/api/tags';
    const fetchImpl = jest.fn(async () => ({
      body: { destroy },
      headers: headers(),
      redirected: false,
      status: 503,
      url: target
    }));
    const executor = createTestExecutor(fetchImpl);

    await expect(checkHost('http://ollama:11434', { executor })).resolves.toMatchObject({
      available: false,
      error: 'HTTP 503',
      models: []
    });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('enforces request and response byte caps before retaining unbounded data', async () => {
    const oversizedResponseFetch = jest.fn(async (url) => response(url, {
      body: '{}',
      headerValues: { 'content-length': String(1024 * 1024 + 1) }
    }));
    const responseExecutor = createTestExecutor(oversizedResponseFetch);

    await expect(hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama:11434/api/tags',
      { method: 'GET' },
      responseExecutor
    )).rejects.toMatchObject({
      code: 'OUTBOUND_RESPONSE_TOO_LARGE',
      sinkId: HOST_TEST_OPERATIONS.TAGS
    });

    const requestFetch = jest.fn();
    const requestExecutor = createTestExecutor(requestFetch);
    await expect(hostTestRequest(
      HOST_TEST_OPERATIONS.UNLOAD_ONE,
      'http://ollama:11434/api/generate',
      { method: 'POST', body: 'x'.repeat(64 * 1024 + 1) },
      requestExecutor
    )).rejects.toMatchObject({
      code: 'OUTBOUND_REQUEST_TOO_LARGE',
      sinkId: HOST_TEST_OPERATIONS.UNLOAD_ONE
    });
    expect(requestFetch).not.toHaveBeenCalled();
  });

  test('enforces the full response lifecycle deadline and aborts the transport', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn((_url, { signal }) => new Promise((_resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      if (signal.aborted) abort();
      else signal.addEventListener('abort', abort, { once: true });
    }));
    const executor = createTestExecutor(fetchImpl);
    const requestPromise = hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama:11434/api/tags',
      { method: 'GET' },
      executor
    );
    const assertion = expect(requestPromise).rejects.toMatchObject({
      code: 'OUTBOUND_DEADLINE_EXCEEDED',
      sinkId: HOST_TEST_OPERATIONS.TAGS
    });

    await jest.advanceTimersByTimeAsync(5_001);
    await assertion;
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  test('bounds authority admission inside the same operation deadline', async () => {
    jest.useFakeTimers();
    const fetchImpl = jest.fn();
    const executor = createHostTestExecutor({
      admitOllamaTargetResolved: () => new Promise(() => {}),
      coreUrl: configuredCoreOrigin(),
      fetchImpl,
      getConfiguredHosts: () => [],
      transportAdapter: passthroughTransport()
    });
    const requestPromise = hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama.example:11434/api/tags',
      { method: 'GET' },
      executor
    );
    const assertion = expect(requestPromise).rejects.toMatchObject({
      code: 'OUTBOUND_DEADLINE_EXCEEDED',
      sinkId: HOST_TEST_OPERATIONS.TAGS
    });

    await jest.advanceTimersByTimeAsync(5_001);
    await assertion;
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('propagates caller cancellation before dispatch', async () => {
    const fetchImpl = jest.fn();
    const executor = createTestExecutor(fetchImpl);
    const controller = new AbortController();
    controller.abort('caller-controlled detail');

    await expect(hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama:11434/api/tags',
      { method: 'GET', signal: controller.signal },
      executor
    )).rejects.toMatchObject({
      code: 'OUTBOUND_CALLER_ABORTED',
      sinkId: HOST_TEST_OPERATIONS.TAGS
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('keeps the Benchmark credential on the loaded Core warm-up only', async () => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-host-test-token';
    isSameOllamaModel.mockImplementation((left, right) => left === right);
    const fetchImpl = jest.fn(async (url) => {
      if (url.endsWith('/api/ps')) {
        return response(url, {
          body: JSON.stringify({
            models: [{ name: 'model-a', context_length: 4096 }]
          })
        });
      }
      return response(url, { body: JSON.stringify({ done: true }) });
    });
    const executor = createTestExecutor(fetchImpl);

    await warmUp('http://ollama:11434', 'model-a', 60_000, 4096, executor);

    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0][1].headers || {}).not.toHaveProperty(
      'x-agentx-benchmark-token'
    );
    expect(fetchImpl.mock.calls[1][0]).toMatch(/\/api\/inference\/generate$/);
    expect(fetchImpl.mock.calls[1][1].headers).toMatchObject({
      'content-type': 'application/json',
      'x-agentx-benchmark-token': 'benchmark-host-test-token'
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toMatchObject({
      callerDetail: 'benchmark-host-test-warmup',
      host: 'http://ollama:11434',
      model: 'model-a'
    });
  });

  test('requires an exact done terminal for direct or delegated warm-up responses', async () => {
    const incompleteExecutor = createTestExecutor(jest.fn(async (url) => response(url, {
      body: JSON.stringify({ response: 'ready' })
    })));
    const incomplete = await hostTestRequest(
      HOST_TEST_OPERATIONS.WARMUP,
      'http://ollama:11434/api/generate',
      { method: 'POST', body: '{}' },
      incompleteExecutor
    );
    await expect(readExactGenerateTerminal(incomplete, 'cold_preload warm-up'))
      .rejects.toMatchObject({ code: 'OLLAMA_RESPONSE_INCOMPLETE' });

    const completeExecutor = createTestExecutor(jest.fn(async (url) => response(url, {
      body: JSON.stringify({ done: true, response: 'ready' })
    })));
    const complete = await hostTestRequest(
      HOST_TEST_OPERATIONS.WARMUP,
      'http://ollama:11434/api/generate',
      { method: 'POST', body: '{}' },
      completeExecutor
    );
    await expect(readExactGenerateTerminal(complete, 'cold_preload warm-up'))
      .resolves.toMatchObject({ done: true });
  });

  test('requires /api/ps to attest the exact applied context after a probe', async () => {
    isSameOllamaModel.mockImplementation((left, right) => left === right);
    const exactExecutor = createTestExecutor(jest.fn(async (url) => response(url, {
      body: JSON.stringify({ models: [{ name: 'model-a', context_length: 32768 }] })
    })));
    await expect(verifyAppliedContext(
      'http://ollama:11434',
      'model-a',
      32768,
      null,
      exactExecutor
    )).resolves.toBe(32768);

    const clampedExecutor = createTestExecutor(jest.fn(async (url) => response(url, {
      body: JSON.stringify({ models: [{ name: 'model-a', context_length: 8192 }] })
    })));
    await expect(verifyAppliedContext(
      'http://ollama:11434',
      'model-a',
      32768,
      null,
      clampedExecutor
    )).rejects.toMatchObject({
      code: 'HOST_TEST_CONTEXT_CLAMPED',
      requestedNumCtx: 32768,
      observedNumCtx: 8192
    });

    const absentExecutor = createTestExecutor(jest.fn(async (url) => response(url, {
      body: JSON.stringify({ models: [] })
    })));
    await expect(verifyAppliedContext(
      'http://ollama:11434',
      'model-a',
      32768,
      null,
      absentExecutor
    )).rejects.toMatchObject({ code: 'HOST_TEST_CONTEXT_UNVERIFIED' });
  });

  test('uses bounded managed JSON readers for the successful inventory response', async () => {
    const fetchImpl = jest.fn(async (url) => response(url, {
      body: JSON.stringify({ models: [{ name: 'model-a' }] })
    }));
    const executor = createTestExecutor(fetchImpl);
    const managed = await hostTestRequest(
      HOST_TEST_OPERATIONS.TAGS,
      'http://ollama:11434/api/tags',
      { method: 'GET' },
      executor
    );

    await expect(readBoundedJson(managed)).resolves.toEqual({
      models: [{ name: 'model-a' }]
    });
  });
});
