const express = require('express');
const request = require('supertest');

jest.mock('../../models/PipelineTask', () => ({
  find: jest.fn(),
  aggregate: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../src/services/pipelineTaskService', () => ({
  createTaskInMongo: jest.fn(),
  findNextEligibleTask: jest.fn(),
  claimEligibleTask: jest.fn(),
  assertLeaseMutationAllowed: jest.fn(() => null),
  heartbeatClaim: jest.fn(),
  releaseAutomationSlot: jest.fn(),
}));

const PipelineTask = require('../../models/PipelineTask');
const pipelineTaskService = require('../../src/services/pipelineTaskService');
const pipelineRoutes = require('../../routes/pipeline');

function createApp({ ip } = {}) {
  const app = express();
  app.use(express.json());
  if (ip) {
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: ip, configurable: true });
      next();
    });
  }
  app.use('/api/pipeline', pipelineRoutes);
  return app;
}

function createFindQuery(tasks) {
  const query = {
    sort: jest.fn(() => query),
    limit: jest.fn(() => query),
    select: jest.fn(() => query),
    lean: jest.fn(async () => tasks),
  };
  return query;
}

test('keeps the retired board-sync path as an explicit adapter shim', async () => {
  const response = await request(createApp())
    .post('/api/pipeline/leantime-sync')
    .send({ dryRun: true })
    .expect(410);

  expect(response.body).toMatchObject({ code: 'ADAPTER_REQUIRED' });
});

describe('GET /api/pipeline/tasks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PipelineTask.aggregate.mockResolvedValue([]);
  });

  test('supports summary view for lightweight pipeline dashboards', async () => {
    const query = createFindQuery([
      {
        pipelineId: '0326',
        title: 'Expose the local task pipeline in AgentX UI',
        status: 'in_progress',
        assignee: 'codex',
      },
    ]);
    PipelineTask.find.mockReturnValue(query);
    PipelineTask.aggregate.mockResolvedValue([
      { _id: 'in_progress', count: 1 },
      { _id: 'queued', count: 4 }
    ]);

    const res = await request(createApp())
      .get('/api/pipeline/tasks?view=summary&limit=50')
      .expect(200);

    expect(PipelineTask.find).toHaveBeenCalledWith({
      status: { $in: ['queued', 'in_progress', 'review', 'blocked'] }
    });
    expect(query.sort).toHaveBeenCalledWith({ pipelineId: 1 });
    expect(query.limit).toHaveBeenCalledWith(50);
    expect(query.select).toHaveBeenCalledWith(
      [
        'pipelineId', 'title', 'service', 'status', 'assignee', 'heartbeatAt',
        'epic', 'source', 'priority', 'dependsOn', 'notBefore', 'dueAt', 'risk',
        'automation', 'automationAttemptCount',
        'planningItemIds', 'scheduleEntryIds', 'createdAt', 'updatedAt'
      ].join(' ')
    );
    expect(res.body.status).toBe('success');
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.tasks[0].pipelineId).toBe('0326');
    expect(res.body.data.summary).toEqual(expect.objectContaining({
      matchedCount: 5,
      openCount: 5,
      doneCount: 0
    }));
    expect(res.body.data.evidence).toMatchObject({
      authority: 'core.pipeline',
      scope: {
        statuses: ['queued', 'in_progress', 'review', 'blocked'],
        includesDone: false,
        timeWindow: { kind: 'all_time' }
      },
      rows: { limit: 50, returnedCount: 1, matchedCount: 5, truncated: true }
    });
    expect(res.body.data.evidence.observedAt).toEqual(expect.any(String));
  });

  test('allows explicit full-history listing when includeDone is true', async () => {
    const query = createFindQuery([{ pipelineId: '0001', status: 'done' }]);
    PipelineTask.find.mockReturnValue(query);

    await request(createApp())
      .get('/api/pipeline/tasks?includeDone=true&view=summary')
      .expect(200);

    expect(PipelineTask.find).toHaveBeenCalledWith({});
  });

  test('keeps explicit status and assignee filters unchanged', async () => {
    const query = createFindQuery([{ pipelineId: '0326', spec: '# full prompt' }]);
    PipelineTask.find.mockReturnValue(query);

    await request(createApp())
      .get('/api/pipeline/tasks?status=queued&assignee=worker&limit=10')
      .expect(200);

    expect(PipelineTask.find).toHaveBeenCalledWith({ status: 'queued', assignee: 'worker' });
    expect(query.limit).toHaveBeenCalledWith(10);
    expect(query.select).not.toHaveBeenCalled();
  });
});

