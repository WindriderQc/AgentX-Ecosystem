/**
 * 0156 — inferenceHealthService.getJudgeDriftSnapshot unit tests.
 *
 * Confirms the nerve-center "Judge drift" row gracefully degrades when
 * benchmark is unreachable and passes through the payload otherwise.
 */

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockGetJudgeDrift = jest.fn();
jest.mock('../../src/services/benchmarkServiceClient', () => ({
  getBenchmarkServiceClient: () => ({ getJudgeDrift: mockGetJudgeDrift })
}));

// Avoid side effects from peer modules pulled by inferenceHealthService.
jest.mock('../../src/services/hostGate', () => ({ stats: () => ({ enabled: false, entries: {} }) }));
jest.mock('../../src/services/ollamaWatchdogService', () => ({ getStats: () => ({ isRunning: false }) }));
jest.mock('../../src/services/hostPreferenceService', () => ({ listBenchmarkClaims: async () => [] }));

const { getJudgeDriftSnapshot, summarizeDriftRows } = require('../../src/services/inferenceHealthService');

describe('inferenceHealthService.getJudgeDriftSnapshot', () => {
  beforeEach(() => {
    mockGetJudgeDrift.mockReset();
  });

  it('passes through a drift payload from the benchmark client', async () => {
    const payload = {
      overall_status: 'warning',
      baseline_label: 'v1-2026Q1',
      thresholds: { drop_pp: 0.15, absolute_floor: 0.5, min_sample_size: 5 },
      categories: [
        { category: 'coding', current_rho: 0.7, baseline_rho: 0.82, drop_pp: 0.12, sample_size: 30, status: 'warning', reasons: [], triggered: false }
      ]
    };
    mockGetJudgeDrift.mockResolvedValue(payload);

    const snap = await getJudgeDriftSnapshot();
    expect(snap).toEqual(payload);
  });

  it('returns unavailable when benchmark returns null (unreachable)', async () => {
    mockGetJudgeDrift.mockResolvedValue(null);

    const snap = await getJudgeDriftSnapshot();
    expect(snap).toMatchObject({ unavailable: true, reason: 'benchmark-unreachable' });
  });

  it('returns unavailable with error message when the client throws', async () => {
    mockGetJudgeDrift.mockRejectedValue(new Error('boom'));

    const snap = await getJudgeDriftSnapshot();
    expect(snap).toMatchObject({ unavailable: true, error: 'boom' });
  });
});

describe('inferenceHealthService num_ctx evidence', () => {
  it('treats host preference pins as compliant policy instead of drift', () => {
    const result = summarizeDriftRows([
      { _id: { caller: 'chat', source: 'host_preference_pin' }, count: 8 },
      { _id: { caller: 'benchmark', source: 'caller' }, count: 2 },
      { _id: { caller: 'proxy', source: 'fallback' }, count: 1 },
      { _id: { caller: 'embedding', source: 'n/a' }, count: 20 },
      { _id: { caller: 'chat', source: null }, count: 3 },
    ], 900000, '2026-08-30T12:00:00.000Z');

    expect(result.totals).toEqual({
      total: 11, modelfile: 0, caller: 2, pinned: 8, resolved: 1, unknown: 3, na: 20,
    });
    expect(result).toEqual(expect.objectContaining({ hasSamples: true, driftPct: 9.1 }));
  });

  it('returns unknown drift instead of a healthy zero for an empty denominator', () => {
    const result = summarizeDriftRows([
      { _id: { caller: 'embedding', source: 'n/a' }, count: 5 },
    ]);
    expect(result).toEqual(expect.objectContaining({ hasSamples: false, driftPct: null }));
  });
});
