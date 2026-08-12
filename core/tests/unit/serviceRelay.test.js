'use strict';

const { EventEmitter } = require('events');
const {
  NEVER_FORWARD,
  CORRELATION_HEADER,
  buildRelayHeaders,
  relayAbortSignal,
  pipeEventStream,
} = require('../../src/helpers/serviceRelay');

/** Minimal Express-request stand-in: `get()` plus close events. */
function fakeRequest(headers = {}, extra = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = new EventEmitter();
  req.headers = lower;
  req.get = (name) => lower[String(name).toLowerCase()];
  return Object.assign(req, extra);
}

describe('service-edge relay headers (0520)', () => {
  test('forwards only the allowlisted request headers', () => {
    const headers = buildRelayHeaders(fakeRequest({
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
      'User-Agent': 'hermes/1.0',
      'X-Random-Vendor-Header': 'should-not-cross',
    }));

    expect(headers['content-type']).toBe('application/json');
    expect(headers.accept).toBe('text/event-stream');
    expect(headers['user-agent']).toBe('hermes/1.0');
    // Allowlist, not blocklist: an unknown header is simply not relayed.
    expect(headers['x-random-vendor-header']).toBeUndefined();
  });

  test.each(NEVER_FORWARD)('never forwards %s', (header) => {
    const headers = buildRelayHeaders(fakeRequest({ [header]: 'super-secret-value' }));
    const values = Object.values(headers).map(String);
    expect(headers[header]).toBeUndefined();
    expect(values).not.toContain('super-secret-value');
  });

  test('a caller cannot spoof an injected credential', () => {
    // Injection happens after filtering, so an inbound header of the same name
    // loses. Otherwise a caller could pre-set Authorization and have it survive.
    const headers = buildRelayHeaders(
      fakeRequest({ Authorization: 'Bearer attacker-token' }),
      { inject: { Authorization: 'Bearer server-side-key' } }
    );
    expect(headers.authorization).toBe('Bearer server-side-key');
  });

  test('propagates correlation so a trace survives the hop', () => {
    const fromHeader = buildRelayHeaders(fakeRequest({ [CORRELATION_HEADER]: 'corr-from-header' }));
    expect(fromHeader[CORRELATION_HEADER]).toBe('corr-from-header');

    // The middleware-assigned id is used when the caller sent none.
    const fromReq = buildRelayHeaders(fakeRequest({}, { correlationId: 'corr-from-middleware' }));
    expect(fromReq[CORRELATION_HEADER]).toBe('corr-from-middleware');
  });

  test('always sets a content type, and null injections are skipped', () => {
    expect(buildRelayHeaders(fakeRequest({}))['content-type']).toBe('application/json');
    const headers = buildRelayHeaders(fakeRequest({}), { inject: { 'X-Optional': null } });
    expect(headers['x-optional']).toBeUndefined();
  });
});

describe('service-edge relay cancellation (0520)', () => {
  test('aborts when the client disconnects', () => {
    const req = fakeRequest();
    const relay = relayAbortSignal(req, { timeoutMs: 60_000 });

    expect(relay.signal.aborted).toBe(false);
    req.emit('close');

    expect(relay.signal.aborted).toBe(true);
    expect(relay.reason).toBe('client_disconnect');
    relay.dispose();
  });

  test('aborts on a bounded timeout', async () => {
    const relay = relayAbortSignal(fakeRequest(), { timeoutMs: 5 });
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(relay.signal.aborted).toBe(true);
    expect(relay.reason).toBe('timeout');
    relay.dispose();
  });

  test('dispose stops the timer from firing later', async () => {
    const relay = relayAbortSignal(fakeRequest(), { timeoutMs: 10 });
    relay.dispose();
    await new Promise((resolve) => setTimeout(resolve, 30));

    // A completed request must not abort retroactively, and its timer must not
    // hold the event loop open.
    expect(relay.signal.aborted).toBe(false);
  });

  test('an SSE client disconnect aborts the upstream request, not just the local pipe', async () => {
    // The acceptance criterion for 0520. Destroying the local Readable wrapper
    // leaves the upstream fetch running with nobody reading it — on a model host
    // that is a generation burning capacity for a client that already left.
    const req = fakeRequest();
    const res = new EventEmitter();
    res.setHeader = jest.fn();
    res.write = jest.fn();
    res.end = jest.fn();
    res.on = EventEmitter.prototype.on.bind(res);
    res.emit = EventEmitter.prototype.emit.bind(res);
    res.once = EventEmitter.prototype.once.bind(res);
    res.write.bind = () => {};

    let cancelled = false;
    const body = new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: hello\n\n')); },
      cancel() { cancelled = true; },
    });

    const relay = relayAbortSignal(req, { timeoutMs: 60_000 });
    const upstream = pipeEventStream({ body }, req, res, relay);

    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream');
    // Proxies in front of Core must not buffer an event stream.
    expect(res.setHeader).toHaveBeenCalledWith('X-Accel-Buffering', 'no');
    expect(relay.signal.aborted).toBe(false);

    req.emit('close');
    await new Promise((resolve) => setImmediate(resolve));

    expect(relay.signal.aborted).toBe(true);
    expect(relay.reason).toBe('client_disconnect');
    expect(upstream.destroyed).toBe(true);
    expect(cancelled).toBe(true);
  });

  test('the first abort reason wins and repeat aborts are harmless', () => {
    const req = fakeRequest();
    const relay = relayAbortSignal(req, { timeoutMs: 60_000 });

    req.emit('close');
    relay.abort('timeout');

    expect(relay.reason).toBe('client_disconnect');
    expect(relay.signal.aborted).toBe(true);
    relay.dispose();
  });
});
