'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_RELEASE_RESPONSE_BYTES,
  RECEIPT_KIND,
  ReleaseEvidenceError,
  parseArgs,
  runCli,
  verifyReleaseEvidence,
} = require('./verify-release-evidence');

const BASE_URLS = Object.freeze({
  core: 'http://core.test',
  benchmark: 'http://benchmark.test',
  rag: 'http://rag.test',
});

function jsonResponse(body, status = 200) {
  const bytes = Buffer.from(JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name) {
        return String(name).toLowerCase() === 'content-length' ? String(bytes.byteLength) : null;
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
  for (const [url, response] of Object.entries(overrides)) routes.set(url, response);
  return routes;
}

function fullSnapshot(overrides = {}) {
  return {
    schemaVersion: 2,
    generatedAt: '2026-08-28T12:00:01.000Z',
    authority: 'agentx-product',
    readOnly: true,
    health: { status: 'degraded' },
    identityConsistency: {
      status: 'ok',
      profiles: ['full'],
      versions: ['0.1.1'],
      revisions: ['build-abc123'],
    },
    evidenceTrust: {
      schemaVersion: 1,
      status: 'verified',
      operationalStatus: 'degraded',
      contradictionBudget: {
        allowed: 0,
        observed: 0,
        withinBudget: true,
        contradictions: [],
      },
      freshness: { status: 'current', current: 7, stale: 0, unknown: 0 },
    },
    ...overrides,
  };
}

function fullTrust(overrides = {}) {
  return {
    ...fullSnapshot().evidenceTrust,
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
      id: 'core-playground',
      service: 'core',
      path: '/playground',
      profiles: ['demo', 'full'],
      journey: 'try',
      critical: true,
      performanceBudget: 'standard',
    }),
    Object.freeze({
      id: 'benchmark-home',
      service: 'benchmark',
      path: '/',
      profiles: ['demo', 'full'],
      journey: 'evaluate',
      critical: true,
      performanceBudget: 'standard',
    }),
    Object.freeze({
      id: 'rag-home',
      service: 'rag',
      path: '/',
      profiles: ['demo', 'full'],
      journey: 'knowledge',
      critical: true,
      performanceBudget: 'standard',
    }),
  ]),
});

function successfulDependencies(routes, calls = []) {
  return {
    now: () => new Date('2026-08-28T12:00:30.000Z'),
    fetchImpl: async (url) => {
      calls.push(url);
      const response = routes.get(url);
      if (!response) throw new Error(`unexpected request: ${url}`);
      return response;
    },
    verifyReleaseContractImpl: () => ({
      tag: null,
      version: '0.1.1',
      services: { core: '0.1.1', benchmark: '0.1.1', rag: '0.1.1' },
    }),
    verifyProductSurfacesImpl: async ({ profile, criticalOnly }) => ({
      profile,
      criticalOnly,
      total: 1,
      passed: [{ id: 'core-playground', service: 'core', path: '/playground', status: 200 }],
    }),
  };
}

function options(profile = 'demo') {
  return {
    profile,
    baseUrls: BASE_URLS,
    registry: REGISTRY,
    root: process.cwd(),
    now: () => new Date('2026-08-28T12:00:30.000Z'),
  };
}

test('creates a deterministic demo receipt without probing a profile-disabled ecosystem API', async () => {
  const calls = [];
  const dependencies = successfulDependencies(healthRoutes('demo'), calls);

  const first = await verifyReleaseEvidence(options('demo'), dependencies);
  const second = await verifyReleaseEvidence(options('demo'), successfulDependencies(healthRoutes('demo')));

  assert.deepEqual(first, second);
  assert.equal(first.kind, RECEIPT_KIND);
  assert.equal(first.generatedAt, '2026-08-28T12:00:30.000Z');
  assert.equal(first.status, 'pass');
  assert.equal(first.evidence.ecosystem.availability, 'not-applicable');
  assert.equal(first.evidence.ollama.required, false);
  assert.equal(first.evidence.ollama.observedStatus, 'unavailable');
  assert.equal(first.evidence.ollama.outcome, 'non-blocking');
  assert.equal(first.gates.find((gate) => gate.id === 'ecosystem-evidence').status, 'skip');
  assert(!calls.some((url) => url.includes('/api/nerve-center/ecosystem')));
});

