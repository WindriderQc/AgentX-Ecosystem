'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const { Readable } = require('node:stream');
const test = require('node:test');

const {
  CONNECT_TIME_PEER_VERIFICATION,
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
  createOutboundHttpExecutor,
  discardBoundedResponse,
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
  toPublicOutboundError,
} = require('./outboundHttpExecutor');

const SINK_ID = 'core.chat.inference';
const EXPECTED_ORIGIN = 'http://model.internal:11434';
const TARGET = `${EXPECTED_ORIGIN}/api/chat?mode=test`;

function operation(overrides = {}) {
  return {
    authoritySource: 'configured',
    deadlineMs: 500,
    maxRequestBytes: 1024,
    maxResponseBytes: 1024,
    ...overrides,
  };
}

function headers(values = {}) {
  const normalized = new Map(Object.entries(values)
    .map(([key, value]) => [key.toLowerCase(), String(value)]));
  return { get: (name) => normalized.get(String(name).toLowerCase()) ?? null };
}

function response({
  body = Readable.from([]), headerValues = {}, redirected = false, status = 200, url = '',
} = {}) {
  return { body, headers: headers(headerValues), redirected, status, url };
}

function attestedAdapter(overrides = {}) {
  return async ({ fetchImpl, target, init }) => ({
    response: await fetchImpl(target, init),
    peerVerification: CONNECT_TIME_PEER_VERIFICATION,
    ...overrides,
  });
}

function configuredAuthorityAdapter({ target }) {
  if (new URL(target).origin !== EXPECTED_ORIGIN) throw new Error('not configured');
  return { expectedOrigin: EXPECTED_ORIGIN };
}

function executor({
  authorityAdapter = configuredAuthorityAdapter,
  fetchImpl = async () => response(),
  operationOverrides,
  operations = { [SINK_ID]: operation(operationOverrides) },
  transportAdapter = attestedAdapter(),
} = {}) {
  return createOutboundHttpExecutor({ authorityAdapter, fetchImpl, operations, transportAdapter });
}

async function perform(client, {
  admitOptions, requestOptions, sinkId = SINK_ID, target = TARGET,
} = {}) {
  const receipt = await client.admitTarget(sinkId, target, admitOptions);
  return client.request(receipt, requestOptions);
}

function expectCode(code) {
  return (error) => {
    assert(error instanceof OutboundHttpError);
    assert.equal(error.code, code);
    return true;
  };
}

test('uses a closed operation registry and runs authority admission before dispatch', async () => {
  const events = [];
  const client = executor({
    authorityAdapter: ({ authoritySource, sinkId, target }) => {
      events.push(`admit:${sinkId}`);
      assert.equal(authoritySource, 'configured');
      assert.equal(target, TARGET);
      return { expectedOrigin: EXPECTED_ORIGIN };
    },
    transportAdapter: async ({ fetchImpl, target, init }) => {
      events.push('dispatch');
      return {
        response: await fetchImpl(target, init),
        peerVerification: CONNECT_TIME_PEER_VERIFICATION,
      };
    },
  });
  const managed = await perform(client);
  await managed.cancel();
  assert.deepEqual(events, [`admit:${SINK_ID}`, 'dispatch']);

  await assert.rejects(
    client.admitTarget('core.chat.unknown', TARGET),
    expectCode(OUTBOUND_ERROR_CODES.OPERATION_UNKNOWN)
  );
  assert.throws(
    () => createOutboundHttpExecutor({
      authorityAdapter: configuredAuthorityAdapter,
      operations: { [SINK_ID]: { ...operation(), extra: true } },
      transportAdapter: attestedAdapter(),
    }),
    expectCode(OUTBOUND_ERROR_CODES.POLICY_INVALID)
  );
});

test('mints opaque, executor-bound, single-use receipts and rejects lookalikes', async () => {
  const first = executor();
  const second = executor();
  const receipt = await first.admitTarget(SINK_ID, TARGET);
  assert.deepEqual(Object.keys(receipt), []);
  assert.equal(Object.isFrozen(receipt), true);

  for (const lookalike of [
    {}, Object.freeze(Object.create(null)),
    { expectedOrigin: EXPECTED_ORIGIN, sinkId: SINK_ID, target: TARGET },
  ]) {
    await assert.rejects(first.request(lookalike), expectCode(OUTBOUND_ERROR_CODES.ADMISSION_INVALID));
  }
  await assert.rejects(second.request(receipt), expectCode(OUTBOUND_ERROR_CODES.ADMISSION_INVALID));
  const managed = await first.request(receipt);
  await managed.cancel();
  await assert.rejects(first.request(receipt), expectCode(OUTBOUND_ERROR_CODES.ADMISSION_INVALID));
});

