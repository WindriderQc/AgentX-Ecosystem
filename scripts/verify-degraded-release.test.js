'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  MAX_DEGRADED_RESPONSE_BYTES,
  RECEIPT_KIND,
  REQUEST_SETTLEMENT_TOLERANCE_MS,
  ResilienceEvidenceError,
  boundedJsonRequest,
  parseArgs,
  runCli,
  verifyDegradedRelease,
} = require('./verify-degraded-release');

const OBSERVED_AT = '2026-08-28T12:00:00.000Z';
const GENERATED_AT = '2026-08-28T12:00:01.000Z';
const RECEIVED_AT = '2026-08-28T12:00:30.000Z';
const EXPECTED_REVISION = 'build-abc123';
const EXPECTED_VERSION = '0.1.1';
const SCENARIO_RUN_ID = 'ci-123-build-abc123';
const BASE_URLS = Object.freeze({
  core: 'http://core.fixture.test',
  benchmark: 'http://benchmark.fixture.test',
  rag: 'http://rag.fixture.test',
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

function identity(service, overrides = {}) {
  return {
    service,
    version: EXPECTED_VERSION,
    profile: 'full',
    revision: EXPECTED_REVISION,
    ts: OBSERVED_AT,
    ...overrides,
  };
}

function healthResponse(service) {
  if (service === 'core') {
    return jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-core'),
      details: { mongodb: 'connected', ollama: 'unavailable' },
    });
  }
  if (service === 'benchmark') {
    return jsonResponse({
      ok: true,
      status: 'ok',
      ...identity('agentx-benchmark'),
      db: 'connected',
    });
  }
  return jsonResponse({
    ok: true,
    status: 'ok',
    ...identity('agentx-rag'),
    db: 'connected',
    vectorStore: { healthy: true, type: 'qdrant' },
  });
}

function serviceRows(phase) {
  const rows = [
    {
      id: 'core',
      status: 'ok',
      latency_ms: 0,
      issues: [],
      identity: identity('agentx-core'),
    },
    {
      id: 'benchmark',
      status: 'ok',
      latency_ms: 4,
      issues: [],
      identity: identity('agentx-benchmark'),
    },
  ];
  if (phase === 'degraded') {
    rows.push({
      id: 'rag',
      status: 'down',
      latency_ms: null,
      issues: ['fetch failed'],
      identity: null,
    });
  } else {
    rows.push({
      id: 'rag',
      status: 'ok',
      latency_ms: 5,
      issues: [],
      identity: identity('agentx-rag'),
    });
  }
  return rows;
}

function consistency(phase) {
  return phase === 'degraded'
    ? {
        status: 'degraded',
        profiles: ['full'],
        versions: [EXPECTED_VERSION],
        revisions: [EXPECTED_REVISION],
        missing: ['rag'],
        issues: ['Identity unavailable: rag'],
      }
    : {
        status: 'ok',
        profiles: ['full'],
        versions: [EXPECTED_VERSION],
        revisions: [EXPECTED_REVISION],
        missing: [],
        issues: [],
      };
}

function serviceSummary(phase) {
  return phase === 'degraded'
    ? { status: 'down', total: 3, healthy: 2, degraded: 0, down: 1, identityStatus: 'degraded' }
    : { status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0, identityStatus: 'ok' };
}

function portalFixture(phase, overrides = {}) {
  return {
    generatedAt: GENERATED_AT,
    generated_at: GENERATED_AT,
    summary: serviceSummary(phase),
    consistency: consistency(phase),
    services: serviceRows(phase),
    ...overrides,
  };
}

function evidenceTrust(phase, overrides = {}) {
  const degraded = phase === 'degraded';
  return {
    schemaVersion: 1,
    status: degraded ? 'inconsistent' : 'verified',
    operationalStatus: 'degraded',
    contradictionBudget: {
      allowed: 0,
      observed: 0,
      withinBudget: true,
      contradictions: [],
    },
    freshness: degraded
      ? { status: 'partial', budgetMs: 120000, current: 4, stale: 0, unknown: 1 }
      : { status: 'current', budgetMs: 120000, current: 5, stale: 0, unknown: 0 },
    coverage: degraded
      ? { status: 'partial', expectedSources: 5, observedSources: 4, missing: ['service:rag'] }
      : { status: 'complete', expectedSources: 5, observedSources: 5, missing: [] },
    checks: [
      { id: 'internal-consistency', status: 'pass', detail: '0 contradictions observed' },
      {
        id: 'runtime-identity',
        status: degraded ? 'fail' : 'pass',
        detail: degraded ? 'degraded' : 'ok',
      },
      { id: 'freshness', status: degraded ? 'warn' : 'pass', detail: degraded ? '4/5 sources current' : '5/5 sources current' },
    ],
    ...overrides,
  };
}

