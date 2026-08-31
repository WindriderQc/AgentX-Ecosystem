'use strict';

const mockBenchmarkFetch = jest.fn();
jest.mock('node-fetch', () => (...args) => mockBenchmarkFetch(...args));
jest.mock('../../src/helpers/outboundHttpTransport', () => {
  const { CONNECT_TIME_PEER_VERIFICATION } = jest.requireActual('../../../shared/outboundHttpExecutor');
  return {
    createNodeFetchPeerTransport: () => async ({ fetchImpl, init, target }) => ({
      response: await fetchImpl(target, init),
      peerVerification: CONNECT_TIME_PEER_VERIFICATION,
    }),
  };
});

const {
  clearHarnessCatalogCache,
  createSpendGrant,
  executeHarnessTarget,
  getHarnessTargets,
  resolveHarnessTarget,
} = require('../../src/services/benchmark/harnessBrokerClient');
const { normalizeBenchmarkTarget } = require('../../../shared/benchmarkTargetContract');
const { fingerprint, normalizeWorkerReceipt } = require('../../../shared/workerContract');

const HEX = (character) => character.repeat(64);

function jsonResponse(status, payload) {
  const raw = Buffer.from(JSON.stringify(payload), 'utf8');
  return {
    status,
    redirected: false,
    url: '',
    headers: {
      get: (name) => String(name).toLowerCase() === 'content-type' ? 'application/json' : null,
    },
    body: {
      async *[Symbol.asyncIterator]() { yield raw; },
      destroy: jest.fn(),
    },
  };
}

function target(overrides = {}) {
  return normalizeBenchmarkTarget({
    id: 'openclaw-fixture', label: 'OpenClaw fixture', executionKind: 'harness',
    mode: 'isolated_model', tier: 'free_cloud', provider: 'openrouter', model: 'vendor/model',
    modelVersion: 'provider-version-1', harness: { name: 'openclaw', version: '2026.8.1' },
    adapter: { name: 'openclaw-benchmark', version: '1.0.0' },
    profile: { id: 'benchmark-isolated', version: '1', fingerprint: HEX('1') },
    api: { name: 'openclaw-agent-cli', version: '2026.8.1' }, contextWindow: 131072,
    capabilities: { candidate: true, judge: true },
    pricing: { kind: 'free', currency: 'USD', source: 'fixture-free', effectiveAt: null, inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 0 },
    available: true, observedAt: '2026-08-31T00:00:00.000Z', catalogFingerprint: HEX('a'),
    ...overrides,
  });
}

function receiptFor(request, output) {
  const selected = request.target;
  const envelope = request.envelope;
  return normalizeWorkerReceipt({
    schema: 'agentx.worker-receipt/v1', schemaVersion: 1, executionProfile: envelope.executionProfile,
    identity: {
      harness: selected.harness, adapter: selected.adapter,
      provider: { name: selected.provider, version: 'fixture-api' },
      model: { name: selected.model, version: selected.modelVersion, digest: null, runtimeFingerprint: HEX('9') },
      api: selected.api,
      environment: { id: selected.profile.id, version: selected.profile.version, fingerprint: selected.profile.fingerprint },
    },
    fingerprints: {
      prompt: envelope.prompt.fingerprint, tools: envelope.tools.schemaFingerprint,
      policies: envelope.policies.fingerprint, envelope: envelope.fingerprint,
    },
    finalState: 'succeeded', failure: { classification: null, code: null },
    usage: { durationMs: 25, inputTokens: 4, outputTokens: 3, totalTokens: 7, costNanodollars: 0, turns: 1, toolCalls: 0 },
    toolErrors: [], humanInterventions: [], evidence: { patches: [], artifacts: [], tests: [] }, violations: [],
    result: { contractSatisfied: true, fingerprint: fingerprint(output) },
  }, { envelope });
}

