'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_URLS,
  MAX_CLEAN_FIRST_RUN_RESPONSE_BYTES,
  parseArgs,
  verifyCleanFirstRun,
} = require('./verify-clean-first-run');

function response(body, { status = 200, url = '' } = {}) {
  const bytes = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  return {
    ok: status >= 200 && status < 300,
    status,
    url,
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

function harness(overrides = {}) {
  const identity = (service) => ({
    service,
    version: '0.1.1',
    profile: 'demo',
    revision: 'test-revision',
    ts: '2026-08-28T12:00:00.000Z',
  });
  const routes = new Map([
    [`${DEFAULT_URLS.core}/health`, response({
      ok: true,
      status: 'ok',
      ...identity('agentx-core'),
      details: { mongodb: 'connected', ollama: 'unavailable' },
    })],
    [`${DEFAULT_URLS.benchmark}/health`, response({
      ok: true,
      status: 'ok',
      ...identity('agentx-benchmark'),
      db: 'connected',
    })],
    [`${DEFAULT_URLS.rag}/health`, response({
      ok: true,
      status: 'ok',
      ...identity('agentx-rag'),
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
      [`${DEFAULT_URLS.benchmark}/health`]: response({
        ok: true,
        status: 'ok',
        service: 'personal-benchmark',
        version: '0.1.1',
        profile: 'demo',
        revision: 'test-revision',
        ts: '2026-08-28T12:00:00.000Z',
        db: 'connected',
      }),
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

test('rejects a mixed or unidentified service build', async () => {
  await assert.rejects(
    verifyCleanFirstRun({ fetchImpl: harness({
      [`${DEFAULT_URLS.rag}/health`]: response({
        ok: true,
        status: 'ok',
        service: 'agentx-rag',
        version: '0.1.1',
        profile: 'full',
        revision: '',
        ts: '2026-08-28T12:00:00.000Z',
        db: 'connected',
        vectorStore: { healthy: true, type: 'qdrant' },
      }),
    }) }),
    /RAG health profile is not demo/
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

test('rejects a first-run response that exceeds the byte budget', async () => {
  await assert.rejects(
    verifyCleanFirstRun({ fetchImpl: harness({
      [`${DEFAULT_URLS.core}/api/config`]: {
        ok: true,
        status: 200,
        url: `${DEFAULT_URLS.core}/api/config`,
        headers: { get: () => String(MAX_CLEAN_FIRST_RUN_RESPONSE_BYTES + 1) },
        body: {
          async *[Symbol.asyncIterator]() {
            yield Buffer.from('{}');
          },
        },
      },
    }) }),
    /Core config response could not be read: Response body exceeded its byte limit/
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
