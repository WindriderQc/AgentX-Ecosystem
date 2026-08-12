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

const { getJudgeDriftSnapshot } = require('../../src/services/inferenceHealthService');

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
