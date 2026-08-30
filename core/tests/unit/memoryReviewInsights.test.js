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
          { runtime: 'agentx', submittedAt: new Date('2026-08-12T03:30:00Z'), errors: [], drift: ['legacy owner marker absent'] },
          { runtime: 'codex', submittedAt: new Date('2026-08-12T03:30:00Z'), errors: [], drift: [] },
        ],
        candidates: [], summary: { noEligibleObservations: true, modelCalled: false },
      },
      {
        runId: 'historical', status: 'completed', createdAt: new Date('2026-08-11T03:30:00Z'),
        collectors: [{ runtime: 'agentx', errors: ['old failure'], drift: ['old drift', 'old drift'] }],
        candidates: [], summary: {},
      },
    ];

    const result = summarizeRuns(runs, 30, new Date('2026-08-12T03:45:00Z'));
    expect(result.health).toEqual(expect.objectContaining({
      state: 'attention', errors: 0, advisories: 1, collecting: true,
      missing: 1, missingRuntimes: ['external'],
    }));
    expect(result.latest.runId).toBe('complete-new');
    expect(result.runtimes.find((runtime) => runtime.runtime === 'agentx')).toEqual(expect.objectContaining({
      currentErrors: 0, currentAdvisories: 1, health: 'healthy',
    }));
    expect(result.quality.evidence).toEqual(expect.objectContaining({ state: 'partial' }));
    expect(result.safeDigest).toContain('1 collector(s) not observed');
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
      overdue: true, missingRuntimes: ['agentx', 'codex', 'external'],
    }));
    expect(result.safeDigest).toContain('1 overdue reconciliation(s)');
  });

  test('a previously seen collector becomes stale instead of remaining healthy forever', () => {
    const result = summarizeRuns([{
      runId: 'old-quiet-run', status: 'completed', createdAt: new Date('2026-08-08T03:30:00Z'),
      collectors: [{ runtime: 'agentx', submittedAt: new Date('2026-08-08T03:31:00Z'), errors: [], drift: [] }],
      candidates: [], summary: { noEligibleObservations: true },
    }], 30, new Date('2026-08-12T03:45:00Z'));

    expect(result.health).toEqual(expect.objectContaining({
      state: 'attention', stale: 1, staleRuntimes: ['agentx'], errors: 0,
    }));
    expect(result.runtimes.find((runtime) => runtime.runtime === 'agentx')).toEqual(expect.objectContaining({
      health: 'stale', staleAfterMs: 48 * 60 * 60 * 1000,
    }));
    expect(result.safeDigest).toContain('1 stale collector(s)');
    expect(result.quality.metrics.modelSkips).toEqual(expect.objectContaining({
      value: null, lastValue: 1, denominator: 1, state: 'stale',
    }));
    expect(result.quality.metrics.filterRate).toEqual(expect.objectContaining({
      value: null, denominator: 0, state: 'insufficient',
    }));
  });

  test('publishes quality values only with fresh complete coverage and a real denominator', () => {
    const submittedAt = new Date('2026-08-12T03:30:00Z');
    const result = summarizeRuns([{
      runId: 'current-complete', status: 'completed', createdAt: submittedAt,
      collectors: [
        { runtime: 'agentx', submittedAt, sourceEventsSeen: 4, eligibleObservations: 3, rejectedObservations: 1, errors: [], drift: [] },
        { runtime: 'claude-code', submittedAt, sourceEventsSeen: 1, errors: [], drift: [] },
        { runtime: 'codex', submittedAt, sourceEventsSeen: 1, errors: [], drift: [] },
        { runtime: 'external', submittedAt, sourceEventsSeen: 1, errors: [], drift: [] },
      ],
      candidates: [
        { status: 'approved', recurrence: { independentRuntimes: 2 }, conflicts: [], risk: {} },
        { status: 'rejected', recurrence: { independentRuntimes: 1 }, conflicts: [], risk: {} },
      ],
      summary: { modelCalled: true },
    }], 30, new Date('2026-08-12T04:00:00Z'));

    expect(result.health).toEqual(expect.objectContaining({ state: 'healthy', missing: 0, stale: 0 }));
    expect(result.quality.evidence).toEqual(expect.objectContaining({ state: 'current' }));
    expect(result.quality.metrics.filterRate).toEqual(expect.objectContaining({ value: 25, denominator: 4, state: 'current' }));
    expect(result.quality.metrics.approvalPrecision).toEqual(expect.objectContaining({ value: 50, denominator: 2, state: 'current' }));
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
