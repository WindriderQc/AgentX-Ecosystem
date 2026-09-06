jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const mockFetch = jest.fn();
jest.mock('node-fetch', () => mockFetch);

const { BenchmarkServiceClient } = require('../../src/services/benchmarkServiceClient');

describe('BenchmarkServiceClient judge evidence classification', () => {
  let client;
  beforeEach(() => { client = new BenchmarkServiceClient(); mockFetch.mockReset(); });

  it('reports unreachable, error and empty drift evidence distinctly', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await client.getJudgeDriftEvidence()).toEqual({ unavailable: true, reason: 'benchmark-unreachable', httpStatus: null });

    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => '{"status":"error"}' });
    expect(await client.getJudgeDriftEvidence()).toEqual({ unavailable: true, reason: 'benchmark-drift-error', httpStatus: 500 });

    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: null }) });
    expect(await client.getJudgeDriftEvidence()).toEqual({ unavailable: true, reason: 'benchmark-drift-empty', httpStatus: null });

    mockFetch.mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ status: 'success', data: { overall_status: 'ok' } }) });
    expect(await client.getJudgeDriftEvidence()).toEqual({ unavailable: false, payload: { overall_status: 'ok' } });
  });

  it('reads judge readiness from the Benchmark contract', async () => {
    mockFetch.mockResolvedValue({
      ok: true, status: 200,
      text: async () => JSON.stringify({ status: 'success', data: { ready: false, status: 'blocked', code: 'judge_host_unreachable' } })
    });
    const evidence = await client.getJudgeReadiness();
    expect(evidence).toEqual({ unavailable: false, readiness: { ready: false, status: 'blocked', code: 'judge_host_unreachable' } });
    expect(new URL(mockFetch.mock.calls[0][0]).pathname).toBe('/api/benchmark/judge/readiness');

    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    expect(await client.getJudgeReadiness()).toEqual({ unavailable: true, reason: 'benchmark-unreachable', httpStatus: null });
  });
});
