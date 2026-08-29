'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_RESPONSE_BYTES,
  RECEIPT_KIND,
  SupportReceiptError,
  createSupportReceipt,
  parseArgs,
  runCli,
} = require('./export-support-receipt');

const BASE_URLS = Object.freeze({
  core: 'http://core.private.test',
  benchmark: 'http://benchmark.private.test',
  rag: 'http://rag.private.test',
});
const NOW = '2026-08-28T12:00:30.000Z';

function jsonResponse(body, status = 200, declaredLength = null) {
  const text = JSON.stringify(body);
  const bytes = Buffer.from(text, 'utf8');
  return {
    status,
    headers: {
      get(name) {
        if (String(name).toLowerCase() !== 'content-length') return null;
        return declaredLength === null ? String(Buffer.byteLength(text, 'utf8')) : String(declaredLength);
      },
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

function identity(service, profile = 'demo', overrides = {}) {
  return {
    service,
    version: '0.1.1',
    profile,
    revision: 'build-abc123',
    ts: '2026-08-28T12:00:00.000Z',
    ...overrides,
  };
}

function healthRoutes(profile = 'demo', overrides = {}) {
  const routes = new Map([
    [`${BASE_URLS.core}/health`, jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-core', profile),
      details: { mongodb: 'connected', ollama: 'unavailable' },
    })],
    [`${BASE_URLS.benchmark}/health`, jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-benchmark', profile),
      db: 'connected',
    })],
    [`${BASE_URLS.rag}/health`, jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-rag', profile),
      db: 'connected',
      vectorStore: { healthy: true, type: 'qdrant' },
    })],
  ]);
  for (const [address, response] of Object.entries(overrides)) routes.set(address, response);
  return routes;
}

function fullSnapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    generatedAt: '2026-08-28T12:00:01.000Z',
    authority: 'agentx-product',
    readOnly: true,
    health: {
      status: 'ok',
      configuredHosts: 1,
      onlineHosts: 1,
      offlineHosts: 0,
      observedModels: 2,
    },
    serviceHealth: { status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0 },
    identityConsistency: {
      status: 'ok',
      profiles: ['full'],
      versions: ['0.1.1'],
      revisions: ['build-abc123'],
    },
    evidenceTrust: {
      schemaVersion: 1,
      status: 'verified',
      operationalStatus: 'ok',
      contradictionBudget: {
        allowed: 0,
        observed: 0,
        withinBudget: true,
        contradictions: [],
      },
      freshness: {
        status: 'current',
        budgetMs: 120000,
        current: 7,
        stale: 0,
        unknown: 0,
      },
      coverage: {
        status: 'complete',
        expectedSources: 7,
        observedSources: 7,
        missing: [],
      },
      checks: [
        { id: 'runtime-identity', status: 'pass', detail: 'do not copy raw detail' },
        { id: 'freshness', status: 'pass', detail: '7/7 sources current' },
        { id: 'internal-consistency', status: 'pass', detail: '0 contradictions observed' },
      ],
    },
    ...overrides,
  };
}

const REGISTRY = Object.freeze({
  schemaVersion: 2,
  profiles: ['demo', 'full'],
  services: ['core', 'benchmark', 'rag'],
  performanceBudgets: Object.freeze({
    standard: Object.freeze({
      maxDecodedBytes: 1000,
      maxJavaScriptBytes: 500,
      maxAssetRequests: 10,
      maxDomNodes: 100,
    }),
  }),
  surfaces: Object.freeze([
    Object.freeze({
      id: 'rag-home', service: 'rag', path: '/', profiles: ['demo', 'full'], journey: 'knowledge', critical: true, performanceBudget: 'standard',
    }),
    Object.freeze({
      id: 'core-playground', service: 'core', path: '/playground', profiles: ['demo', 'full'], journey: 'try', critical: true, performanceBudget: 'standard',
    }),
    Object.freeze({
      id: 'benchmark-home', service: 'benchmark', path: '/', profiles: ['demo', 'full'], journey: 'evaluate', critical: true, performanceBudget: 'standard',
    }),
  ]),
});