describe('GET /api/pipeline/performance', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns privacy-safe attempt performance with explicit evidence coverage', async () => {
    const acquiredAt = new Date(Date.now() - 60_000).toISOString();
    const completedAt = new Date(Date.now() - 30_000).toISOString();
    const query = createFindQuery([{
      pipelineId: '0700',
      createdAt: new Date(Date.now() - 120_000).toISOString(),
      automationAttempts: [{
        leaseId: 'lease-1',
        assignee: 'worker-a',
        attempt: 1,
        acquiredAt,
        completedAt,
        finalState: 'review',
        evidence: {
          verification: { status: 'passed' },
          changes: { filesChanged: 1, bytesChanged: 100 },
          usage: { durationMs: 60000, costNanodollars: null },
          failureCodes: [],
        },
      }],
    }]);
    PipelineTask.find.mockReturnValue(query);

    const response = await request(createApp())
      .get('/api/pipeline/performance?window=7d')
      .expect(200);

    expect(PipelineTask.find).toHaveBeenCalledWith({
      'automationAttempts.acquiredAt': { $gte: expect.any(Date), $lte: expect.any(Date) },
    });
    expect(query.select).toHaveBeenCalledWith('pipelineId createdAt automation automationAttempts');
    expect(response.body.data.performance).toMatchObject({
      schema: 'agentx.pipeline-automation-performance/v1',
      authority: 'core.pipeline',
      window: { days: 7 },
      counts: { attempts: 1 },
      coverage: { attemptEvidence: 1, cost: 0, total: 1 },
      usage: { totalCostNanodollars: null },
    });
  });

  test('keeps provider spend separate from session estimates in the API aggregate', async () => {
    const recent = new Date(Date.now() - 60_000).toISOString();
    const completed = new Date(Date.now() - 30_000).toISOString();
    const costAttempt = (costKind, costSource, costNanodollars, digest) => ({
      assignee: 'worker-a', attempt: 1, acquiredAt: recent, completedAt: completed, finalState: 'review',
      evidence: {
        verification: { status: 'passed' }, changes: {}, failureCodes: [],
        usage: { costKind, costSource, costNanodollars, costEvidenceFingerprint: digest.repeat(64) },
      },
    });
    PipelineTask.find.mockReturnValue(createFindQuery([
      {
        pipelineId: '0701', createdAt: recent,
        automationAttempts: [costAttempt('provider-spend', 'openclaw-local-provider-spend/v1', 0, 'a')],
      },
      {
        pipelineId: '0702', createdAt: recent,
        automationAttempts: [costAttempt('session-estimate', 'openclaw-session-usage/v1', 125971320, 'b')],
      },
    ]));

    const response = await request(createApp())
      .get('/api/pipeline/performance?window=30d')
      .expect(200);

    expect(response.body.data.performance.usage).toMatchObject({
      costAggregateKind: 'mixed',
      observedCostNanodollars: 0,
      totalCostNanodollars: null,
      observedProviderSpendNanodollars: 0,
      observedSessionEstimateNanodollars: 125971320,
    });
  });

  test('rejects unbounded performance windows', async () => {
    const response = await request(createApp())
      .get('/api/pipeline/performance?window=365d')
      .expect(400);

    expect(response.body.code).toBe('INVALID_PERFORMANCE_WINDOW');
    expect(PipelineTask.find).not.toHaveBeenCalled();
  });
});

describe('GET /api/pipeline/tasks/:id', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns the full task document for the detail drawer', async () => {
    PipelineTask.findOne.mockReturnValue({
      lean: async () => ({
        pipelineId: '0326',
        title: 'Expose the local task pipeline in AgentX UI',
        status: 'review',
        spec: '# full markdown body',
        feedback: [{ by: 'codex', text: 'implemented' }],
      }),
    });

    const res = await request(createApp())
      .get('/api/pipeline/tasks/0326')
      .expect(200);

    expect(PipelineTask.findOne).toHaveBeenCalledWith({ pipelineId: '0326' });
    expect(res.body.data.task.spec).toBe('# full markdown body');
    expect(res.body.data.task.feedback).toHaveLength(1);
  });

  test('returns 404 for an unknown pipelineId', async () => {
    PipelineTask.findOne.mockReturnValue({ lean: async () => null });

    const res = await request(createApp())
      .get('/api/pipeline/tasks/9999')
      .expect(404);

    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('does not shadow the literal /tasks/next route', async () => {
    pipelineTaskService.findNextEligibleTask.mockResolvedValue(null);

    await request(createApp())
      .get('/api/pipeline/tasks/next')
      .expect(200);

    expect(pipelineTaskService.findNextEligibleTask).toHaveBeenCalled();
    expect(PipelineTask.findOne).not.toHaveBeenCalled();
  });
});

describe('GET /api/pipeline/tasks/:id/worker', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns one non-personal queued task without changing claim state', async () => {
    PipelineTask.findOne.mockReturnValue({
      lean: async () => ({
        pipelineId: '0707',
        status: 'queued',
        assignee: null,
        service: 'core',
        spec: '# bounded worker prompt',
      }),
    });

    const response = await request(createApp())
      .get('/api/pipeline/tasks/0707/worker?agent=worker-a')
      .expect(200);

    expect(PipelineTask.findOne).toHaveBeenCalledWith({
      pipelineId: '0707',
      service: { $ne: 'personal' },
      source: { $ne: 'idea-drop' },
      $or: [
        { status: 'queued', assignee: null },
        { status: { $in: ['in_progress', 'review', 'blocked'] }, assignee: 'worker-a' },
      ],
    });
    expect(response.body.data.task.spec).toBe('# bounded worker prompt');
    expect(pipelineTaskService.claimEligibleTask).not.toHaveBeenCalled();
  });

  test('does not disclose unavailable or personal task detail', async () => {
    PipelineTask.findOne.mockReturnValue({ lean: async () => null });

    const response = await request(createApp())
      .get('/api/pipeline/tasks/0708/worker?agent=worker-a')
      .expect(404);

    expect(response.body.code).toBe('WORKER_TASK_UNAVAILABLE');
  });
});

