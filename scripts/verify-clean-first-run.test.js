'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { DEFAULT_URLS, parseArgs, verifyCleanFirstRun } = require('./verify-clean-first-run');

function response(body, { status = 200, url = '' } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
    async json() { return body; },
    async text() { return String(body); },
  };
}

function harness(overrides = {}) {
  const routes = new Map([
    [`${DEFAULT_URLS.core}/health`, response({
      ok: true,
      status: 'ok',
      service: 'agentx-core',
      details: { mongodb: 'connected', ollama: 'unavailable' },
    })],
    [`${DEFAULT_URLS.benchmark}/health`, response({
      status: 'ok',
      service: 'agentx-benchmark',
      db: 'connected',
    })],
    [`${DEFAULT_URLS.rag}/health`, response({
      ok: true,
      status: 'ok',
      service: 'agentx-rag',
      db: 'connected',
      vectorStore: { healthy: true, type: 'qdrant' },
    })],
    [`${DEFAULT_URLS.core}/api/config`, response({ profile: 'demo' })],
    [`${DEFAULT_URLS.core}/`, response(
      '<!doctype html><title>Agent X</title><a href="/playground?persona=learning_guide">Start Learning Guide</a>',
      { url: `${DEFAULT_URLS.core}/demo` }
    )],
  ]);
  for (const [url, value] of Object.entries(overrides)) routes.set(url, value);
  return async (url) => routes.get(url) || response('', { status: 404, url });
}

test('accepts a healthy standalone demo without Ollama', async () => {
  const receipt = await verifyCleanFirstRun({ fetchImpl: harness() });
  assert.deepEqual(receipt.services, { core: 'healthy', benchmark: 'healthy', rag: 'healthy' });
  assert.equal(receipt.profile, 'demo');
  assert.equal(receipt.landing.path, '/demo');
  assert.equal(receipt.ollama, 'optional-not-required');
});

test('rejects a degraded or wrongly identified product service', async () => {
  await assert.rejects(
    verifyCleanFirstRun({ fetchImpl: harness({
      [`${DEFAULT_URLS.benchmark}/health`]: response({ status: 'ok', service: 'personal-benchmark', db: 'connected' }),
    }) }),
    /Benchmark health service identity is invalid/
  );
});

test('rejects a first run that is not in the demo profile', async () => {
  await assert.rejects(
    verifyCleanFirstRun({ fetchImpl: harness({
      [`${DEFAULT_URLS.core}/api/config`]: response({ profile: 'full' }),
    }) }),
    /did not start in the demo profile/
  );
});

test('rejects private environment identity on the first-run landing page', async () => {
  await assert.rejects(
    verifyCleanFirstRun({ fetchImpl: harness({
      [`${DEFAULT_URLS.core}/`]: response(
        '<title>Agent X</title><a href="/playground?persona=learning_guide">Guide</a><p>OpenClaw</p>',
        { url: `${DEFAULT_URLS.core}/demo` }
      ),
    }) }),
    /private-environment marker/
  );
});

test('rejects a demo that omits the guided persona doorway', async () => {
  await assert.rejects(
    verifyCleanFirstRun({ fetchImpl: harness({
      [`${DEFAULT_URLS.core}/`]: response('<title>Agent X</title>', { url: `${DEFAULT_URLS.core}/demo` }),
    }) }),
    /missing the Learning Guide path/
  );
});

test('parses explicit local endpoint overrides', () => {
  assert.deepEqual(parseArgs([
    '--core-url', 'http://localhost:4180',
    '--benchmark-url', 'http://localhost:4181',
    '--rag-url', 'http://localhost:4182',
  ]), {
    core: 'http://localhost:4180',
    benchmark: 'http://localhost:4181',
    rag: 'http://localhost:4182',
  });
});