function options(profile = 'demo') {
  return {
    profile,
    baseUrls: BASE_URLS,
    registry: REGISTRY,
    timeoutMs: 1000,
    freshnessMs: 120000,
  };
}

function dependencies(routes, calls = []) {
  return {
    now: () => new Date(NOW),
    fetchImpl: async (address) => {
      calls.push(address);
      const response = routes.get(address);
      if (response instanceof Error) throw response;
      if (!response) throw new Error(`private request failed at ${address} with token=hunter2`);
      return response;
    },
  };
}

function forbiddenReceiptMaterial(receipt) {
  const serialized = JSON.stringify(receipt);
  return [
    'core.private.test',
    'benchmark.private.test',
    'rag.private.test',
    'hunter2',
    'C:\\Users\\private',
    '/playground',
    'do not copy raw detail',
  ].filter((value) => serialized.includes(value));
}

test('creates a deterministic, address-free demo receipt from health and the surface registry', async () => {
  const calls = [];
  const first = await createSupportReceipt(options('demo'), dependencies(healthRoutes('demo'), calls));
  const second = await createSupportReceipt(options('demo'), dependencies(healthRoutes('demo')));

  assert.deepEqual(first, second);
  assert.equal(first.kind, RECEIPT_KIND);
  assert.equal(first.generatedAt, NOW);
  assert.equal(first.status, 'pass');
  assert.equal(first.identity.status, 'consistent');
  assert.equal(first.identity.revision, 'build-abc123');
  assert.equal(first.componentHealth.services[0].components[1].id, 'ollama');
  assert.equal(first.componentHealth.services[0].components[1].required, false);
  assert.equal(first.ecosystem.availability, 'not-applicable');
  assert.equal(first.gates.find((gate) => gate.id === 'ecosystem-evidence').status, 'skip');
  assert.deepEqual(first.surfaces.surfaceIds, ['benchmark-home', 'core-playground', 'rag-home']);
  assert.equal(first.surfaces.registrySchemaVersion, 2);
  assert.equal(forbiddenReceiptMaterial(first).length, 0);
  assert(!calls.some((address) => address.includes('/api/nerve-center/ecosystem')));
});

test('projects full-profile trust, coverage, contradiction budget, and component health', async () => {
  const routes = healthRoutes('full');
  routes.set(
    `${BASE_URLS.core}/api/nerve-center/ecosystem`,
    jsonResponse({ status: 'success', data: fullSnapshot() })
  );

  const receipt = await createSupportReceipt(options('full'), dependencies(routes));

  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.ecosystem.trust.status, 'verified');
  assert.deepEqual(receipt.ecosystem.trust.contradictionBudget.categories, []);
  assert.equal(receipt.ecosystem.trust.freshness.current, 7);
  assert.equal(receipt.ecosystem.trust.coverage.status, 'complete');
  assert.deepEqual(
    receipt.ecosystem.trust.checks.map((check) => check.id),
    ['freshness', 'internal-consistency', 'runtime-identity']
  );
  assert.equal(receipt.ecosystem.componentHealth.services.healthy, 3);
  assert.equal(receipt.ecosystem.identity.revision, receipt.identity.revision);
  assert.equal(forbiddenReceiptMaterial(receipt).length, 0);
});