describe('GET /api/pipeline/tasks/next', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('skips personal idea-drop tasks by default and surfaces nextTaskId', async () => {
    pipelineTaskService.findNextEligibleTask.mockResolvedValue({
      pipelineId: '0343',
      title: 'models: catalog case-duplicates',
      service: 'core',
      source: 'api',
      status: 'queued',
    });

    const res = await request(createApp())
      .get('/api/pipeline/tasks/next?agent=codex')
      .expect(200);

    expect(pipelineTaskService.findNextEligibleTask).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'codex' })
    );
    expect(res.body.data.nextTaskId).toBe('0343');
    expect(res.body.data.pipelineId).toBe('0343');
    expect(res.body.data.task.pipelineId).toBe('0343');
  });

  test('can include personal idea-drop tasks when explicitly requested', async () => {
    pipelineTaskService.findNextEligibleTask.mockResolvedValue({
      pipelineId: '0319',
      title: 'Cancel Spotify subscription',
      service: 'personal',
      source: 'idea-drop',
      status: 'queued',
    });

    const res = await request(createApp())
      .get('/api/pipeline/tasks/next?includePersonal=true')
      .expect(200);

    expect(pipelineTaskService.findNextEligibleTask).toHaveBeenCalledWith(
      expect.objectContaining({ includePersonal: 'true' })
    );
    expect(res.body.data.nextTaskId).toBe('0319');
  });
});

describe('POST /api/pipeline/tasks/:id/claim', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Task 0529: the ->done gate must stay a *distinct-reviewer* rule, not an
  // allowlist of privileged identities. Identity consolidation is allowed to
  // rename or retire `overseer`; it must not be able to break confirmation by
  // doing so. These assert the rule is "different from the assignee", full stop.
  describe('distinct-reviewer gate carries no literal overseer identity (0529)', () => {
    test.each(['overseer', 'claude-code', 'some-brand-new-agent', 'operator-42'])(
      'any identity other than the assignee may confirm: %s',
      async (confirmer) => {
        PipelineTask.findOne.mockResolvedValue({ pipelineId: '0600', status: 'review', assignee: 'codex' });
        PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0600', status: 'done' });

        const res = await request(createApp())
          .post('/api/pipeline/tasks/0600/status')
          .send({ status: 'done', by: confirmer })
          .expect(200);

        expect(res.body.data.task.status).toBe('done');
      }
    );

    test('the assignee still cannot self-certify, whatever it is called', async () => {
      PipelineTask.findOne.mockResolvedValue({ pipelineId: '0601', status: 'review', assignee: 'overseer' });

      const res = await request(createApp())
        .post('/api/pipeline/tasks/0601/status')
        .send({ status: 'done', by: 'overseer' })
        .expect(403);

      expect(res.body.code).toBe('SELF_CERTIFY_FORBIDDEN');
    });
  });

  test('delegates eligibility and atomic claim to the pipeline service', async () => {
    pipelineTaskService.claimEligibleTask.mockResolvedValue({
      pipelineId: '0518',
      status: 'in_progress',
      assignee: 'codex',
    });

    const res = await request(createApp())
      .post('/api/pipeline/tasks/0518/claim')
      .send({ assignee: 'codex' })
      .expect(200);

    expect(pipelineTaskService.claimEligibleTask).toHaveBeenCalledWith('0518', 'codex');
    expect(res.body.data.task.status).toBe('in_progress');
  });

  test('returns the eligibility error without weakening its status or code', async () => {
    const err = new Error('Task dependencies are not complete');
    err.status = 409;
    err.code = 'TASK_DEPENDENCIES_BLOCKED';
    pipelineTaskService.claimEligibleTask.mockRejectedValue(err);

    const res = await request(createApp())
      .post('/api/pipeline/tasks/0519/claim')
      .send({ assignee: 'codex' })
      .expect(409);

    expect(res.body.code).toBe('TASK_DEPENDENCIES_BLOCKED');
  });

  test('requests a server-issued lease only for explicit automated claims', async () => {
    pipelineTaskService.claimEligibleTask.mockResolvedValue({
      pipelineId: '0520',
      status: 'in_progress',
      assignee: 'coding-dispatcher',
      automationLease: { leaseId: 'lease-1' },
    });

    const res = await request(createApp())
      .post('/api/pipeline/tasks/0520/claim')
      .send({ assignee: 'coding-dispatcher', automated: true, leaseDurationMs: 60000 })
      .expect(200);

    expect(pipelineTaskService.claimEligibleTask).toHaveBeenCalledWith(
      '0520',
      'coding-dispatcher',
      expect.any(Date),
      { automated: true, leaseDurationMs: 60000 }
    );
    expect(res.body.data.task.automationLease.leaseId).toBe('lease-1');
  });
});