function ecosystemFixture(phase, overrides = {}) {
  return {
    schemaVersion: 2,
    generatedAt: GENERATED_AT,
    authority: 'agentx-product',
    readOnly: true,
    health: {
      status: 'degraded',
      configuredHosts: 0,
      onlineHosts: 0,
      offlineHosts: 0,
      observedModels: 0,
    },
    serviceHealth: serviceSummary(phase),
    services: serviceRows(phase),
    identityConsistency: consistency(phase),
    evidence: { snapshotObservedAt: GENERATED_AT, servicesObservedAt: GENERATED_AT },
    cluster: [],
    alertSummary: { observedAt: GENERATED_AT },
    evidenceTrust: evidenceTrust(phase),
    ...overrides,
  };
}

function scenarioRoutes(phase = 'degraded') {
  return new Map([
    [`${BASE_URLS.core}/health`, healthResponse('core')],
    [`${BASE_URLS.benchmark}/health`, healthResponse('benchmark')],
    [`${BASE_URLS.rag}/health`, phase === 'degraded'
      ? new Error('connect ECONNREFUSED 203.0.113.77')
      : healthResponse('rag')],
    [`${BASE_URLS.core}/api/portal/health`, jsonResponse(portalFixture(phase))],
    [`${BASE_URLS.core}/api/nerve-center/ecosystem`, jsonResponse({
      status: 'success',
      data: ecosystemFixture(phase),
    })],
  ]);
}

function options(phase, overrides = {}) {
  return {
    phase,
    scenario: 'rag-unavailable',
    scenarioRunId: SCENARIO_RUN_ID,
    executionMode: 'contract-fixture',
    expectedRevision: EXPECTED_REVISION,
    expectedVersion: EXPECTED_VERSION,
    baseUrls: BASE_URLS,
    timeoutMs: 100,
    freshnessMs: 120000,
    ...overrides,
  };
}

function dependencies(routes, calls = []) {
  return {
    now: () => new Date(RECEIVED_AT),
    fetchImpl: async (url, requestOptions) => {
      calls.push({ url, requestOptions });
      if (!routes.has(url)) throw new Error(`unexpected fixture request: ${url}`);
      const result = routes.get(url);
      if (result instanceof Error) throw result;
      if (typeof result === 'function') return result(requestOptions);
      return result;
    },
  };
}

function gate(receipt, id) {
  return receipt.gates.find((candidate) => candidate.id === id);
}

test('emits address-free degraded evidence for an exact full-profile RAG transport outage', async () => {
  const calls = [];
  const receipt = await verifyDegradedRelease(
    options('degraded', { executionMode: 'compose-ci' }),
    dependencies(scenarioRoutes('degraded'), calls)
  );

  assert.equal(receipt.kind, RECEIPT_KIND);
  assert.equal(receipt.schemaVersion, 1);
  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.executionMode, 'compose-ci');
  assert.equal(receipt.profile, 'full');
  assert.equal(receipt.scenario, 'rag-unavailable');
  assert.equal(receipt.scenarioRunId, SCENARIO_RUN_ID);
  assert.equal(receipt.phase, 'degraded');
  assert.deepEqual(receipt.relatedPhases, ['degraded', 'recovery']);
  assert.equal(receipt.expectedRevision, EXPECTED_REVISION);
  assert.equal(receipt.collectionMode, 'parallel');
  assert.equal(receipt.overallBudgetMs, receipt.requestBudgetMs + REQUEST_SETTLEMENT_TOLERANCE_MS);
  assert.equal(receipt.summary.failed, 0);
  assert.equal(receipt.summary.total, 6);
  assert.equal(receipt.requests.length, 5);
  assert(receipt.requests.every((request) => request.withinBudget === true));
  assert(calls.every(({ requestOptions }) => requestOptions.signal instanceof AbortSignal));

  assert.equal(receipt.evidence.services.core.identity.service, 'agentx-core');
  assert.equal(receipt.evidence.services.benchmark.identity.service, 'agentx-benchmark');
  assert.deepEqual(receipt.evidence.services.rag, {
    state: 'transport-unavailable',
    httpStatus: null,
    failureClass: 'network-error',
    identity: null,
  });
  assert.deepEqual(receipt.evidence.portal.summary, serviceSummary('degraded'));
  assert.deepEqual(receipt.evidence.portal.consistency.missing, ['rag']);
  assert.equal(receipt.evidence.portal.services.find((service) => service.id === 'rag').identityPresent, false);
  assert.equal(receipt.evidence.ecosystem.evidenceTrust.status, 'inconsistent');
  assert.equal(receipt.evidence.ecosystem.evidenceTrust.contradictionBudget.observed, 0);
  assert.deepEqual(receipt.evidence.ecosystem.evidenceTrust.coverage.missing, ['service:rag']);
  assert.equal(gate(receipt, 'ecosystem-rag-unavailable').status, 'pass');

  const serialized = JSON.stringify(receipt);
  assert.doesNotMatch(serialized, /core\.fixture\.test|benchmark\.fixture\.test|rag\.fixture\.test/);
  assert.doesNotMatch(serialized, /203\.0\.113\.77|ECONNREFUSED/);
});

