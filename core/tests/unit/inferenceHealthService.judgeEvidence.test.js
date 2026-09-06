/**
 * Benchmark reachable versus judge usable: the Nerve Center judge row names
 * which one failed, and the functional judge readiness is reported beside
 * the HTTP status instead of being folded into "benchmark unreachable".
 */

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const mockClient = { getJudgeDrift: jest.fn(), getJudgeDriftEvidence: jest.fn(), getJudgeReadiness: jest.fn() };
jest.mock('../../src/services/benchmarkServiceClient', () => ({ getBenchmarkServiceClient: () => mockClient }));
jest.mock('../../src/services/hostGate', () => ({ stats: () => ({ enabled: false, entries: {} }) }));
jest.mock('../../src/services/ollamaWatchdogService', () => ({ getStats: () => ({ isRunning: false }) }));
jest.mock('../../src/services/hostPreferenceService', () => ({ listBenchmarkClaims: async () => [] }));

const {
  getJudgeDriftSnapshot,
  getJudgeReadinessSnapshot,
  getInferenceHealth
} = require('../../src/services/inferenceHealthService');

describe('judge evidence classification', () => {
  beforeEach(() => { Object.values(mockClient).forEach((fn) => fn.mockReset()); });

  it('distinguishes an unreachable service from a reachable one whose drift endpoint failed', async () => {
    mockClient.getJudgeDriftEvidence.mockResolvedValue({ unavailable: true, reason: 'benchmark-unreachable', httpStatus: null });
    expect(await getJudgeDriftSnapshot()).toEqual({ unavailable: true, reason: 'benchmark-unreachable', benchmarkReachable: false });

    mockClient.getJudgeDriftEvidence.mockResolvedValue({ unavailable: true, reason: 'benchmark-drift-error', httpStatus: 500 });
    expect(await getJudgeDriftSnapshot()).toEqual({ unavailable: true, reason: 'benchmark-drift-error', httpStatus: 500, benchmarkReachable: true });

    mockClient.getJudgeDriftEvidence.mockResolvedValue({ unavailable: true, reason: 'benchmark-drift-empty', httpStatus: null });
    expect(await getJudgeDriftSnapshot()).toMatchObject({ unavailable: true, reason: 'benchmark-drift-empty', benchmarkReachable: true });

    const payload = { overall_status: 'ok', categories: [] };
    mockClient.getJudgeDriftEvidence.mockResolvedValue({ unavailable: false, payload });
    expect(await getJudgeDriftSnapshot()).toBe(payload);
    expect(mockClient.getJudgeDrift).not.toHaveBeenCalled();
  });

  it('projects the functional judge readiness as its own fact', async () => {
    mockClient.getJudgeReadiness.mockResolvedValue({ unavailable: false, readiness: {
      ready: false, status: 'blocked', code: 'judge_host_unreachable', checked_at: '2026-09-05T12:00:00.000Z',
      configured_host_count: 2, ready_host_count: 0, summary: 'No configured judge host answered.',
      blockers: ['a', 'b', 'c', 'd', 'e', 'f']
    } });
    const snapshot = await getJudgeReadinessSnapshot();
    expect(snapshot).toMatchObject({
      unavailable: false, ready: false, status: 'blocked', code: 'judge_host_unreachable',
      readyHostCount: 0, configuredHostCount: 2, checkedAt: '2026-09-05T12:00:00.000Z'
    });
    expect(snapshot.blockers).toHaveLength(5);

    mockClient.getJudgeReadiness.mockResolvedValue({ unavailable: true, reason: 'benchmark-readiness-error', httpStatus: 503 });
    expect(await getJudgeReadinessSnapshot()).toEqual({ unavailable: true, reason: 'benchmark-readiness-error', httpStatus: 503, benchmarkReachable: true });
  });

  it('includes judge readiness in the inference health payload', async () => {
    mockClient.getJudgeDriftEvidence.mockResolvedValue({ unavailable: false, payload: { overall_status: 'ok' } });
    mockClient.getJudgeReadiness.mockResolvedValue({ unavailable: false, readiness: { ready: true, status: 'ready' } });
    const health = await getInferenceHealth();
    expect(health.judgeReadiness).toMatchObject({ unavailable: false, ready: true, status: 'ready' });
    expect(health.judgeDrift).toEqual({ overall_status: 'ok' });
  });
});