describe('POST /api/pipeline/tasks/:id/feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0352', status: 'in_progress', assignee: 'codex'
    });
    pipelineTaskService.assertLeaseMutationAllowed.mockReturnValue(null);
  });

  test('rejects empty feedback without updating the task', async () => {
    const res = await request(createApp())
      .post('/api/pipeline/tasks/0352/feedback')
      .send({ by: 'codex', status: 'done', text: '   ' })
      .expect(400);

    expect(res.body).toMatchObject({
      ok: false,
      status: 'error',
      code: 'EMPTY_FEEDBACK'
    });
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('stores trimmed feedback and maps done to review', async () => {
    PipelineTask.findOneAndUpdate.mockResolvedValue({
      pipelineId: '0352',
      status: 'review',
      feedback: [{ by: 'codex', text: 'implemented' }]
    });

    const res = await request(createApp())
      .post('/api/pipeline/tasks/0352/feedback')
      .send({ by: ' codex ', status: 'done', text: '  implemented  ' })
      .expect(200);

    expect(PipelineTask.findOneAndUpdate).toHaveBeenCalledWith(
      { pipelineId: '0352' },
      {
        $push: {
          feedback: expect.objectContaining({
            by: 'codex',
            text: 'implemented'
          })
        },
        $set: { status: 'review' }
      },
      { new: true }
    );
    expect(res.body.data.task.pipelineId).toBe('0352');
  });

  test('maps blocked status to blocked and stores trimmed guard feedback', async () => {
    PipelineTask.findOneAndUpdate.mockResolvedValue({
      pipelineId: '0403',
      status: 'blocked',
      feedback: [{ by: 'guarded-dispatch', text: 'guard failure blocked' }]
    });

    const res = await request(createApp())
      .post('/api/pipeline/tasks/0403/feedback')
      .send({
        by: ' guarded-dispatch ',
        status: 'blocked',
        text: '  guard failure blocked  '
      })
      .expect(200);

    expect(PipelineTask.findOneAndUpdate).toHaveBeenCalledWith(
      { pipelineId: '0403' },
      {
        $push: {
          feedback: expect.objectContaining({
            by: 'guarded-dispatch',
            text: 'guard failure blocked'
          })
        },
        $set: { status: 'blocked' }
      },
      { new: true }
    );
    expect(res.body.data.task.pipelineId).toBe('0403');
    expect(res.body.data.task.status).toBe('blocked');
  });

  test('binds automated completion to the active lease and attempt', async () => {
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0710',
      status: 'in_progress',
      assignee: 'worker-a',
      automationLease: { leaseId: 'lease-1', assignee: 'worker-a' },
    });
    pipelineTaskService.assertLeaseMutationAllowed.mockReturnValue({
      leaseId: 'lease-1', assignee: 'worker-a', attempt: 1, durationMs: 60000,
    });
    PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0710', status: 'review' });

    await request(createApp())
      .post('/api/pipeline/tasks/0710/feedback')
      .send({
        status: 'done',
        by: 'guarded-dispatch',
        leaseAssignee: 'worker-a',
        leaseId: 'lease-1',
        text: 'verified',
        attemptEvidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'passed', durationMs: 1200, testsPassed: 12, testsFailed: 0 },
          changes: { filesChanged: 2, bytesChanged: 900 },
          usage: { durationMs: 45000 },
          failureCodes: [],
          source: 'clawdx-guarded/v1',
        },
      })
      .expect(200);

    expect(PipelineTask.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: '0710',
        status: 'in_progress',
        assignee: 'worker-a',
        'automationLease.leaseId': 'lease-1',
        'automationLease.expiresAt': { $gt: expect.any(Date) },
      }),
      expect.objectContaining({
        $set: expect.objectContaining({
          status: 'review',
          'automationAttempts.$[attempt].finalState': 'review',
          'automationAttempts.$[attempt].completedAt': expect.any(Date),
          'automationAttempts.$[attempt].evidence': {
            schema: 'agentx.pipeline-automation-evidence/v1',
            verification: { status: 'passed', durationMs: 1200, testsPassed: 12, testsFailed: 0 },
            changes: { filesChanged: 2, bytesChanged: 900 },
            usage: {
              durationMs: 45000,
              costNanodollars: null,
              costKind: null,
              costSource: null,
              costEvidenceFingerprint: null,
            },
            failureCodes: [],
            workerReceiptFingerprint: null,
            source: 'clawdx-guarded/v1',
          },
        }),
        $unset: { automationLease: 1 },
      }),
      { new: true, arrayFilters: [{ 'attempt.leaseId': 'lease-1' }] }
    );
    expect(pipelineTaskService.releaseAutomationSlot).toHaveBeenCalledWith({
      leaseId: 'lease-1',
      pipelineId: '0710',
      assignee: 'worker-a',
    });
  });

  test('rejects attempt evidence that is not bound to an automation lease', async () => {
    const response = await request(createApp())
      .post('/api/pipeline/tasks/0352/feedback')
      .send({
        status: 'done',
        by: 'manual-worker',
        text: 'not lease bound',
        attemptEvidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'unknown' },
          changes: {},
          usage: {},
        },
      })
      .expect(400);

    expect(response.body.code).toBe('AUTOMATION_EVIDENCE_REQUIRES_LEASE');
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('forces an observed over-budget success into blocked with bounded evidence', async () => {
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0711',
      status: 'in_progress',
      assignee: 'worker-a',
      automation: { budgets: { maxCostNanodollars: 0 } },
      automationLease: { leaseId: 'lease-2', assignee: 'worker-a' },
    });
    pipelineTaskService.assertLeaseMutationAllowed.mockReturnValue({
      leaseId: 'lease-2', assignee: 'worker-a', attempt: 1, durationMs: 60000,
    });
    PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0711', status: 'blocked' });

    await request(createApp())
      .post('/api/pipeline/tasks/0711/feedback')
      .send({
        status: 'done',
        by: 'guarded-dispatch',
        leaseAssignee: 'worker-a',
        leaseId: 'lease-2',
        text: 'verified',
        attemptEvidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'passed' },
          changes: { filesChanged: 1, bytesChanged: 10 },
          usage: {
            durationMs: 1000,
            costNanodollars: 1,
            costKind: 'session-estimate',
            costSource: 'openclaw-session-usage/v1',
            costEvidenceFingerprint: 'b'.repeat(64),
          },
          failureCodes: [],
          source: 'clawdx-guarded/v1',
        },
      })
      .expect(200);

    const update = PipelineTask.findOneAndUpdate.mock.calls[0][1];
    expect(update.$set.status).toBe('blocked');
    expect(update.$set['automationAttempts.$[attempt].finalState']).toBe('blocked');
    expect(update.$set['automationAttempts.$[attempt].evidence'].failureCodes)
      .toContain('cost_budget_exceeded');
  });

  test('forces a budgeted automated success without cost evidence into blocked', async () => {
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0713',
      status: 'in_progress',
      assignee: 'worker-a',
      automation: { budgets: { maxCostNanodollars: 0 } },
      automationLease: { leaseId: 'lease-4', assignee: 'worker-a' },
    });
    pipelineTaskService.assertLeaseMutationAllowed.mockReturnValue({
      leaseId: 'lease-4', assignee: 'worker-a', attempt: 1, durationMs: 60000,
    });
    PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0713', status: 'blocked' });

    await request(createApp())
      .post('/api/pipeline/tasks/0713/feedback')
      .send({
        status: 'done',
        by: 'guarded-dispatch',
        leaseAssignee: 'worker-a',
        leaseId: 'lease-4',
        text: 'verified but cost receipt missing',
        attemptEvidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'passed' },
          changes: {},
          usage: { durationMs: 1000 },
          failureCodes: [],
        },
      })
      .expect(200);

    const evidence = PipelineTask.findOneAndUpdate.mock.calls[0][1]
      .$set['automationAttempts.$[attempt].evidence'];
    expect(PipelineTask.findOneAndUpdate.mock.calls[0][1].$set.status).toBe('blocked');
    expect(evidence.usage.costNanodollars).toBeNull();
    expect(evidence.failureCodes).toContain('cost_evidence_required');
  });

  test('rejects a worker cost amount without its complete nature and provenance', async () => {
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0712',
      status: 'in_progress',
      assignee: 'worker-a',
      automation: { budgets: { maxCostNanodollars: 0 } },
      automationLease: { leaseId: 'lease-3', assignee: 'worker-a' },
    });
    pipelineTaskService.assertLeaseMutationAllowed.mockReturnValue({
      leaseId: 'lease-3', assignee: 'worker-a', attempt: 1, durationMs: 60000,
    });

    const response = await request(createApp())
      .post('/api/pipeline/tasks/0712/feedback')
      .send({
        status: 'done',
        by: 'guarded-dispatch',
        leaseAssignee: 'worker-a',
        leaseId: 'lease-3',
        text: 'verified',
        attemptEvidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'passed' },
          changes: {},
          usage: { costNanodollars: 0 },
          failureCodes: [],
        },
      })
      .expect(400);

    expect(response.body.code).toBe('INVALID_AUTOMATION_INTENT');
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });
});