test('accepts full-profile trusted evidence with zero contradictions despite optional runtime degradation', async () => {
  const routes = healthRoutes('full');
  routes.set(
    `${BASE_URLS.core}/api/nerve-center/ecosystem`,
    jsonResponse({ status: 'success', data: fullSnapshot() })
  );

  const receipt = await verifyReleaseEvidence({
    ...options('full'),
    expectedRevision: 'build-abc123',
  }, successfulDependencies(routes));

  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.evidence.runtime.consistency.expectedRevision, 'build-abc123');
  assert.equal(receipt.evidence.runtime.consistency.buildRevisionVerified, true);
  assert.equal(receipt.evidence.ecosystem.operationalStatus, 'degraded');
  assert.equal(receipt.evidence.ecosystem.evidenceTrust.status, 'verified');
  assert.equal(receipt.evidence.ecosystem.evidenceTrust.contradictionBudget.observed, 0);
  assert.equal(receipt.gates.find((gate) => gate.id === 'ecosystem-evidence').status, 'pass');
});

test('blocks a full release when ecosystem evidence exceeds the zero-contradiction budget', async () => {
  const routes = healthRoutes('full');
  routes.set(`${BASE_URLS.core}/api/nerve-center/ecosystem`, jsonResponse({
    status: 'success',
    data: fullSnapshot({
      evidenceTrust: {
        schemaVersion: 1,
        status: 'contradictory',
        contradictionBudget: {
          allowed: 0,
          observed: 1,
          withinBudget: false,
          contradictions: [{ id: 'service-total', expected: 3, observed: 2 }],
        },
        freshness: { status: 'current', current: 7, stale: 0, unknown: 0 },
      },
    }),
  }));

  await assert.rejects(
    verifyReleaseEvidence(options('full'), successfulDependencies(routes)),
    (error) => {
      assert(error instanceof ReleaseEvidenceError);
      assert.match(error.message, /ecosystem-evidence: .*contradiction budget is exceeded/);
      assert.equal(error.receipt.status, 'fail');
      assert.equal(error.receipt.evidence.ecosystem.evidenceTrust.contradictionBudget.observed, 1);
      return true;
    }
  );
});

for (const [name, snapshot, expected] of [
  [
    'partial trust coverage',
    fullSnapshot({
      evidenceTrust: fullTrust({
        status: 'partial',
        freshness: { status: 'partial', current: 6, stale: 0, unknown: 1 },
      }),
    }),
    /evidence-trust status must be verified.*freshness status must be current.*unknown source/i,
  ],
  [
    'missing freshness assessment',
    fullSnapshot({ evidenceTrust: fullTrust({ freshness: undefined }) }),
    /freshness assessment is missing/i,
  ],
  [
    'internally inconsistent freshness counts',
    fullSnapshot({
      evidenceTrust: fullTrust({
        freshness: { status: 'current', current: 0, stale: 0, unknown: 99 },
      }),
    }),
    /99 unknown source.*no current sources/i,
  ],
  [
    'invalid identity status',
    fullSnapshot({
      identityConsistency: {
        status: 'garbage',
        profiles: ['full'],
        versions: ['0.1.1'],
        revisions: ['build-abc123'],
      },
    }),
    /identity consistency status must be ok/i,
  ],
  [
    'mixed identity revisions',
    fullSnapshot({
      identityConsistency: {
        status: 'ok',
        profiles: ['full'],
        versions: ['0.1.1'],
        revisions: ['build-abc123', 'build-def456'],
      },
    }),
    /exactly one known build revision/i,
  ],
]) {
  test(`blocks a full release with ${name}`, async () => {
    const routes = healthRoutes('full');
    routes.set(
      `${BASE_URLS.core}/api/nerve-center/ecosystem`,
      jsonResponse({ status: 'success', data: snapshot })
    );

    await assert.rejects(
      verifyReleaseEvidence(options('full'), successfulDependencies(routes)),
      expected
    );
  });
}

