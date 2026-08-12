'use strict';

const mockGetAll = jest.fn();
jest.mock('../../src/services/hostPreferenceService', () => ({ getAll: (...a) => mockGetAll(...a) }));
jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const logger = require('../../config/logger');
const {
  buildCandidates,
  evaluateShadow,
  scheduleShadowEvaluation,
} = require('../../src/services/routing/shadowEvaluation');

const ORIGINAL = process.env.ROUTE_RESOLVER_SHADOW;
const enable = () => { process.env.ROUTE_RESOLVER_SHADOW = 'true'; };
const disable = () => { delete process.env.ROUTE_RESOLVER_SHADOW; };

beforeEach(() => { jest.clearAllMocks(); disable(); });
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.ROUTE_RESOLVER_SHADOW;
  else process.env.ROUTE_RESOLVER_SHADOW = ORIGINAL;
});

const PREFS = [
  {
    hostUrl: 'http://192.0.2.199:11434', hostKey: 'primary', status: 'ready',
    live: { online: true }, loadedModels: ['m1'],
    pinnedModels: [{ model: 'm1', contextSize: 83558 }],
  },
  {
    hostUrl: 'http://192.0.2.12:11434', hostKey: 'secondary', status: 'ready',
    live: { online: true }, loadedModels: [], pinnedModels: [],
  },
];

/** Let the setImmediate callback and its awaits run. */
const flush = () => new Promise((resolve) => setImmediate(() => setImmediate(resolve)));

describe('the flag is genuinely inert when off (0522)', () => {
  test('evaluateShadow does no work at all', async () => {
    expect(await evaluateShadow({ model: 'm1', hostUrl: 'http://x' }, {})).toBeNull();
    // Not even the Mongo read happens — the flag gates before any I/O.
    expect(mockGetAll).not.toHaveBeenCalled();
  });

  test('scheduleShadowEvaluation schedules nothing', async () => {
    scheduleShadowEvaluation({ model: 'm1', hostUrl: 'http://x' }, {});
    await flush();
    expect(mockGetAll).not.toHaveBeenCalled();
    expect(logger.info).not.toHaveBeenCalled();
  });
});

describe('candidate construction records facts, never guesses (0522)', () => {
  test('absent facts stay undefined so the resolver treats them as unknown', () => {
    const [primary, secondary] = buildCandidates(PREFS, 'm1', 'http://192.0.2.199:11434');

    // The resolver excludes only on explicit disqualification. A `false` here
    // would filter out a host that is merely unprofiled.
    // A resident model is positive evidence that the artifact is installed.
    expect(primary.artifact.installed).toBe(true);
    expect(primary.artifact.qualified).toBeUndefined();
    expect(primary.host.freeVramMiB).toBeUndefined();

    expect(primary.artifact.resident).toBe(true);
    expect(primary.artifact.pinned).toBe(true);
    expect(primary.artifact.maxContextTokens).toBe(83558);
    expect(secondary.artifact.resident).toBeUndefined();
    expect(secondary.artifact.installed).toBeUndefined();
  });

  test('a benchmark claim is carried through so the resolver can exclude it', () => {
    const [claimed] = buildCandidates(
      [{ ...PREFS[0], status: 'benchmarking' }], 'm1', 'http://x'
    );
    expect(claimed.host.benchmarkClaimed).toBe(true);

    const [byBatch] = buildCandidates(
      [{ ...PREFS[0], benchmarkClaim: { batchId: 'b1' } }], 'm1', 'http://x'
    );
    expect(byBatch.host.benchmarkClaimed).toBe(true);
  });

  test('marks which tuple production actually used', () => {
    const built = buildCandidates(PREFS, 'm1', 'http://192.0.2.12:11434');
    expect(built.map((c) => c.wasActual)).toEqual([false, true]);
  });

  test('preferences without a host url are skipped', () => {
    expect(buildCandidates([{ hostKey: 'ghost' }], 'm1', 'http://x')).toEqual([]);
  });

  test('missing liveness stays unknown instead of becoming online', () => {
    const [candidate] = buildCandidates([
      { hostUrl: 'http://unknown:11434', hostKey: 'secondary', pinnedModels: [], loadedModels: [] },
    ], 'm1', 'http://x');
    expect(candidate.host.online).toBeUndefined();
  });
});

describe('comparison records (0522)', () => {
  test('agreement is recorded as a match', async () => {
    enable();
    mockGetAll.mockResolvedValue(PREFS);
    const record = await evaluateShadow(
      { model: 'm1', hostUrl: 'http://192.0.2.199:11434' }, {}
    );
    // Primary is resident + pinned, so the resolver should agree with production.
    expect(record.match).toBe(true);
    expect(record.shadowSelected.hostUrl).toBe('http://192.0.2.199:11434');
  });

  test('a disagreement is reason-coded rather than reduced to a boolean', async () => {
    enable();
    mockGetAll.mockResolvedValue(PREFS);
    const record = await evaluateShadow(
      { model: 'm1', hostUrl: 'http://192.0.2.12:11434' }, {}
    );
    expect(record.match).toBe(false);
    expect(record.mismatches).toContain('host_mismatch');
  });

  test('no candidates yields no sample, which is not agreement', async () => {
    enable();
    mockGetAll.mockResolvedValue([]);
    // null means "we have no comparison", never "they agreed" — the same
    // unknown-vs-zero distinction as 0529 and 0538.
    expect(await evaluateShadow({ model: 'm1', hostUrl: 'http://x' }, {})).toBeNull();
  });
});

describe('a diagnostic must never break production (0522)', () => {
  test('a failing host-preference read is swallowed', async () => {
    enable();
    mockGetAll.mockRejectedValue(new Error('mongo unreachable'));
    expect(await evaluateShadow({ model: 'm1', hostUrl: 'http://x' }, {})).toBeNull();
    expect(logger.debug).toHaveBeenCalledWith(
      'Shadow route evaluation failed (non-fatal)',
      expect.objectContaining({ error: 'mongo unreachable' })
    );
  });

  test('scheduleShadowEvaluation never rejects, even when everything fails', async () => {
    enable();
    mockGetAll.mockRejectedValue(new Error('boom'));
    // Synchronous return, deferred work, no unhandled rejection.
    expect(() => scheduleShadowEvaluation({ model: 'm1', hostUrl: 'http://x' }, {})).not.toThrow();
    await flush();
  });

  test('a throwing result handler is contained', async () => {
    enable();
    mockGetAll.mockResolvedValue(PREFS);
    scheduleShadowEvaluation(
      { model: 'm1', hostUrl: 'http://192.0.2.199:11434' }, {},
      () => { throw new Error('consumer blew up'); }
    );
    await flush();
    // Nothing escapes; the request has long since been answered.
  });

  test('runs deferred, not inline — the caller returns before any I/O', () => {
    enable();
    mockGetAll.mockResolvedValue(PREFS);
    scheduleShadowEvaluation({ model: 'm1', hostUrl: 'http://x' }, {});
    // This is the property that keeps the shadow off the request's critical
    // path: nothing has happened yet when the caller regains control.
    expect(mockGetAll).not.toHaveBeenCalled();
  });
});