describe('POST /api/pipeline/tasks/:id/automation-attempts/:attempt/cost', () => {
  const savedOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
  });

  afterAll(() => {
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;
  });

  test('write-once reconciles a completed unknown cost and records an audit entry', async () => {
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0580',
      automationAttempts: [{
        attempt: 2,
        completedAt: new Date('2026-09-01T12:59:53.642Z'),
        finalState: 'review',
        evidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'passed', durationMs: 406 },
          changes: { filesChanged: 1, bytesChanged: 1283 },
          usage: { durationMs: 67219, costNanodollars: null },
          failureCodes: [],
          source: 'clawdx-guarded/v1',
        },
      }],
    });
    PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0580' });

    const response = await request(createApp())
      .post('/api/pipeline/tasks/0580/automation-attempts/2/cost')
      .set('X-AgentX-Operator-Token', 'operator-token')
      .send({
        by: 'codex-cost-reconciler',
        costNanodollars: 15281520,
        costKind: 'session-estimate',
        costSource: 'openclaw-session-usage/v1',
        costEvidenceFingerprint: 'c'.repeat(64),
      })
      .expect(200);

    const [query, update, options] = PipelineTask.findOneAndUpdate.mock.calls[0];
    expect(query).toMatchObject({ pipelineId: '0580' });
    expect(update.$set['automationAttempts.$[attempt].evidence'].usage).toMatchObject({
      costNanodollars: 15281520,
      costKind: 'session-estimate',
      costSource: 'openclaw-session-usage/v1',
      costEvidenceFingerprint: 'c'.repeat(64),
    });
    expect(update.$push.feedback).toMatchObject({ by: 'codex-cost-reconciler' });
    expect(options).toEqual({ new: true, arrayFilters: [{ 'attempt.attempt': 2 }] });
    expect(response.body.data.costReconciliation.reconciled).toBe(true);
  });

  test('rejects attempts to contradict existing cost evidence', async () => {
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0580',
      automationAttempts: [{
        attempt: 2,
        completedAt: new Date(),
        finalState: 'review',
        evidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'passed' },
          changes: {},
          usage: {
            costNanodollars: 10,
            costKind: 'session-estimate',
            costSource: 'openclaw-session-usage/v1',
            costEvidenceFingerprint: 'd'.repeat(64),
          },
          failureCodes: [],
        },
      }],
    });

    const response = await request(createApp())
      .post('/api/pipeline/tasks/0580/automation-attempts/2/cost')
      .set('X-AgentX-Operator-Token', 'operator-token')
      .send({
        by: 'codex-cost-reconciler',
        costNanodollars: 11,
        costKind: 'session-estimate',
        costSource: 'openclaw-session-usage/v1',
        costEvidenceFingerprint: 'e'.repeat(64),
      })
      .expect(409);

    expect(response.body.code).toBe('COST_EVIDENCE_CONFLICT');
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });
});


