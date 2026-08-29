'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Readable } = require('node:stream');
const outboundRegistry = require('../../../config/outbound-http-sinks.json');
const { createCorePublicUrlsResolver } = require('../../../shared/browserPublicUrls');

const {
  CONNECT_TIME_PEER_VERIFICATION,
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
} = require('../../../shared/outboundHttpExecutor');
const {
  CORE_OUTBOUND_OPERATIONS,
  CORE_OUTBOUND_OPERATION_IDS,
  CORE_OUTBOUND_REQUEST_SPECS,
  configuredCoreBaseUrl,
  createConnectTimeLookup,
  createConfiguredCoreAuthorityAdapter,
  createCoreOutboundClient,
  createCorePublicUrlsConfigLoader,
  createPinnedNodeFetchTransport,
  normalizeHostname,
  normalizeIpAddress,
} = require('../../src/clients/coreOutboundClient');

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

describe('RAG Core outbound operation registry', () => {
  test('defines closed, bounded policies for model observation and telemetry delivery', () => {
    expect(Object.isFrozen(CORE_OUTBOUND_OPERATIONS)).toBe(true);
    expect(CORE_OUTBOUND_OPERATIONS).toEqual({
      [CORE_OUTBOUND_OPERATION_IDS.MODEL_CATALOG]: {
        authoritySource: 'configured',
        deadlineMs: 10_000,
        maxRequestBytes: 0,
        maxResponseBytes: 8 * 1024 * 1024,
      },
      [CORE_OUTBOUND_OPERATION_IDS.PLATFORM_EVENT]: {
        authoritySource: 'configured',
        deadlineMs: 5_000,
        maxRequestBytes: 64 * 1024,
        maxResponseBytes: 64 * 1024,
      },
      [CORE_OUTBOUND_OPERATION_IDS.PUBLIC_URLS_CONFIG]: {
        authoritySource: 'configured',
        deadlineMs: 2_000,
        maxRequestBytes: 0,
        maxResponseBytes: 65_536,
      },
    });
  });

  test('closes each operation over one method and path', () => {
    expect(Object.isFrozen(CORE_OUTBOUND_REQUEST_SPECS)).toBe(true);
    expect(CORE_OUTBOUND_REQUEST_SPECS).toEqual({
      [CORE_OUTBOUND_OPERATION_IDS.MODEL_CATALOG]: {
        allowSearch: true,
        method: 'GET',
        pathname: '/api/models/all',
      },
      [CORE_OUTBOUND_OPERATION_IDS.PLATFORM_EVENT]: {
        allowSearch: false,
        method: 'POST',
        pathname: '/api/platform-events',
      },
      [CORE_OUTBOUND_OPERATION_IDS.PUBLIC_URLS_CONFIG]: {
        allowSearch: false,
        method: 'GET',
        pathname: '/api/config',
      },
    });
    for (const spec of Object.values(CORE_OUTBOUND_REQUEST_SPECS)) {
      expect(Object.isFrozen(spec)).toBe(true);
    }
  });

  test('keeps both runtime policies and bounded response modes aligned with registry v2', () => {
    const registered = new Map(outboundRegistry.operations
      .filter(({ registrationSource }) => registrationSource === 'rag/src/clients/coreOutboundClient.js')
      .map((operation) => [operation.id, operation]));
    expect([...registered.keys()].sort()).toEqual(Object.values(CORE_OUTBOUND_OPERATION_IDS).sort());

    for (const [operationId, policy] of Object.entries(CORE_OUTBOUND_OPERATIONS)) {
      expect(registered.get(operationId)).toMatchObject({
        ...policy,
        enforcementStatus: 'enforced',
      });
    }
    for (const [operationId, requestSpec] of Object.entries(CORE_OUTBOUND_REQUEST_SPECS)) {
      expect(registered.get(operationId)).toMatchObject({
        allowSearch: requestSpec.allowSearch,
        method: requestSpec.method,
        pathPattern: `^${requestSpec.pathname}$`,
      });
    }
    expect(registered.get(CORE_OUTBOUND_OPERATION_IDS.MODEL_CATALOG).responseMode).toBe('bytes');
    expect(registered.get(CORE_OUTBOUND_OPERATION_IDS.PLATFORM_EVENT).responseMode).toBe('discard');
    expect(registered.get(CORE_OUTBOUND_OPERATION_IDS.PUBLIC_URLS_CONFIG).responseMode).toBe('json');
  });

  test('admits only the exact configured Core origin', () => {
    const admit = createConfiguredCoreAuthorityAdapter('http://core.test:3080');
    expect(admit({
      sinkId: CORE_OUTBOUND_OPERATION_IDS.MODEL_CATALOG,
      target: 'http://core.test:3080/api/models/all?host=primary',
    })).toEqual({
      expectedOrigin: 'http://core.test:3080',
    });
    expect(() => admit({
      sinkId: CORE_OUTBOUND_OPERATION_IDS.MODEL_CATALOG,
      target: 'http://other.test:3080/api/models/all',
    })).toThrow(
      'Outbound target does not match the configured Core authority.'
    );
    expect(() => admit({
      sinkId: CORE_OUTBOUND_OPERATION_IDS.PUBLIC_URLS_CONFIG,
      target: 'http://core.test:3080/api/models/all',
    })).toThrow('Outbound target does not match the configured Core authority.');
  });

  test('accepts only an HTTP(S) origin as configured Core authority', () => {
    expect(configuredCoreBaseUrl(' HTTP://Core.Test:80/ ')).toBe('http://core.test');
    expect(configuredCoreBaseUrl('http://[::1]:3080/')).toBe('http://[::1]:3080');
    for (const invalid of [
      'ftp://core.test',
      'http://user:secret@core.test',
      'http://core.test/api',
      'http://core.test/?mode=test',
      'http://core.test/#fragment',
      'not-a-url',
    ]) {
      expect(() => configuredCoreBaseUrl(invalid)).toThrow(
        'Configured Core URL must be an HTTP(S) origin.'
      );
    }
  });

  test('constructs the catalog target from its fixed path and rejects query path escapes', async () => {
    const transportAdapter = jest.fn(attestedTransport());
    const client = createCoreOutboundClient({
      coreUrl: 'http://core.test:3080',
      fetchImpl: jest.fn(),
      transportAdapter,
    });

    for (const query of ['//other.test/api/models/all', '#fragment', '?ok=1#fragment']) {
      await expect(client.getModelCatalog({ query })).rejects.toThrow(
        'Outbound Core operation does not match its closed request specification.'
      );
    }
    expect(transportAdapter).not.toHaveBeenCalled();
  });

  test('normalizes bracketed IPv6 literals before IP-family checks', () => {
    expect(normalizeHostname('[::1]')).toBe('::1');
    expect(normalizeIpAddress('[::1]')).toBe('::1');
    expect(normalizeIpAddress('[::ffff:127.0.0.1]')).toBe('127.0.0.1');
  });

  test('returns every admitted A/AAAA answer to connect-time lookup', async () => {
    const records = [
      { address: '::1', family: 6 },
      { address: '127.0.0.1', family: 4 },
    ];
    const lookupImpl = jest.fn((_hostname, options, callback) => {
      expect(options).toEqual({ all: true, verbatim: true });
      callback(null, records);
    });
    const admitted = [];
    const lookup = createConnectTimeLookup('core.test', lookupImpl, (address) => admitted.push(address));

    const resolved = await new Promise((resolve, reject) => {
      lookup('core.test', { all: true }, (error, answers) => (error ? reject(error) : resolve(answers)));
    });

    expect(resolved).toEqual(records);
    expect(admitted).toEqual(['::1', '127.0.0.1']);
    expect(lookupImpl).toHaveBeenCalledTimes(1);
  });

  test('rejects authority and hop-by-hop headers before transport dispatch', async () => {
    const fetchImpl = jest.fn();
    const lookup = jest.fn();
    const transport = createPinnedNodeFetchTransport({ lookup });

    await expect(transport({
      authority: {
        expectedOrigin: 'http://core.test:3080',
        hostname: 'core.test',
        protocol: 'http:',
      },
      fetchImpl,
      init: { headers: { Host: 'other.test', connection: 'keep-alive' } },
      target: 'http://core.test:3080/api/config',
    })).rejects.toThrow('Outbound Core transport headers are invalid.');
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(lookup).not.toHaveBeenCalled();
  });

  test('forwards catalog metadata through manual redirects and a bounded body reader', async () => {
    const fetchImpl = jest.fn(async (target) => rawResponse({
      body: JSON.stringify({ ok: true, data: { models: [] } }),
      headerValues: { 'content-type': 'application/json' },
      url: target,
    }));
    const client = createCoreOutboundClient({
      coreUrl: 'http://core.test:3080',
      fetchImpl,
      transportAdapter: attestedTransport(),
    });

    const response = await client.getModelCatalog({
      operatorToken: 'operator-token',
      query: '?host=primary',
    });

    expect(response.status).toBe(200);
    expect(JSON.parse(response.body.toString('utf8'))).toEqual({ ok: true, data: { models: [] } });
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://core.test:3080/api/models/all?host=primary',
      expect.objectContaining({
        redirect: 'manual',
        headers: expect.objectContaining({
          accept: 'application/json',
          'x-agentx-operator-token': 'operator-token',
        }),
        signal: expect.any(AbortSignal),
      })
    );
  });

  test('loads bounded JSON configuration through the exact public-URL adapter contract', async () => {
    const payload = {
      publicUrls: {
        core: 'https://product.example',
        benchmark: 'https://evaluation.example',
        rag: 'https://knowledge.example',
      },
    };
    const fetchImpl = jest.fn(async (target) => rawResponse({
      body: JSON.stringify(payload),
      headerValues: { 'content-type': 'application/json' },
      url: target,
    }));
    const client = createCoreOutboundClient({
      coreUrl: 'http://core.test:3080',
      fetchImpl,
      transportAdapter: attestedTransport(),
    });
    const loader = createCorePublicUrlsConfigLoader({
      coreOutboundClient: client,
      coreUrl: 'http://core.test:3080',
    });

    const response = await loader();

    expect(response).toEqual(payload);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://core.test:3080/api/config',
      expect.objectContaining({
        headers: { accept: 'application/json' },
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      })
    );
  });

  test('injects the bounded config loader into the shared public-URL resolver', () => {
    const appSource = fs.readFileSync(path.resolve(__dirname, '../../app.js'), 'utf8');
    expect(appSource).toMatch(/createCorePublicUrlsResolver\(\{[\s\S]*loadCoreConfig:\s*createCorePublicUrlsConfigLoader\(\{/);
    expect(appSource).not.toMatch(/createCorePublicUrlsResolver\(\{[\s\S]*fetchImpl:/);
  });

  test('satisfies the shared resolver loader contract with parsed authority JSON', async () => {
    const getPublicUrlsConfig = jest.fn().mockResolvedValue({
      ok: true,
      payload: {
        publicUrls: {
          core: 'https://core.authority.test',
          rag: 'https://rag.authority.test',
        },
      },
      status: 200,
    });
    const resolvePublicUrls = createCorePublicUrlsResolver({
      enabled: true,
      env: {
        BENCHMARK_PUBLIC_URL: 'https://benchmark.fallback.test',
        CORE_PUBLIC_URL: 'https://core.fallback.test',
        RAG_PUBLIC_URL: 'https://rag.fallback.test',
      },
      loadCoreConfig: createCorePublicUrlsConfigLoader({
        coreOutboundClient: { getPublicUrlsConfig },
      }),
    });

    await expect(resolvePublicUrls()).resolves.toEqual({
      benchmark: 'https://benchmark.fallback.test',
      core: 'https://core.authority.test',
      rag: 'https://rag.authority.test',
    });
    expect(getPublicUrlsConfig).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
    });
  });

  test('passes resolver cancellation into the operation and rejects non-success status', async () => {
    const signal = new AbortController().signal;
    const getPublicUrlsConfig = jest.fn().mockResolvedValue({
      ok: false,
      payload: { error: 'unavailable' },
      status: 503,
    });
    const loader = createCorePublicUrlsConfigLoader({
      coreOutboundClient: { getPublicUrlsConfig },
    });

    await expect(loader({ signal })).rejects.toThrow('Core public URL authority returned HTTP 503');
    expect(getPublicUrlsConfig).toHaveBeenCalledWith({ signal });
  });

  test('rejects oversized telemetry before transport dispatch', async () => {
    const transportAdapter = jest.fn(attestedTransport());
    const client = createCoreOutboundClient({
      coreUrl: 'http://core.test:3080',
      fetchImpl: jest.fn(),
      transportAdapter,
    });

    await expect(client.deliverPlatformEvent({ body: 'x'.repeat((64 * 1024) + 1) }))
      .rejects.toMatchObject({
        code: OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE,
        name: OutboundHttpError.name,
      });
    expect(transportAdapter).not.toHaveBeenCalled();
  });

  test('rejects redirects and oversized declared catalog responses', async () => {
    const responses = [
      rawResponse({ status: 302 }),
      rawResponse({ headerValues: { 'content-length': (8 * 1024 * 1024) + 1 } }),
    ];
    const client = createCoreOutboundClient({
      coreUrl: 'http://core.test:3080',
      fetchImpl: jest.fn(async () => responses.shift()),
      transportAdapter: attestedTransport(),
    });

    await expect(client.getModelCatalog()).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.REDIRECT_REJECTED,
      name: OutboundHttpError.name,
    });
    await expect(client.getModelCatalog()).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE,
      name: OutboundHttpError.name,
    });
  });

  test('rejects oversized and malformed public-URL JSON', async () => {
    const responses = [
      rawResponse({ headerValues: { 'content-length': 65_537 } }),
      rawResponse({ body: '{not-json' }),
    ];
    const client = createCoreOutboundClient({
      coreUrl: 'http://core.test:3080',
      fetchImpl: jest.fn(async () => responses.shift()),
      transportAdapter: attestedTransport(),
    });

    await expect(client.getPublicUrlsConfig()).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE,
      name: OutboundHttpError.name,
    });
    await expect(client.getPublicUrlsConfig()).rejects.toMatchObject({
      code: OUTBOUND_ERROR_CODES.INVALID_JSON,
      name: OutboundHttpError.name,
    });
  });
});

