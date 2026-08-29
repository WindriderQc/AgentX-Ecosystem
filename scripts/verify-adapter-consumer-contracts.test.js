'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  NOW,
  degradedFixtures,
  healthyFixtures,
} = require('./adapter-consumer-contract-fixtures');
const {
  MAX_ADAPTER_RESPONSE_BYTES,
  parseArgs,
  readRegistry,
  validateRegistry,
  verifyAdapterConsumerContracts,
} = require('./verify-adapter-consumer-contracts');

const BASE_URLS = Object.freeze({
  core: 'https://core.invalid',
  rag: 'https://rag.invalid',
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function fixtureResponse(fixtureValue) {
  const headers = Object.fromEntries(Object.entries(fixtureValue.headers || {})
    .map(([key, value]) => [key.toLowerCase(), value]));
  const bytes = Buffer.from(JSON.stringify(clone(fixtureValue.body)));
  return {
    status: fixtureValue.status,
    ok: fixtureValue.status >= 200 && fixtureValue.status < 300,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        if (key === 'content-length') return String(bytes.byteLength);
        return headers[key] || null;
      },
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield bytes;
      },
    },
  };
}

function fixtureFetch(registry, fixtures, calls = []) {
  return async (rawUrl, options = {}) => {
    const url = new URL(rawUrl);
    const check = registry.checks.find((candidate) => (
      candidate.method === options.method
      && candidate.path === url.pathname
      && url.origin === new URL(BASE_URLS[candidate.service]).origin
    ));
    assert(check, `unexpected fixture request: ${options.method} ${url.pathname}`);
    const expectedQuery = new URLSearchParams(Object.entries(check.query || {}).map(([key, value]) => [key, String(value)]));
    assert.equal(url.searchParams.toString(), expectedQuery.toString(), `${check.id} query mismatch`);
    if (check.body) assert.deepEqual(JSON.parse(options.body), check.body, `${check.id} body mismatch`);
    calls.push({ check: check.id, url: rawUrl, options });
    assert(fixtures[check.id], `missing fixture for ${check.id}`);
    return fixtureResponse(fixtures[check.id]);
  };
}

async function verifyFixtures(fixtures, overrides = {}) {
  const registry = clone(overrides.registry || readRegistry());
  return verifyAdapterConsumerContracts({
    registry,
    baseUrls: BASE_URLS,
    fetchImpl: fixtureFetch(registry, fixtures, overrides.calls),
    now: () => new Date(NOW),
    ...overrides,
    // Keep the fetch tied to the possibly overridden registry.
    ...(overrides.fetchImpl ? {} : { fetchImpl: fixtureFetch(registry, fixtures, overrides.calls) }),
  });
}