test('blocks a full release when ecosystem and runtime revisions differ', async () => {
  const routes = healthRoutes('full');
  routes.set(`${BASE_URLS.core}/api/nerve-center/ecosystem`, jsonResponse({
    status: 'success',
    data: fullSnapshot({
      identityConsistency: {
        status: 'ok',
        profiles: ['full'],
        versions: ['0.1.1'],
        revisions: ['build-other456'],
      },
    }),
  }));

  await assert.rejects(
    verifyReleaseEvidence(options('full'), successfulDependencies(routes)),
    /Ecosystem identity revision must be build-abc123; received build-other456/
  );
});

test('blocks mixed runtime profiles and versions with service-specific evidence', async () => {
  const routes = healthRoutes('demo', {
    [`${BASE_URLS.rag}/health`]: jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-rag', 'full', { version: '0.1.2' }),
      db: 'connected',
      vectorStore: { healthy: true, type: 'qdrant' },
    }),
  });

  await assert.rejects(
    verifyReleaseEvidence(options('demo'), successfulDependencies(routes)),
    (error) => {
      assert.match(error.message, /RAG health profile must be demo/);
      assert.match(error.message, /Runtime health reports mixed versions/);
      const runtime = error.receipt.evidence.runtime;
      assert.deepEqual(runtime.consistency.profiles, ['demo', 'full']);
      assert.deepEqual(runtime.consistency.versions, ['0.1.1', '0.1.2']);
      return true;
    }
  );
});

test('blocks stale or future-dated health evidence instead of treating reachability as freshness', async () => {
  const staleRoutes = healthRoutes('demo', {
    [`${BASE_URLS.core}/health`]: jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-core', 'demo', { ts: '2026-08-28T11:50:00.000Z' }),
      details: { mongodb: 'connected', ollama: 'unavailable' },
    }),
  });

  await assert.rejects(
    verifyReleaseEvidence(options('demo'), successfulDependencies(staleRoutes)),
    /Core health timestamp is stale/
  );

  const futureRoutes = healthRoutes('demo', {
    [`${BASE_URLS.rag}/health`]: jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-rag', 'demo', { ts: '2026-08-28T12:01:00.000Z' }),
      db: 'connected',
      vectorStore: { healthy: true, type: 'qdrant' },
    }),
  });
  await assert.rejects(
    verifyReleaseEvidence(options('demo'), successfulDependencies(futureRoutes)),
    /RAG health timestamp is future-dated/
  );
});

test('does not follow canonical health redirects', async () => {
  const routes = healthRoutes('demo');
  const dependencies = successfulDependencies(routes);
  const normalFetch = dependencies.fetchImpl;
  dependencies.fetchImpl = async (url, requestOptions) => {
    assert.equal(requestOptions.redirect, 'manual');
    if (url === `${BASE_URLS.core}/health`) return jsonResponse({}, 302);
    return normalFetch(url, requestOptions);
  };

  await assert.rejects(
    verifyReleaseEvidence(options('demo'), dependencies),
    /Core health returned HTTP 302/
  );
});

test('blocks a stale full-profile ecosystem snapshot even when its internal scorecard is clean', async () => {
  const routes = healthRoutes('full');
  routes.set(`${BASE_URLS.core}/api/nerve-center/ecosystem`, jsonResponse({
    status: 'success',
    data: fullSnapshot({ generatedAt: '2026-08-28T11:50:00.000Z' }),
  }));

  await assert.rejects(
    verifyReleaseEvidence(options('full'), successfulDependencies(routes)),
    /Ecosystem snapshot timestamp is stale/
  );
});

