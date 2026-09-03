'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_BASE_URLS,
  MAX_SURFACE_RESPONSE_BYTES,
  parseArgs,
  readRegistry,
  selectSurfaces,
  validateRegistry,
  verifyProductSurfaces,
} = require('./verify-product-surfaces');

function htmlResponse(body, status = 200, options = {}) {
  const bodyText = String(body);
  const headers = new Map(Object.entries({
    'content-type': 'text/html; charset=utf-8',
    'content-length': String(Buffer.byteLength(bodyText)),
    ...(options.headers || {}),
  }).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    ok: status >= 200 && status < 300,
    status,
    url: options.url || '',
    headers: { get: (name) => headers.get(String(name).toLowerCase()) || null },
    body: {
      async *[Symbol.asyncIterator]() { yield Buffer.from(bodyText); },
      async cancel() {},
    },
  };
}

function canonicalRegistry(extraSurfaces = []) {
  return {
    schemaVersion: 2,
    profiles: ['demo', 'full'],
    services: ['core', 'benchmark', 'rag'],
    performanceBudgets: {
      standard: {
        maxDecodedBytes: 1000,
        maxJavaScriptBytes: 500,
        maxAssetRequests: 10,
        maxDomNodes: 100,
      },
    },
    surfaces: [
      { id: 'core-playground', service: 'core', path: '/playground', profiles: ['demo', 'full'], journey: 'try', critical: true, performanceBudget: 'standard' },
      { id: 'benchmark-home', service: 'benchmark', path: '/', profiles: ['demo', 'full'], journey: 'evaluate', critical: true, performanceBudget: 'standard' },
      { id: 'rag-home', service: 'rag', path: '/', profiles: ['demo', 'full'], journey: 'knowledge', critical: true, performanceBudget: 'standard' },
      ...extraSurfaces,
    ],
  };
}

function identityForUrl(url) {
  const parsed = new URL(url);
  if (parsed.origin === new URL(DEFAULT_BASE_URLS.core).origin) return 'core-playground';
  if (parsed.origin === new URL(DEFAULT_BASE_URLS.benchmark).origin) return 'benchmark-home';
  return 'rag-home';
}

function validFetch(url) {
  const identity = identityForUrl(url);
  return htmlResponse(
    `<!doctype html><body data-agentx-surface="${identity}"><main></main></body>`,
    200,
    { url }
  );
}

test('the checked-in registry is valid and separates demo-only from full-only surfaces', () => {
  const registry = validateRegistry(readRegistry());
  const demo = selectSurfaces(registry, { profile: 'demo' });
  const full = selectSurfaces(registry, { profile: 'full' });

  assert(demo.some((surface) => surface.id === 'core-demo'));
  assert(!demo.some((surface) => surface.id === 'core-nerve-center'));
  assert(demo.some((surface) => surface.id === 'benchmark-harnesses'));
  assert(full.some((surface) => surface.id === 'core-nerve-center'));
  assert(full.some((surface) => surface.id === 'benchmark-harnesses'));
  assert(!full.some((surface) => surface.id === 'core-demo'));
  assert(registry.surfaces
    .filter((surface) => surface.critical)
    .every((surface) => registry.performanceBudgets[surface.performanceBudget]));
});

test('registry validation fails closed on malformed or missing critical-surface budgets', () => {
  const missingReference = canonicalRegistry();
  delete missingReference.surfaces[0].performanceBudget;
  assert.throws(
    () => validateRegistry(missingReference),
    /Performance budget reference is missing for critical surface core-playground/
  );

  const unknownReference = canonicalRegistry();
  unknownReference.surfaces[0].performanceBudget = 'missing';
  assert.throws(
    () => validateRegistry(unknownReference),
    /Unknown performance budget for core-playground: missing/
  );

  for (const invalid of [0, -1, 1.5, '1000']) {
    const invalidLimit = canonicalRegistry();
    invalidLimit.performanceBudgets.standard.maxDecodedBytes = invalid;
    assert.throws(
      () => validateRegistry(invalidLimit),
      /standard\.maxDecodedBytes must be a positive integer/
    );
  }

  const misspelledField = canonicalRegistry();
  misspelledField.performanceBudgets.standard.maxRequests = 10;
  assert.throws(
    () => validateRegistry(misspelledField),
    /fields must be exactly/
  );
});

test('registry validation fails closed on missing profile or per-service critical coverage', () => {
  const noFull = canonicalRegistry();
  noFull.surfaces = noFull.surfaces.map((surface) => ({ ...surface, profiles: ['demo'] }));
  assert.throws(() => validateRegistry(noFull), /no full coverage for core/);

  const noRag = canonicalRegistry();
  noRag.surfaces = noRag.surfaces.filter((surface) => surface.service !== 'rag');
  assert.throws(() => validateRegistry(noRag), /no demo coverage for rag/);

  const noCriticalBenchmark = canonicalRegistry();
  noCriticalBenchmark.surfaces = noCriticalBenchmark.surfaces.map((surface) => (
    surface.service === 'benchmark' ? { ...surface, critical: false } : surface
  ));
  assert.throws(() => validateRegistry(noCriticalBenchmark), /no critical demo surface for benchmark/);
});

