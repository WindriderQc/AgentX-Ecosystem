/**
 * Task 0277 — Buddy /emit cross-container token auth.
 *
 * Proves the POST /api/buddy/emit trust boundary:
 *   - loopback caller is always allowed (unchanged behavior);
 *   - when BUDDY_EMIT_TOKEN is set, a non-loopback caller with a matching
 *     X-Buddy-Emit-Token is allowed;
 *   - a non-loopback caller with a missing/wrong token is rejected (403);
 *   - when BUDDY_EMIT_TOKEN is unset, a non-loopback caller is rejected (403)
 *     regardless of any header it sends (no silent widening).
 *
 * The buddy event bus is mocked so we assert only on the route's guard
 * decision (emit called or not) without spinning up the SSE fan-out.
 */

const express = require('express');
const request = require('supertest');

// Mock the event bus: emit() becomes a spy, bus is a no-op emitter so the
// route's `require` does not pull in real listeners.
jest.mock('../../src/services/buddyEvents', () => {
  const { EventEmitter } = require('events');
  return { bus: new EventEmitter(), emit: jest.fn(), classifyIntent: jest.fn(() => 'suggesting') };
});
const { emit: emitBuddyEvent } = require('../../src/services/buddyEvents');

const buddyRoutes = require('../../routes/buddy');

/**
 * Build an app that mounts the buddy router behind a middleware which forces
 * req.ip to a caller-controlled value. This lets us exercise loopback vs
 * non-loopback deterministically without relying on the socket address or
 * trust-proxy semantics. The guard reads `req.ip` first, so overriding it is
 * faithful to the production code path.
 */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    const forcedIp = app.locals.forcedIp || '127.0.0.1';
    Object.defineProperty(req, 'ip', { value: forcedIp, configurable: true });
    next();
  });
  app.use('/api/buddy', buddyRoutes);
  return app;
}

const VALID_BODY = { type: 'judge_start', class: 'benchmark', summary: 'hi', surfaceScope: 'benchmark' };

describe('POST /api/buddy/emit — cross-container token auth (task 0277)', () => {
  const savedToken = process.env.BUDDY_EMIT_TOKEN;
  let app;
  let server;
  let agent;

  beforeAll(async () => {
    app = buildApp();
    server = await new Promise((resolve, reject) => {
      const listener = app.listen(0, '127.0.0.1', () => resolve(listener));
      listener.on('error', reject);
    });
    agent = request(server);
  });

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.BUDDY_EMIT_TOKEN;
    app.locals.forcedIp = '127.0.0.1';
  });

  afterAll(async () => {
    if (savedToken === undefined) delete process.env.BUDDY_EMIT_TOKEN;
    else process.env.BUDDY_EMIT_TOKEN = savedToken;
    if (server) {
      await new Promise((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  function postEmitAs(forcedIp) {
    app.locals.forcedIp = forcedIp;
    return agent.post('/api/buddy/emit');
  }

  it('allows a loopback caller (token unset)', async () => {
    const res = await postEmitAs('127.0.0.1').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(emitBuddyEvent).toHaveBeenCalledTimes(1);
  });

  it('allows a loopback caller via the IPv6-mapped form', async () => {
    const res = await postEmitAs('::ffff:127.0.0.1').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(emitBuddyEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-loopback caller when the token is unset (403, no widening)', async () => {
    const res = await postEmitAs('172.18.0.5')
      // even sending a header must not help when the server has no token set
      .set('X-Buddy-Emit-Token', 'anything')
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(emitBuddyEvent).not.toHaveBeenCalled();
  });

  it('allows a non-loopback caller with a valid token', async () => {
    process.env.BUDDY_EMIT_TOKEN = 's3cret-token';
    const res = await postEmitAs('172.18.0.5')
      .set('X-Buddy-Emit-Token', 's3cret-token')
      .send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(emitBuddyEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects a non-loopback caller with a wrong token (403)', async () => {
    process.env.BUDDY_EMIT_TOKEN = 's3cret-token';
    const res = await postEmitAs('172.18.0.5')
      .set('X-Buddy-Emit-Token', 'wrong-token')
      .send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(emitBuddyEvent).not.toHaveBeenCalled();
  });

  it('rejects a non-loopback caller with a missing token (403)', async () => {
    process.env.BUDDY_EMIT_TOKEN = 's3cret-token';
    const res = await postEmitAs('172.18.0.5').send(VALID_BODY);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('forbidden');
    expect(emitBuddyEvent).not.toHaveBeenCalled();
  });

  it('still allows a loopback caller even when a token is set (loopback OR token)', async () => {
    process.env.BUDDY_EMIT_TOKEN = 's3cret-token';
    const res = await postEmitAs('127.0.0.1').send(VALID_BODY);
    expect(res.status).toBe(200);
    expect(emitBuddyEvent).toHaveBeenCalledTimes(1);
  });

  it('rejects a valid-token caller with an invalid payload (400) — guard runs before validation only for auth', async () => {
    process.env.BUDDY_EMIT_TOKEN = 's3cret-token';
    const res = await postEmitAs('172.18.0.5')
      .set('X-Buddy-Emit-Token', 's3cret-token')
      .send({ type: 'judge_start' }); // missing class + summary
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
    expect(emitBuddyEvent).not.toHaveBeenCalled();
  });
});