test('assesses ecosystem freshness at response receipt time', async () => {
  let currentMs = Date.parse('2026-08-28T12:00:30.000Z');
  const routes = healthRoutes('full');
  const envelope = Buffer.from(JSON.stringify({
    status: 'success',
    data: fullSnapshot({ generatedAt: '2026-08-28T12:00:36.000Z' }),
  }));
  routes.set(`${BASE_URLS.core}/api/nerve-center/ecosystem`, {
    ok: true,
    status: 200,
    headers: { get: () => String(envelope.byteLength) },
    body: {
      async *[Symbol.asyncIterator]() {
        currentMs = Date.parse('2026-08-28T12:00:36.000Z');
        yield envelope;
      },
    },
  });
  const dependencies = successfulDependencies(routes);
  dependencies.now = () => new Date(currentMs);

  const receipt = await verifyReleaseEvidence({
    ...options('full'),
    expectedRevision: 'build-abc123',
  }, dependencies);

  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.generatedAt, '2026-08-28T12:00:36.000Z');
  assert.equal(receipt.evidence.ecosystem.freshness, 'current');
  assert.equal(receipt.evidence.ecosystem.evidenceAgeMs, 0);
});

test('blocks an oversized canonical health response before parsing it', async () => {
  const routes = healthRoutes('demo', {
    [`${BASE_URLS.core}/health`]: {
      ok: true,
      status: 200,
      headers: { get: () => String(MAX_RELEASE_RESPONSE_BYTES + 1) },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}');
        },
      },
    },
  });

  await assert.rejects(
    verifyReleaseEvidence(options('demo'), successfulDependencies(routes)),
    /Core health response could not be read: Response body exceeded its byte limit/
  );
});

test('does not infer successful pages when the surface verifier reports failures', async () => {
  const dependencies = successfulDependencies(healthRoutes('demo'));
  dependencies.verifyProductSurfacesImpl = async () => {
    const error = new Error('Surface verification failed (1/1): core-playground returned HTTP 500');
    error.failures = [{ id: 'core-playground', error: 'core-playground returned HTTP 500' }];
    throw error;
  };

  await assert.rejects(
    verifyReleaseEvidence(options('demo'), dependencies),
    (error) => {
      assert.equal(error.receipt.evidence.surfaces.passed, null);
      assert.deepEqual(error.receipt.evidence.surfaces.failures, [
        { id: 'core-playground', error: 'core-playground returned HTTP 500' },
      ]);
      return true;
    }
  );
});

test('blocks unknown build revisions while keeping optional Ollama non-blocking', async () => {
  const routes = healthRoutes('demo', Object.fromEntries([
    ['core', 'agentx-core'],
    ['benchmark', 'agentx-benchmark'],
    ['rag', 'agentx-rag'],
  ].map(([service, serviceIdentity]) => {
    const body = {
      ok: true,
      status: 'ok',
      ...identity(serviceIdentity, 'demo', { revision: 'unknown' }),
      ...(service === 'core' && { details: { mongodb: 'connected', ollama: 'error' } }),
      ...(service === 'benchmark' && { db: 'connected' }),
      ...(service === 'rag' && { db: 'connected', vectorStore: { healthy: true, type: 'qdrant' } }),
    };
    return [`${BASE_URLS[service]}/health`, jsonResponse(body)];
  })));

  await assert.rejects(
    verifyReleaseEvidence(options('demo'), successfulDependencies(routes)),
    (error) => {
      assert(error instanceof ReleaseEvidenceError);
      assert.match(error.message, /Runtime health build revision is unknown/);
      assert.equal(error.receipt.evidence.runtime.consistency.buildRevisionConsistent, false);
      assert.equal(error.receipt.evidence.runtime.consistency.buildRevisionVerified, false);
      assert.equal(error.receipt.gates.find((gate) => gate.id === 'optional-ollama').status, 'skip');
      assert.equal(error.receipt.evidence.ollama.observedStatus, 'error');
      return true;
    }
  );
});

test('blocks malformed runtime revisions', async () => {
  const routes = healthRoutes('demo', {
    [`${BASE_URLS.core}/health`]: jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-core', 'demo', { revision: 'bad revision!' }),
      details: { mongodb: 'connected', ollama: 'unavailable' },
    }),
  });

  await assert.rejects(
    verifyReleaseEvidence(options('demo'), successfulDependencies(routes)),
    /Core health revision is invalid/
  );
});

