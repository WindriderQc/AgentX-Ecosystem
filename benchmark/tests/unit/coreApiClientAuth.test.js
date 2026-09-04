'use strict';

const { Readable } = require('node:stream');
const fs = require('node:fs');
const path = require('node:path');
const outboundRegistry = require('../../../config/outbound-http-sinks.json');

jest.mock('node-fetch', () => jest.fn());
jest.mock('../../src/helpers/outboundHttpTransport', () => ({
  createNodeFetchPeerTransport: () => async ({ fetchImpl, init, target }) => ({
    response: await fetchImpl(target, init),
    peerVerification: 'connect-time',
  }),
}));
jest.mock('../../config/logger', () => ({
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
}));

const savedCoreUrl = process.env.CORE_URL;
process.env.CORE_URL = 'http://core.test:3080';

const fetch = require('node-fetch');
const {
  claimHostForBenchmark,
  getBenchmarkClaims,
  getBenchmarkClaimIdentity,
  heartbeatBenchmarkClaim,
  releaseBenchmarkClaim,
  coreRequest,
  CORE_OPERATIONS,
  loadCorePublicConfig,
  _internal: {
    classifyCoreOperation,
    CORE_OPERATION_SPECS,
  },
} = require('../../src/clients/coreApiClient');
const { createCorePublicUrlsResolver } = require('../../../shared/browserPublicUrls');

function headers(values = {}) {
  const normalized = new Map(Object.entries(values)
    .map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) ?? null };
}

function response(url, {
  body = JSON.stringify({ status: 'success' }),
  headerValues = {},
  redirected = false,
  status = 200,
} = {}) {
  return {
    body: Readable.from([body]),
    headers: headers(headerValues),
    redirected,
    status,
    url,
  };
}

