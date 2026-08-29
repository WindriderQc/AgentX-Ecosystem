'use strict';

const http = require('node:http');
const { Readable } = require('node:stream');
const outboundRegistry = require('../../../config/outbound-http-sinks.json');

const {
  CONNECT_TIME_PEER_VERIFICATION,
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
} = require('../../../shared/outboundHttpExecutor');
const fetchWithTimeout = require('../../src/utils/fetchWithTimeout');
const {
  SERVICE_OUTBOUND_OPERATIONS,
  SERVICE_OUTBOUND_OPERATION_IDS,
  SERVICE_OUTBOUND_REQUEST_SPECS,
  SERVICE_OUTBOUND_TIMEOUTS,
  configuredDeadline,
  configuredServiceOrigin,
  createServiceOutboundClient,
} = require('../../src/clients/serviceOutboundClient');

function headers(values = {}) {
  const normalized = new Map(Object.entries(values)
    .map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) ?? null };
}

function rawResponse({ body = '', headerValues = {}, status = 200, url = '' } = {}) {
  return {
    body: Readable.from([Buffer.from(body)]),
    headers: headers(headerValues),
    redirected: false,
    status,
    url,
  };
}

function attestedTransport() {
  return async ({ fetchImpl, init, target }) => ({
    peerVerification: CONNECT_TIME_PEER_VERIFICATION,
    response: await fetchImpl(target, init),
  });
}

