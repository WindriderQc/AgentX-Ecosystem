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
  acquireWorkloadAdmission,
  heartbeatWorkloadAdmission,
  releaseWorkloadAdmission,
  coreRequest,
  CORE_OPERATIONS,
  loadCorePublicConfig,
  _internal: {
    classifyCoreOperation,
    CORE_OPERATION_SPECS,
    exactBenchmarkReleaseReceipt,
    runtimeSnapshotIdentity,
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

function workloadAcquireBody(workloadId, hosts = []) {
  return {
    status: 'success',
    data: {
      acquired: true,
      admissionId: `admission-${workloadId}`,
      generation: `generation-${workloadId}`,
      principal: 'benchmark-service',
      requestId: `benchmark:${workloadId}`,
      workloadId,
      kind: 'benchmark',
      batchId: null,
      hosts: [...hosts].sort(),
      expiresAt: new Date(Date.now() + 60_000).toISOString()
    }
  };
}

function runtimeSnapshot(residents = [], capturedAt = '2026-09-04T12:00:00.000Z') {
  const snapshot = { capturedAt, source: 'ollama_ps', exact: true, residents };
  return { ...snapshot, identityDigest: runtimeSnapshotIdentity(snapshot) };
}

function claimAcquireBody({ hostUrl, batchId, claimGeneration, prevStatus = 'idle', snapshot }) {
  return {
    status: 'success',
    data: {
      claimed: true,
      batchId,
      claimGeneration,
      prevStatus,
      snapshotExact: true,
      snapshotIdentity: snapshot.identityDigest,
      pref: {
        hostUrl,
        benchmarkClaim: {
          batchId,
          claimGeneration,
          prevStatus,
          preClaimRuntime: snapshot,
        },
      },
    },
  };
}

function exactReleaseReceipt({
  hostUrl,
  batchId,
  claimGeneration,
  prevStatus = 'idle',
  snapshot,
  residents = snapshot.residents,
  excludedModels = [],
  expiredModels = [],
  filterEvaluatedAt = '2026-09-04T12:00:05.000Z',
}) {
  const appliedIdentityDigest = runtimeSnapshotIdentity(snapshot, residents);
  return {
    contract: 'agentx.benchmark-claim-release/v1',
    hostUrl,
    batchId,
    claimGeneration,
    snapshot: {
      identityDigest: snapshot.identityDigest,
      appliedIdentityDigest,
      exact: true,
      capturedAt: snapshot.capturedAt,
      source: snapshot.source,
      filterEvaluatedAt,
      residentCount: residents.length,
      residents,
      excludedModels,
      expiredModels,
    },
    verification: {
      status: 'ready',
      ready: true,
      verified: true,
      degraded: false,
      mode: 'exact_runtime_snapshot',
      snapshotIdentity: appliedIdentityDigest,
    },
    state: {
      restoredStatus: prevStatus,
      claimCleared: true,
      finalizerCleared: true,
    },
    releasedAt: '2026-09-04T12:00:06.000Z',
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

  test('keeps all logical operations closed over their exact method/path families', () => {
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
      ['POST', '/api/nerve-center/host-preferences/ollama/benchmark-claim/batch-1/release-receipt', CORE_OPERATIONS.CLAIM_RELEASE_RECOVERY],
      ['GET', '/api/nerve-center/host-preferences/benchmark-claims/active', CORE_OPERATIONS.CLAIMS_ACTIVE],
      ['POST', '/api/nerve-center/workload-admissions', CORE_OPERATIONS.WORKLOAD_ACQUIRE],
      ['POST', '/api/nerve-center/workload-admissions/admission-1/heartbeat', CORE_OPERATIONS.WORKLOAD_HEARTBEAT],
      ['DELETE', '/api/nerve-center/workload-admissions/admission-1', CORE_OPERATIONS.WORKLOAD_RELEASE],
      ['POST', '/api/nerve-center/workload-admissions/admission-1/release-receipt', CORE_OPERATIONS.WORKLOAD_RELEASE_RECOVERY],
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

  test('keeps all twelve request and response contracts aligned with registry v2', () => {
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
    fetch.mockImplementationOnce(async (url) => response(url, {
      body: JSON.stringify(workloadAcquireBody('batch-1', ['http://ollama:11434']))
    }));
    await acquireWorkloadAdmission('batch-1', { hosts: ['http://ollama:11434'] });
    fetch.mockClear();
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
    const hostUrl = 'http://claim-owner:11434';
    const snapshot = runtimeSnapshot();
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(workloadAcquireBody('batch-generation', [hostUrl]))
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(claimAcquireBody({
          hostUrl, batchId: 'batch-generation', claimGeneration, snapshot
        })),
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          heartbeat: true,
          batchId: 'batch-generation',
          claimGeneration,
          prevStatus: 'idle',
          snapshotExact: true,
          snapshotIdentity: snapshot.identityDigest
        } }),
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: { released: false, reason: 'stale' } }),
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          heartbeat: true,
          batchId: 'batch-generation',
          claimGeneration,
          prevStatus: 'idle',
          snapshotExact: true,
          snapshotIdentity: snapshot.identityDigest
        } }),
      }));

    await acquireWorkloadAdmission('batch-generation', { hosts: [hostUrl] });
    await claimHostForBenchmark(hostUrl, 'batch-generation', null, {
      claimGeneration,
    });
    await heartbeatBenchmarkClaim(hostUrl, 'batch-generation', 30_000);
    await releaseBenchmarkClaim(hostUrl, 'batch-generation');
    await heartbeatBenchmarkClaim(hostUrl, 'batch-generation', 60_000);

    const bodies = fetch.mock.calls.slice(1).map(([, init]) => JSON.parse(init.body));
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

  test('keeps the local claim proof until Core returns an exact restoration receipt', async () => {
    const hostUrl = 'http://release-receipt:11434';
    const batchId = 'batch-release-receipt';
    const claimGeneration = '55555555-5555-4555-8555-555555555555';
    const snapshot = runtimeSnapshot([{
      model: 'qwen:7b',
      digest: 'sha256:model',
      artifactSize: 4_000_000_000,
      sizeVram: 4_500_000_000,
      contextLength: 32768,
      keepAlive: -1,
      expiresAt: '9999-12-31T23:59:59.000Z'
    }]);
    const snapshotIdentity = snapshot.identityDigest;
    const exactReceipt = exactReleaseReceipt({
      hostUrl, batchId, claimGeneration, prevStatus: 'ready', snapshot
    });
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(workloadAcquireBody(batchId, [hostUrl]))
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(claimAcquireBody({
          hostUrl, batchId, claimGeneration, prevStatus: 'ready', snapshot
        }))
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          released: true,
          releaseReceipt: { ...exactReceipt, verification: { ...exactReceipt.verification, verified: false } }
        } })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          heartbeat: true,
          batchId,
          claimGeneration,
          prevStatus: 'ready',
          snapshotExact: true,
          snapshotIdentity
        } })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          released: true,
          releaseReceipt: exactReceipt
        } })
      }));

    await acquireWorkloadAdmission(batchId, { hosts: [hostUrl] });
    await expect(claimHostForBenchmark(hostUrl, batchId, null, { claimGeneration }))
      .resolves.toMatchObject({ claimed: true, snapshotExact: true });
    await expect(releaseBenchmarkClaim(hostUrl, batchId))
      .resolves.toMatchObject({ released: false, reason: expect.stringContaining('receipt is invalid') });
    await heartbeatBenchmarkClaim(hostUrl, batchId);
    expect(JSON.parse(fetch.mock.calls[3][1].body).claimGeneration).toBe(claimGeneration);
    await expect(releaseBenchmarkClaim(hostUrl, batchId))
      .resolves.toMatchObject({ released: true, releaseReceipt: exactReceipt });
    expect(getBenchmarkClaimIdentity(hostUrl, batchId)).toBeNull();
  });

  test('recomputes release digests and TTL membership instead of trusting receipt projections', () => {
    const hostUrl = 'http://receipt-verifier:11434';
    const batchId = 'batch-receipt-verifier';
    const claimGeneration = '59595959-5959-4959-8959-595959595959';
    const snapshot = runtimeSnapshot([{
      model: 'finite-live:latest',
      digest: 'sha256:finite-live',
      artifactSize: 5_000_000_000,
      sizeVram: 4_700_000_000,
      contextLength: 65536,
      keepAlive: 3600,
      expiresAt: '2026-09-04T13:00:00.000Z',
    }]);
    const expected = {
      hostUrl,
      batchId,
      claimGeneration,
      prevStatus: 'ready',
      snapshotIdentity: snapshot.identityDigest,
      preClaimRuntime: snapshot,
      excludedModels: [],
    };
    const validReceipt = exactReleaseReceipt({
      hostUrl, batchId, claimGeneration, prevStatus: 'ready', snapshot
    });
    expect(exactBenchmarkReleaseReceipt({ released: true, releaseReceipt: validReceipt }, expected))
      .toBe(true);

    const emptyDigest = runtimeSnapshotIdentity(snapshot, []);
    const forgedExpiry = structuredClone(validReceipt);
    forgedExpiry.snapshot.residents = [];
    forgedExpiry.snapshot.residentCount = 0;
    forgedExpiry.snapshot.expiredModels = ['finite-live:latest'];
    forgedExpiry.snapshot.appliedIdentityDigest = emptyDigest;
    forgedExpiry.verification.snapshotIdentity = emptyDigest;
    expect(exactBenchmarkReleaseReceipt({ released: true, releaseReceipt: forgedExpiry }, expected))
      .toBe(false);

    const forgedResident = structuredClone(validReceipt);
    forgedResident.snapshot.residents[0].contextLength = 262144;
    expect(exactBenchmarkReleaseReceipt({ released: true, releaseReceipt: forgedResident }, expected))
      .toBe(false);

    const impossibleTimeline = structuredClone(validReceipt);
    impossibleTimeline.releasedAt = '2026-09-04T12:00:04.000Z';
    expect(exactBenchmarkReleaseReceipt({ released: true, releaseReceipt: impossibleTimeline }, expected))
      .toBe(false);
  });

  test('recovers a durable exact receipt when the release response is lost', async () => {
    const hostUrl = 'http://ambiguous-release:11434';
    const batchId = 'batch-ambiguous-release';
    const claimGeneration = '77777777-7777-4777-8777-777777777777';
    const snapshot = runtimeSnapshot();
    const snapshotIdentity = snapshot.identityDigest;
    const releaseReceipt = exactReleaseReceipt({ hostUrl, batchId, claimGeneration, snapshot });
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(workloadAcquireBody(batchId, [hostUrl]))
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(claimAcquireBody({ hostUrl, batchId, claimGeneration, snapshot }))
      }))
      .mockImplementationOnce(async (url) => response(url, {
        status: 500,
        body: JSON.stringify({ status: 'error', code: 'RESPONSE_LOST' })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          recovered: true, released: true, releaseReceipt
        } })
      }));

    await acquireWorkloadAdmission(batchId, { hosts: [hostUrl] });
    await claimHostForBenchmark(hostUrl, batchId, null, { claimGeneration });
    await expect(releaseBenchmarkClaim(hostUrl, batchId)).resolves.toMatchObject({
      released: true,
      releaseReceipt
    });
    expect(fetch.mock.calls[3][0]).toContain('/release-receipt');
    expect(getBenchmarkClaimIdentity(hostUrl, batchId)).toBeNull();
  });

  test('retries a release only when Core reattests the same active generation as safe', async () => {
    const hostUrl = 'http://safe-release-retry:11434';
    const batchId = 'batch-safe-release-retry';
    const claimGeneration = '88888888-8888-4888-8888-888888888888';
    const snapshot = runtimeSnapshot();
    const releaseReceipt = exactReleaseReceipt({ hostUrl, batchId, claimGeneration, snapshot });
    fetch
      .mockImplementationOnce(async (url) => response(url, { body: JSON.stringify(workloadAcquireBody(batchId, [hostUrl])) }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(claimAcquireBody({ hostUrl, batchId, claimGeneration, snapshot }))
      }))
      .mockImplementationOnce(async (url) => response(url, { status: 500, body: JSON.stringify({ status: 'error' }) }))
      .mockImplementationOnce(async (url) => response(url, { body: JSON.stringify({ status: 'success', data: {
        recovered: true, released: false, retryable: true, finalizing: false
      } }) }))
      .mockImplementationOnce(async (url) => response(url, { body: JSON.stringify({ status: 'success', data: {
        released: true, releaseReceipt
      } }) }));

    await acquireWorkloadAdmission(batchId, { hosts: [hostUrl] });
    await claimHostForBenchmark(hostUrl, batchId, null, { claimGeneration });
    await expect(releaseBenchmarkClaim(hostUrl, batchId)).resolves.toMatchObject({ released: true });
    expect(fetch.mock.calls.map(call => call[0]).filter(url => url.endsWith(`/benchmark-claim/${batchId}`))).toHaveLength(2);
  });

  test('rejects a successful claim receipt without exact pre-claim snapshot evidence', async () => {
    const claimGeneration = '66666666-6666-4666-8666-666666666666';
    const hostUrl = 'http://legacy-claim:11434';
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(workloadAcquireBody('batch-legacy-claim', [hostUrl]))
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          claimed: true,
          batchId: 'batch-legacy-claim',
          claimGeneration,
          prevStatus: 'idle',
          snapshotExact: false,
          snapshotIdentity: null
        } })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: { released: false, reason: 'legacy claim' } })
      }));

    await acquireWorkloadAdmission('batch-legacy-claim', { hosts: [hostUrl] });
    await expect(claimHostForBenchmark(
      hostUrl,
      'batch-legacy-claim',
      null,
      { claimGeneration }
    )).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_RECEIPT_MISMATCH' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('accepts only an exact Core-minted workload receipt and carries it through heartbeat and release', async () => {
    const workloadId = 'workload-client-contract';
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          acquired: true,
          admissionId: 'admission-core-1',
          generation: 'generation-core-1',
          principal: 'benchmark-service',
          requestId: `benchmark:${workloadId}`,
          workloadId,
          kind: 'benchmark',
          batchId: null
        } })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          heartbeat: true,
          admissionId: 'admission-core-1',
          generation: 'generation-core-1',
          principal: 'benchmark-service',
          requestId: `benchmark:${workloadId}`,
          workloadId,
          kind: 'benchmark',
          batchId: null,
          expiresAt: new Date(Date.now() + 60_000).toISOString()
        } })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          released: true,
          admissionId: 'admission-core-1',
          generation: 'generation-core-1',
          principal: 'benchmark-service',
          requestId: `benchmark:${workloadId}`,
          workloadId,
          kind: 'benchmark',
          batchId: null,
          releasedAt: new Date().toISOString()
        } })
      }));

    const acquired = await acquireWorkloadAdmission(workloadId, { ttlMs: 60_000 });
    expect(acquired).toMatchObject({
      admissionId: 'admission-core-1',
      generation: 'generation-core-1'
    });
    await expect(heartbeatWorkloadAdmission(workloadId, 60_000))
      .resolves.toMatchObject({ heartbeat: true });
    await expect(releaseWorkloadAdmission(workloadId))
      .resolves.toMatchObject({ released: true });

    const bodies = fetch.mock.calls.map(([, init]) => JSON.parse(init.body));
    expect(bodies[0]).not.toHaveProperty('generation');
    expect(bodies[1].generation).toBe('generation-core-1');
    expect(bodies[2].generation).toBe('generation-core-1');
  });

  test('retries ambiguous workload acquisition with one idempotency key and rejects divergent receipts', async () => {
    const workloadId = 'workload-ambiguous-contract';
    fetch
      .mockRejectedValueOnce(new Error('connection reset after write'))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          acquired: true,
          admissionId: 'admission-core-retry',
          generation: 'generation-core-retry',
          principal: 'benchmark-service',
          requestId: 'request-stable',
          workloadId,
          kind: 'benchmark',
          batchId: null
        } })
      }));
    await expect(acquireWorkloadAdmission(workloadId, { requestId: 'request-stable' }))
      .resolves.toMatchObject({ admissionId: 'admission-core-retry' });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(fetch.mock.calls[0][1].body).requestId)
      .toBe(JSON.parse(fetch.mock.calls[1][1].body).requestId);

    fetch.mockReset().mockImplementationOnce(async (url) => response(url, {
      body: JSON.stringify({ status: 'success', data: {
        acquired: true,
        admissionId: 'admission-wrong',
        generation: 'generation-wrong',
        principal: 'benchmark-service',
        requestId: 'different-request',
        workloadId: 'different-workload',
        kind: 'benchmark',
        batchId: null
      } })
    }));
    await expect(acquireWorkloadAdmission('workload-divergent', { requestId: 'request-divergent' }))
      .rejects.toMatchObject({ code: 'WORKLOAD_ADMISSION_REJECTED' });
  });

  test('recovers the exact durable workload receipt when the release response is lost', async () => {
    const workloadId = 'workload-lost-release-response';
    const identity = {
      admissionId: `admission-${workloadId}`,
      generation: `generation-${workloadId}`,
      principal: 'benchmark-service',
      requestId: `benchmark:${workloadId}`,
      workloadId,
      kind: 'benchmark',
      batchId: null,
      hosts: []
    };
    const releasedAt = new Date().toISOString();
    fetch
      .mockImplementationOnce(async url => response(url, {
        body: JSON.stringify({ status: 'success', data: { acquired: true, ...identity } })
      }))
      .mockRejectedValueOnce(new Error('connection reset after release commit'))
      .mockImplementationOnce(async url => response(url, {
        body: JSON.stringify({
          status: 'success',
          data: { recovered: true, released: true, coordinationKind: 'workload', ...identity, releasedAt }
        })
      }));

    await acquireWorkloadAdmission(workloadId);
    await expect(releaseWorkloadAdmission(workloadId)).resolves.toMatchObject({
      recovered: true,
      released: true,
      ...identity,
      releasedAt
    });
    expect(fetch.mock.calls.map(call => new URL(call[0]).pathname)).toEqual([
      '/api/nerve-center/workload-admissions',
      `/api/nerve-center/workload-admissions/${identity.admissionId}`,
      `/api/nerve-center/workload-admissions/${identity.admissionId}/release-receipt`
    ]);
    await expect(releaseWorkloadAdmission(workloadId))
      .resolves.toMatchObject({ released: false, reason: expect.stringContaining('local') });
  });

  test('retries release only after Core reattests the exact active workload proof', async () => {
    const workloadId = 'workload-active-release-retry';
    const identity = {
      admissionId: `admission-${workloadId}`,
      generation: `generation-${workloadId}`,
      principal: 'benchmark-service',
      requestId: `benchmark:${workloadId}`,
      workloadId,
      kind: 'benchmark',
      batchId: null,
      hosts: []
    };
    fetch
      .mockImplementationOnce(async url => response(url, {
        body: JSON.stringify({ status: 'success', data: { acquired: true, ...identity } })
      }))
      .mockRejectedValueOnce(new Error('safe transport failure before release'))
      .mockImplementationOnce(async url => response(url, {
        body: JSON.stringify({
          status: 'success',
          data: { recovered: true, released: false, retryable: true, ...identity }
        })
      }))
      .mockImplementationOnce(async url => response(url, {
        body: JSON.stringify({
          status: 'success',
          data: { released: true, ...identity, releasedAt: new Date().toISOString() }
        })
      }));

    await acquireWorkloadAdmission(workloadId);
    await expect(releaseWorkloadAdmission(workloadId)).resolves.toMatchObject({ released: true, ...identity });
    expect(fetch.mock.calls.map(call => new URL(call[0]).pathname)).toEqual([
      '/api/nerve-center/workload-admissions',
      `/api/nerve-center/workload-admissions/${identity.admissionId}`,
      `/api/nerve-center/workload-admissions/${identity.admissionId}/release-receipt`,
      `/api/nerve-center/workload-admissions/${identity.admissionId}`
    ]);
  });

  test('keeps the local workload proof when heartbeat identity diverges and clears it only on an exact release receipt', async () => {
    const workloadId = 'workload-receipt-divergence';
    const requestId = `benchmark:${workloadId}`;
    const identity = {
      admissionId: 'admission-divergence',
      generation: 'generation-divergence',
      principal: 'benchmark-service',
      requestId,
      workloadId,
      kind: 'benchmark',
      batchId: null
    };
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: { acquired: true, ...identity } })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          heartbeat: true,
          ...identity,
          generation: 'different-generation'
        } })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          released: true,
          ...identity,
          releasedAt: new Date().toISOString()
        } })
      }));

    await expect(acquireWorkloadAdmission(workloadId)).resolves.toMatchObject(identity);
    await expect(heartbeatWorkloadAdmission(workloadId))
      .resolves.toMatchObject({ heartbeat: false, reason: expect.stringContaining('invalid') });
    await expect(releaseWorkloadAdmission(workloadId))
      .resolves.toMatchObject({ released: true, ...identity });
    await expect(releaseWorkloadAdmission(workloadId))
      .resolves.toMatchObject({ released: false, reason: expect.stringContaining('local') });
  });

  test('re-attests cached proof, reacquires after expiry, and never rebinds host intent locally', async () => {
    const workloadId = 'workload-expiry-reacquire';
    const hosts = ['http://host-a:11434'];
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(workloadAcquireBody(workloadId, hosts))
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'error', data: {
          heartbeat: false,
          reason: 'lease proof no longer owns coordination state'
        } })
      }))
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify({ status: 'success', data: {
          ...workloadAcquireBody(workloadId, hosts).data,
          admissionId: 'admission-reacquired',
          generation: 'generation-reacquired'
        } })
      }));

    await expect(acquireWorkloadAdmission(workloadId, { hosts }))
      .resolves.toMatchObject({ admissionId: `admission-${workloadId}` });
    await expect(acquireWorkloadAdmission(workloadId, { hosts }))
      .resolves.toMatchObject({ admissionId: 'admission-reacquired', generation: 'generation-reacquired' });
    expect(fetch.mock.calls.map(call => new URL(call[0]).pathname)).toEqual([
      '/api/nerve-center/workload-admissions',
      `/api/nerve-center/workload-admissions/admission-${workloadId}/heartbeat`,
      '/api/nerve-center/workload-admissions'
    ]);

    await expect(acquireWorkloadAdmission(workloadId, {
      hosts: ['http://host-b:11434']
    })).rejects.toMatchObject({ code: 'WORKLOAD_ADMISSION_CONFLICT' });
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  test('rejects a divergent claim receipt and retains proof when fenced cleanup is refused', async () => {
    const requestedGeneration = '33333333-3333-4333-8333-333333333333';
    const hostUrl = 'http://receipt-mismatch:11434';
    fetch
      .mockImplementationOnce(async (url) => response(url, {
        body: JSON.stringify(workloadAcquireBody('batch-receipt', [hostUrl]))
      }))
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

    await acquireWorkloadAdmission('batch-receipt', { hosts: [hostUrl] });
    await expect(claimHostForBenchmark(
      hostUrl,
      'batch-receipt',
      null,
      { claimGeneration: requestedGeneration }
    )).rejects.toMatchObject({ code: 'BENCHMARK_CLAIM_RECEIPT_MISMATCH' });

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toEqual({
      claimGeneration: requestedGeneration,
      admissionId: 'admission-batch-receipt',
      admissionGeneration: 'generation-batch-receipt'
    });
    expect(getBenchmarkClaimIdentity(
      'http://receipt-mismatch:11434',
      'batch-receipt'
    )).toEqual({
      claimBatchId: 'batch-receipt',
      claimGeneration: requestedGeneration
    });
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
