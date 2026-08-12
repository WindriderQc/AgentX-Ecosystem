const {
  countByStatus,
  derivePlanningHealth
} = require('../../src/services/planningHealthService');

describe('planningHealthService', () => {
  test('produces an explicit pipeline progress breakdown', () => {
    expect(countByStatus([
      { status: 'done' },
      { status: 'review' },
      { status: 'blocked' }
    ])).toEqual({
      total: 3,
      queued: 0,
      in_progress: 0,
      review: 1,
      blocked: 1,
      done: 1
    });
  });

  test('derives risk reasons without changing planning status', () => {
    const item = {
      type: 'milestone',
      status: 'active',
      isOverdue: false,
      dates: { targetAt: '2026-07-20T00:00:00.000Z' },
      progress: { mode: 'tasks', metric: {} },
      computedProgress: 0
    };
    const health = derivePlanningHealth(item, {
      now: new Date('2026-07-16T16:00:00.000Z'),
      tasks: [
        { status: 'blocked' },
        { status: 'in_progress', heartbeatAt: '2026-07-16T10:00:00.000Z' }
      ],
      schedules: [{ metadata: { consecutiveErrors: 2 } }]
    });

    expect(item.status).toBe('active');
    expect(health.level).toBe('blocked');
    expect(health.reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining([
      'blocked_tasks',
      'stale_task_heartbeat',
      'schedule_errors'
    ]));
    expect(health.progress.tasks).toMatchObject({ total: 2, blocked: 1, in_progress: 1 });
  });

  test('flags due-soon commitments with no progress', () => {
    const health = derivePlanningHealth({
      type: 'milestone',
      status: 'planned',
      isOverdue: false,
      dates: { targetAt: '2026-07-20T00:00:00.000Z' },
      progress: { mode: 'manual', manual: 0, metric: {} },
      computedProgress: 0
    }, {
      now: new Date('2026-07-16T16:00:00.000Z')
    });
    expect(health.level).toBe('at_risk');
    expect(health.reasons[0].code).toBe('due_soon_no_progress');
  });

  test('surfaces stale and degraded metric observations without mutating status', () => {
    const item = {
      type: 'outcome',
      status: 'active',
      isOverdue: false,
      dates: {},
      computedProgress: 50,
      progress: {
        mode: 'metric',
        metric: {
          adapter: 'alerts.active_count',
          staleAfterMs: 3600000,
          observation: {
            value: 4,
            observedAt: '2026-07-16T10:00:00.000Z',
            status: 'fresh'
          }
        }
      }
    };
    const health = derivePlanningHealth(item, {
      now: new Date('2026-07-16T16:00:00.000Z')
    });
    expect(item.status).toBe('active');
    expect(health.level).toBe('at_risk');
    expect(health.reasons[0].code).toBe('metric_stale');

    item.progress.metric.observation.status = 'degraded';
    const degraded = derivePlanningHealth(item, {
      now: new Date('2026-07-16T16:00:00.000Z')
    });
    expect(degraded.reasons[0].code).toBe('metric_degraded');
  });
});