test('does not accept caller-authored policy or origin fields at request time', async () => {
  for (const unsafeOptions of [
    { expectedOrigin: EXPECTED_ORIGIN },
    { admittedTarget: { expectedOrigin: EXPECTED_ORIGIN } },
    { policy: operation() },
  ]) {
    const client = executor();
    const receipt = await client.admitTarget(SINK_ID, TARGET);
    await assert.rejects(client.request(receipt, unsafeOptions), expectCode(OUTBOUND_ERROR_CODES.POLICY_INVALID));
  }
});

test('rejects non-HTTP, fragment, credential, and non-admitted authorities before dispatch', async () => {
  let dispatches = 0;
  const client = executor({
    transportAdapter: async () => { dispatches += 1; throw new Error('must not dispatch'); },
  });
  for (const target of [
    'https://model.internal:11434/api/chat',
    'file:///etc/passwd',
    `${TARGET}#fragment`,
    'http://operator:password@model.internal:11434/api/chat',
  ]) {
    await assert.rejects(client.admitTarget(SINK_ID, target), expectCode(OUTBOUND_ERROR_CODES.TARGET_REJECTED));
  }
  assert.equal(dispatches, 0);
});

test('keeps raw targets, credentials, adapter errors, and JSON fragments out of errors', async () => {
  const secret = 'do-not-expose-this-password';
  const rawTarget = `http://operator:${secret}@model.internal:11434/private?token=${secret}`;
  let caught;
  try { await executor().admitTarget(SINK_ID, rawTarget); } catch (error) { caught = error; }
  assert(caught instanceof OutboundHttpError);
  assert.equal(caught.code, OUTBOUND_ERROR_CODES.TARGET_REJECTED);
  assert.doesNotMatch(`${caught}\n${caught.stack}\n${JSON.stringify(caught)}`, /do-not-expose-this-password|operator:|private\?token/);

  const failingTransport = executor({
    transportAdapter: async () => { throw new Error(`connect failed for ${rawTarget}`); },
  });
  await assert.rejects(perform(failingTransport), (error) => {
    assert.equal(error.code, OUTBOUND_ERROR_CODES.REQUEST_FAILED);
    assert.doesNotMatch(`${error}\n${error.stack}\n${JSON.stringify(error)}`, new RegExp(secret));
    assert.equal('cause' in error, false);
    return true;
  });

  const invalidJson = executor({
    fetchImpl: async () => response({ body: Readable.from([`{"${secret}":`]) }),
  });
  const managed = await perform(invalidJson);
  await assert.rejects(managed.json(), (error) => {
    assert.equal(error.code, OUTBOUND_ERROR_CODES.INVALID_JSON);
    assert.doesNotMatch(`${error}\n${error.stack}`, new RegExp(secret));
    return true;
  });
});

test('forces manual redirects, owns the signal, and strips transport overrides', async () => {
  const caller = new AbortController();
  let observed;
  const client = executor({
    fetchImpl: async (target, init) => {
      observed = { target, init };
      return response({ body: Readable.from(['ok']) });
    },
  });
  const managed = await perform(client, {
    requestOptions: {
      agent: {}, dispatcher: {}, method: 'POST', redirect: 'follow', signal: caller.signal,
    },
  });
  assert.equal(await managed.text(), 'ok');
  assert.equal(observed.target, TARGET);
  assert.equal(observed.init.method, 'POST');
  assert.equal(observed.init.redirect, 'manual');
  assert(observed.init.signal instanceof AbortSignal);
  assert.notEqual(observed.init.signal, caller.signal);
  assert.equal('agent' in observed.init, false);
  assert.equal('dispatcher' in observed.init, false);
});

