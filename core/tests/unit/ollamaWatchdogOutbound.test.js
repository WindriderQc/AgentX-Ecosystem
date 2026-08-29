'use strict';

const { Readable } = require('node:stream');
const outboundRegistry = require('../../../config/outbound-http-sinks.json');

jest.mock('../../config/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn()
}));

jest.mock('../../src/helpers/ollamaHostConfig', () => ({
  getConfiguredHosts: jest.fn(() => [])
}));

const {
  OUTBOUND_ERROR_CODES,
  readBoundedJson
} = require('../../../shared/outboundHttpExecutor');
const watchdog = require('../../src/services/ollamaWatchdogService');
const hostGate = require('../../src/services/hostGate');

const HOST = Object.freeze({
  id: 'primary',
  name: 'Configured Ollama',
  url: 'http://ollama.test:11434'
});

const {
  WATCHDOG_OPERATIONS,
  checkMeta,
  probeHost,
  _internal: {
    GENERATE_MAX_REQUEST_BYTES,
    GENERATE_MAX_RESPONSE_BYTES,
    META_MAX_RESPONSE_BYTES,
    META_TIMEOUT_MS,
    PROBE_TIMEOUT_MS,
    RESTORE_TIMEOUT_MS,
    UNJAM_TIMEOUT_MS,
    WATCHDOG_OPERATION_SPECS,
    WATCHDOG_OUTBOUND_OPERATIONS,
    createWatchdogExecutor,
    operationMatches,
    reloadModel,
    unjamHost,
    watchdogRequest
  }
} = watchdog;

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
    body: typeof body === 'string' || Buffer.isBuffer(body)
      ? Readable.from(body ? [body] : [])
      : body,
    headers: headers(headerValues),
    redirected,
    status,
    url
  };
}

function passthroughTransport({ attest = true } = {}) {
  return async ({ fetchImpl, init, target }) => ({
    response: await fetchImpl(target, init),
    ...(attest ? { peerVerification: 'connect-time' } : {})
  });
}

function createTestExecutor(fetchImpl, options = {}) {
  return createWatchdogExecutor({
    fetchImpl,
    getConfiguredHosts: options.getConfiguredHosts || (() => [HOST]),
    transportAdapter: options.transportAdapter || passthroughTransport()
  });
}

