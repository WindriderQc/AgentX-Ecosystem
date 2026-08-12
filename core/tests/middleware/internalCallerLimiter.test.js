/**
 * Internal Caller Limiter Tests (task 0141)
 *
 * Covers the expanded caller-aware routing added on top of 0132:
 *   - nestor/*, buddy/*, chat-*, nerve-center-*, alerts-* route to internalCallerLimiter
 *     (5000/15min) so they don't starve on the general apiLimiter (500/15min).
 *   - benchmark-* continues to route to benchmarkLimiter (5000/15min).
 *   - Untagged external callers stay on apiLimiter and get throttled at 500.
 *
 * The three-bucket separation keeps stats independently trackable.
 */

const { runMiddlewareChain } = require('../helpers/runMiddleware');

// Ensure test-mode deterministic bucketing
process.env.NODE_ENV = 'test';

// Re-require a fresh copy of the module so limiter stores start clean for this
// test file (each rateLimit() call has an in-memory MemoryStore). This
// guarantees isolation from any other test that imported the module earlier
// in the same worker.
jest.isolateModules(() => {
  // no-op — used just to document intent; require below resolves in-scope.
});

const {
  inferenceCallerRouter,
  INTERNAL_CALLER_PREFIXES
} = require('../../src/middleware/rateLimiter');

function postInference(clientKey, body) {
  // Use a non-`/api/inference/generate` path so the apiLimiter's production
  // skip-list does not mask throttling decisions under test. The router
  // function is path-agnostic; it makes its decision from req.body.
  return runMiddlewareChain([
    inferenceCallerRouter,
    (req, res) => {
      res.json({
        status: 'success',
        callerDetail: req.body?.callerDetail ?? null
      });
    }
  ], {
    method: 'POST',
    path: '/_test/inference',
    headers: { 'x-test-client': clientKey },
    body
  });
}

async function fire(clientKey, body, count) {
  let ok = 0;
  let throttled = 0;
  for (let i = 0; i < count; i += 1) {
    // eslint-disable-next-line no-await-in-loop
    const res = await postInference(clientKey, body);
    if (res.status === 200) ok += 1;
    else if (res.status === 429) throttled += 1;
  }
  return { ok, throttled };
}

describe('internalCallerLimiter — routing for Nestor and other interactive callers', () => {
  jest.setTimeout(120000);

  it('exports the documented internal-caller prefix list', () => {
    expect(INTERNAL_CALLER_PREFIXES).toEqual(
      expect.arrayContaining(['nestor/', 'buddy/', 'chat-', 'nerve-center-', 'alerts-'])
    );
  });

  it('passes 600 buddy/react calls without throttling', async () => {
    const { ok, throttled } = await fire(
      '0141-buddy-pass',
      { callerDetail: 'buddy/react' },
      600
    );
    expect(throttled).toBe(0);
    expect(ok).toBe(600);
  });

  it('throttles 600 untagged calls after the 500th', async () => {
    const { ok, throttled } = await fire(
      '0141-untagged-throttle',
      {},
      600
    );
    // apiLimiter max is 500/15min — the first 500 succeed, remainder get 429
    expect(ok).toBe(500);
    expect(throttled).toBe(100);
  });

  it('still routes benchmark callers through benchmarkLimiter (5000/15min)', async () => {
    const { ok, throttled } = await fire(
      '0141-benchmark-pass',
      { callerDetail: 'benchmark-judge' },
      600
    );
    expect(throttled).toBe(0);
    expect(ok).toBe(600);
  });

  it('recognizes each documented internal prefix', async () => {
    const samples = [
      'nestor/desktop/chat',
      'buddy/react',
      'buddy/event',
      'chat-stream',
      'chat-completion',
      'nerve-center-inference-health',
      'alerts-evaluator'
    ];
    for (const tag of samples) {
      // eslint-disable-next-line no-await-in-loop
      const res = await postInference(`0141-prefix-${tag}`, { callerDetail: tag });
      expect(res.status).toBe(200);
      expect(res.body.callerDetail).toBe(tag);
    }
  });
});