describe('POST /api/pipeline/tasks/:id/status (0354 review->done gate)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('rejects an unknown status', async () => {
    const res = await request(createApp())
      .post('/api/pipeline/tasks/0500/status')
      .send({ status: 'finished' })
      .expect(400);
    expect(res.body.code).toBe('INVALID_STATUS');
    expect(PipelineTask.findOne).not.toHaveBeenCalled();
  });

  test('blocks confirming done when the task never reached review', async () => {
    PipelineTask.findOne.mockResolvedValue({ pipelineId: '0500', status: 'in_progress', assignee: 'worker-a' });
    const res = await request(createApp())
      .post('/api/pipeline/tasks/0500/status')
      .send({ status: 'done', by: 'worker-a' })
      .expect(409);
    expect(res.body.code).toBe('DONE_REQUIRES_REVIEW');
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('requires a confirmer identity to move review->done', async () => {
    PipelineTask.findOne.mockResolvedValue({ pipelineId: '0500', status: 'review', assignee: 'worker-a' });
    const res = await request(createApp())
      .post('/api/pipeline/tasks/0500/status')
      .send({ status: 'done' })
      .expect(400);
    expect(res.body.code).toBe('CONFIRM_REQUIRES_BY');
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('forbids a worker self-certifying its own task', async () => {
    PipelineTask.findOne.mockResolvedValue({ pipelineId: '0500', status: 'review', assignee: 'worker-a' });
    const res = await request(createApp())
      .post('/api/pipeline/tasks/0500/status')
      .send({ status: 'done', by: 'worker-a' })
      .expect(403);
    expect(res.body.code).toBe('SELF_CERTIFY_FORBIDDEN');
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('allows a different overseer to confirm review->done and records an audit entry', async () => {
    PipelineTask.findOne.mockResolvedValue({ pipelineId: '0500', status: 'review', assignee: 'worker-a' });
    PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0500', status: 'done' });
    const res = await request(createApp())
      .post('/api/pipeline/tasks/0500/status')
      .send({ status: 'done', by: 'overseer' })
      .expect(200);
    expect(PipelineTask.findOneAndUpdate).toHaveBeenCalledWith(
      { pipelineId: '0500' },
      expect.objectContaining({
        $set: { status: 'done' },
        $push: { feedback: expect.objectContaining({ by: 'overseer' }) }
      }),
      { new: true }
    );
    expect(res.body.data.task.status).toBe('done');
  });

  test('records the human review outcome against the exact latest automation attempt', async () => {
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0501',
      status: 'review',
      assignee: 'worker-a',
      automationAttempts: [{
        leaseId: 'lease-review',
        attempt: 1,
        finalState: 'review',
        completedAt: new Date('2026-09-01T00:00:00.000Z'),
      }],
    });
    PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0501', status: 'done' });

    await request(createApp())
      .post('/api/pipeline/tasks/0501/status')
      .send({ status: 'done', by: 'overseer' })
      .expect(200);

    expect(PipelineTask.findOneAndUpdate).toHaveBeenCalledWith(
      { pipelineId: '0501' },
      {
        $set: {
          status: 'done',
          'automationAttempts.$[reviewAttempt].reviewOutcome': 'accepted',
          'automationAttempts.$[reviewAttempt].reviewedAt': expect.any(Date),
        },
        $push: { feedback: expect.objectContaining({ by: 'overseer' }) },
      },
      { new: true, arrayFilters: [{ 'reviewAttempt.leaseId': 'lease-review' }] }
    );
  });

  test('releases the worker and heartbeat when a task is re-queued', async () => {
    PipelineTask.findOne.mockResolvedValue({ pipelineId: '0500', status: 'in_progress', assignee: 'worker-a' });
    PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0500', status: 'queued' });
    const res = await request(createApp())
      .post('/api/pipeline/tasks/0500/status')
      .send({ status: 'queued' })
      .expect(200);
    expect(PipelineTask.findOneAndUpdate).toHaveBeenCalledWith(
      { pipelineId: '0500' },
      { $set: { status: 'queued', assignee: null, heartbeatAt: null } },
      { new: true }
    );
  });
});

describe('pipeline scoped machine identity', () => {
  const REMOTE_IP = '198.51.100.24';
  const ENV_KEYS = [
    'AGENTX_PIPELINE_TOKEN',
    'AGENTX_OPERATOR_TOKEN',
    'AGENTX_ADMIN_TOKEN',
    'AGENTX_TRUST_INTERNAL_SERVICE_HOSTS',
    'AGENTX_TRUST_LOOPBACK_PROXY_UI',
    'AGENTX_OPERATOR_UI_HOSTS',
    'AGENTX_TRUSTED_UI_HOSTS',
    'CORE_PUBLIC_URL',
  ];
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

  beforeEach(() => {
    jest.clearAllMocks();
    pipelineTaskService.assertLeaseMutationAllowed.mockReturnValue(null);
    for (const key of ENV_KEYS) delete process.env[key];
  });

  afterAll(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const mutationCases = [
    ['claim', '/api/pipeline/tasks/0700/claim', { assignee: 'remote-worker' }, () => {
      expect(pipelineTaskService.claimEligibleTask).not.toHaveBeenCalled();
    }],
    ['heartbeat', '/api/pipeline/tasks/0700/heartbeat', {}, () => {
      expect(pipelineTaskService.heartbeatClaim).not.toHaveBeenCalled();
    }],
    ['status', '/api/pipeline/tasks/0700/status', { status: 'in_progress' }, () => {
      expect(PipelineTask.findOne).not.toHaveBeenCalled();
      expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
    }],
    ['feedback', '/api/pipeline/tasks/0700/feedback', { status: 'partial', text: 'still working' }, () => {
      expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
    }],
  ];

  const rejectedCredentialCases = [
    ['missing', 'pipeline-secret', undefined],
    ['wrong', 'pipeline-secret', 'not-the-secret'],
    ['unconfigured', undefined, 'orphaned-token'],
  ];

  test.each(mutationCases.flatMap(([action, path, body, assertNoSideEffect]) => (
    rejectedCredentialCases.map(([credentialState, configured, presented]) => [
      action, credentialState, path, body, assertNoSideEffect, configured, presented,
    ])
  )))('rejects remote %s with a %s credential before side effects', async (
    _action, _credentialState, path, body, assertNoSideEffect, configured, presented
  ) => {
    if (configured !== undefined) process.env.AGENTX_PIPELINE_TOKEN = configured;
    let pending = request(createApp({ ip: REMOTE_IP }))
      .post(path)
      .set('Host', 'remote-worker.example');
    if (presented !== undefined) pending = pending.set('X-AgentX-Pipeline-Token', presented);

    const response = await pending.send(body).expect(403);

    expect(response.body).toMatchObject({
      ok: false,
      status: 'error',
      code: 'PIPELINE_ACCESS_REQUIRED',
    });
    assertNoSideEffect();
  });

  test('admits the exact scoped token to claim, heartbeat, non-final status, and feedback', async () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';
    const app = createApp({ ip: REMOTE_IP });
    const workerHeaders = { Host: 'remote-worker.example', 'X-AgentX-Pipeline-Token': 'pipeline-secret' };

    pipelineTaskService.claimEligibleTask.mockResolvedValue({
      pipelineId: '0701', status: 'in_progress', assignee: 'remote-worker'
    });
    await request(app)
      .post('/api/pipeline/tasks/0701/claim')
      .set(workerHeaders)
      .send({ assignee: 'remote-worker' })
      .expect(200);

    pipelineTaskService.heartbeatClaim.mockResolvedValueOnce({
      pipelineId: '0701', heartbeatAt: new Date('2026-08-28T12:00:00.000Z')
    });
    await request(app)
      .post('/api/pipeline/tasks/0701/heartbeat')
      .set(workerHeaders)
      .send({})
      .expect(200);

    PipelineTask.findOne.mockResolvedValueOnce({
      pipelineId: '0701', status: 'in_progress', assignee: 'remote-worker'
    });
    PipelineTask.findOneAndUpdate.mockResolvedValueOnce({
      pipelineId: '0701', status: 'blocked', assignee: 'remote-worker'
    });
    await request(app)
      .post('/api/pipeline/tasks/0701/status')
      .set(workerHeaders)
      .send({ status: 'blocked', by: 'remote-worker' })
      .expect(200);

    PipelineTask.findOne.mockResolvedValueOnce({
      pipelineId: '0701', status: 'in_progress', assignee: 'remote-worker'
    });
    PipelineTask.findOneAndUpdate.mockResolvedValueOnce({
      pipelineId: '0701', status: 'review', assignee: 'remote-worker'
    });
    await request(app)
      .post('/api/pipeline/tasks/0701/feedback')
      .set(workerHeaders)
      .send({ status: 'done', by: 'remote-worker', text: 'implementation and verification complete' })
      .expect(200);

    expect(pipelineTaskService.claimEligibleTask).toHaveBeenCalledWith('0701', 'remote-worker');
    expect(PipelineTask.findOneAndUpdate).toHaveBeenLastCalledWith(
      { pipelineId: '0701' },
      expect.objectContaining({ $set: { status: 'review' } }),
      { new: true }
    );
  });

  test('reports an automation heartbeat lease mismatch as a conflict', async () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';
    pipelineTaskService.heartbeatClaim.mockRejectedValueOnce(Object.assign(
      new Error('automation lease identity is missing or stale'),
      { status: 409, code: 'TASK_LEASE_MISMATCH' }
    ));

    const response = await request(createApp({ ip: REMOTE_IP }))
      .post('/api/pipeline/tasks/0701/heartbeat')
      .set('Host', 'remote-worker.example')
      .set('X-AgentX-Pipeline-Token', 'pipeline-secret')
      .send({ assignee: 'remote-worker', leaseId: 'stale-lease' })
      .expect(409);

    expect(response.body).toMatchObject({
      ok: false,
      code: 'TASK_LEASE_MISMATCH',
    });
  });

  test('does not let a remote worker token acquire final authority through status=done', async () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';

    const response = await request(createApp({ ip: REMOTE_IP }))
      .post('/api/pipeline/tasks/0702/status')
      .set('Host', 'remote-worker.example')
      .set('X-AgentX-Pipeline-Token', 'pipeline-secret')
      .send({ status: 'done', by: 'different-overseer-name' })
      .expect(403);

    expect(response.body.code).toBe('PIPELINE_FINALIZE_REQUIRES_CONTROL_AUTHORITY');
    expect(PipelineTask.findOne).not.toHaveBeenCalled();
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('binds a remote non-final status mutation to the active automation lease', async () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0711',
      status: 'in_progress',
      assignee: 'worker-a',
      automationLease: {
        leaseId: 'lease-1',
        assignee: 'worker-a',
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    pipelineTaskService.assertLeaseMutationAllowed.mockReturnValue({
      leaseId: 'lease-1', assignee: 'worker-a', attempt: 1, durationMs: 60000,
    });
    PipelineTask.findOneAndUpdate.mockResolvedValue({
      pipelineId: '0711', status: 'blocked', assignee: 'worker-a'
    });

    await request(createApp({ ip: REMOTE_IP }))
      .post('/api/pipeline/tasks/0711/status')
      .set('Host', 'remote-worker.example')
      .set('X-AgentX-Pipeline-Token', 'pipeline-secret')
      .send({ status: 'blocked', by: 'worker-a', leaseId: 'lease-1' })
      .expect(200);

    expect(PipelineTask.findOneAndUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        pipelineId: '0711',
        status: 'in_progress',
        assignee: 'worker-a',
        'automationLease.leaseId': 'lease-1',
        'automationLease.expiresAt': { $gt: expect.any(Date) },
      }),
      {
        $set: {
          status: 'blocked',
          'automationAttempts.$[attempt].finalState': 'blocked',
          'automationAttempts.$[attempt].completedAt': expect.any(Date),
        },
        $unset: { automationLease: 1 },
      },
      { new: true, arrayFilters: [{ 'attempt.leaseId': 'lease-1' }] }
    );
    expect(pipelineTaskService.releaseAutomationSlot).toHaveBeenCalledWith({
      leaseId: 'lease-1',
      pipelineId: '0711',
      assignee: 'worker-a',
    });
  });

  test('retains remote operator finalization and its existing force override', async () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-secret';
    PipelineTask.findOne.mockResolvedValue({
      pipelineId: '0703', status: 'in_progress', assignee: 'remote-worker'
    });
    PipelineTask.findOneAndUpdate.mockResolvedValue({ pipelineId: '0703', status: 'done' });

    await request(createApp({ ip: REMOTE_IP }))
      .post('/api/pipeline/tasks/0703/status')
      .set('Host', 'operator.example')
      .set('X-AgentX-Operator-Token', 'operator-secret')
      .send({ status: 'done' })
      .expect(200);

    expect(PipelineTask.findOneAndUpdate).toHaveBeenCalledWith(
      { pipelineId: '0703' },
      {
        $set: { status: 'done' },
        $push: { feedback: expect.objectContaining({ by: 'operator' }) }
      },
      { new: true }
    );
  });

  test('retains explicit trusted internal-machine access without the worker token', async () => {
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';
    pipelineTaskService.claimEligibleTask.mockResolvedValue({
      pipelineId: '0704', status: 'in_progress', assignee: 'local-harness'
    });

    await request(createApp({ ip: REMOTE_IP }))
      .post('/api/pipeline/tasks/0704/claim')
      .set('Host', 'core:3080')
      .send({ assignee: 'local-harness' })
      .expect(200);

    expect(pipelineTaskService.claimEligibleTask).toHaveBeenCalledWith('0704', 'local-harness');
  });

  test.each([
    ['missing', 'pipeline-secret', undefined],
    ['wrong', 'pipeline-secret', 'not-the-secret'],
    ['unconfigured', undefined, 'orphaned-token'],
  ])('rejects the bounded next-task read with a %s remote credential before task selection', async (
    _credentialState, configured, presented
  ) => {
    if (configured !== undefined) process.env.AGENTX_PIPELINE_TOKEN = configured;
    let pending = request(createApp({ ip: REMOTE_IP }))
      .get('/api/pipeline/tasks/next?agent=remote-worker')
      .set('Host', 'remote-worker.example');
    if (presented !== undefined) pending = pending.set('X-AgentX-Pipeline-Token', presented);

    const response = await pending.expect(403);

    expect(response.body.code).toBe('PIPELINE_ACCESS_REQUIRED');
    expect(pipelineTaskService.findNextEligibleTask).not.toHaveBeenCalled();
  });

  test('admits the exact worker token to the bounded next-task read', async () => {
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-secret';
    pipelineTaskService.findNextEligibleTask.mockResolvedValue({
      pipelineId: '0706', status: 'queued', assignee: null
    });
    const app = createApp({ ip: REMOTE_IP });

    const next = await request(app)
      .get('/api/pipeline/tasks/next?agent=remote-worker')
      .set('Host', 'remote-worker.example')
      .set('X-AgentX-Pipeline-Token', 'pipeline-secret')
      .expect(200);

    expect(next.body.data.nextTaskId).toBe('0706');
    expect(pipelineTaskService.findNextEligibleTask).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'remote-worker' })
    );
  });
});
