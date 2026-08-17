const PlanningItem = require('../../models/PlanningItem');
const PlanningAutomationState = require('../../models/PlanningAutomationState');
const PipelineTask = require('../../models/PipelineTask');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');
const Alert = require('../../models/Alert');
const planningEvidenceService = require('../../src/services/planningEvidenceService');

describe('planningEvidenceService', () => {
  beforeEach(async () => {
    await Promise.all([
      PlanningItem.deleteMany({}),
      PlanningAutomationState.deleteMany({}),
      PipelineTask.deleteMany({}),
      ClusterScheduleEntry.deleteMany({}),
      Alert.deleteMany({})
    ]);
  });

  test('previews, applies, and idempotently replays linked pipeline evidence', async () => {
    const now = new Date(Date.now() + 5000);
    const feedbackAt = new Date(now.getTime() - 60000);
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Pipeline proof',
      automation: {
        evidenceBindings: [{
          source: 'pipeline',
          params: { events: ['feedback', 'review'] }
        }]
      }
    });
    await PipelineTask.create({
      pipelineId: '0601',
      title: 'Evidence task',
      status: 'review',
      planningItemIds: [item._id],
      feedback: [{
        at: feedbackAt,
        by: 'codex',
        text: 'Tests and smoke passed. token=supersecret ```diff\n+private patch\n```'
      }]
    });

    const preview = await planningEvidenceService.reconcile({
      dryRun: true,
      force: true,
      itemId: String(item._id),
      now
    });

    expect(preview.totals).toMatchObject({ updated: 2, failed: 0 });
    expect(preview.groups[0].results.map((row) => row.status)).toEqual(['preview', 'preview']);
    expect((await PlanningItem.findById(item._id)).evidence).toHaveLength(0);
    expect(await PlanningAutomationState.countDocuments({})).toBe(0);

    const applied = await planningEvidenceService.reconcile({
      dryRun: false,
      force: true,
      itemId: String(item._id),
      owner: 'evidence-test',
      now
    });
    expect(applied.totals).toMatchObject({ updated: 2, failed: 0 });

    const updated = await PlanningItem.findById(item._id);
    expect(updated.evidence).toHaveLength(2);
    expect(updated.evidence.map((row) => row.externalKey)).toEqual(expect.arrayContaining([
      expect.stringContaining('pipeline:0601:feedback'),
      expect.stringContaining('pipeline:0601:status:review')
    ]));
    expect(updated.evidence.every((row) => row.source === 'pipeline')).toBe(true);
    const feedbackEvidence = updated.evidence.find((row) => row.externalKey.includes(':feedback:'));
    expect(feedbackEvidence.note).toContain('token=[redacted]');
    expect(feedbackEvidence.note).toContain('[code omitted]');
    expect(feedbackEvidence.note).not.toContain('supersecret');
    expect(feedbackEvidence.note).not.toContain('private patch');

    const replay = await planningEvidenceService.reconcile({
      dryRun: false,
      force: true,
      itemId: String(item._id),
      owner: 'evidence-test',
      now: new Date(now.getTime() + 1000)
    });
    expect(replay.totals).toMatchObject({ updated: 0, failed: 0, skipped: 2 });
    expect((await PlanningItem.findById(item._id)).evidence).toHaveLength(2);

    const state = await PlanningAutomationState.findOne({ collector: 'evidence:pipeline' });
    expect(state.status).toBe('ok');
    expect(state.cursor.through).toBeTruthy();
    expect(state.lease.owner).toBe('');
  });

  test('collects filtered alert lifecycle and linked schedule-run evidence without mutating sources', async () => {
    const now = new Date(Date.now() + 5000);
    const resolvedAt = new Date(now.getTime() - 120000);
    const lastRun = new Date(now.getTime() - 60000);
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Lifecycle proof',
      scheduleRefs: [{ source: 'agentx', sourceId: 'schedule-proof', label: 'Proof job' }],
      automation: {
        evidenceBindings: [
          {
            source: 'alerts',
            params: { events: ['resolved'], severity: 'critical', component: 'core' }
          },
          { source: 'schedule', params: { events: ['run'] } }
        ]
      }
    });
    await Alert.create([
      {
        severity: 'critical',
        status: 'resolved',
        title: 'Core recovered',
        message: 'Core is healthy',
        fingerprint: 'core-recovered',
        context: { component: 'core' },
        resolution: {
          resolved: true,
          resolvedAt,
          resolvedBy: 'self-healing',
          resolutionMethod: 'auto'
        }
      },
      {
        severity: 'warning',
        status: 'resolved',
        title: 'Filtered warning',
        message: 'Not critical',
        fingerprint: 'filtered-warning',
        context: { component: 'core' },
        resolution: { resolved: true, resolvedAt }
      }
    ]);
    await ClusterScheduleEntry.create({
      source: 'agentx',
      sourceId: 'schedule-proof',
      name: 'Proof job',
      taskType: 'monitoring',
      schedule: { type: 'interval', intervalMs: 900000 },
      lastRun,
      metadata: { lastStatus: 'ok', consecutiveErrors: 0 }
    });
    const pipelineMutation = jest.spyOn(PipelineTask, 'updateOne');
    const alertMutation = jest.spyOn(Alert, 'updateOne');
    const scheduleMutation = jest.spyOn(ClusterScheduleEntry, 'updateOne');

    const result = await planningEvidenceService.reconcile({
      dryRun: false,
      force: true,
      itemId: String(item._id),
      owner: 'evidence-test',
      now
    });

    expect(result.totals).toMatchObject({ updated: 2, failed: 0 });
    const updated = await PlanningItem.findById(item._id);
    expect(updated.evidence.map((row) => row.source).sort()).toEqual(['alerts', 'schedule']);
    expect(updated.evidence.find((row) => row.source === 'alerts')).toMatchObject({
      label: 'Alert resolved: Core recovered',
      metadata: expect.objectContaining({ event: 'resolved', severity: 'critical' })
    });
    expect(updated.evidence.find((row) => row.source === 'schedule')).toMatchObject({
      label: 'Proof job run ok',
      metadata: expect.objectContaining({ sourceId: 'schedule-proof', status: 'ok' })
    });
    expect(pipelineMutation).not.toHaveBeenCalled();
    expect(alertMutation).not.toHaveBeenCalled();
    expect(scheduleMutation).not.toHaveBeenCalled();
    pipelineMutation.mockRestore();
    alertMutation.mockRestore();
    scheduleMutation.mockRestore();
  });

  test('does not advance a cursor when evidence persistence fails', async () => {
    const now = new Date(Date.now() + 5000);
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Cursor safety',
      scheduleRefs: [{ source: 'agentx', sourceId: 'schedule-fail', label: 'Failing write' }],
      automation: {
        evidenceBindings: [{ source: 'schedule', params: { events: ['run'] } }]
      }
    });
    await ClusterScheduleEntry.create({
      source: 'agentx',
      sourceId: 'schedule-fail',
      name: 'Failing write',
      taskType: 'monitoring',
      schedule: { type: 'interval', intervalMs: 900000 },
      lastRun: new Date(now.getTime() - 60000),
      metadata: { lastStatus: 'ok' }
    });
    const persistence = jest.spyOn(PlanningItem, 'updateOne').mockRejectedValueOnce(
      new Error('simulated persistence failure')
    );

    const result = await planningEvidenceService.reconcile({
      dryRun: false,
      force: true,
      itemId: String(item._id),
      owner: 'evidence-test',
      now
    });

    expect(result.groups[0]).toMatchObject({
      status: 'degraded',
      statistics: { failed: 1 }
    });
    const state = await PlanningAutomationState.findOne({ collector: 'evidence:schedule' });
    expect(state.status).toBe('degraded');
    expect(state.cursor).toBeNull();
    expect(state.lease.owner).toBe('');
    persistence.mockRestore();
  });

  test('drains a bounded alert backlog across cursor-safe passes', async () => {
    const now = new Date(Date.now() + 10000);
    const base = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Bounded alert backlog',
      automation: {
        evidenceBindings: [{
          source: 'alerts',
          params: { events: ['resolved'], component: 'backlog-test' }
        }]
      }
    });
    await Alert.collection.insertMany(Array.from({ length: 105 }, (_, index) => {
      const at = new Date(base.getTime() + index * 1000);
      return {
        ruleId: 'backlog',
        ruleName: 'Backlog',
        severity: 'warning',
        status: 'resolved',
        title: `Resolved ${index}`,
        message: `Resolved backlog alert ${index}`,
        context: { component: 'backlog-test' },
        fingerprint: `backlog-${index}`,
        occurrenceCount: 1,
        lastOccurrence: at,
        resolution: { resolved: true, resolvedAt: at, resolutionMethod: 'test' },
        createdAt: at,
        updatedAt: at
      };
    }));

    const first = await planningEvidenceService.reconcile({
      dryRun: false,
      force: true,
      itemId: String(item._id),
      owner: 'backlog-test',
      now
    });
    expect(first.totals.updated).toBe(100);

    const second = await planningEvidenceService.reconcile({
      dryRun: false,
      force: false,
      itemId: String(item._id),
      owner: 'backlog-test',
      now: new Date(now.getTime() + 1000)
    });
    expect(second.totals.updated).toBe(5);
    expect((await PlanningItem.findById(item._id)).evidence).toHaveLength(105);
  });

  test('captures a delayed schedule sync by ingestion time without changing the run timestamp', async () => {
    const now = new Date(Date.now() + 10000);
    const cursor = new Date(now.getTime() - 30 * 60 * 1000);
    const lastRun = new Date(now.getTime() - 2 * 60 * 60 * 1000);
    const item = await PlanningItem.create({
      type: 'outcome',
      title: 'Delayed schedule sync',
      scheduleRefs: [{ source: 'agentx', sourceId: 'schedule-delayed', label: 'Delayed' }],
      automation: {
        evidenceBindings: [{ source: 'schedule', params: { events: ['run'] } }]
      }
    });
    await ClusterScheduleEntry.collection.insertOne({
      source: 'agentx',
      sourceId: 'schedule-delayed',
      name: 'Delayed',
      taskType: 'monitoring',
      schedule: { type: 'interval', intervalMs: 900000, timezone: 'America/Toronto' },
      enabled: true,
      lastRun,
      metadata: { lastStatus: 'ok', consecutiveErrors: 0 },
      created_at: new Date(now.getTime() - 3 * 60 * 60 * 1000),
      updated_at: new Date(now.getTime() - 60000)
    });
    await PlanningAutomationState.create({
      collector: 'evidence:schedule',
      cursor: { through: cursor.toISOString() },
      status: 'ok'
    });

    const result = await planningEvidenceService.reconcile({
      dryRun: false,
      force: false,
      itemId: String(item._id),
      owner: 'delayed-test',
      now
    });

    expect(result.totals.updated).toBe(1);
    const updated = await PlanningItem.findById(item._id);
    expect(updated.evidence[0].occurredAt).toEqual(lastRun);
    expect(updated.evidence[0].externalKey).toContain('schedule:schedule-delayed');
  });

  test('rejects unknown selectors without network access', () => {
    const network = jest.spyOn(global, 'fetch');
    expect(() => planningEvidenceService.validateBinding({
      source: 'alerts',
      params: { url: 'https://example.com/alerts' }
    })).toThrow('Unsupported alerts evidence parameter');
    expect(() => planningEvidenceService.validateBinding({
      source: 'https://example.com'
    })).toThrow('Unsupported Planning evidence source');
    expect(network).not.toHaveBeenCalled();
    network.mockRestore();
  });
});