test('emits linked recovery evidence only after all identities and trusted ecosystem evidence return', async () => {
  const receipt = await verifyDegradedRelease(
    options('recovery', { executionMode: 'compose-ci' }),
    dependencies(scenarioRoutes('recovery'))
  );

  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.phase, 'recovery');
  assert.equal(receipt.scenarioRunId, SCENARIO_RUN_ID);
  assert.equal(receipt.evidence.services.rag.state, 'healthy');
  assert.equal(receipt.evidence.services.rag.identity.service, 'agentx-rag');
  assert.deepEqual(receipt.evidence.portal.summary, serviceSummary('recovery'));
  assert.deepEqual(receipt.evidence.portal.consistency.missing, []);
  assert.equal(receipt.evidence.ecosystem.evidenceTrust.status, 'verified');
  assert.equal(receipt.evidence.ecosystem.evidenceTrust.freshness.status, 'current');
  assert.equal(gate(receipt, 'ecosystem-recovered').status, 'pass');
});

test('fails closed on stale or wrong-revision identities even when health says ok', async () => {
  const routes = scenarioRoutes('degraded');
  routes.set(`${BASE_URLS.core}/health`, jsonResponse({
    ok: true,
    status: 'ok',
    ...identity('agentx-core', { revision: 'build-other' }),
    details: { mongodb: 'connected', ollama: 'unavailable' },
  }));
  routes.set(`${BASE_URLS.benchmark}/health`, jsonResponse({
    ok: true,
    status: 'ok',
    ...identity('agentx-benchmark', { ts: '2026-08-28T11:00:00.000Z' }),
    db: 'connected',
  }));

  await assert.rejects(
    verifyDegradedRelease(options('degraded'), dependencies(routes)),
    (error) => {
      assert.equal(gate(error.receipt, 'core-health').status, 'fail');
      assert.match(gate(error.receipt, 'core-health').summary, /revision/i);
      assert.equal(gate(error.receipt, 'benchmark-health').status, 'fail');
      assert.match(gate(error.receipt, 'benchmark-health').summary, /stale/i);
      return true;
    }
  );
});

test('fails closed when RAG answers HTTP instead of being transport-unavailable', async () => {
  const routes = scenarioRoutes('degraded');
  routes.set(`${BASE_URLS.rag}/health`, jsonResponse({ ok: false, status: 'degraded' }, 503));

  await assert.rejects(
    verifyDegradedRelease(options('degraded'), dependencies(routes)),
    (error) => {
      assert(error instanceof ResilienceEvidenceError);
      assert.equal(error.receipt.status, 'fail');
      assert.equal(error.receipt.evidence.services.rag.state, 'response');
      assert.equal(error.receipt.evidence.services.rag.httpStatus, 503);
      assert.equal(gate(error.receipt, 'rag-transport-unavailable').status, 'fail');
      return true;
    }
  );
});

test('fails closed when Portal softens the outage or invents a missing RAG identity', async () => {
  const routes = scenarioRoutes('degraded');
  const portal = portalFixture('degraded');
  portal.summary = { ...portal.summary, status: 'degraded', healthy: 3, down: 0 };
  portal.services = portal.services.map((service) => service.id === 'rag'
    ? { ...service, identity: identity('agentx-rag') }
    : service);
  routes.set(`${BASE_URLS.core}/api/portal/health`, jsonResponse(portal));

  await assert.rejects(
    verifyDegradedRelease(options('degraded'), dependencies(routes)),
    (error) => {
      assert.equal(gate(error.receipt, 'portal-rag-unavailable').status, 'fail');
      assert.match(gate(error.receipt, 'portal-rag-unavailable').summary, /healthy must be 2|must not invent/i);
      return true;
    }
  );
});