describe('Core API client scoped outbound execution', () => {
  const originalToken = process.env.AGENTX_BENCHMARK_TOKEN;

  beforeEach(() => {
    fetch.mockImplementation(async (url) => response(url));
  });

  afterEach(() => {
    fetch.mockReset();
    if (originalToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = originalToken;
  });

  afterAll(() => {
    if (savedCoreUrl === undefined) delete process.env.CORE_URL;
    else process.env.CORE_URL = savedCoreUrl;
  });

  test('attaches the configured Benchmark credential through a peer-verifying manual-redirect transport', async () => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-token';

    await coreRequest('/api/models/registry', {
      headers: { Accept: 'application/json' },
    });

    expect(fetch).toHaveBeenCalledWith(
      'http://core.test:3080/api/models/registry',
      expect.objectContaining({
        redirect: 'manual',
        signal: expect.any(AbortSignal),
        headers: expect.objectContaining({
          accept: 'application/json',
          'x-agentx-benchmark-token': 'benchmark-token',
          'x-service-caller': 'benchmark',
        }),
      })
    );
  });

  test('rejects an unknown path and an operation/path mismatch before dispatch', async () => {
    await expect(coreRequest('/api/admin/secrets')).rejects.toThrow('not registered');
    await expect(coreRequest('/api/models/registry', {
      operationId: CORE_OPERATIONS.CLAIMS_ACTIVE,
    })).rejects.toThrow('not registered');
    expect(fetch).not.toHaveBeenCalled();
  });

  test.each([
    ['Host', { Host: 'attacker.invalid' }],
    [':authority', [[':authority', 'attacker.invalid']]],
    ['service identity', { 'X-Service-Caller': 'attacker' }],
    ['machine credential', new Headers({ 'X-AgentX-Benchmark-Token': 'attacker' })],
    ['fixed content type', { 'content-TYPE': 'text/plain' }],
  ])('rejects caller overrides of the protected %s header before dispatch', async (_label, headers) => {
    await expect(coreRequest('/api/models/registry', { headers }))
      .rejects.toThrow('protected headers');
    expect(fetch).not.toHaveBeenCalled();
  });

  test('keeps all nine logical operations closed over their exact method/path families', () => {
    expect(Object.keys(CORE_OPERATION_SPECS).sort()).toEqual(Object.values(CORE_OPERATIONS).sort());
    expect([
      ['GET', '/api/models/registry?status=active', CORE_OPERATIONS.MODEL_REGISTRIES],
      ['GET', '/api/models/registry/qwen%3A7b?host=ollama', CORE_OPERATIONS.MODEL_REGISTRY],
      ['GET', '/api/config', CORE_OPERATIONS.PUBLIC_CONFIG],
      ['GET', '/api/nerve-center/host-preferences', CORE_OPERATIONS.HOST_PREFERENCES],
      ['POST', '/api/nerve-center/host-preferences/ollama/reload', CORE_OPERATIONS.HOST_RELOAD],
      ['POST', '/api/nerve-center/host-preferences/ollama/benchmark-claim', CORE_OPERATIONS.CLAIM_ACQUIRE],
      ['POST', '/api/nerve-center/host-preferences/ollama/benchmark-claim/batch-1/heartbeat', CORE_OPERATIONS.CLAIM_HEARTBEAT],
      ['DELETE', '/api/nerve-center/host-preferences/ollama/benchmark-claim/batch-1', CORE_OPERATIONS.CLAIM_RELEASE],
      ['GET', '/api/nerve-center/host-preferences/benchmark-claims/active', CORE_OPERATIONS.CLAIMS_ACTIVE],
    ].map(([method, path, operationId]) => classifyCoreOperation(path, method)))
      .toEqual(Object.values(CORE_OPERATIONS));
    expect(() => classifyCoreOperation('/api/nerve-center/host-preferences', 'POST'))
      .toThrow('not registered');
  });

  test('loads bounded Core public configuration through the exact config operation', async () => {
    fetch.mockImplementationOnce(async (url) => response(url, {
      body: JSON.stringify({
        publicUrls: {
          core: 'http://127.0.0.1:3180',
          benchmark: 'http://127.0.0.1:3181',
          rag: 'http://127.0.0.1:3182',
        },
      }),
    }));

    await expect(loadCorePublicConfig()).resolves.toEqual({
      publicUrls: {
        core: 'http://127.0.0.1:3180',
        benchmark: 'http://127.0.0.1:3181',
        rag: 'http://127.0.0.1:3182',
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://core.test:3080/api/config',
      expect.objectContaining({ redirect: 'manual' })
    );
    expect(CORE_OPERATION_SPECS[CORE_OPERATIONS.PUBLIC_CONFIG].policy).toEqual({
      authoritySource: 'configured',
      deadlineMs: 2_000,
      maxRequestBytes: 0,
      maxResponseBytes: 64 * 1024,
    });
  });

  test('rejects an oversized public-configuration response at its 64 KiB cap', async () => {
    fetch.mockImplementationOnce(async (url) => response(url, {
      body: '{}',
      headerValues: { 'content-length': String(64 * 1024 + 1) },
    }));

    await expect(loadCorePublicConfig()).rejects.toMatchObject({
      code: 'OUTBOUND_RESPONSE_TOO_LARGE',
      sinkId: CORE_OPERATIONS.PUBLIC_CONFIG,
    });
  });

  test('injects the exact Core loader into the shared public-URL resolver', async () => {
    fetch.mockImplementationOnce(async (url) => response(url, {
      body: JSON.stringify({
        publicUrls: {
          core: 'http://127.0.0.1:3180/',
          benchmark: 'http://127.0.0.1:3181/',
          rag: 'http://127.0.0.1:3182/',
        },
      }),
    }));
    const resolver = createCorePublicUrlsResolver({
      env: {
        CORE_PUBLIC_URL: 'http://localhost:3080',
        BENCHMARK_PUBLIC_URL: 'http://localhost:3081',
        RAG_PUBLIC_URL: 'http://localhost:3082',
      },
      loadCoreConfig: loadCorePublicConfig,
      ttlMs: 30_000,
    });

    await expect(resolver()).resolves.toEqual({
      core: 'http://127.0.0.1:3180',
      benchmark: 'http://127.0.0.1:3181',
      rag: 'http://127.0.0.1:3182',
    });
    expect(fetch).toHaveBeenCalledWith(
      'http://core.test:3080/api/config',
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );

    const serverSource = fs.readFileSync(path.resolve(__dirname, '..', '..', 'server.js'), 'utf8');
    expect(serverSource).toContain('loadCoreConfig: loadCorePublicConfig');
    expect(serverSource).not.toMatch(/createCorePublicUrlsResolver\([\s\S]*?fetchImpl\s*:/);
    const dotenvConfigIndex = serverSource.indexOf("require('dotenv').config");
    const coreClientIndex = serverSource.indexOf("require('./src/clients/coreApiClient')");
    expect(dotenvConfigIndex).toBeGreaterThanOrEqual(0);
    expect(coreClientIndex).toBeGreaterThan(dotenvConfigIndex);
  });

  test('keeps all nine request and response contracts aligned with registry v2', () => {
    const registered = new Map(outboundRegistry.operations
      .filter(({ delegateId }) => delegateId === 'benchmark.core-api.executor')
      .map((operation) => [operation.id, operation]));

    expect([...registered.keys()].sort()).toEqual(Object.values(CORE_OPERATIONS).sort());
    for (const [operationId, spec] of Object.entries(CORE_OPERATION_SPECS)) {
      expect(registered.get(operationId)).toMatchObject({
        ...spec.policy,
        allowSearch: spec.allowSearch,
        method: spec.method,
        pathPattern: spec.pathPattern,
        responseMode: 'json',
        enforcementStatus: 'enforced',
      });
    }
  });

  test('publishes immutable path sources instead of mutable RegExp instances', () => {
    const spec = CORE_OPERATION_SPECS[CORE_OPERATIONS.MODEL_REGISTRIES];
    expect(typeof spec.pathPattern).toBe('string');
    expect(spec.pathPattern.compile).toBeUndefined();
    expect(() => classifyCoreOperation('/api/admin/secrets', 'GET'))
      .toThrow('Core API operation is not registered');
  });

  test('rejects redirects without following them', async () => {
    fetch.mockImplementationOnce(async (url) => response(url, {
      status: 302,
      headerValues: { location: 'http://other.test/private' },
    }));

    await expect(coreRequest('/api/models/registry')).rejects.toMatchObject({
      code: 'OUTBOUND_REDIRECT_REJECTED',
      sinkId: CORE_OPERATIONS.MODEL_REGISTRIES,
      status: 302,
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('enforces the registered response cap before reading a declared oversized body', async () => {
    fetch.mockImplementationOnce(async (url) => response(url, {
      body: '{}',
      headerValues: { 'content-length': String(2 * 1024 * 1024 + 1) },
    }));

    await expect(coreRequest('/api/models/registry')).rejects.toMatchObject({
      code: 'OUTBOUND_RESPONSE_TOO_LARGE',
      sinkId: CORE_OPERATIONS.MODEL_REGISTRIES,
    });
  });

  test('enforces the claim request cap before dispatch', async () => {
    await expect(claimHostForBenchmark(
      'http://ollama:11434',
      'batch-1',
      null,
      { padding: 'x'.repeat(64 * 1024) }
    )).rejects.toMatchObject({
      code: 'OUTBOUND_REQUEST_TOO_LARGE',
      sinkId: CORE_OPERATIONS.CLAIM_ACQUIRE,
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  test('carries one cryptographic claim generation across acquire, heartbeat, and refused release', async () => {
    const claimGeneration = '11111111-1111-4111-8111-111111111111';
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          claimed: true,
          batchId: 'batch-generation',
          claimGeneration,
        } }),
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: { heartbeat: true } }),
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: { released: false, reason: 'stale' } }),
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: { heartbeat: true } }),
      }));

    await claimHostForBenchmark('http://claim-owner:11434', 'batch-generation', null, {
      claimGeneration,
    });
    await heartbeatBenchmarkClaim('http://claim-owner:11434', 'batch-generation', 30_000);
    await releaseBenchmarkClaim('http://claim-owner:11434', 'batch-generation');
    await heartbeatBenchmarkClaim('http://claim-owner:11434', 'batch-generation', 60_000);

    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies.map(body => body.claimGeneration)).toEqual([
      claimGeneration,
      claimGeneration,
      claimGeneration,
      claimGeneration,
    ]);
  });

  test('does not treat operator claim discovery as a release capability', async () => {
    const claimGeneration = '22222222-2222-4222-8222-222222222222';
    fetch.mockImplementationOnce(async (url) => response(url, {
      body: JSON.stringify({
        status: 'success',
        data: {
          claims: [{
            hostUrl: 'http://recovery-owner:11434',
            batchId: 'batch-recovery',
            claimGeneration,
          }],
        },
      }),
    }));

    await expect(getBenchmarkClaims()).resolves.toHaveLength(1);
    expect(getBenchmarkClaimIdentity(
      'http://recovery-owner:11434',
      'batch-recovery'
    )).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  test('rejects a divergent claim receipt and performs only a fenced cleanup', async () => {
    const requestedGeneration = '33333333-3333-4333-8333-333333333333';
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({
          status: 'success',
          data: {
            claimed: true,
            batchId: 'different-batch',
            claimGeneration: '44444444-4444-4444-8444-444444444444',
          },
        }),
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: { released: false, reason: 'stale' } }),
      }));

    await expect(claimHostForBenchmark(
      'http://receipt-mismatch:11434',
      'batch-receipt',
      null,
      { claimGeneration: requestedGeneration }
    )).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_RECEIPT_MISMATCH' });

    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[1][1].body)).toEqual({
      claimGeneration: requestedGeneration,
    });
    expect(getBenchmarkClaimIdentity(
      'http://receipt-mismatch:11434',
      'batch-receipt'
    )).toBeNull();
  });

  test('preserves bounded Core status errors for conflict handling', async () => {
    fetch.mockImplementationOnce(async (url) => response(url, {
      body: 'claim already held',
      status: 409,
    }));

    await expect(coreRequest(
      '/api/nerve-center/host-preferences/http%3A%2F%2Follama%3A11434/benchmark-claim',
      {
        method: 'POST',
        operationId: CORE_OPERATIONS.CLAIM_ACQUIRE,
        body: '{}',
      }
    )).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('claim already held'),
    });
  });
});