test('classifies contradictions and missing sources without copying private identifiers or values', async () => {
  const routes = healthRoutes('full');
  const snapshot = fullSnapshot();
  snapshot.evidenceTrust = {
    ...snapshot.evidenceTrust,
    status: 'contradictory',
    contradictionBudget: {
      allowed: 0,
      observed: 2,
      withinBudget: false,
      contradictions: [
        {
          id: 'future-timestamp:host:http://10.0.0.4/private',
          expected: 'token=hunter2',
          observed: 'C:\\Users\\private\\state.json',
        },
        { id: 'private-adapter-mismatch', expected: 'secret', observed: 'chat transcript' },
      ],
    },
    freshness: { ...snapshot.evidenceTrust.freshness, status: 'partial', current: 6, unknown: 1 },
    coverage: {
      status: 'partial',
      expectedSources: 7,
      observedSources: 6,
      missing: ['host:http://10.0.0.4/private'],
    },
  };
  routes.set(
    `${BASE_URLS.core}/api/nerve-center/ecosystem`,
    jsonResponse({ status: 'success', data: snapshot })
  );

  const receipt = await createSupportReceipt(options('full'), dependencies(routes));
  const serialized = JSON.stringify(receipt);

  assert.equal(receipt.status, 'fail');
  assert.deepEqual(receipt.ecosystem.trust.contradictionBudget.categories, [
    { id: 'future-timestamp:host', count: 1 },
    { id: 'unclassified', count: 1 },
  ]);
  assert.deepEqual(receipt.ecosystem.trust.coverage.missingCategories, [{ id: 'host', count: 1 }]);
  assert(!serialized.includes('10.0.0.4'));
  assert(!serialized.includes('hunter2'));
  assert(!serialized.includes('private-adapter-mismatch'));
  assert(!serialized.includes('chat transcript'));
  assert(!serialized.includes('C:\\Users\\private'));
});

test('fails closed on missing health evidence without leaking transport failures', async () => {
  const routes = healthRoutes('demo');
  routes.set(
    `${BASE_URLS.rag}/health`,
    new Error('connect ECONNREFUSED http://10.9.8.7/private token=hunter2\n at C:\\Users\\private\\client.js')
  );

  const receipt = await createSupportReceipt(options('demo'), dependencies(routes));
  const rag = receipt.componentHealth.services.find((service) => service.id === 'rag');
  const serialized = JSON.stringify(receipt);

  assert.equal(receipt.status, 'fail');
  assert.equal(rag.evidenceStatus, 'unavailable');
  assert.deepEqual(rag.reasonCodes, ['rag_request_unavailable']);
  assert.equal(receipt.identity.status, 'inconsistent');
  assert(!serialized.includes('10.9.8.7'));
  assert(!serialized.includes('hunter2'));
  assert(!serialized.includes('client.js'));
});

test('keeps degraded component evidence but excludes raw component errors', async () => {
  const routes = healthRoutes('demo', {
    [`${BASE_URLS.rag}/health`]: jsonResponse({
      ok: false,
      status: 'degraded',
      ...identity('agentx-rag'),
      db: 'connected',
      vectorStore: {
        healthy: false,
        type: 'qdrant',
        error: 'failed at http://10.0.0.5/private with token=hunter2',
      },
    }, 503),
  });

  const receipt = await createSupportReceipt(options('demo'), dependencies(routes));
  const rag = receipt.componentHealth.services.find((service) => service.id === 'rag');
  const serialized = JSON.stringify(receipt);

  assert.equal(receipt.status, 'fail');
  assert.equal(rag.healthStatus, 'degraded');
  assert.equal(rag.components.find((component) => component.id === 'vector-store').status, 'unavailable');
  assert(rag.reasonCodes.includes('rag_vector_store_not_ready'));
  assert(!serialized.includes('10.0.0.5'));
  assert(!serialized.includes('hunter2'));
});

test('rejects path-like revisions and oversized API responses', async () => {
  const revisionRoutes = healthRoutes('demo', {
    [`${BASE_URLS.core}/health`]: jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-core', 'demo', { revision: 'refs/heads/private' }),
      details: { mongodb: 'connected', ollama: 'unavailable' },
    }),
  });
  const revisionReceipt = await createSupportReceipt(options('demo'), dependencies(revisionRoutes));
  assert.equal(revisionReceipt.status, 'fail');
  assert.equal(revisionReceipt.componentHealth.services[0].identity.revision, null);
  assert(!JSON.stringify(revisionReceipt).includes('refs/heads/private'));

  const oversizedRoutes = healthRoutes('demo', {
    [`${BASE_URLS.benchmark}/health`]: jsonResponse({}, 200, MAX_RESPONSE_BYTES + 1),
  });
  const oversizedReceipt = await createSupportReceipt(options('demo'), dependencies(oversizedRoutes));
  const benchmark = oversizedReceipt.componentHealth.services.find((service) => service.id === 'benchmark');
  assert.equal(oversizedReceipt.status, 'fail');
  assert.deepEqual(benchmark.reasonCodes, ['benchmark_response_too_large']);
});