describe('RAG Core peer-verifying transport', () => {
  let server;
  let origin;
  let receivedEventBody;
  let receivedEventToken;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/api/config') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({
          publicUrls: { core: 'http://localhost:3080' },
        }));
        return;
      }
      if (request.url.startsWith('/api/models/all')) {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ ok: true, data: { models: [{ name: 'local-test' }] } }));
        return;
      }
      if (request.url === '/api/platform-events' && request.method === 'POST') {
        receivedEventToken = request.headers['x-platform-event-token'];
        const chunks = [];
        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
          receivedEventBody = Buffer.concat(chunks).toString('utf8');
          response.statusCode = 202;
          response.end(JSON.stringify({ ok: true }));
        });
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://core.test:${server.address().port}`;
  });

  afterAll(async () => {
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  test('pins configured DNS resolution and verifies the connected peer before attesting', async () => {
    const lookup = jest.fn((hostname, options, callback) => {
      expect(hostname).toBe('core.test');
      expect(options).toEqual(expect.objectContaining({ all: true, verbatim: true }));
      callback(null, [
        { address: '::1', family: 6 },
        { address: '127.0.0.1', family: 4 },
      ]);
    });
    const client = createCoreOutboundClient({ coreUrl: origin, lookup });

    const config = await client.getPublicUrlsConfig();
    const catalog = await client.getModelCatalog({ query: '?host=local' });
    const delivered = await client.deliverPlatformEvent({
      body: JSON.stringify({ type: 'test-event' }),
      token: 'test-token',
    });

    expect(config).toEqual({
      ok: true,
      payload: { publicUrls: { core: 'http://localhost:3080' } },
      status: 200,
    });
    expect(JSON.parse(catalog.body.toString('utf8')).data.models).toEqual([{ name: 'local-test' }]);
    expect(delivered).toEqual({ ok: true, status: 202 });
    expect(JSON.parse(receivedEventBody)).toEqual({ type: 'test-event' });
    expect(receivedEventToken).toBe('test-token');
    expect(lookup).toHaveBeenCalledTimes(3);
  });
});
