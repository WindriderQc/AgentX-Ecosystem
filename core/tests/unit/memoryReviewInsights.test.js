const { summarizeRuns } = require('../../src/services/memoryReview/insightsService');

describe('Dreaming Review insights read model', () => {
  test('current health uses the latest contribution per runtime, not historical notice totals', () => {
    const runs = [
      {
        runId: 'partial-new', status: 'collecting', createdAt: new Date('2026-08-12T03:15:00Z'),
        collectors: [{ runtime: 'claude-code', submittedAt: new Date('2026-08-12T03:15:00Z'), errors: [], drift: [] }],
        candidates: [], summary: {},
      },
      {
        runId: 'complete-new', status: 'completed', createdAt: new Date('2026-08-12T03:30:00Z'), completedAt: new Date('2026-08-12T03:31:00Z'),
        collectors: [
          { runtime: 'openclaw', submittedAt: new Date('2026-08-12T03:30:00Z'), errors: [], drift: ['legacy owner marker absent'] },
          { runtime: 'hermes', submittedAt: new Date('2026-08-12T03:30:00Z'), errors: [], drift: [] },
        ],
        candidates: [], summary: { noEligibleObservations: true, modelCalled: false },
      },
      {
        runId: 'historical', status: 'completed', createdAt: new Date('2026-08-11T03:30:00Z'),
        collectors: [{ runtime: 'openclaw', errors: ['old failure'], drift: ['old drift', 'old drift'] }],
        candidates: [], summary: {},
      },
    ];

    const result = summarizeRuns(runs, 30, new Date('2026-08-12T03:45:00Z'));
    expect(result.health).toEqual(expect.objectContaining({ state: 'healthy', errors: 0, advisories: 1, collecting: true }));
    expect(result.latest.runId).toBe('complete-new');
    expect(result.runtimes.find((runtime) => runtime.runtime === 'openclaw')).toEqual(expect.objectContaining({
      currentErrors: 0, currentAdvisories: 1, health: 'healthy',
    }));
  });

  test('an overdue reconciliation is attention without inventing a collector error', () => {
    const result = summarizeRuns([{
      runId: 'late-handoff', status: 'collecting', createdAt: new Date('2026-08-12T03:15:00Z'),
      collectors: [{ runtime: 'claude-code', errors: [], drift: [] }], candidates: [], summary: {},
    }], 30, new Date('2026-08-12T05:30:00Z'));
    expect(result.health).toEqual(expect.objectContaining({
      state: 'attention', errors: 0, overdue: 1, collecting: true,
    }));
    expect(result.health.activeRun.reconciliation).toEqual(expect.objectContaining({
      overdue: true, missingRuntimes: ['codex', 'openclaw', 'hermes'],
    }));
    expect(result.safeDigest).toContain('1 overdue reconciliation(s)');
  });

  test('safe digest and distributions never include candidate statements', () => {
    const result = summarizeRuns([{
      runId: 'one', status: 'ready_for_review', createdAt: new Date(), collectors: [], summary: { modelCalled: true },
      candidates: [{
        statement: 'Private durable wording', type: 'preference', status: 'proposed',
        target: { kind: 'shared_fact', topic: 'communication' }, evidence: [], recurrence: {}, conflicts: [], risk: {},
      }],
    }], 30);
    expect(result.totals.pending).toBe(1);
    expect(result.distributions.candidateTypes.preference).toBe(1);
    expect(JSON.stringify(result)).not.toContain('Private durable wording');
  });

  test('prefers the newest reviewable run and reports an empty system as waiting', () => {
    const result = summarizeRuns([
      { runId: 'older-complete', status: 'completed', createdAt: new Date('2026-08-11T03:30:00Z'), collectors: [], candidates: [] },
      { runId: 'newer-ready', status: 'ready_for_review', createdAt: new Date('2026-08-12T03:30:00Z'), collectors: [], candidates: [] },
    ], 30);
    expect(result.latest.runId).toBe('newer-ready');
    expect(summarizeRuns([], 30).health.state).toBe('waiting');
  });
});
