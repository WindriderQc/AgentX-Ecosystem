const PlanningItem = require('../../models/PlanningItem');
const PlanningAutomationState = require('../../models/PlanningAutomationState');
const PipelineTask = require('../../models/PipelineTask');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');
const Alert = require('../../models/Alert');
const planningAutomationService = require('../../src/services/planningAutomationService');

describe('planningAutomationService', () => {
  beforeEach(async () => {
    await Promise.all([
      PlanningItem.deleteMany({}),
      PlanningAutomationState.deleteMany({}),
      PipelineTask.deleteMany({}),
      ClusterScheduleEntry.deleteMany({}),
      Alert.deleteMany({})
    ]);
  });

  test('previews pipeline metrics without writing observation state', async () => {
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Pipeline completion',
      progress: {
        mode: 'metric',
        metric: {
          baseline: 0,
          current: 0,
          target: 100,
          adapter: 'pipeline.done_ratio',
          params: {}
        }
      }
    });
    await PipelineTask.create([
      { pipelineId: '0501', title: 'Done', status: 'done', planningItemIds: [item._id] },
      { pipelineId: '0502', title: 'Open', status: 'in_progress', planningItemIds: [item._id] }
    ]);

    const result = await planningAutomationService.reconcile({
      dryRun: true,
      force: true,
      itemId: String(item._id),
      now: new Date('2026-07-16T16:00:00.000Z')
    });

    expect(result.totals).toMatchObject({ scanned: 1, updated: 1, failed: 0 });
    expect(result.groups[0].results[0]).toMatchObject({ status: 'preview', value: 50 });
    const unchanged = await PlanningItem.findById(item._id);
    expect(unchanged.progress.metric.current).toBe(0);
    expect(unchanged.progress.metric.observation.observedAt).toBeNull();
    expect(await PlanningAutomationState.countDocuments({})).toBe(0);
  });

  test('applies observations and records a released successful lease', async () => {
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Pipeline progress',
      progress: {
        mode: 'metric',
        metric: {
          baseline: 0,
          current: 0,
          target: 100,
          adapter: 'pipeline.progress',
          params: {}
        }
      }
    });
    await PipelineTask.create({
      pipelineId: '0503',
      title: 'In review',
      status: 'review',
      planningItemIds: [item._id]
    });

    await planningAutomationService.reconcile({
      dryRun: false,
      force: true,
      itemId: String(item._id),
      owner: 'test-owner',
      now: new Date('2026-07-16T16:00:00.000Z')
    });

    const updated = await PlanningItem.findById(item._id);
    expect(updated.progress.metric.current).toBe(85);
    expect(updated.progress.metric.observation).toMatchObject({
      value: 85,
      status: 'fresh',
      error: ''
    });
    const state = await PlanningAutomationState.findOne({ collector: 'metric:pipeline.progress' });
    expect(state.status).toBe('ok');
    expect(state.error).toBe('');
    expect(state.lease.owner).toBe('');
    expect(state.lastSuccessAt).toBeTruthy();

    const replay = await planningAutomationService.reconcile({
      dryRun: false,
      force: false,
      itemId: String(item._id),
      owner: 'test-owner',
      now: new Date('2026-07-16T16:01:00.000Z')
    });
    expect(replay.totals).toMatchObject({ updated: 0, skipped: 1, failed: 0 });
  });

  test('preserves the last good value when a source becomes unavailable', async () => {
    const observedAt = new Date('2026-07-16T12:00:00.000Z');
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Schedule trust',
      progress: {
        mode: 'metric',
        metric: {
          baseline: 0,
          current: 80,
          target: 100,
          adapter: 'schedule.success_rate',
          params: {},
          observation: { value: 80, observedAt, status: 'fresh', error: '' }
        }
      }
    });

    const result = await planningAutomationService.reconcile({
      dryRun: false,
      force: true,
      itemId: String(item._id),
      owner: 'test-owner',
      now: new Date('2026-07-16T16:00:00.000Z')
    });

    expect(result.totals.failed).toBe(1);
    const updated = await PlanningItem.findById(item._id);
    expect(updated.progress.metric.current).toBe(80);
    expect(updated.progress.metric.observation.value).toBe(80);
    expect(updated.progress.metric.observation.observedAt).toEqual(observedAt);
    expect(updated.progress.metric.observation.status).toBe('degraded');
    expect(updated.progress.metric.observation.error).toContain('No linked schedules');
  });

  test('counts stale active alerts with allowlisted filters', async () => {
    const now = new Date('2026-07-16T16:00:00.000Z');
    await Alert.create([
      {
        severity: 'critical',
        title: 'Old alert',
        message: 'Old',
        fingerprint: 'old-alert',
        status: 'active',
        lastOccurrence: new Date(now.getTime() - 90000000)
      },
      {
        severity: 'critical',
        title: 'Fresh alert',
        message: 'Fresh',
        fingerprint: 'fresh-alert',
        status: 'active',
        lastOccurrence: new Date(now.getTime() - 1000)
      }
    ]);
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Stale alerts',
      progress: {
        mode: 'metric',
        metric: {
          baseline: 2,
          current: 2,
          target: 0,
          direction: 'decrease',
          adapter: 'alerts.active_count',
          params: { status: 'active', severity: 'critical', olderThanMs: 86400000 }
        }
      }
    });

    const result = await planningAutomationService.reconcile({
      dryRun: true,
      force: true,
      itemId: String(item._id),
      now
    });
    expect(result.groups[0].results[0].value).toBe(1);
  });

  test('derives schedule success and respects an existing collector lease', async () => {
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Schedule success',
      scheduleRefs: [
        { source: 'openclaw', sourceId: 'oc-one', label: 'One' },
        { source: 'openclaw', sourceId: 'oc-two', label: 'Two' }
      ],
      progress: {
        mode: 'metric',
        metric: {
          baseline: 0,
          current: 0,
          target: 100,
          adapter: 'schedule.success_rate',
          params: {}
        }
      }
    });
    await ClusterScheduleEntry.create([
      {
        source: 'openclaw',
        sourceId: 'oc-one',
        name: 'One',
        taskType: 'monitoring',
        schedule: { type: 'cron', cron: '0 1 * * *' },
        metadata: { lastStatus: 'ok', consecutiveErrors: 0 }
      },
      {
        source: 'openclaw',
        sourceId: 'oc-two',
        name: 'Two',
        taskType: 'monitoring',
        schedule: { type: 'cron', cron: '0 2 * * *' },
        metadata: { lastStatus: 'error', consecutiveErrors: 2 }
      }
    ]);
    await PlanningAutomationState.create({
      collector: 'metric:schedule.success_rate',
      lease: {
        owner: 'other-owner',
        expiresAt: new Date('2026-07-16T17:00:00.000Z')
      },
      status: 'running'
    });

    const leased = await planningAutomationService.reconcile({
      dryRun: false,
      force: true,
      itemId: String(item._id),
      owner: 'test-owner',
      now: new Date('2026-07-16T16:00:00.000Z')
    });
    expect(leased.groups[0]).toMatchObject({
      status: 'leased',
      statistics: { skipped: 1 }
    });

    const preview = await planningAutomationService.reconcile({
      dryRun: true,
      force: true,
      itemId: String(item._id),
      now: new Date('2026-07-16T16:00:00.000Z')
    });
    expect(preview.groups[0].results[0].value).toBe(50);
  });
});
