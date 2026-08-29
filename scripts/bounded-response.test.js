'use strict';

const assert = require('node:assert/strict');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  BoundedResponseError,
  cancelResponseBody,
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
} = require('./bounded-response');

function headers(values = {}) {
  const normalized = new Map(Object.entries(values)
    .map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) ?? null };
}

test('reads Web and Node response streams within one byte cap', async () => {
  const web = new Response('{"ok":true}', {
    headers: { 'content-type': 'application/json' },
  });
  assert.deepEqual(await readBoundedJson(web, { maxBytes: 64 }), { ok: true });

  const node = {
    headers: headers(),
    body: Readable.from([Buffer.from('Agent '), Buffer.from('X')]),
  };
  assert.equal(await readBoundedText(node, { maxBytes: 64 }), 'Agent X');
});

test('rejects declared and streamed overflows and cancels their bodies', async () => {
  let declaredCancelled = false;
  await assert.rejects(
    readBoundedBytes({
      headers: headers({ 'content-length': '65' }),
      body: { cancel: async () => { declaredCancelled = true; } },
    }, { maxBytes: 64 }),
    (error) => error instanceof BoundedResponseError && error.code === 'RESPONSE_TOO_LARGE'
  );
  assert.equal(declaredCancelled, true);

  let returned = false;
  const iterator = {
    calls: 0,
    async next() {
      this.calls += 1;
      return this.calls === 1 ? { done: false, value: Buffer.alloc(65) } : { done: true };
    },
    async return() { returned = true; return { done: true }; },
  };
  await assert.rejects(
    readBoundedBytes({ headers: headers(), body: { [Symbol.asyncIterator]: () => iterator } }, { maxBytes: 64 }),
    (error) => error?.code === 'RESPONSE_TOO_LARGE'
  );
  assert.equal(returned, true);
});

test('rejects malformed lengths, unreadable bodies, and invalid JSON', async () => {
  const malformedBody = Readable.from([]);
  await assert.rejects(
    readBoundedBytes({ headers: headers({ 'content-length': '1, 2' }), body: malformedBody }, { maxBytes: 64 }),
    (error) => error?.code === 'INVALID_CONTENT_LENGTH'
  );
  assert.equal(malformedBody.destroyed, true);

  let unreadableCancelled = false;
  await assert.rejects(
    readBoundedBytes({
      headers: headers(),
      body: { cancel: async () => { unreadableCancelled = true; } },
    }, { maxBytes: 64 }),
    (error) => error?.code === 'RESPONSE_UNREADABLE'
  );
  assert.equal(unreadableCancelled, true);
  await assert.rejects(
    readBoundedJson({ headers: headers(), body: Readable.from(['not json']) }, { maxBytes: 64 }),
    (error) => error?.code === 'INVALID_JSON'
  );
});

test('owns cancellation even when an injected body reader never settles', async () => {
  const controller = new AbortController();
  let returned = false;
  const iterator = {
    next: () => new Promise(() => {}),
    async return() { returned = true; return { done: true }; },
  };
  const pending = readBoundedBytes({
    headers: headers(),
    body: { [Symbol.asyncIterator]: () => iterator },
  }, { maxBytes: 64, signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (error) => error?.code === 'RESPONSE_ABORTED');
  assert.equal(returned, true);
});

test('cancels an intentionally unconsumed response without buffering it', async () => {
  let cancelled = false;
  await cancelResponseBody({ body: { cancel: async () => { cancelled = true; } } });
  assert.equal(cancelled, true);
});