test('checked-in registry is address-free, version-pinned, and audits both consumer allowlists', () => {
  const registry = validateRegistry(readRegistry());
  const coreVersion = require('../core/package.json').version;
  const ragVersion = require('../rag/package.json').version;

  assert.equal(registry.productVersion, coreVersion);
  assert.equal(registry.productVersion, ragVersion);
  assert(!JSON.stringify(registry).match(/https?:\/\//i));
  assert(registry.checks.some((check) => check.contract?.flavor === 'generic'));
  assert(registry.checks.some((check) => check.contract?.flavor === 'nestor'));
  assert(registry.checks.some((check) => check.id === 'rag-documents-read'));
  assert(registry.checks.some((check) => check.id === 'rag-search-read'));
});

test('a separately operated Data service can use its own identity without claiming product ownership', () => {
  const registry = clone(readRegistry());
  registry.services.push({ id: 'data', identity: 'private-data', version: '2.4.0', productOwned: false });
  assert.doesNotThrow(() => validateRegistry(registry));

  registry.services.at(-1).identity = 'agentx-data';
  assert.throws(() => validateRegistry(registry), /must not claim an Agent X product identity/);
});

test('verifies every healthy fixture and sends only the bounded registered requests', async () => {
  const registry = readRegistry();
  const calls = [];
  const receipt = await verifyAdapterConsumerContracts({
    registry,
    baseUrls: BASE_URLS,
    fetchImpl: fixtureFetch(registry, healthyFixtures(), calls),
    now: () => new Date(NOW),
    consumerToken: 'fixture-token',
  });

  assert.equal(receipt.total, registry.checks.length);
  assert.equal(receipt.ok, registry.checks.length);
  assert.equal(receipt.degraded, 0);
  assert.equal(calls.length, registry.checks.length);
  assert(calls.every((call) => call.url.startsWith(BASE_URLS[registry.checks.find((check) => check.id === call.check).service])));
  assert.equal(calls.find((call) => call.check === 'nestor-data-read-search').options.method, 'POST');
  assert.deepEqual(
    JSON.parse(calls.find((call) => call.check === 'nestor-data-read-search').options.body),
    { source: 'agentx', query: 'agentx conformance probe', k: 3 }
  );
  assert.equal(
    calls.find((call) => call.check === 'generic-consumer-routing').options.headers['X-AgentX-Consumer-Token'],
    'fixture-token'
  );
  assert.equal(calls.find((call) => call.check === 'core-health').options.headers['X-AgentX-Consumer-Token'], undefined);
  assert.equal(calls.find((call) => call.check === 'nestor-consumer-routing').options.headers['X-AgentX-Consumer-Token'], undefined);
});

test('rejects a response whose declared size exceeds the conformance byte budget', async () => {
  const registry = readRegistry();
  const fixtures = healthyFixtures();
  const fetchFixture = fixtureFetch(registry, fixtures);
  const fetchImpl = async (url, options) => {
    const response = await fetchFixture(url, options);
    if (url === `${BASE_URLS.core}/health`) {
      return {
        ...response,
        headers: {
          get(name) {
            if (String(name).toLowerCase() === 'content-length') {
              return String(MAX_ADAPTER_RESPONSE_BYTES + 1);
            }
            return response.headers.get(name);
          },
        },
      };
    }
    return response;
  };

  await assert.rejects(
    verifyAdapterConsumerContracts({
      registry,
      baseUrls: BASE_URLS,
      fetchImpl,
      now: () => new Date(NOW),
    }),
    /core-health response could not be read: Response body exceeded its byte limit/
  );
});

test('accepts honest degraded fixtures while retaining identity, freshness, and reason evidence', async () => {
  const receipt = await verifyFixtures(degradedFixtures());
  assert.equal(receipt.total, readRegistry().checks.length);
  assert.equal(receipt.ok, 0);
  assert.equal(receipt.degraded, receipt.total);
  assert.equal(receipt.passed.find((entry) => entry.id === 'core-health').httpStatus, 503);
  assert.equal(receipt.passed.find((entry) => entry.id === 'core-portal-health').state, 'down');
  assert.equal(receipt.passed.find((entry) => entry.id === 'rag-search-read').state, 'degraded');
});

test('freshness policy accepts any fresh canonical timestamp but rejects stale, future, and non-canonical values', async (t) => {
  await t.test('accepts a different fresh observation', async () => {
    const fixtures = healthyFixtures();
    fixtures['core-health'].body.ts = '2026-08-28T15:58:01.000Z';
    await verifyFixtures(fixtures);
  });

  for (const [name, timestamp, expected] of [
    ['stale', '2026-08-28T15:57:59.999Z', /stale by/],
    ['future', '2026-08-28T16:00:06.000Z', /implausibly in the future/],
    ['non-canonical', '2026-08-28T15:59:30Z', /canonical ISO-8601/],
  ]) await t.test(`rejects ${name} evidence`, async () => {
    const fixtures = healthyFixtures();
    fixtures['core-health'].body.ts = timestamp;
    await assert.rejects(verifyFixtures(fixtures), expected);
  });
});

test('rejects unstable service identity, product version, and consumer contract version', async (t) => {
  await t.test('service identity', async () => {
    const fixtures = healthyFixtures();
    fixtures['core-health'].body.service = 'agentx-impostor';
    await assert.rejects(verifyFixtures(fixtures), /service identity must be agentx-core/);
  });

  await t.test('product version', async () => {
    const fixtures = healthyFixtures();
    fixtures['rag-health'].body.version = '9.9.9';
    await assert.rejects(verifyFixtures(fixtures), /version must be 0\.1\.1/);
  });

  await t.test('contract header', async () => {
    const fixtures = healthyFixtures();
    fixtures['nestor-consumer-routing'].headers['x-agentx-consumer-contract'] = '1.1.0';
    await assert.rejects(verifyFixtures(fixtures), /contract header must be 1\.2\.0/);
  });
});

test('generic and Nestor public projections fail closed on extra topology and absolute URLs', async (t) => {
  await t.test('generic route hostUrl', async () => {
    const fixtures = healthyFixtures();
    fixtures['generic-consumer-routing'].body.data.tasks.general_chat.hostUrl = 'https://private.invalid/inference';
    await assert.rejects(verifyFixtures(fixtures), /exposes a location field|unversioned fields/);
  });

  await t.test('Nestor route URL in a nominal reason', async () => {
    const fixtures = healthyFixtures();
    fixtures['nestor-consumer-routing'].body.data.routes.chat.reason = 'Selected https://private.invalid/inference';
    await assert.rejects(verifyFixtures(fixtures), /exposes an absolute URL/);
  });

  await t.test('Nestor status URL field', async () => {
    const fixtures = healthyFixtures();
    fixtures['nestor-data-read-status'].body.data.sources.agentx.hostUrl = 'https://private.invalid';
    await assert.rejects(verifyFixtures(fixtures), /exposes a location field/);
  });

  await t.test('wrong allowlist for a versioned flavor', async () => {
    const fixtures = healthyFixtures();
    fixtures['generic-consumer-capabilities'].body.data.externalExperiences = { supported: false };
    await assert.rejects(verifyFixtures(fixtures), /contains unversioned fields/);
  });
});

test('bounded reads reject over-limit results, missing provenance, and dishonest counts', async (t) => {
  await t.test('over-limit', async () => {
    const fixtures = healthyFixtures();
    const result = fixtures['rag-search-read'].body.data.results[0];
    fixtures['rag-search-read'].body.data.results = [result, result, result, result];
    fixtures['rag-search-read'].body.data.count = 4;
    await assert.rejects(verifyFixtures(fixtures), /above its 3 limit/);
  });

  await t.test('missing provenance', async () => {
    const fixtures = healthyFixtures();
    delete fixtures['rag-search-read'].body.data.results[0].metadata.documentId;
    await assert.rejects(verifyFixtures(fixtures), /lacks provenance/);
  });

  await t.test('dishonest count', async () => {
    const fixtures = healthyFixtures();
    fixtures['rag-search-read'].body.data.count = 2;
    await assert.rejects(verifyFixtures(fixtures), /exact count is inconsistent/);
  });

  await t.test('unbounded source group', async () => {
    const fixtures = healthyFixtures();
    fixtures['nestor-data-read-search'].body.data.bySource.private = [];
    await assert.rejects(verifyFixtures(fixtures), /unbounded source group set/);
  });
});

test('degraded shapes fail when status contradicts evidence or a failure lacks a stable envelope', async (t) => {
  await t.test('health contradiction', async () => {
    const fixtures = degradedFixtures();
    fixtures['core-health'].body.ok = true;
    await assert.rejects(verifyFixtures(fixtures), /ok contradicts HTTP 503/);
  });

  await t.test('missing source warning', async () => {
    const fixtures = degradedFixtures();
    fixtures['nestor-data-read-status'].body.data.warnings = [];
    await assert.rejects(verifyFixtures(fixtures), /lacks evidence/);
  });

  await t.test('unshaped RAG failure', async () => {
    const fixtures = degradedFixtures();
    fixtures['rag-search-read'].body = { status: 'failed' };
    await assert.rejects(verifyFixtures(fixtures), /degraded status must be error|needs an error message/);
  });
});

test('CLI parsing keeps addresses outside the registry and supports arbitrary separately operated services', () => {
  const registryPath = path.resolve('config', 'adapter-consumer-contracts.json');
  assert.deepEqual(parseArgs([
    '--registry', registryPath,
    '--core-url', 'https://core.invalid',
    '--rag-url', 'https://rag.invalid',
    '--base-url', 'data=https://data.invalid',
    '--timeout-ms', '9000',
    '--consumer-token-env', 'CONSUMER_TOKEN',
  ]), {
    registryPath,
    baseUrls: {
      core: 'https://core.invalid',
      rag: 'https://rag.invalid',
      data: 'https://data.invalid',
    },
    timeoutMs: 9000,
    tokenEnv: 'CONSUMER_TOKEN',
  });
});