test('rejects caller-controlled authority, forwarding, and hop-by-hop headers', async () => {
  let dispatches = 0;
  const client = executor({
    transportAdapter: async () => {
      dispatches += 1;
      throw new Error('must not dispatch');
    },
  });
  for (const unsafeHeaders of [
    { Host: 'other.internal' },
    { ':authority': 'other.internal' },
    { Connection: 'keep-alive' },
    { 'Proxy-Authorization': 'Basic hidden' },
    { 'Transfer-Encoding': 'chunked' },
    { Upgrade: 'websocket' },
    { 'X-Forwarded-Host': 'other.internal' },
  ]) {
    const receipt = await client.admitTarget(SINK_ID, TARGET);
    await assert.rejects(
      client.request(receipt, { headers: unsafeHeaders }),
      expectCode(OUTBOUND_ERROR_CODES.POLICY_INVALID)
    );
  }
  assert.equal(dispatches, 0);
});

test('owns Content-Length and sends the admitted URL authority on the wire', async () => {
  let observedHost;
  let observedLength;
  const server = http.createServer((request, response_) => {
    observedHost = request.headers.host;
    observedLength = request.headers['content-length'];
    request.resume();
    request.on('end', () => {
      response_.writeHead(200, { 'content-type': 'text/plain' });
      response_.end('ok');
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });

  try {
    const { port } = server.address();
    const expectedOrigin = `http://127.0.0.1:${port}`;
    const target = `${expectedOrigin}/authority-proof`;
    const client = createOutboundHttpExecutor({
      authorityAdapter: () => ({ expectedOrigin }),
      fetchImpl: (requestTarget, init) => new Promise((resolve, reject) => {
        const request = http.request(requestTarget, {
          headers: init.headers,
          method: init.method,
          signal: init.signal,
        }, (upstream) => resolve({
          body: upstream,
          headers: upstream.headers,
          redirected: false,
          status: upstream.statusCode,
          url: requestTarget,
        }));
        request.once('error', reject);
        request.end(init.body);
      }),
      operations: { [SINK_ID]: operation() },
      transportAdapter: attestedAdapter(),
    });
    const managed = await perform(client, {
      requestOptions: {
        body: 'hello',
        headers: { 'content-length': '5', 'x-purpose': 'authority-test' },
        method: 'POST',
      },
      target,
    });
    assert.equal(await managed.text(), 'ok');
    assert.equal(observedHost, `127.0.0.1:${port}`);
    assert.equal(observedLength, '5');
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('measures request bodies and rejects oversize, malformed, or mismatched lengths before dispatch', async () => {
  const observedBodies = [];
  const client = executor({
    operationOverrides: { maxRequestBytes: 5 },
    fetchImpl: async (_target, init) => { observedBodies.push(init.body); return response(); },
  });
  const accepted = await perform(client, {
    requestOptions: { body: 'hello', headers: { 'content-length': '5' }, method: 'POST' },
  });
  await accepted.cancel();
  assert.deepEqual(observedBodies, ['hello']);

  for (const [requestOptions, code] of [
    [{ body: Buffer.from('longer'), method: 'POST' }, OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE],
    [{ body: new Uint8Array([1, 2, 3]), headers: [['Content-Length', '2']], method: 'POST' }, OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH],
    [{ body: 'hello', headers: { 'content-length': 'not-a-number' }, method: 'POST' }, OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH],
  ]) {
    const receipt = await client.admitTarget(SINK_ID, TARGET);
    await assert.rejects(client.request(receipt, requestOptions), expectCode(code));
  }
  assert.equal(observedBodies.length, 1);
});

test('snapshots Blob bodies through trusted intrinsics and fails closed on unbounded bodies', async () => {
  let dispatches = 0;
  let observedInit;
  const client = executor({
    operationOverrides: { maxRequestBytes: 3 },
    fetchImpl: async (_target, init) => {
      dispatches += 1;
      observedInit = init;
      return response();
    },
  });
  const acceptedBlob = new Blob(['abc'], { type: 'text/plain' });
  Object.defineProperties(acceptedBlob, {
    arrayBuffer: { value: async () => new ArrayBuffer(0) },
    size: { value: 0 },
    stream: {
      value: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('attacker-controlled'));
          controller.close();
        },
      }),
    },
  });
  const accepted = await perform(client, {
    requestOptions: { body: acceptedBlob, headers: { 'content-length': '3' }, method: 'POST' },
  });
  await accepted.cancel();
  assert(Buffer.isBuffer(observedInit.body));
  assert.equal(observedInit.body.toString(), 'abc');
  assert.equal(observedInit.headers['content-length'], '3');
  assert.equal(observedInit.headers['content-type'], 'text/plain');

  for (const body of [
    Readable.from(['abc']),
    new ReadableStream({ start(controller) { controller.close(); } }),
    new URLSearchParams({ key: 'value' }),
    new FormData(),
  ]) {
    const receipt = await client.admitTarget(SINK_ID, TARGET);
    await assert.rejects(
      client.request(receipt, { body, headers: { 'content-length': '0' }, method: 'POST' }),
      expectCode(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED)
    );
  }
  assert.equal(dispatches, 1);
});

test('a forged Blob cannot send bytes under a zero-byte cap and declared zero length', async () => {
  let dispatches = 0;
  const forged = new Blob(['hidden-bytes']);
  Object.defineProperties(forged, {
    arrayBuffer: { value: async () => new ArrayBuffer(0) },
    size: { value: 0 },
    stream: {
      value: () => new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hidden-bytes'));
          controller.close();
        },
      }),
    },
  });
  const client = executor({
    operationOverrides: { maxRequestBytes: 0 },
    transportAdapter: async () => {
      dispatches += 1;
      throw new Error('must not dispatch');
    },
  });
  const receipt = await client.admitTarget(SINK_ID, TARGET);
  await assert.rejects(
    client.request(receipt, {
      body: forged,
      headers: { 'content-length': '0' },
      method: 'POST',
    }),
    expectCode(OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE)
  );
  assert.equal(dispatches, 0);
});

