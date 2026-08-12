const request = require('supertest');

const PlanningItem = require('../../models/PlanningItem');
const PlanningAutomationState = require('../../models/PlanningAutomationState');
const PipelineTask = require('../../models/PipelineTask');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');
const { app } = require('../../src/app');

describe('AgentX Planning API', () => {
  beforeEach(async () => {
    await Promise.all([
      PlanningItem.deleteMany({}),
      PlanningAutomationState.deleteMany({}),
      PipelineTask.deleteMany({}),
      ClusterScheduleEntry.deleteMany({})
    ]);
  });

  test('renders the frozen Planning reference surface and assets', async () => {
    const response = await request(app)
      .get('/planning')
      .expect(200);

    expect(response.text).toContain('id="planningRoot"');
    expect(response.text).toContain('data-lifecycle="frozen"');
    expect(response.text).toContain('Planning is frozen by the platform realignment.');
    expect(response.text).toContain('Open Pipeline');
    expect(response.text).toContain('id="planningViewTabs"');
    expect(response.text).toContain('id="planningTaskContext"');
    expect(response.text).toContain('id="planningTaskItemSearch"');
    expect(response.text).toContain('Evidence');
    expect(response.text).toContain('/js/planning.js');
    expect(response.text).toContain('/js/planning-editor.js');
    expect(response.text).toContain('/css/planning.css');
  });

  test('dashboard is useful before planning items exist', async () => {
    await PipelineTask.create({
      pipelineId: '0401',
      title: 'Repair recurring schedule ingestion',
      service: 'core',
      status: 'queued',
      epic: 'Scheduling reliability'
    });
    await PipelineTask.create({
      pipelineId: '0400',
      title: 'Personal reminder stays in Pipeline',
      service: 'personal',
      source: 'idea-drop',
      status: 'queued'
    });
    await ClusterScheduleEntry.create({
      source: 'openclaw',
      sourceId: 'weekly-review',
      name: 'Weekly Review',
      taskType: 'monitoring',
      schedule: { type: 'cron', cron: '0 9 * * 1' }
    });

    const response = await request(app)
      .get('/api/planning/dashboard')
      .expect(200);

    expect(response.body.data.summary).toMatchObject({
      workstream: 0,
      activeTasks: 1,
      unlinkedTasks: 1,
      schedules: 1
    });
    expect(response.body.data.unlinkedTasks[0].pipelineId).toBe('0401');
    expect(response.body.data.schedules[0].sourceId).toBe('weekly-review');
  });

  test('deterministically organizes unlinked pipeline tasks into workstreams', async () => {
    await PipelineTask.create([
      {
        pipelineId: '0410',
        title: 'Nerve Center Phase 1 — make alerts legible',
        service: 'core',
        status: 'queued'
      },
      {
        pipelineId: '0411',
        title: 'RAG memory lane health',
        service: 'rag',
        status: 'queued'
      }
    ]);

    const preview = await request(app)
      .post('/api/planning/bootstrap')
      .send({ dryRun: true, by: 'codex' })
      .expect(200);
    expect(preview.body.data.groups).toHaveLength(2);
    expect(await PlanningItem.countDocuments({})).toBe(0);

    const response = await request(app)
      .post('/api/planning/bootstrap')
      .send({ by: 'codex' })
      .expect(200);

    expect(response.body.data).toMatchObject({
      workstreamsCreated: 2,
      tasksLinked: 2
    });
    expect(await PlanningItem.countDocuments({ type: 'workstream' })).toBe(2);
    expect((await PipelineTask.findOne({ pipelineId: '0410' })).planningItemIds).toHaveLength(1);

    const secondRun = await request(app)
      .post('/api/planning/bootstrap')
      .send({ by: 'codex' })
      .expect(200);
    expect(secondRun.body.data.workstreamsCreated).toBe(0);
    expect(secondRun.body.data.tasksLinked).toBe(0);
  });

  test('seeds the AgentX starter portfolio when the pipeline is empty', async () => {
    const response = await request(app)
      .post('/api/planning/bootstrap')
      .send({ includeEmpty: true, by: 'codex' })
      .expect(200);

    expect(response.body.data).toMatchObject({
      workstreamsCreated: 6,
      tasksLinked: 0
    });
    expect(await PlanningItem.countDocuments({ type: 'workstream' })).toBe(6);
    expect(await PlanningItem.countDocuments({ type: 'workstream', status: 'draft' })).toBe(6);
  });

  test('previews and idempotently imports the Nerve Center reference plan', async () => {
    await PipelineTask.create({
      pipelineId: '0374',
      title: 'Make Nerve Center alerts legible',
      service: 'core',
      status: 'queued'
    });
    await ClusterScheduleEntry.create({
      source: 'openclaw',
      sourceId: 'oc-weekly-review',
      name: 'Weekly Review',
      taskType: 'monitoring',
      schedule: { type: 'cron', cron: '0 9 * * 1' }
    });

    const catalog = await request(app)
      .get('/api/planning/reference-plans')
      .expect(200);
    expect(catalog.body.data.plans).toContainEqual(expect.objectContaining({
      key: 'nerve-center-alerting',
      itemCount: 28
    }));

    const preview = await request(app)
      .post('/api/planning/reference-plans/nerve-center-alerting/import')
      .send({ by: 'codex' })
      .expect(200);
    expect(preview.body.data).toMatchObject({
      dryRun: true,
      summary: {
        items: 28,
        create: 28,
        availableTasks: ['0374'],
        availableSchedules: ['oc-weekly-review']
      }
    });
    expect(await PlanningItem.countDocuments({})).toBe(0);

    const applied = await request(app)
      .post('/api/planning/reference-plans/nerve-center-alerting/import')
      .send({ dryRun: false, by: 'codex' })
      .expect(200);
    expect(applied.body.data).toMatchObject({
      dryRun: false,
      itemsCreated: 28,
      itemsReused: 0,
      tasksLinked: 4,
      schedulesLinked: 1,
      evidenceAdded: 7
    });
    expect(await PlanningItem.countDocuments({ type: 'workstream' })).toBe(1);
    expect(await PlanningItem.countDocuments({ type: 'outcome' })).toBe(5);
    expect(await PlanningItem.countDocuments({ type: 'milestone' })).toBe(16);
    expect(await PlanningItem.countDocuments({ type: 'decision', status: 'accepted' })).toBe(6);
    expect((await PipelineTask.findOne({ pipelineId: '0374' })).planningItemIds).toHaveLength(4);
    expect(await PlanningItem.countDocuments({
      type: 'outcome',
      'automation.evidenceBindings.source': { $in: ['pipeline', 'alerts', 'schedule'] }
    })).toBe(5);
    await PlanningItem.updateOne(
      { key: 'agentx:nerve-center-alerting:alert-legibility' },
      { $set: { 'automation.evidenceBindings': [] } }
    );

    const second = await request(app)
      .post('/api/planning/reference-plans/nerve-center-alerting/import')
      .send({ dryRun: false, by: 'codex' })
      .expect(200);
    expect(second.body.data).toMatchObject({
      itemsCreated: 0,
      itemsReused: 28,
      tasksLinked: 0,
      schedulesLinked: 0,
      evidenceAdded: 0,
      evidenceBindingsUpdated: 1
    });

    const third = await request(app)
      .post('/api/planning/reference-plans/nerve-center-alerting/import')
      .send({ dryRun: false, by: 'codex' })
      .expect(200);
    expect(third.body.data).toMatchObject({
      itemsCreated: 0,
      itemsReused: 28,
      evidenceBindingsUpdated: 0
    });
  });

  test('validates typed metric bindings and exposes the automation catalog', async () => {
    const catalog = await request(app)
      .get('/api/planning/automation/catalog')
      .expect(200);
    expect(catalog.body.data.adapters.map((entry) => entry.adapter)).toEqual(
      expect.arrayContaining([
        'pipeline.progress',
        'alerts.active_count',
        'schedule.success_rate'
      ])
    );
    expect(catalog.body.data.evidenceSources.map((entry) => entry.reconcileSource)).toEqual([
      'evidence.pipeline',
      'evidence.alerts',
      'evidence.schedule'
    ]);

    const invalid = await request(app)
      .post('/api/planning/items')
      .send({
        type: 'outcome',
        title: 'Unsafe metric',
        progress: {
          mode: 'metric',
          metric: {
            adapter: 'https://example.com/metric',
            params: { url: 'https://example.com' }
          }
        }
      })
      .expect(400);
    expect(invalid.body.code).toBe('UNKNOWN_PLANNING_METRIC_ADAPTER');

    const valid = await request(app)
      .post('/api/planning/items')
      .send({
        type: 'outcome',
        title: 'Stale critical alerts',
        progress: {
          mode: 'metric',
          metric: {
            baseline: 7,
            current: 7,
            target: 0,
            direction: 'decrease',
            adapter: 'alerts.active_count',
            params: {
              status: 'active',
              severity: 'critical',
              olderThanMs: 86400000
            },
            refreshEveryMs: 900000,
            staleAfterMs: 3600000
          }
        }
      })
      .expect(201);
    expect(valid.body.data.item.progress.metric).toMatchObject({
      adapter: 'alerts.active_count',
      params: {
        status: 'active',
        severity: 'critical',
        olderThanMs: 86400000
      },
      refreshEveryMs: 900000,
      staleAfterMs: 3600000
    });
  });

  test('token-gates applied reconciliation and reports automation status', async () => {
    const originalToken = process.env.AGENTX_MCP_TOKEN;
    process.env.AGENTX_MCP_TOKEN = 'planning-test-token';
    try {
      const item = await PlanningItem.create({
        type: 'outcome',
        title: 'Pipeline done ratio',
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
      await PipelineTask.create({
        pipelineId: '0590',
        title: 'Completed delivery',
        status: 'done',
        planningItemIds: [item._id]
      });

      await request(app)
        .post('/api/planning/automation/reconcile')
        .send({ dryRun: false, force: true, itemId: String(item._id) })
        .expect(401);

      const applied = await request(app)
        .post('/api/planning/automation/reconcile')
        .set('x-agentx-mcp-token', 'planning-test-token')
        .send({ dryRun: false, force: true, itemId: String(item._id), owner: 'route-test' })
        .expect(200);
      expect(applied.body.data.totals).toMatchObject({ updated: 1, failed: 0 });

      const status = await request(app)
        .get('/api/planning/automation/status')
        .expect(200);
      expect(status.body.data.collectors[0]).toMatchObject({
        collector: 'metric:pipeline.done_ratio',
        status: 'ok'
      });
      expect(status.body.data.items[0]).toMatchObject({
        itemId: String(item._id),
        status: 'fresh',
        value: 100
      });
    } finally {
      if (originalToken === undefined) delete process.env.AGENTX_MCP_TOKEN;
      else process.env.AGENTX_MCP_TOKEN = originalToken;
    }
  });

  test('reconciles scoped evidence sources without mutating delivery records', async () => {
    const originalToken = process.env.AGENTX_MCP_TOKEN;
    process.env.AGENTX_MCP_TOKEN = 'planning-test-token';
    try {
      const item = await PlanningItem.create({
        type: 'outcome',
        title: 'Pipeline evidence',
        automation: {
          evidenceBindings: [{
            source: 'pipeline',
            params: { events: ['feedback', 'review'] }
          }]
        }
      });
      await PipelineTask.create({
        pipelineId: '0591',
        title: 'Evidence delivery',
        status: 'review',
        planningItemIds: [item._id],
        feedback: [{ by: 'codex', text: 'Evidence-ready feedback', at: new Date() }]
      });

      const response = await request(app)
        .post('/api/planning/automation/reconcile')
        .set('x-agentx-mcp-token', 'planning-test-token')
        .send({
          dryRun: false,
          force: true,
          source: 'evidence.pipeline',
          itemId: String(item._id),
          owner: 'route-evidence-test'
        })
        .expect(200);

      expect(response.body.data.groups).toEqual([]);
      expect(response.body.data.evidence).toMatchObject({
        source: 'pipeline',
        totals: { updated: 2, failed: 0 }
      });
      const updated = await PlanningItem.findById(item._id);
      expect(updated.evidence).toHaveLength(2);
      expect(updated.evidence.every((entry) => entry.source === 'pipeline')).toBe(true);
      const delivery = await PipelineTask.findOne({ pipelineId: '0591' });
      expect(delivery.status).toBe('review');
      expect(delivery.feedback).toHaveLength(1);
    } finally {
      if (originalToken === undefined) delete process.env.AGENTX_MCP_TOKEN;
      else process.env.AGENTX_MCP_TOKEN = originalToken;
    }
  });

  test('fails closed for reconciliation when production has no MCP token', async () => {
    const originalToken = process.env.AGENTX_MCP_TOKEN;
    const originalNodeEnv = process.env.NODE_ENV;
    delete process.env.AGENTX_MCP_TOKEN;
    process.env.NODE_ENV = 'production';
    try {
      const response = await request(app)
        .post('/api/planning/automation/reconcile')
        .send({ dryRun: true })
        .expect(503);
      expect(response.body.code).toBe('PLANNING_AUTOMATION_TOKEN_REQUIRED');
    } finally {
      if (originalToken === undefined) delete process.env.AGENTX_MCP_TOKEN;
      else process.env.AGENTX_MCP_TOKEN = originalToken;
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
    }
  });

  test('creates planning hierarchy and calculates metric progress', async () => {
    const workstreamResponse = await request(app)
      .post('/api/planning/items')
      .send({
        type: 'workstream',
        title: 'Nerve Center Trust',
        progress: { mode: 'children' }
      })
      .expect(201);

    const workstreamId = workstreamResponse.body.data.item.id;
    const outcomeResponse = await request(app)
      .post('/api/planning/items')
      .send({
        type: 'outcome',
        title: 'Eliminate stale critical alerts',
        workstreamId,
        owner: 'core',
        targetAt: '2026-08-01',
        progress: {
          mode: 'metric',
          metric: {
            label: 'Stale critical alerts',
            unit: 'count',
            baseline: 8,
            current: 4,
            target: 0,
            direction: 'decrease',
            sourceRef: '/api/alerts?status=active'
          }
        }
      })
      .expect(201);

    expect(outcomeResponse.body.data.item.workstreamId).toBe(workstreamId);

    const dashboard = await request(app)
      .get('/api/planning/dashboard')
      .expect(200);

    const outcome = dashboard.body.data.items.find((item) => item.type === 'outcome');
    expect(outcome.computedProgress).toBe(50);
    expect(outcome.workstream.title).toBe('Nerve Center Trust');

    const detail = await request(app)
      .get(`/api/planning/items/${outcomeResponse.body.data.item.id}`)
      .expect(200);
    expect(detail.body.data.item.workstream.title).toBe('Nerve Center Trust');
  });

  test('inherits a workstream through explicit parent hierarchy', async () => {
    const workstream = await PlanningItem.create({
      type: 'workstream',
      title: 'Model Quality',
      status: 'active'
    });
    const outcome = await PlanningItem.create({
      type: 'outcome',
      title: 'Routing decisions are evidence-backed',
      status: 'active',
      workstreamId: workstream._id,
      parentId: workstream._id
    });

    const response = await request(app)
      .post('/api/planning/items')
      .send({
        type: 'milestone',
        title: 'Qualification matrix complete',
        parentId: outcome._id
      })
      .expect(201);

    expect(response.body.data.item.parentId).toBe(String(outcome._id));
    expect(response.body.data.item.workstreamId).toBe(String(workstream._id));
  });

  test('links pipeline tasks and rolls task state into milestone progress', async () => {
    await PipelineTask.create([
      { pipelineId: '0402', title: 'Phase 1', status: 'done' },
      {
        pipelineId: '0403',
        title: 'Phase 2',
        status: 'in_progress',
        assignee: 'codex',
        heartbeatAt: new Date(Date.now() - (3 * 60 * 60 * 1000))
      }
    ]);
    const milestoneResponse = await request(app)
      .post('/api/planning/items')
      .send({
        type: 'milestone',
        title: 'Alert trust rollout',
        progress: { mode: 'tasks' }
      })
      .expect(201);
    const milestoneId = milestoneResponse.body.data.item.id;

    await request(app)
      .post(`/api/planning/items/${milestoneId}/tasks/0402`)
      .send({ by: 'codex' })
      .expect(200);
    await request(app)
      .post(`/api/planning/items/${milestoneId}/tasks/0403`)
      .send({ by: 'codex' })
      .expect(200);

    const dashboard = await request(app)
      .get('/api/planning/dashboard')
      .expect(200);
    const milestone = dashboard.body.data.items.find((item) => item.id === milestoneId);

    expect(milestone.linkedTaskCount).toBe(2);
    expect(milestone.computedProgress).toBe(75);
    expect(milestone.progressBreakdown.tasks).toMatchObject({
      total: 2,
      done: 1,
      in_progress: 1
    });
    expect(milestone.health.level).toBe('at_risk');
    expect(milestone.health.reasons[0].code).toBe('stale_task_heartbeat');
    expect(dashboard.body.data.unlinkedTasks).toHaveLength(0);
  });

  test('links runtime schedules and stores evidence with history', async () => {
    await ClusterScheduleEntry.create({
      source: 'openclaw',
      sourceId: 'docs-steward-audit',
      name: 'Docs Steward Audit',
      taskType: 'diagnostics',
      schedule: { type: 'cron', cron: '30 10 * * 1' }
    });
    const itemResponse = await request(app)
      .post('/api/planning/items')
      .send({ type: 'outcome', title: 'Documentation stays current' })
      .expect(201);
    const itemId = itemResponse.body.data.item.id;

    await request(app)
      .post(`/api/planning/items/${itemId}/schedules`)
      .send({ sourceId: 'docs-steward-audit', by: 'codex' })
      .expect(200);
    const evidenceResponse = await request(app)
      .post(`/api/planning/items/${itemId}/evidence`)
      .send({
        kind: 'document',
        label: 'Latest Docs Steward report',
        ref: 'docs/audits/docs-steward/latest',
        by: 'codex'
      })
      .expect(201);

    expect(evidenceResponse.body.data.evidence.label).toBe('Latest Docs Steward report');

    const detail = await request(app)
      .get(`/api/planning/items/${itemId}`)
      .expect(200);

    expect(detail.body.data.item.scheduleRefs[0].sourceId).toBe('docs-steward-audit');
    expect(detail.body.data.item.evidence).toHaveLength(1);
    expect(detail.body.data.item.history.map((entry) => entry.action)).toEqual(
      expect.arrayContaining(['created', 'schedule_linked', 'evidence_added'])
    );
  });

  test('promotes an idea into a draft planning item without creating an active commitment', async () => {
    const ideaResponse = await request(app)
      .post('/api/planning/items')
      .send({
        type: 'idea',
        title: 'Automatic benchmark evidence rollups',
        summary: 'Attach relevant batch evidence to outcomes.'
      })
      .expect(201);
    const ideaId = ideaResponse.body.data.item.id;

    const blockedPromotion = await request(app)
      .post(`/api/planning/ideas/${ideaId}/promote`)
      .send({ targetType: 'outcome', by: 'codex' })
      .expect(409);
    expect(blockedPromotion.body.code).toBe('PLANNING_IDEA_NOT_SHAPED');

    await request(app)
      .post(`/api/planning/items/${ideaId}/actions/shape`)
      .send({ by: 'codex' })
      .expect(200);

    const promoteResponse = await request(app)
      .post(`/api/planning/ideas/${ideaId}/promote`)
      .send({ targetType: 'outcome', by: 'codex' })
      .expect(201);

    expect(promoteResponse.body.data.idea.status).toBe('promoted');
    expect(promoteResponse.body.data.promoted).toMatchObject({
      type: 'outcome',
      title: 'Automatic benchmark evidence rollups',
      status: 'draft'
    });
  });

  test('supports Capture → Shape → Commit → Deliver → Prove with preserved lineage', async () => {
    const workstream = await request(app)
      .post('/api/planning/items')
      .send({ type: 'workstream', title: 'Nerve Center & Alerting' })
      .expect(201);
    const idea = await request(app)
      .post('/api/planning/items')
      .send({
        type: 'idea',
        title: 'Make alert recurrence visible',
        summary: 'Operators need occurrence count and last-seen context.'
      })
      .expect(201);

    await request(app)
      .post(`/api/planning/items/${idea.body.data.item.id}/actions/shape`)
      .send({ by: 'codex' })
      .expect(200);

    const promotion = await request(app)
      .post(`/api/planning/ideas/${idea.body.data.item.id}/promote`)
      .send({
        targetType: 'outcome',
        workstreamId: workstream.body.data.item.id,
        owner: 'core',
        targetAt: '2026-08-20',
        progress: { mode: 'tasks' },
        by: 'codex'
      })
      .expect(201);
    const goalId = promotion.body.data.promoted.id;

    await PipelineTask.create({
      pipelineId: '0499',
      title: 'Expose alert recurrence fields',
      service: 'core',
      status: 'in_progress',
      heartbeatAt: new Date()
    });
    await request(app)
      .post(`/api/planning/items/${goalId}/tasks/0499`)
      .send({ by: 'codex' })
      .expect(200);
    await request(app)
      .post(`/api/planning/items/${goalId}/actions/commit`)
      .send({ by: 'codex' })
      .expect(200);
    await request(app)
      .post(`/api/planning/items/${goalId}/actions/start`)
      .send({ by: 'codex' })
      .expect(200);
    await request(app)
      .post(`/api/planning/items/${goalId}/evidence`)
      .send({
        kind: 'task_feedback',
        label: 'Recurrence UI verified',
        ref: '0499',
        by: 'codex'
      })
      .expect(201);
    const proved = await request(app)
      .post(`/api/planning/items/${goalId}/actions/complete`)
      .send({ by: 'codex' })
      .expect(200);

    expect(proved.body.data.item.status).toBe('completed');
    const shapedIdea = await PlanningItem.findById(idea.body.data.item.id);
    expect(String(shapedIdea.promotedTo)).toBe(goalId);
  });

  test('gates goal commitment, start, and completion without mutating delivery sources', async () => {
    const premature = await request(app)
      .post('/api/planning/items')
      .send({ type: 'outcome', title: 'Premature commitment', status: 'active' })
      .expect(400);
    expect(premature.body.code).toBe('INVALID_PLANNING_INITIAL_STATUS');

    const workstream = await request(app)
      .post('/api/planning/items')
      .send({ type: 'workstream', title: 'Nerve Center & Alerting' })
      .expect(201);
    const workstreamId = workstream.body.data.item.id;

    const goal = await request(app)
      .post('/api/planning/items')
      .send({ type: 'outcome', title: 'Alerts explain what happened' })
      .expect(201);
    const goalId = goal.body.data.item.id;

    const gatedCommit = await request(app)
      .post(`/api/planning/items/${goalId}/actions/commit`)
      .send({ by: 'codex' })
      .expect(422);
    expect(gatedCommit.body.code).toBe('PLANNING_TRANSITION_GATED');
    expect(gatedCommit.body.message).toContain('a workstream is required');

    await request(app)
      .patch(`/api/planning/items/${goalId}`)
      .send({
        workstreamId,
        owner: 'core',
        summary: 'Every active alert carries a useful fingerprint and occurrence context.',
        targetAt: '2026-08-15',
        progress: {
          mode: 'metric',
          metric: {
            label: 'Legible active alerts',
            unit: '%',
            baseline: 7,
            current: 7,
            target: 100,
            direction: 'increase',
            sourceRef: '/api/alerts?status=active'
          }
        },
        by: 'codex'
      })
      .expect(200);

    const committed = await request(app)
      .post(`/api/planning/items/${goalId}/actions/commit`)
      .send({ by: 'codex' })
      .expect(200);
    expect(committed.body.data.item.status).toBe('planned');

    const invalidJump = await request(app)
      .patch(`/api/planning/items/${goalId}`)
      .send({ status: 'completed', by: 'codex' })
      .expect(409);
    expect(invalidJump.body.code).toBe('INVALID_PLANNING_TRANSITION');

    const started = await request(app)
      .post(`/api/planning/items/${goalId}/actions/start`)
      .send({ by: 'codex' })
      .expect(200);
    expect(started.body.data.item.status).toBe('active');

    const gatedComplete = await request(app)
      .post(`/api/planning/items/${goalId}/actions/complete`)
      .send({ by: 'codex' })
      .expect(422);
    expect(gatedComplete.body.message).toContain('evidence');

    await request(app)
      .post(`/api/planning/items/${goalId}/evidence`)
      .send({
        kind: 'task_feedback',
        label: 'Task 0374 verification',
        ref: '0374',
        by: 'codex'
      })
      .expect(201);

    const completed = await request(app)
      .post(`/api/planning/items/${goalId}/actions/complete`)
      .send({ by: 'codex' })
      .expect(200);
    expect(completed.body.data.item.status).toBe('completed');
    expect(completed.body.data.item.dates.completedAt).toBeTruthy();
    expect(await PipelineTask.countDocuments({ planningItemIds: goalId })).toBe(0);
  });

  test('enforces named transitions and decision acceptance gates', async () => {
    const invalidDecision = await request(app)
      .post('/api/planning/items')
      .send({ type: 'decision', title: 'Invalid legacy state', status: 'active' })
      .expect(400);
    expect(invalidDecision.body.code).toBe('INVALID_PLANNING_STATUS');

    const decision = await request(app)
      .post('/api/planning/items')
      .send({ type: 'decision', title: 'Adopt the native planning spine' })
      .expect(201);

    await request(app)
      .post(`/api/planning/items/${decision.body.data.item.id}/actions/propose`)
      .send({ by: 'codex' })
      .expect(200);

    const gated = await request(app)
      .post(`/api/planning/items/${decision.body.data.item.id}/actions/accept`)
      .send({ by: 'codex' })
      .expect(422);
    expect(gated.body.code).toBe('PLANNING_TRANSITION_GATED');

    await request(app)
      .patch(`/api/planning/items/${decision.body.data.item.id}`)
      .send({
        decision: {
          context: 'Planning state was spread across task and schedule tools.',
          choice: 'Adopt the native planning spine.',
          rationale: 'Intent needs a durable home without duplicating delivery truth.'
        },
        by: 'codex'
      })
      .expect(200);

    const accepted = await request(app)
      .post(`/api/planning/items/${decision.body.data.item.id}/actions/accept`)
      .send({ by: 'codex' })
      .expect(200);
    expect(accepted.body.data.item.status).toBe('accepted');
    expect(accepted.body.data.item.decision.decidedAt).toBeTruthy();

    const invalidIdea = await request(app)
      .post('/api/planning/items')
      .send({ type: 'idea', title: 'Skip triage', status: 'active' })
      .expect(400);
    expect(invalidIdea.body.code).toBe('INVALID_PLANNING_STATUS');
  });

  test('archives items without deleting their history', async () => {
    const itemResponse = await request(app)
      .post('/api/planning/items')
      .send({ type: 'decision', title: 'Keep scheduling in Core' })
      .expect(201);
    const itemId = itemResponse.body.data.item.id;

    const archiveResponse = await request(app)
      .delete(`/api/planning/items/${itemId}`)
      .send({ by: 'codex' })
      .expect(200);

    expect(archiveResponse.body.data.item.status).toBe('archived');
    expect(archiveResponse.body.data.item.archivedAt).toBeTruthy();
    expect(await PlanningItem.countDocuments({ _id: itemId })).toBe(1);

    const list = await request(app)
      .get('/api/planning/items')
      .expect(200);
    expect(list.body.data.items).toHaveLength(0);
  });
});