describe('ollamaWatchdogService governed outbound operations', () => {
  beforeEach(() => {
    jest.useRealTimers();
    hostGate._resetForTests();
  });

  afterAll(() => watchdog.stop());

  test('registers exactly four configured operations with bounded metadata', () => {
    expect(outboundRegistry.delegates.find(({ id }) => id === 'core.watchdog.executor'))
      .toEqual({
        id: 'core.watchdog.executor',
        service: 'core',
        source: 'core/src/services/ollamaWatchdogService.js',
        transportAdapterExpression: 'options.transportAdapter||peerVerifiedNodeFetchTransport',
        target: {
          kind: 'sink',
          id: 'core.transport.peer-verified-node-fetch'
        }
      });
    expect(Object.keys(WATCHDOG_OPERATION_SPECS).sort())
      .toEqual(Object.values(WATCHDOG_OPERATIONS).sort());
    expect(WATCHDOG_OPERATION_SPECS).toMatchObject({
      [WATCHDOG_OPERATIONS.GENERATE_PROBE]: {
        allowSearch: false,
        method: 'POST',
        pathPattern: '^/api/generate$',
        responseMode: 'discard',
        policy: {
          authoritySource: 'configured',
          deadlineMs: PROBE_TIMEOUT_MS,
          maxRequestBytes: GENERATE_MAX_REQUEST_BYTES,
          maxResponseBytes: GENERATE_MAX_RESPONSE_BYTES
        }
      },
      [WATCHDOG_OPERATIONS.PS]: {
        allowSearch: false,
        method: 'GET',
        pathPattern: '^/api/ps$',
        responseMode: 'json',
        policy: {
          authoritySource: 'configured',
          deadlineMs: META_TIMEOUT_MS,
          maxRequestBytes: 0,
          maxResponseBytes: META_MAX_RESPONSE_BYTES
        }
      },
      [WATCHDOG_OPERATIONS.UNJAM]: {
        method: 'POST',
        policy: { deadlineMs: UNJAM_TIMEOUT_MS }
      },
      [WATCHDOG_OPERATIONS.RESTORE]: {
        method: 'POST',
        policy: { deadlineMs: RESTORE_TIMEOUT_MS }
      }
    });
    expect(WATCHDOG_OUTBOUND_OPERATIONS).toEqual(Object.fromEntries(
      Object.entries(WATCHDOG_OPERATION_SPECS)
        .map(([operationId, spec]) => [operationId, spec.policy])
    ));

    for (const [operationId, spec] of Object.entries(WATCHDOG_OPERATION_SPECS)) {
      expect(outboundRegistry.operations.find(({ id }) => id === operationId)).toMatchObject({
        allowSearch: spec.allowSearch,
        authoritySource: spec.policy.authoritySource,
        deadlineMs: spec.policy.deadlineMs,
        delegateId: 'core.watchdog.executor',
        enforcementStatus: 'enforced',
        maxRequestBytes: spec.policy.maxRequestBytes,
        maxResponseBytes: spec.policy.maxResponseBytes,
        method: spec.method,
        pathPattern: spec.pathPattern,
        registrationSource: 'core/src/services/ollamaWatchdogService.js',
        responseMode: spec.responseMode,
        service: 'core'
      });
    }
    expect(outboundRegistry.sinks.filter(({ id }) => Object.values(WATCHDOG_OPERATIONS).includes(id)))
      .toEqual([]);
  });

  test('closes method, path, search, and configured-authority contracts before dispatch', async () => {
    const fetchImpl = jest.fn();
    const executor = createTestExecutor(fetchImpl);
    const psSpec = WATCHDOG_OPERATION_SPECS[WATCHDOG_OPERATIONS.PS];

    expect(operationMatches(
      psSpec,
      'GET',
      new URL(`${HOST.url}/api/ps`)
    )).toBe(true);
    expect(operationMatches(
      psSpec,
      'POST',
      new URL(`${HOST.url}/api/ps`)
    )).toBe(false);

    await expect(watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      `${HOST.url}/api/tags`,
      { method: 'GET' },
      executor
    )).rejects.toThrow('not registered');
    await expect(watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      `${HOST.url}/api/ps?next=/api/generate`,
      { method: 'GET' },
      executor
    )).rejects.toThrow('not registered');
    await expect(watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      `${HOST.url}/api/ps`,
      { method: 'POST' },
      executor
    )).rejects.toThrow('not registered');
    await expect(watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      'http://attacker.test:11434/api/ps',
      { method: 'GET' },
      executor
    )).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.TARGET_REJECTED,
      sinkId: WATCHDOG_OPERATIONS.PS
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('keeps non-2xx decisions status-first and cancels hanging error bodies', async () => {
    const body = new Readable({ read() {} });
    const destroy = jest.spyOn(body, 'destroy');
    const fetchImpl = jest.fn(async (url) => response(url, { body, status: 503 }));
    const executor = createTestExecutor(fetchImpl);

    await expect(checkMeta(HOST, executor)).resolves.toEqual({ ok: false, models: [] });
    expect(destroy).toHaveBeenCalled();
  });

  test('keeps generate probe, unload retry, and restore status semantics', async () => {
    const fetchImpl = jest.fn(async (url, init) => {
      const model = JSON.parse(init.body).model;
      const status = model === 'accepted-legacy'
        ? 499
        : model === 'server-failure'
          ? 503
          : model === 'probe-model'
            ? 404
            : model === 'later-success'
              ? 200
              : 500;
      return response(url, { body: new Readable({ read() {} }), status });
    });
    const executor = createTestExecutor(fetchImpl);

    await expect(probeHost(HOST, 'probe-model', executor)).resolves.toMatchObject({
      ok: true,
      status: 404
    });
    await expect(unjamHost(
      HOST,
      ['accepted-legacy', 'server-failure', 'later-success'],
      executor
    )).resolves.toEqual({
      success: true,
      unloaded: ['accepted-legacy', 'later-success'],
      errors: ['server-failure: HTTP 503'],
      skipped: []
    });
    await expect(reloadModel(HOST, 'restore-model', executor)).resolves.toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });

  test('enforces a full response-lifecycle deadline on a hanging metadata body', async () => {
    jest.useFakeTimers();
    let bodyReturns = 0;
    const body = {
      [Symbol.asyncIterator]() {
        return {
          next: () => new Promise(() => {}),
          return: async () => {
            bodyReturns += 1;
            return { done: true };
          }
        };
      }
    };
    let transportSignal;
    const fetchImpl = jest.fn(async (url, init) => {
      transportSignal = init.signal;
      return response(url, { body });
    });
    const executor = createTestExecutor(fetchImpl);

    const pending = checkMeta(HOST, executor);
    await jest.advanceTimersByTimeAsync(META_TIMEOUT_MS + 1);

    await expect(pending).resolves.toEqual({ ok: false, models: [] });
    expect(transportSignal.aborted).toBe(true);
    expect(bodyReturns).toBe(1);
  });

  test('enforces request and streamed-response byte caps', async () => {
    const requestFetch = jest.fn();
    const requestExecutor = createTestExecutor(requestFetch);
    await expect(watchdogRequest(
      WATCHDOG_OPERATIONS.UNJAM,
      `${HOST.url}/api/generate`,
      { method: 'POST', body: 'x'.repeat(GENERATE_MAX_REQUEST_BYTES + 1) },
      requestExecutor
    )).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE,
      sinkId: WATCHDOG_OPERATIONS.UNJAM
    });
    expect(requestFetch).not.toHaveBeenCalled();

    const responseFetch = jest.fn(async (url) => response(url, {
      body: Buffer.alloc(META_MAX_RESPONSE_BYTES + 1, 0x20)
    }));
    const responseExecutor = createTestExecutor(responseFetch);
    const managed = await watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      `${HOST.url}/api/ps`,
      { method: 'GET' },
      responseExecutor
    );
    await expect(readBoundedJson(managed)).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE,
      sinkId: WATCHDOG_OPERATIONS.PS
    });
  });

  test('rejects redirects and forces manual redirect handling', async () => {
    const body = Readable.from(['redirect']);
    const destroy = jest.spyOn(body, 'destroy');
    const fetchImpl = jest.fn(async (url) => response(url, {
      body,
      headerValues: { location: 'http://attacker.test/private' },
      status: 307
    }));
    const executor = createTestExecutor(fetchImpl);

    await expect(watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      `${HOST.url}/api/ps`,
      { method: 'GET' },
      executor
    )).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.REDIRECT_REJECTED,
      sinkId: WATCHDOG_OPERATIONS.PS,
      status: 307
    });
    expect(fetchImpl.mock.calls[0][1].redirect).toBe('manual');
    expect(destroy).toHaveBeenCalled();
  });

  test('rejects a transport response without connect-time peer attestation', async () => {
    const body = Readable.from(['{}']);
    const destroy = jest.spyOn(body, 'destroy');
    const fetchImpl = jest.fn(async (url) => response(url, { body }));
    const executor = createTestExecutor(fetchImpl, {
      transportAdapter: passthroughTransport({ attest: false })
    });

    await expect(watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      `${HOST.url}/api/ps`,
      { method: 'GET' },
      executor
    )).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.PEER_UNVERIFIED,
      sinkId: WATCHDOG_OPERATIONS.PS
    });
    expect(destroy).toHaveBeenCalled();
  });

  test('preserves caller cancellation before transport dispatch', async () => {
    const fetchImpl = jest.fn();
    const executor = createTestExecutor(fetchImpl);
    const controller = new AbortController();
    controller.abort('caller-controlled detail');

    await expect(watchdogRequest(
      WATCHDOG_OPERATIONS.PS,
      `${HOST.url}/api/ps`,
      { method: 'GET', signal: controller.signal },
      executor
    )).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.CALLER_ABORTED,
      sinkId: WATCHDOG_OPERATIONS.PS
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