test('snapshots mutable binary request bodies before asynchronous dispatch', async (t) => {
  const backing = new ArrayBuffer(1, { maxByteLength: 1024 });
  if (typeof backing.resize !== 'function') {
    t.skip('Resizable ArrayBuffer is unavailable in this Node runtime');
    return;
  }
  const source = new Uint8Array(backing);
  source[0] = 65;
  let releaseTransport;
  const transportGate = new Promise((resolve) => { releaseTransport = resolve; });
  let observed;
  const client = executor({
    operationOverrides: { maxRequestBytes: 1 },
    transportAdapter: async ({ init }) => {
      await transportGate;
      observed = init;
      return {
        response: response(),
        peerVerification: CONNECT_TIME_PEER_VERIFICATION,
      };
    },
  });
  const receipt = await client.admitTarget(SINK_ID, TARGET);
  const pending = client.request(receipt, { body: source, method: 'POST' });
  backing.resize(1024);
  source.fill(90);
  releaseTransport();
  const managed = await pending;
  await managed.cancel();
  assert(Buffer.isBuffer(observed.body));
  assert.equal(observed.body.byteLength, 1);
  assert.equal(observed.body[0], 65);
  assert.equal(observed.headers['content-length'], '1');
});

test('requires authority admission and explicit connect-time peer attestation', async () => {
  const noAuthority = createOutboundHttpExecutor({
    fetchImpl: async () => response(),
    operations: { [SINK_ID]: operation() },
    transportAdapter: attestedAdapter(),
  });
  await assert.rejects(noAuthority.admitTarget(SINK_ID, TARGET), expectCode(OUTBOUND_ERROR_CODES.AUTHORITY_ADAPTER_REQUIRED));

  const noTransport = executor({ transportAdapter: null });
  const noTransportReceipt = await noTransport.admitTarget(SINK_ID, TARGET);
  await assert.rejects(noTransport.request(noTransportReceipt), expectCode(OUTBOUND_ERROR_CODES.TRANSPORT_ADAPTER_REQUIRED));

  let cancellations = 0;
  const unattested = executor({
    fetchImpl: async () => response({ body: { async cancel() { cancellations += 1; } } }),
    transportAdapter: async ({ fetchImpl, target, init }) => ({ response: await fetchImpl(target, init) }),
  });
  await assert.rejects(perform(unattested), expectCode(OUTBOUND_ERROR_CODES.PEER_UNVERIFIED));
  assert.equal(cancellations, 1);
});

test('rejects redirects, Location responses, and changed final response URLs', async () => {
  for (const upstream of [
    response({ status: 302, headerValues: { location: 'http://metadata.invalid/private' } }),
    response({ status: 200, redirected: true, url: TARGET }),
    response({ status: 200, url: 'http://other.internal:11434/api/chat' }),
    response({ status: 200, url: `${EXPECTED_ORIGIN}/different-path` }),
  ]) {
    let cancellations = 0;
    upstream.body = { async cancel() { cancellations += 1; } };
    await assert.rejects(perform(executor({ fetchImpl: async () => upstream })), (error) => {
      assert.equal(error.code, OUTBOUND_ERROR_CODES.REDIRECT_REJECTED);
      assert.doesNotMatch(`${error}\n${error.stack}`, /metadata\.invalid|private/);
      return true;
    });
    assert.equal(cancellations, 1);
  }
});