test('fails closed when degraded ecosystem trust is falsely verified or contradictory', async () => {
  const routes = scenarioRoutes('degraded');
  const snapshot = ecosystemFixture('degraded', {
    evidenceTrust: evidenceTrust('degraded', {
      status: 'verified',
      contradictionBudget: {
        allowed: 0,
        observed: 1,
        withinBudget: false,
        contradictions: [{
          id: 'service-total',
          expected: 3,
          observed: 'http://private.fixture.test:9999',
        }],
      },
    }),
  });
  routes.set(`${BASE_URLS.core}/api/nerve-center/ecosystem`, jsonResponse({ status: 'success', data: snapshot }));

  await assert.rejects(
    verifyDegradedRelease(options('degraded'), dependencies(routes)),
    (error) => {
      const trust = error.receipt.evidence.ecosystem.evidenceTrust;
      assert.equal(gate(error.receipt, 'ecosystem-rag-unavailable').status, 'fail');
      assert.equal(trust.contradictionBudget.observed, 1);
      assert.doesNotMatch(JSON.stringify(error.receipt), /private\.fixture\.test/);
      return true;
    }
  );
});

test('recovery fails closed when RAG identity or verified trust has not returned', async () => {
  const routes = scenarioRoutes('recovery');
  routes.set(`${BASE_URLS.rag}/health`, new Error('still unavailable'));
  const portal = portalFixture('recovery');
  portal.consistency = consistency('degraded');
  portal.summary = serviceSummary('degraded');
  portal.services = serviceRows('degraded');
  routes.set(`${BASE_URLS.core}/api/portal/health`, jsonResponse(portal));
  const snapshot = ecosystemFixture('degraded');
  routes.set(`${BASE_URLS.core}/api/nerve-center/ecosystem`, jsonResponse({ status: 'success', data: snapshot }));

  await assert.rejects(
    verifyDegradedRelease(options('recovery'), dependencies(routes)),
    (error) => {
      assert.equal(error.receipt.status, 'fail');
      assert.equal(gate(error.receipt, 'rag-health').status, 'fail');
      assert.equal(gate(error.receipt, 'portal-recovered').status, 'fail');
      assert.equal(gate(error.receipt, 'ecosystem-recovered').status, 'fail');
      return true;
    }
  );
});

test('owns the request deadline even when the transport ignores AbortSignal', async () => {
  const routes = scenarioRoutes('degraded');
  routes.set(`${BASE_URLS.rag}/health`, () => new Promise(() => {}));
  const timeoutMs = 15;
  const started = Date.now();

  const receipt = await verifyDegradedRelease(
    options('degraded', { timeoutMs }),
    dependencies(routes)
  );
  const wallMs = Date.now() - started;

  assert.equal(receipt.status, 'pass');
  assert.equal(receipt.evidence.services.rag.failureClass, 'timeout');
  assert.equal(receipt.requests.find((request) => request.service === 'rag').outcome, 'transport-unavailable');
  assert.equal(gate(receipt, 'bounded-collection').status, 'pass');
  assert(receipt.elapsedMs <= timeoutMs + REQUEST_SETTLEMENT_TOLERANCE_MS);
  assert(wallMs <= timeoutMs + REQUEST_SETTLEMENT_TOLERANCE_MS);
});

test('classifies an oversized evidence response without buffering it', async () => {
  const result = await boundedJsonRequest({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => String(MAX_DEGRADED_RESPONSE_BYTES + 1) },
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from('{}');
        },
      },
    }),
    baseUrl: BASE_URLS.core,
    service: 'core',
    requestPath: '/health',
    timeoutMs: 100,
    monotonicNow: () => 0,
  });

  assert.equal(result.state, 'invalid-response');
  assert.equal(result.timing.failureClass, 'response-too-large');
});

test('parses explicit scenario metadata and always persists a failure receipt when output is requested', async () => {
  const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-resilience-'));
  const outputPath = path.join(outputDirectory, 'degraded.json');
  const argv = [
    '--phase', 'degraded',
    '--scenario', 'rag-unavailable',
    '--scenario-run-id', SCENARIO_RUN_ID,
    '--execution-mode', 'contract-fixture',
    '--expected-revision', EXPECTED_REVISION,
    '--core-url', BASE_URLS.core,
    '--benchmark-url', BASE_URLS.benchmark,
    '--rag-url', BASE_URLS.rag,
    '--timeout-ms', '100',
    '--freshness-ms', '120000',
    '--output', outputPath,
  ];
  const parsed = parseArgs(argv);
  assert.equal(parsed.phase, 'degraded');
  assert.equal(parsed.scenarioRunId, SCENARIO_RUN_ID);
  assert.equal(parsed.executionMode, 'contract-fixture');

  const routes = scenarioRoutes('degraded');
  routes.set(`${BASE_URLS.rag}/health`, healthResponse('rag'));
  try {
    await assert.rejects(runCli(argv, dependencies(routes)), ResilienceEvidenceError);
    const receipt = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
    assert.equal(receipt.kind, RECEIPT_KIND);
    assert.equal(receipt.status, 'fail');
    assert.equal(receipt.phase, 'degraded');
    assert.equal(receipt.executionMode, 'contract-fixture');
    assert.equal(gate(receipt, 'rag-transport-unavailable').status, 'fail');
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
});