test('verifies every selected page concurrently and returns surface identities', async () => {
  const calls = [];
  const receipt = await verifyProductSurfaces({
    registry: canonicalRegistry(),
    profile: 'demo',
    criticalOnly: true,
    fetchImpl: async (url) => { calls.push(url); return validFetch(url); },
    baseUrls: DEFAULT_BASE_URLS,
  });

  assert.equal(receipt.total, 3);
  assert.deepEqual(new Set(receipt.passed.map((entry) => entry.identity)), new Set([
    'core-playground', 'benchmark-home', 'rag-home',
  ]));
  assert.equal(calls.length, 3);
});

test('fails with the exact surface id for server errors and unresolved templates', async () => {
  const registry = canonicalRegistry([
    { id: 'core-prompts', service: 'core', path: '/prompts', profiles: ['demo', 'full'], journey: 'configure', critical: true, performanceBudget: 'standard' },
  ]);
  const fetchImpl = async (url) => {
    if (url.endsWith('/playground')) return htmlResponse('Internal Server Error', 500, { url });
    if (url.endsWith('/prompts')) {
      return htmlResponse('<body data-agentx-surface="core-prompts"><h1>{{component}}</h1></body>', 200, { url });
    }
    return validFetch(url);
  };

  await assert.rejects(
    verifyProductSurfaces({ registry, fetchImpl, baseUrls: DEFAULT_BASE_URLS }),
    /core-playground returned HTTP 500; core-prompts rendered an unresolved template token/
  );
});

test('rejects an oversized page body before template inspection', async () => {
  const registry = canonicalRegistry();
  await assert.rejects(
    verifyProductSurfaces({
      registry,
      fetchImpl: async (url) => url.endsWith('/playground')
        ? htmlResponse('x'.repeat(MAX_SURFACE_RESPONSE_BYTES + 1), 200, { url })
        : validFetch(url),
      baseUrls: DEFAULT_BASE_URLS,
    }),
    /byte limit/
  );
});

for (const [kind, markup, expected] of [
  ['script', '<script src="https://cdn.example.test/runtime.js"></script>', /WAN-dependent runtime script/],
  ['stylesheet', '<link href="https://cdn.example.test/runtime.css" rel="stylesheet">', /WAN-dependent runtime stylesheet/],
]) test(`rejects a page whose functionality depends on an external runtime ${kind}`, async () => {
  await assert.rejects(
    verifyProductSurfaces({
      registry: canonicalRegistry(),
      fetchImpl: async (url) => url.endsWith('/playground')
        ? htmlResponse(`<body data-agentx-surface="core-playground">${markup}</body>`, 200, { url })
        : validFetch(url),
      baseUrls: DEFAULT_BASE_URLS,
    }),
    expected
  );
});

test('rejects redirects, wrong final URLs, and generic pages without canonical identity', async () => {
  const cases = [
    {
      response: (url) => htmlResponse('', 302, { url, headers: { location: 'https://outside.example/' } }),
      expected: /core-playground redirected with HTTP 302/,
    },
    {
      response: () => htmlResponse('<body data-agentx-surface="core-playground"></body>', 200, { url: 'https://outside.example/' }),
      expected: /core-playground resolved to the wrong URL/,
    },
    {
      response: (url) => htmlResponse('<body><main>Generic home</main></body>', 200, { url }),
      expected: /core-playground did not render its canonical surface identity/,
    },
  ];

  for (const entry of cases) {
    await assert.rejects(
      verifyProductSurfaces({
        registry: canonicalRegistry(),
        fetchImpl: async (url) => url.endsWith('/playground') ? entry.response(url) : validFetch(url),
        baseUrls: DEFAULT_BASE_URLS,
      }),
      entry.expected
    );
  }
});

test('checks full-only Core surfaces as negative demo-profile boundaries', async () => {
  const registry = canonicalRegistry([
    { id: 'core-portal', service: 'core', path: '/', profiles: ['full'], journey: 'operate', critical: true, performanceBudget: 'standard' },
    { id: 'core-nerve-center', service: 'core', path: '/nerve-center', profiles: ['full'], journey: 'operate', critical: true, performanceBudget: 'standard' },
  ]);

  const fetchImpl = async (url) => {
    if (url === `${DEFAULT_BASE_URLS.core}/`) {
      return htmlResponse('', 302, {
        url,
        headers: { location: '/demo', 'x-agentx-profile': 'demo' },
      });
    }
    if (url.endsWith('/nerve-center')) {
      return htmlResponse('leaked', 200, { url, headers: { 'x-agentx-profile': 'demo' } });
    }
    return validFetch(url);
  };

  await assert.rejects(
    verifyProductSurfaces({ registry, profile: 'demo', fetchImpl, baseUrls: DEFAULT_BASE_URLS }),
    /core-nerve-center leaked into the demo profile with HTTP 200/
  );
});

test('parses profile, critical mode, and service URL overrides', () => {
  assert.deepEqual(parseArgs([
    '--profile', 'full',
    '--critical-only',
    '--core-url', 'http://localhost:4180',
    '--benchmark-url', 'http://localhost:4181',
    '--rag-url', 'http://localhost:4182',
  ]), {
    profile: 'full',
    criticalOnly: true,
    baseUrls: {
      core: 'http://localhost:4180',
      benchmark: 'http://localhost:4181',
      rag: 'http://localhost:4182',
    },
  });
});