test('rejects oversized Content-Length before reading and malformed lengths as invalid', async () => {
  let reads = 0;
  let cancellations = 0;
  const body = {
    getReader() { reads += 1; return { read: async () => ({ done: true }), cancel: async () => {} }; },
    async cancel() { cancellations += 1; },
  };
  const oversized = executor({
    operationOverrides: { maxResponseBytes: 8 },
    fetchImpl: async () => response({ body, headerValues: { 'content-length': '9' } }),
  });
  await assert.rejects(perform(oversized), expectCode(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE));
  assert.equal(reads, 0);
  assert.equal(cancellations, 1);

  const malformed = executor({
    fetchImpl: async () => response({ headerValues: { 'content-length': '12, 13' } }),
  });
  await assert.rejects(perform(malformed), expectCode(OUTBOUND_ERROR_CODES.INVALID_RESPONSE));
});

test('bounded JSON, text, and byte readers support node-fetch async bodies', async () => {
  const payloads = [
    ['{"ready":', 'true}'], ['hello ', 'world'],
    [Buffer.from([0, 1]), Buffer.from([2, 3])],
  ];
  const client = executor({
    fetchImpl: async () => response({ body: Readable.from(payloads.shift()) }),
  });
  const jsonResponse = await perform(client);
  assert.deepEqual(await readBoundedJson(jsonResponse), { ready: true });
  assert.equal(jsonResponse.bodyUsed, true);
  assert.equal(await readBoundedText(await perform(client)), 'hello world');
  assert.deepEqual(await readBoundedBytes(await perform(client)), Buffer.from([0, 1, 2, 3]));
});

test('discard helper drains without buffering while preserving response limits and single use', async () => {
  let emitted = 0;
  async function* chunks() {
    for (const value of ['one', 'two', 'three']) {
      emitted += 1;
      yield value;
    }
  }
  const accepted = await perform(executor({
    operationOverrides: { maxResponseBytes: 11 },
    fetchImpl: async () => response({ body: chunks() }),
  }));
  assert.equal(await discardBoundedResponse(accepted), undefined);
  assert.equal(emitted, 3);
  assert.equal(accepted.bodyUsed, true);
  await assert.rejects(
    discardBoundedResponse(accepted),
    expectCode(OUTBOUND_ERROR_CODES.BODY_ALREADY_USED)
  );

  const oversized = await perform(executor({
    operationOverrides: { maxResponseBytes: 5 },
    fetchImpl: async () => response({ body: Readable.from(['123', '456']) }),
  }));
  await assert.rejects(
    discardBoundedResponse(oversized),
    expectCode(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE)
  );
});

test('native ReadableStream bodies enforce their streamed byte cap', async () => {
  let cancellations = 0;
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('1234'));
      controller.enqueue(new TextEncoder().encode('5678'));
    },
    cancel() { cancellations += 1; },
  });
  const client = executor({
    operationOverrides: { maxResponseBytes: 7 },
    fetchImpl: async () => response({ body }),
  });
  await assert.rejects((await perform(client)).bytes(), expectCode(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE));
  assert.equal(cancellations, 1);
});

test('streaming yields incrementally without buffering and enforces its cap', async () => {
  let releaseSecond;
  const secondReady = new Promise((resolve) => { releaseSecond = resolve; });
  let secondRequested = false;
  async function* chunks() {
    yield Buffer.from('first');
    secondRequested = true;
    await secondReady;
    yield Buffer.from('second');
  }
  const client = executor({
    operationOverrides: { maxResponseBytes: 10 },
    fetchImpl: async () => response({ body: chunks() }),
  });
  const iterator = (await perform(client)).stream()[Symbol.asyncIterator]();
  assert.equal((await iterator.next()).value.toString(), 'first');
  assert.equal(secondRequested, false);
  const pendingSecond = iterator.next();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondRequested, true);
  releaseSecond();
  await assert.rejects(pendingSecond, expectCode(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE));
});