describe('harness broker client', () => {
  let currentTarget;
  let executionMode;
  let requests;
  let grantRequests;
  let catalogExpiresAt;

  beforeAll(() => {
    process.env.BENCHMARK_HARNESS_ENABLED = 'true';
    process.env.AGENTX_BENCHMARK_HARNESS_URL = 'http://broker.test';
    process.env.AGENTX_BENCHMARK_HARNESS_TOKEN = 'product-service-token';
  });

  afterAll(() => {
    delete process.env.BENCHMARK_HARNESS_ENABLED;
    delete process.env.AGENTX_BENCHMARK_HARNESS_URL;
    delete process.env.AGENTX_BENCHMARK_HARNESS_TOKEN;
  });

  beforeEach(() => {
    currentTarget = target();
    executionMode = 'success';
    requests = [];
    grantRequests = [];
    catalogExpiresAt = new Date(Date.now() + 60_000).toISOString();
    clearHarnessCatalogCache();
    mockBenchmarkFetch.mockReset();
    mockBenchmarkFetch.mockImplementation(async (url, options = {}) => {
      const authorization = Object.entries(options.headers || {})
        .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
      expect(authorization).toBe('Bearer product-service-token');
      if (options.method !== 'POST' && url.endsWith('/v1/benchmark/targets')) {
        return jsonResponse(200, { status: 'success', data: {
            targets: [currentTarget], observedAt: new Date().toISOString(),
            expiresAt: catalogExpiresAt, broker: { name: 'fixture', version: '1' }
          } });
      }
      if (options.method === 'POST' && url.endsWith('/v1/benchmark/execute')) {
        const request = JSON.parse(options.body);
        requests.push(request);
        const data = executionMode === 'missing-receipt'
          ? { schema: 'agentx.harness-execution/v1', schemaVersion: 1, output: 'answer', fallbackUsed: false }
          : (() => {
              const output = request.role === 'judge' ? '{"score":8}' : 'cloud candidate answer';
              return {
                schema: 'agentx.harness-execution/v1', schemaVersion: 1, output,
                finishReason: 'stop', fallbackUsed: executionMode === 'fallback',
                receipt: receiptFor(request, output),
              };
            })();
        return jsonResponse(200, { status: 'success', data });
      }
      if (options.method === 'POST' && url.endsWith('/v1/benchmark/spend-grants')) {
        const request = JSON.parse(options.body);
        grantRequests.push(request);
        const targetFingerprints = [...new Set(request.units.map((unit) => unit.targetFingerprint))].sort();
        return jsonResponse(201, { status: 'success', data: {
            schema: 'agentx.spend-grant/v1', schemaVersion: 1, grantId: 'grant-fixture',
            batchId: request.batchId, batchFingerprint: request.batchFingerprint,
            targetFingerprints, planFingerprint: HEX('d'),
            ...request.approval, expiresAt: new Date(Date.now() + 60_000).toISOString(), signature: HEX('e'),
          } });
      }
      return jsonResponse(404, { status: 'error', error: 'not found' });
    });
  });

  test('discovers a normalized target and executes it as candidate and isolated judge', async () => {
    const catalog = await getHarnessTargets({ force: true });
    expect(catalog.targets).toEqual([currentTarget]);
    const candidate = await executeHarnessTarget({
      batchId: 'batch-1', batchFingerprint: HEX('f'), cellId: 'candidate-1', target: currentTarget,
      promptText: 'candidate prompt', parameters: { maxTokens: 20, timeoutMs: 1000 }, role: 'candidate',
    });
    const judge = await executeHarnessTarget({
      batchId: 'batch-1', batchFingerprint: HEX('f'), cellId: 'judge-1', target: currentTarget,
      promptText: 'judge prompt', parameters: { maxTokens: 20, timeoutMs: 1000 }, role: 'judge',
    });
    expect(candidate.output).toBe('cloud candidate answer');
    expect(judge.output).toBe('{"score":8}');
    expect(requests.map((request) => request.role)).toEqual(['candidate', 'judge']);
    for (const request of requests) {
      expect(request.batchId).toBe('batch-1');
      expect(request.envelope).toMatchObject({
        executionProfile: 'portable', tools: { allowed: [] },
        budgets: { maxTurns: 1, maxToolCalls: 0 },
        policies: { filesystem: { mode: 'none' } },
      });
    }
  });

  test('fails before execution when the catalog target drifts', async () => {
    const selected = currentTarget;
    currentTarget = target({ catalogFingerprint: HEX('b') });
    await expect(resolveHarnessTarget(selected, { force: true }))
      .rejects.toMatchObject({ code: 'HARNESS_TARGET_DRIFT' });
    expect(requests).toHaveLength(0);
  });

  test('rejects an available stale catalog before execution', async () => {
    catalogExpiresAt = new Date(Date.now() - 1_000).toISOString();
    await expect(getHarnessTargets({ force: true }))
      .rejects.toMatchObject({ code: 'HARNESS_CATALOG_STALE' });
    expect(requests).toHaveLength(0);
  });

  test('requests paid grant issuance from AIOps without a Product signing key', async () => {
    currentTarget = target({
      id: 'paid-fixture', tier: 'paid_cloud',
      pricing: { kind: 'manual_per_call', currency: 'USD', source: 'fixture', effectiveAt: '2026-08-31T00:00:00.000Z', inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 1000 },
    });
    const grant = await createSpendGrant({
      batchId: 'paid-batch', targets: [currentTarget], promptCount: 2, repeats: 1,
      batchFingerprint: HEX('f'),
      executionConfig: { response_max_tokens: 10, input_token_ceiling: 10 },
      approval: { confirmed: true, maxCalls: 2, maxTokens: 40, maxCostNanodollars: 2000 },
    });
    expect(grant).toMatchObject({ batchId: 'paid-batch', maxCalls: 2, maxTokens: 40, maxCostNanodollars: 2000 });
    expect(grantRequests).toHaveLength(1);
    expect(grantRequests[0]).not.toHaveProperty('signingKey');
  });

  test.each([
    ['fallback', 'HARNESS_FALLBACK_USED'],
    ['missing-receipt', 'UNSUPPORTED_SCHEMA'],
  ])('fails closed on %s', async (mode, code) => {
    executionMode = mode;
    const attempt = executeHarnessTarget({
      batchId: 'batch-1', cellId: 'candidate-1', target: currentTarget,
      batchFingerprint: HEX('f'),
      promptText: 'candidate prompt', parameters: { maxTokens: 20, timeoutMs: 1000 }, role: 'candidate',
    });
    await expect(attempt).rejects.toMatchObject({ code, infra: true });
  });
});
