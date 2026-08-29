'use strict';

const http = require('node:http');
const {
  CONNECT_TIME_PEER_VERIFICATION,
  OUTBOUND_ERROR_CODES,
} = require('../../../shared/outboundHttpExecutor');
const {
  MODEL_INVENTORY_MAX_RESPONSE_BYTES,
  OPERATIONS_HEALTH_OPERATION_IDS,
  OPERATIONS_HEALTH_OPERATIONS,
  OPERATIONS_HEALTH_REQUEST_SPECS,
  createConfiguredOperationsAuthorityAdapter,
  createOperationsHealthClient,
  publicOperationsHealthError,
} = require('../../src/services/operationsHealthClient');

function listen(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url });
    handler(req, res);
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        origin: `http://127.0.0.1:${server.address().port}`,
        requests,
        server,
      });
    });
  });
}

async function close(server) {
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
}

function configuredClient(origin, options = {}) {
  return createOperationsHealthClient({
    ollamaUrl: origin,
    optionalRuntimeUrl: origin,
    qdrantUrl: origin,
    ...options,
  });
}

function policiesWith(operationId, overrides) {
  return Object.freeze(Object.fromEntries(
    Object.entries(OPERATIONS_HEALTH_OPERATIONS).map(([id, policy]) => [
      id,
      Object.freeze(id === operationId ? { ...policy, ...overrides } : { ...policy }),
    ])
  ));
}

describe('operations health outbound client', () => {
  test('publishes three frozen GET-only, no-search operations', () => {
    expect(Object.keys(OPERATIONS_HEALTH_OPERATIONS)).toEqual([
      'core.operations.optional-runtime-probe',
      'core.operations.ollama-health',
      'core.operations.qdrant-health',
    ]);
    for (const [operationId, spec] of Object.entries(OPERATIONS_HEALTH_REQUEST_SPECS)) {
      expect(spec).toMatchObject({ allowSearch: false, method: 'GET' });
      expect(spec.pathPattern).toEqual(expect.any(String));
      expect(Object.isFrozen(spec)).toBe(true);
      expect(OPERATIONS_HEALTH_OPERATIONS[operationId]).toMatchObject({
        authoritySource: 'configured',
        deadlineMs: 5_000,
        maxRequestBytes: 0,
      });
    }
  });

  test('executes the exact optional-runtime, Ollama and Qdrant probes', async () => {
    const running = await listen((req, res) => {
      if (req.url === '/api/tags') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [{ name: 'model-a' }] }));
        return;
      }
      if (req.url === '/api/ps') {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('READY');
        return;
      }
      if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
        return;
      }
      res.writeHead(404).end();
    });
    const client = configuredClient(running.origin);

    try {
      await expect(client.probeOptionalRuntime('/api/tags')).resolves.toMatchObject({
        data: { models: [{ name: 'model-a' }] },
        json: true,
        ok: true,
        status: 200,
        url: `${running.origin}/api/tags`,
      });
      await expect(client.probeOptionalRuntime('/api/ps')).resolves.toMatchObject({
        data: 'READY',
        json: false,
        ok: true,
        status: 200,
      });
      await expect(client.getOllamaTags()).resolves.toMatchObject({
        data: { models: [{ name: 'model-a' }] },
        ok: true,
        status: 200,
      });
      await expect(client.getQdrantHealth()).resolves.toEqual({ ok: true, status: 200 });
      expect(running.requests).toEqual([
        { method: 'GET', url: '/api/tags' },
        { method: 'GET', url: '/api/ps' },
        { method: 'GET', url: '/api/tags' },
        { method: 'GET', url: '/healthz' },
      ]);
    } finally {
      await close(running.server);
    }
  });

  test('rejects the wrong configured authority and every unregistered path or search', async () => {
    const configured = {
      ollamaUrl: 'http://127.0.0.1:11434',
      optionalRuntimeUrl: 'http://127.0.0.1:11435',
      qdrantUrl: 'http://127.0.0.1:6333',
    };
    const admit = createConfiguredOperationsAuthorityAdapter(configured);
    expect(() => admit({
      authoritySource: 'configured',
      sinkId: OPERATIONS_HEALTH_OPERATION_IDS.OLLAMA_HEALTH,
      target: 'http://127.0.0.1:6333/api/tags',
    })).toThrow('target is not registered');
    expect(() => admit({
      authoritySource: 'request-admitted',
      sinkId: OPERATIONS_HEALTH_OPERATION_IDS.OLLAMA_HEALTH,
      target: 'http://127.0.0.1:11434/api/tags',
    })).toThrow('target is not registered');

    const client = createOperationsHealthClient(configured);
    await expect(client.probeOptionalRuntime('/healthz')).rejects.toThrow(
      'target is not registered'
    );
    await expect(client.probeOptionalRuntime('/api/tags?verbose=1')).rejects.toThrow(
      'target is not registered'
    );
  });

  test('rejects redirects without following them', async () => {
    const running = await listen((_req, res) => {
      res.writeHead(302, { location: '/different' });
      res.end();
    });

    try {
      await expect(configuredClient(running.origin).getOllamaTags()).rejects.toMatchObject({
        code: OUTBOUND_ERROR_CODES.REDIRECT_REJECTED,
        status: 302,
      });
      expect(running.requests).toHaveLength(1);
    } finally {
      await close(running.server);
    }
  });

  test('enforces the declared response cap before consuming the body', async () => {
    const running = await listen((_req, res) => {
      res.writeHead(200, {
        'content-length': String(MODEL_INVENTORY_MAX_RESPONSE_BYTES + 1),
        'content-type': 'application/json',
      });
      res.end('{}');
    });

    try {
      await expect(configuredClient(running.origin).getOllamaTags()).rejects.toMatchObject({
        code: OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE,
        status: 200,
      });
    } finally {
      await close(running.server);
    }
  });

  test('preserves a non-success Qdrant status without draining its error body', async () => {
    const destroy = jest.fn();
    const fetchImpl = jest.fn(async (target) => ({
      body: { destroy },
      headers: { get: () => null },
      redirected: false,
      status: 503,
      url: target,
    }));
    const transportAdapter = async ({ init, target }) => ({
      peerVerification: CONNECT_TIME_PEER_VERIFICATION,
      response: await fetchImpl(target, init),
    });

    await expect(configuredClient('http://qdrant.test:6333', {
      fetchImpl,
      transportAdapter,
    }).getQdrantHealth()).resolves.toEqual({ ok: false, status: 503 });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test('enforces the operation deadline even when a server never responds', async () => {
    const running = await listen(() => {
      // Intentionally leave the response pending; executor cancellation closes it.
    });
    const operations = policiesWith(
      OPERATIONS_HEALTH_OPERATION_IDS.OLLAMA_HEALTH,
      { deadlineMs: 25 }
    );

    try {
      await expect(configuredClient(running.origin, { operations }).getOllamaTags())
        .rejects.toMatchObject({ code: OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED });
    } finally {
      await close(running.server);
    }
  });

  test('projects unexpected failures without leaking transport details', () => {
    expect(publicOperationsHealthError(new Error(
      'connect ECONNREFUSED http://user:secret@private.example:11434'
    ))).toBe('The outbound request failed.');
  });
});