test('breaking streamed consumption cancels node and native bodies exactly once', async () => {
  let nodeReturns = 0;
  const nodeBody = {
    [Symbol.asyncIterator]() {
      let emitted = false;
      return {
        async next() {
          if (!emitted) { emitted = true; return { done: false, value: Buffer.from('one') }; }
          return new Promise(() => {});
        },
        async return() { nodeReturns += 1; return { done: true }; },
      };
    },
  };
  let webCancels = 0;
  const webBody = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); },
    cancel() { webCancels += 1; },
  });
  const bodies = [nodeBody, webBody];
  const client = executor({ fetchImpl: async () => response({ body: bodies.shift() }) });
  for (let index = 0; index < 2; index += 1) {
    for await (const chunk of (await perform(client)).stream()) {
      assert(chunk.byteLength > 0);
      break;
    }
  }
  assert.equal(nodeReturns, 1);
  assert.equal(webCancels, 1);
});

test('one deadline covers admission, headers, and native or node body lifetime', async () => {
  const admissionStall = executor({
    operationOverrides: { deadlineMs: 30 },
    authorityAdapter: async () => new Promise(() => {}),
  });
  await assert.rejects(admissionStall.admitTarget(SINK_ID, TARGET), expectCode(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED));

  const headerStall = executor({
    operationOverrides: { deadlineMs: 30 },
    transportAdapter: async () => new Promise(() => {}),
  });
  await assert.rejects(perform(headerStall), expectCode(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED));

  let nodeReturns = 0;
  const nodeBody = {
    [Symbol.asyncIterator]() {
      return {
        next: async () => new Promise(() => {}),
        return: async () => { nodeReturns += 1; return { done: true }; },
      };
    },
  };
  let webCancels = 0;
  const webBody = new ReadableStream({
    pull() { return new Promise(() => {}); },
    cancel() { webCancels += 1; },
  });
  for (const body of [nodeBody, webBody]) {
    const client = executor({
      operationOverrides: { deadlineMs: 30 },
      fetchImpl: async () => response({ body }),
    });
    await assert.rejects((await perform(client)).bytes(), expectCode(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED));
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nodeReturns, 1);
  assert.equal(webCancels, 1);
});

test('caller signals compose and listeners/timers are cleaned exactly', async () => {
  const controller = new AbortController();
  let additions = 0;
  let removals = 0;
  const countedSignal = {
    get aborted() { return controller.signal.aborted; },
    addEventListener(...args) { additions += 1; controller.signal.addEventListener(...args); },
    removeEventListener(...args) { removals += 1; controller.signal.removeEventListener(...args); },
  };
  const completed = await perform(executor({
    operationOverrides: { deadlineMs: 50 },
    fetchImpl: async () => response({ body: Readable.from(['done']) }),
  }), {
    admitOptions: { signal: countedSignal },
    requestOptions: { signal: countedSignal },
  });
  assert.equal(await completed.text(), 'done');
  assert.equal(additions, 1);
  assert.equal(removals, 1);
  await new Promise((resolve) => setTimeout(resolve, 70));
  assert.equal(removals, 1);

  const abortController = new AbortController();
  const stalled = executor({
    fetchImpl: async () => response({
      body: new ReadableStream({ pull() { return new Promise(() => {}); } }),
    }),
  });
  const managed = await perform(stalled, { requestOptions: { signal: abortController.signal } });
  const read = managed.bytes();
  abortController.abort(`secret reason for ${TARGET}`);
  await assert.rejects(read, (error) => {
    assert.equal(error.code, OUTBOUND_ERROR_CODES.CALLER_ABORTED);
    assert.doesNotMatch(`${error}\n${error.stack}`, /secret reason|model\.internal/);
    return true;
  });
});

test('expired receipts and already-aborted callers never reach transport', async () => {
  let dispatches = 0;
  const client = executor({
    operationOverrides: { deadlineMs: 30 },
    transportAdapter: async () => {
      dispatches += 1;
      return { response: response(), peerVerification: CONNECT_TIME_PEER_VERIFICATION };
    },
  });
  const expired = await client.admitTarget(SINK_ID, TARGET);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(client.request(expired), expectCode(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED));

  const controller = new AbortController();
  controller.abort('private caller reason');
  await assert.rejects(
    client.admitTarget(SINK_ID, TARGET, { signal: controller.signal }),
    expectCode(OUTBOUND_ERROR_CODES.CALLER_ABORTED)
  );
  assert.equal(dispatches, 0);
});