test('blocks a runtime revision that differs from an explicit expected revision', async () => {
  await assert.rejects(
    verifyReleaseEvidence({
      ...options('demo'),
      expectedRevision: 'release-sha-456',
    }, successfulDependencies(healthRoutes('demo'))),
    /Runtime build revision \(build-abc123\) does not match expected revision release-sha-456/
  );

  await assert.rejects(
    verifyReleaseEvidence({ ...options('demo'), expectedRevision: 'not valid!' }, successfulDependencies(healthRoutes('demo'))),
    /expected revision is invalid/
  );
});

test('writes a machine-readable receipt on failure as well as success', async () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-release-evidence-'));
  const failurePath = path.join(tempRoot, 'failure', 'receipt.json');
  const successPath = path.join(tempRoot, 'success', 'receipt.json');
  try {
    const dependencies = successfulDependencies(healthRoutes('demo', {
      [`${BASE_URLS.benchmark}/health`]: jsonResponse({ status: 'degraded' }, 503),
    }));
    await assert.rejects(runCli([
      '--profile', 'demo',
      '--core-url', BASE_URLS.core,
      '--benchmark-url', BASE_URLS.benchmark,
      '--rag-url', BASE_URLS.rag,
      '--output', failurePath,
    ], {
      ...dependencies,
      readRegistryImpl: () => REGISTRY,
    }), /Benchmark health returned HTTP 503/);

    const failureReceipt = JSON.parse(fs.readFileSync(failurePath, 'utf8'));
    assert.equal(failureReceipt.kind, RECEIPT_KIND);
    assert.equal(failureReceipt.status, 'fail');
    assert.equal(failureReceipt.summary.failed, 1);

    await runCli([
      '--profile', 'demo',
      '--core-url', BASE_URLS.core,
      '--benchmark-url', BASE_URLS.benchmark,
      '--rag-url', BASE_URLS.rag,
      '--output', successPath,
    ], {
      ...successfulDependencies(healthRoutes('demo')),
      readRegistryImpl: () => REGISTRY,
    });
    const successReceipt = JSON.parse(fs.readFileSync(successPath, 'utf8'));
    assert.equal(successReceipt.status, 'pass');
    assert.equal(successReceipt.summary.failed, 0);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('parses release, profile, surface, endpoint, and JSON output options', () => {
  const parsed = parseArgs([
    '--root', '.',
    '--tag', 'v0.1.1',
    '--expected-revision', 'release-sha-456',
    '--profile', 'full',
    '--critical-only',
    '--core-url', 'http://localhost:4180',
    '--benchmark-url', 'http://localhost:4181',
    '--rag-url', 'http://localhost:4182',
    '--output', 'artifacts/release-evidence.json',
    '--timeout-ms', '6000',
    '--ecosystem-timeout-ms', '9000',
    '--freshness-ms', '120000',
  ]);

  assert.equal(parsed.tag, 'v0.1.1');
  assert.equal(parsed.expectedRevision, 'release-sha-456');
  assert.equal(parsed.profile, 'full');
  assert.equal(parsed.criticalOnly, true);
  assert.equal(parsed.baseUrls.rag, 'http://localhost:4182');
  assert.equal(parsed.outputPath, 'artifacts/release-evidence.json');
  assert.equal(parsed.timeoutMs, 6000);
  assert.equal(parsed.ecosystemTimeoutMs, 9000);
  assert.equal(parsed.freshnessMs, 120000);
  assert.throws(() => parseArgs(['--output']), /--output requires a value/);
  assert.throws(() => parseArgs(['--expected-revision']), /--expected-revision requires a value/);
  assert.throws(() => parseArgs(['--timeout-ms', 'soon']), /must be a positive integer/);
  assert.throws(() => parseArgs(['--freshness-ms', '0']), /must be a positive integer/);
});