test('rejects address-like revisions and stops reading an undeclared oversized response', async () => {
  const revisionRoutes = healthRoutes('demo', {
    [`${BASE_URLS.core}/health`]: jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-core', 'demo', { revision: '10.0.0.99' }),
      details: { mongodb: 'connected', ollama: 'unavailable' },
    }),
  });
  const revisionReceipt = await createSupportReceipt(options('demo'), dependencies(revisionRoutes));
  assert.equal(revisionReceipt.status, 'fail');
  assert.equal(revisionReceipt.componentHealth.services[0].identity.revision, null);
  assert(!JSON.stringify(revisionReceipt).includes('10.0.0.99'));

  let deliveredChunks = 0;
  const oversizedStream = {
    status: 200,
    headers: { get: () => null },
    body: {
      async *[Symbol.asyncIterator]() {
        deliveredChunks += 1;
        yield Buffer.alloc(MAX_RESPONSE_BYTES, 0x20);
        deliveredChunks += 1;
        yield Buffer.from('{}');
        deliveredChunks += 1;
        yield Buffer.from('must-not-be-read');
      },
    },
  };
  const oversizedRoutes = healthRoutes('demo', {
    [`${BASE_URLS.benchmark}/health`]: oversizedStream,
  });
  const oversizedReceipt = await createSupportReceipt(options('demo'), dependencies(oversizedRoutes));
  const benchmark = oversizedReceipt.componentHealth.services.find((service) => service.id === 'benchmark');
  assert.deepEqual(benchmark.reasonCodes, ['benchmark_response_too_large']);
  assert.equal(deliveredChunks, 2);
});

test('fails closed when the checked-in registry cannot be read', async () => {
  const receipt = await createSupportReceipt({
    ...options('demo'),
    registry: null,
  }, {
    ...dependencies(healthRoutes('demo')),
    readRegistryImpl: () => {
      throw new Error('C:\\Users\\private\\config\\product-surfaces.json missing');
    },
  });

  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.surfaces.availability, 'unavailable');
  assert.deepEqual(receipt.surfaces.reasonCodes, ['surface_registry_unavailable']);
  assert(!JSON.stringify(receipt).includes('C:\\Users\\private'));
});

test('CLI writes a failed JSON receipt before returning a fixed safe error', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-support-receipt-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const output = path.join(directory, 'receipt.json');
  const routes = healthRoutes('demo');
  routes.delete(`${BASE_URLS.rag}/health`);

  await assert.rejects(
    () => runCli([
      '--profile', 'demo',
      '--core-url', BASE_URLS.core,
      '--benchmark-url', BASE_URLS.benchmark,
      '--rag-url', BASE_URLS.rag,
      '--output', output,
    ], {
      ...dependencies(routes),
      readRegistryImpl: () => REGISTRY,
    }),
    (error) => {
      assert(error instanceof SupportReceiptError);
      assert.equal(error.message, 'Agent X support receipt contains failed required evidence gates.');
      return true;
    }
  );

  const written = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(written.status, 'fail');
  assert.equal(forbiddenReceiptMaterial(written).length, 0);
});

test('parses only explicit bounded CLI controls', () => {
  const parsed = parseArgs([
    '--profile', 'full',
    '--timeout-ms', '9000',
    '--freshness-ms', '180000',
    '--output', 'support.json',
  ]);
  assert.equal(parsed.profile, 'full');
  assert.equal(parsed.timeoutMs, 9000);
  assert.equal(parsed.freshnessMs, 180000);
  assert.equal(parsed.outputPath, 'support.json');
  assert.throws(() => parseArgs(['--unknown']), /unknown support receipt argument/);
  assert.throws(() => parseArgs(['--timeout-ms', '0']), /positive integer/);
});
