const { summarizeRuns } = require('../../src/services/memoryReview/insightsService');

describe('Dreaming Review cadence facts', () => {
  test('a quiet latest run reports when evidence last arrived and when the next run is due', () => {
    const runs = [
      {
        runId: 'quiet-now', status: 'completed',
        createdAt: new Date('2026-09-04T03:30:00Z'), completedAt: new Date('2026-09-04T03:31:00Z'),
        collectors: [{ runtime: 'agentx', submittedAt: new Date('2026-09-04T03:30:00Z'), eligibleObservations: 0, errors: [], drift: [] }],
        candidates: [], summary: { noEligibleObservations: true, modelCalled: false },
      },
      {
        runId: 'had-evidence', status: 'completed',
        createdAt: new Date('2026-09-01T03:30:00Z'), completedAt: new Date('2026-09-01T03:32:00Z'),
        collectors: [{ runtime: 'agentx', submittedAt: new Date('2026-09-01T03:30:00Z'), eligibleObservations: 3, errors: [], drift: [] }],
        candidates: [], summary: {},
      },
    ];
    const now = new Date('2026-09-05T12:00:00Z');
    const result = summarizeRuns(runs, 30, now);
    expect(result.latest).toMatchObject({
      quiet: true,
      lastRunAt: '2026-09-04T03:31:00.000Z',
      lastSuccessfulRunAt: '2026-09-04T03:31:00.000Z',
      lastEligibleEvidenceAt: '2026-09-01T03:32:00.000Z',
      expectedWithinMs: 48 * 60 * 60 * 1000,
      nextDueAt: '2026-09-06T03:31:00.000Z',
      overdueRun: false,
    });
    expect(result.latest.ageMs).toBe(now.getTime() - new Date('2026-09-04T03:31:00Z').getTime());
  });

  test('facts stay null rather than "now" when nothing qualifies, and an old run is overdue', () => {
    const result = summarizeRuns([{
      runId: 'old', status: 'completed', createdAt: new Date('2026-08-20T03:30:00Z'),
      collectors: [{ runtime: 'agentx', eligibleObservations: 0, errors: [], drift: [] }],
      candidates: [], summary: { noEligibleObservations: true },
    }], 30, new Date('2026-09-05T12:00:00Z'));
    expect(result.latest).toMatchObject({ lastEligibleEvidenceAt: null, overdueRun: true });
    expect(summarizeRuns([], 30, new Date()).latest).toBeNull();
  });
});