test('late responses from abort-ignoring transports are cancelled exactly once', async () => {
  let resolveDispatch;
  let cancellations = 0;
  const client = executor({
    operationOverrides: { deadlineMs: 30 },
    transportAdapter: () => new Promise((resolve) => { resolveDispatch = resolve; }),
  });
  await assert.rejects(perform(client), expectCode(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED));
  resolveDispatch({
    response: response({ body: { async cancel() { cancellations += 1; } } }),
    peerVerification: CONNECT_TIME_PEER_VERIFICATION,
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancellations, 1);
});

test('body selection is single-use and stream cancellation is idempotent', async () => {
  let cancellations = 0;
  const managed = await perform(executor({
    fetchImpl: async () => response({ body: { async cancel() { cancellations += 1; } } }),
  }));
  const stream = managed.stream();
  assert.throws(() => { managed.bodyUsed = false; }, TypeError);
  assert.equal(managed.bodyUsed, true);
  assert.throws(
    () => Object.defineProperty(managed, 'bodyUsed', { value: false }),
    TypeError
  );
  assert.throws(() => managed.stream(), expectCode(OUTBOUND_ERROR_CODES.BODY_ALREADY_USED));
  await stream.cancel();
  await stream.cancel();
  assert.equal(cancellations, 1);
});

test('managed responses expose no raw source, lifecycle, policy, or body iterator capability', async () => {
  const managed = await perform(executor({
    operationOverrides: { deadlineMs: 30, maxResponseBytes: 0 },
    fetchImpl: async () => response({ body: Readable.from(['private']) }),
  }));

  assert.deepEqual(
    Reflect.ownKeys(managed).sort(),
    ['bodyUsed', 'headers', 'ok', 'status']
  );
  for (const property of ['_source', '_lifecycle', '_policy', '_iterateBody', '_claimBody']) {
    assert.equal(property in managed, false);
    assert.equal(managed[property], undefined);
  }
  assert.equal(Object.isFrozen(managed), true);
  assert.equal(Object.isFrozen(Object.getPrototypeOf(managed)), true);
  assert.throws(
    () => new managed.constructor({}, {}),
    expectCode(OUTBOUND_ERROR_CODES.INVALID_RESPONSE)
  );
  await assert.rejects(
    readBoundedBytes(Object.create(Object.getPrototypeOf(managed))),
    expectCode(OUTBOUND_ERROR_CODES.INVALID_RESPONSE)
  );

  await new Promise((resolve) => setTimeout(resolve, 50));
  await assert.rejects(
    managed.bytes(),
    expectCode(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED)
  );
  assert.equal(managed.bodyUsed, false);

  const capped = await perform(executor({
    operationOverrides: { maxResponseBytes: 0 },
    fetchImpl: async () => response({ body: Readable.from(['private']) }),
  }));
  await assert.rejects(capped.bytes(), expectCode(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE));
  assert.equal(capped.bodyUsed, true);
  assert.throws(() => capped.stream(), expectCode(OUTBOUND_ERROR_CODES.BODY_ALREADY_USED));
});

test('cannot split the aggregate response byte cap across concurrent readers', async () => {
  const managed = await perform(executor({
    operationOverrides: { maxResponseBytes: 3 },
    fetchImpl: async () => response({ body: Readable.from(['1', '2', '3', '4', '5', '6']) }),
  }));
  const first = managed.stream()[Symbol.asyncIterator]();
  assert.equal((await first.next()).value.toString(), '1');
  assert.throws(() => { managed.bodyUsed = false; }, TypeError);
  assert.throws(() => managed.stream(), expectCode(OUTBOUND_ERROR_CODES.BODY_ALREADY_USED));
  assert.equal((await first.next()).value.toString(), '2');
  assert.equal((await first.next()).value.toString(), '3');
  await assert.rejects(first.next(), expectCode(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE));
});

test('public error projection is stable and strips internal metadata', () => {
  const error = new OutboundHttpError(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE, {
    sinkId: SINK_ID, status: 413,
  });
  assert.deepEqual(toPublicOutboundError(error), {
    code: OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE,
    message: 'The outbound response exceeded its byte limit.',
  });
  assert.deepEqual(toPublicOutboundError(new Error('secret raw URL')), {
    code: OUTBOUND_ERROR_CODES.REQUEST_FAILED,
    message: 'The outbound request failed.',
  });
});