describe('RAG service outbound operation registry', () => {
  test('defines one frozen policy and closed method/path rule for every operation', () => {
    expect(Object.isFrozen(SERVICE_OUTBOUND_OPERATIONS)).toBe(true);
    expect(Object.isFrozen(SERVICE_OUTBOUND_REQUEST_SPECS)).toBe(true);
    expect(Object.keys(SERVICE_OUTBOUND_OPERATIONS).sort()).toEqual(
      Object.values(SERVICE_OUTBOUND_OPERATION_IDS).sort()
    );
    expect(Object.keys(SERVICE_OUTBOUND_REQUEST_SPECS).sort()).toEqual(
      Object.values(SERVICE_OUTBOUND_OPERATION_IDS).sort()
    );

    for (const operationId of Object.values(SERVICE_OUTBOUND_OPERATION_IDS)) {
      const policy = SERVICE_OUTBOUND_OPERATIONS[operationId];
      const spec = SERVICE_OUTBOUND_REQUEST_SPECS[operationId];
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(spec)).toBe(true);
      expect(policy).toEqual(expect.objectContaining({
        authoritySource: 'configured',
        deadlineMs: expect.any(Number),
        maxRequestBytes: expect.any(Number),
        maxResponseBytes: expect.any(Number),
      }));
      expect(spec.allowSearch).toBe(false);
      expect(spec.pathPattern.startsWith('^')).toBe(true);
      expect(spec.pathPattern.endsWith('$')).toBe(true);
      expect(() => new RegExp(spec.pathPattern)).not.toThrow();
      expect(SERVICE_OUTBOUND_TIMEOUTS[operationId]).toBeGreaterThan(0);
      expect(SERVICE_OUTBOUND_TIMEOUTS[operationId]).toBeLessThanOrEqual(policy.deadlineMs);
    }
  });

  test('keeps runtime policy, request rules, and response mode aligned with registry v2', () => {
    const registered = new Map(outboundRegistry.operations
      .filter(({ registrationSource }) => (
        registrationSource === 'rag/src/clients/serviceOutboundClient.js'
      ))
      .map((operation) => [operation.id, operation]));
    expect([...registered.keys()].sort()).toEqual(
      Object.values(SERVICE_OUTBOUND_OPERATION_IDS).sort()
    );

    for (const [operationId, policy] of Object.entries(SERVICE_OUTBOUND_OPERATIONS)) {
      expect(registered.get(operationId)).toMatchObject({
        ...policy,
        allowSearch: SERVICE_OUTBOUND_REQUEST_SPECS[operationId].allowSearch,
        delegateId: 'rag.service-http.executor',
        enforcementStatus: 'enforced',
        method: SERVICE_OUTBOUND_REQUEST_SPECS[operationId].method,
        pathPattern: SERVICE_OUTBOUND_REQUEST_SPECS[operationId].pathPattern,
        responseMode: 'bytes',
      });
    }
  });

  test('bounds configured workflow deadlines before they can weaken executor ceilings', () => {
    const envName = 'AGENTX_TEST_OUTBOUND_DEADLINE_MS';
    const original = process.env[envName];
    try {
      delete process.env[envName];
      expect(configuredDeadline(envName, 15, 100)).toBe(15);
      process.env[envName] = '80';
      expect(configuredDeadline(envName, 15, 100)).toBe(80);
      for (const invalid of ['0', '-1', '1.5', '101', 'not-a-number']) {
        process.env[envName] = invalid;
        expect(() => configuredDeadline(envName, 15, 100)).toThrow(envName);
      }
    } finally {
      if (original === undefined) delete process.env[envName];
      else process.env[envName] = original;
    }
  });

  test('accepts origins only and rejects credentials, paths, search, fragments, and non-HTTP schemes', () => {
    expect(configuredServiceOrigin(' HTTP://Qdrant.Test:80/ ')).toBe('http://qdrant.test');
    expect(configuredServiceOrigin('http://[::1]:6333/')).toBe('http://[::1]:6333');
    for (const invalid of [
      'ftp://qdrant.test',
      'http://user:secret@qdrant.test',
      'http://qdrant.test/base',
      'http://qdrant.test/?mode=test',
      'http://qdrant.test/#fragment',
      'not-a-url',
    ]) {
      expect(() => configuredServiceOrigin(invalid)).toThrow(
        'Configured outbound service URL must be an HTTP(S) origin.'
      );
    }
  });

  test('rejects wrong authority, method, path, search, and path-segment escapes before transport', async () => {
    const transportAdapter = jest.fn(attestedTransport());
    const client = createServiceOutboundClient({
      expectedOrigins: ['http://qdrant.test:6333'],
      fetchImpl: jest.fn(),
      transportAdapter,
    });
    const operationId = SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SEARCH;

    await expect(client.requestBytes(
      operationId,
      'http://other.test:6333/collections/agentx_embeddings/points/search',
      { method: 'POST' }
    )).rejects.toMatchObject({ code: OUTBOUND_ERROR_CODES.TARGET_REJECTED });

    for (const [target, method] of [
      ['http://qdrant.test:6333/collections/agentx_embeddings/points/search', 'GET'],
      ['http://qdrant.test:6333/collections/agentx_embeddings/points/delete', 'POST'],
      ['http://qdrant.test:6333/collections/agentx_embeddings/points/search?limit=1', 'POST'],
      ['http://qdrant.test:6333/collections/%2Fescape/points/search', 'POST'],
    ]) {
      await expect(client.requestBytes(operationId, target, { method })).rejects.toThrow(
        'Outbound service operation does not match its closed request specification.'
      );
    }
    expect(transportAdapter).not.toHaveBeenCalled();
  });

  test('enforces request and declared response caps before returning a response', async () => {
    const transportAdapter = jest.fn(attestedTransport());
    const fetchImpl = jest.fn(async (target) => rawResponse({
      headerValues: { 'content-length': (4 * 1024 * 1024) + 1 },
      url: target,
    }));
    const client = createServiceOutboundClient({
      expectedOrigins: ['http://ollama.test:11434'],
      fetchImpl,
      transportAdapter,
    });
    const operationId = SERVICE_OUTBOUND_OPERATION_IDS.OLLAMA_EMBED_SINGLE;
    const target = 'http://ollama.test:11434/api/embeddings';

    await expect(client.requestBytes(operationId, target, {
      body: 'x'.repeat((128 * 1024) + 1),
      method: 'POST',
    })).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE,
      name: OutboundHttpError.name,
    });
    expect(transportAdapter).not.toHaveBeenCalled();

    await expect(client.requestBytes(operationId, target, {
      body: '{}',
      method: 'POST',
    })).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE,
      name: OutboundHttpError.name,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('snapshots and normalizes the method before asynchronous admission', async () => {
    let methodReads = 0;
    const requestOptions = { body: '{}' };
    Object.defineProperty(requestOptions, 'method', {
      enumerable: true,
      get() {
        methodReads += 1;
        return methodReads === 1 ? 'post' : 'DELETE';
      },
    });
    const fetchImpl = jest.fn(async (target) => rawResponse({ body: '{}', url: target }));
    const client = createServiceOutboundClient({
      expectedOrigins: ['http://core.test:3080'],
      fetchImpl,
      transportAdapter: attestedTransport(),
    });

    await expect(client.requestBytes(
      SERVICE_OUTBOUND_OPERATION_IDS.QUERY_EXPANSION_GENERATE,
      'http://core.test:3080/api/inference/generate',
      requestOptions
    )).resolves.toMatchObject({ status: 200 });
    expect(methodReads).toBe(1);
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST');
  });

  test('rejects manual redirects and bounds an undeclared streaming response while reading it', async () => {
    const responses = [
      rawResponse({ status: 302 }),
      rawResponse({ body: 'x'.repeat((1024 * 1024) + 1) }),
    ];
    const client = createServiceOutboundClient({
      expectedOrigins: ['http://qdrant.test:6333'],
      fetchImpl: jest.fn(async () => responses.shift()),
      transportAdapter: attestedTransport(),
    });
    const operationId = SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTIONS_HEALTH;
    const target = 'http://qdrant.test:6333/collections';

    await expect(client.requestBytes(operationId, target)).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.REDIRECT_REJECTED,
    });
    await expect(client.requestBytes(operationId, target)).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE,
    });
  });
});

describe('RAG bounded fetch compatibility facade', () => {
  let server;
  let origin;

  afterEach(async () => {
    if (!server) return;
    await new Promise((resolve) => server.close(resolve));
    server = null;
  });

  async function listen(handler) {
    server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
  }

  test('keeps the caller deadline active through response-body consumption', async () => {
    await listen((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      setTimeout(() => response.end('{"ok":true}'), 100);
    });

    await expect(fetchWithTimeout(
      `${origin}/collections`,
      {},
      20,
      {
        expectedOrigins: [origin],
        operationId: SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTIONS_HEALTH,
      }
    )).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED,
      message: 'HTTP request timed out after 20ms',
    });
  });

  test('returns bounded Fetch-like bytes and preserves single-use body semantics', async () => {
    await listen((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end('{"ok":true}');
    });

    const response = await fetchWithTimeout(
      `${origin}/collections`,
      {},
      2_000,
      {
        expectedOrigins: [origin],
        operationId: SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTIONS_HEALTH,
      }
    );

    expect(response.ok).toBe(true);
    expect(response.bodyUsed).toBe(false);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(response.bodyUsed).toBe(true);
    await expect(response.text()).rejects.toThrow('body used already');
  });
});
