const { buildReviewFromDashboard } = require('../../src/services/planningReviewService');

describe('planningReviewService', () => {
  test('projects Planning pulse, proof, risks, decisions, metrics, and next actions', () => {
    const now = new Date('2026-07-16T20:00:00.000Z');
    const since = new Date('2026-07-09T20:00:00.000Z');
    const dashboard = {
      summary: { unlinkedTasks: 2 },
      items: [
        {
          id: 'goal-1',
          type: 'outcome',
          title: 'Alert lifecycle is trustworthy',
          status: 'blocked',
          priority: 'critical',
          owner: '',
          computedProgress: 35,
          dates: { targetAt: '2026-07-15T04:00:00.000Z' },
          isOverdue: true,
          evidence: [{
            kind: 'alert',
            label: 'Recovery verified',
            ref: 'alert:123',
            addedAt: '2026-07-15T18:00:00.000Z'
          }],
          health: {
            level: 'blocked',
            reasons: [
              { code: 'target_overdue', severity: 'critical', label: 'Target date is overdue' },
              { code: 'metric_degraded', severity: 'warning', label: 'Metric refresh is degraded' }
            ]
          }
        },
        {
          id: 'decision-1',
          type: 'decision',
          title: 'Use one continuous incident',
          status: 'proposed',
          priority: 'high',
          owner: 'Core',
          decision: {
            choice: 'One incident per fingerprint',
            rationale: 'Avoid recurrence churn'
          },
          health: { level: 'on_track', reasons: [] }
        }
      ]
    };
    const automation = {
      collectors: [{
        collector: 'metric:alerts.active_count',
        status: 'degraded',
        lastSuccessAt: '2026-07-15T17:00:00.000Z',
        error: 'source unavailable'
      }],
      items: [{
        itemId: 'goal-1',
        key: 'goal:lifecycle',
        title: 'Alert lifecycle is trustworthy',
        adapter: 'alerts.active_count',
        value: 10,
        status: 'degraded',
        observedAt: '2026-07-15T17:00:00.000Z',
        error: 'source unavailable'
      }]
    };

    const review = buildReviewFromDashboard(dashboard, { automation, since, now });

    expect(review.pulse).toEqual(expect.objectContaining({
      committed: 1,
      blocked: 1,
      overdue: 1,
      proposedDecisions: 1,
      evidenceAdded: 1
    }));
    expect(review.wins[0]).toEqual(expect.objectContaining({
      kind: 'alert',
      label: 'Recovery verified'
    }));
    expect(review.risks[0].reasons.map((reason) => reason.code)).toContain('target_overdue');
    expect(review.staleOrOverdue).toHaveLength(1);
    expect(review.decisions[0]).toEqual(expect.objectContaining({
      status: 'proposed',
      choice: 'One incident per fingerprint'
    }));
    expect(review.metrics[0]).toEqual(expect.objectContaining({
      adapter: 'alerts.active_count',
      value: 10,
      status: 'degraded'
    }));
    expect(review.automation.status).toBe('degraded');
    expect(review.nextActions.map((action) => action.code)).toEqual(expect.arrayContaining([
      'unblock',
      'refresh_metrics',
      'decide',
      'assign_owner',
      'link_delivery'
    ]));
    expect(review.summary).toContain('1 blocked');
  });

  test('returns a calm, bounded review when Planning is empty', () => {
    const review = buildReviewFromDashboard(
      { summary: { unlinkedTasks: 0 }, items: [] },
      {
        automation: { collectors: [], items: [] },
        since: new Date('2026-07-09T20:00:00.000Z'),
        now: new Date('2026-07-16T20:00:00.000Z')
      }
    );

    expect(review.pulse.total).toBe(0);
    expect(review.risks).toEqual([]);
    expect(review.metrics).toEqual([]);
    expect(review.nextActions).toEqual([{
      code: 'none',
      count: 0,
      label: 'No Planning intervention required'
    }]);
    expect(review.automation.status).toBe('ok');
  });
});
