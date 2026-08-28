const express = require('express');
const request = require('supertest');

jest.mock('../../models/PipelineTask', () => ({
  find: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
}));

jest.mock('../../src/services/pipelineTaskService', () => ({
  createTaskInMongo: jest.fn(),
  findNextEligibleTask: jest.fn(),
  claimEligibleTask: jest.fn(),
}));

const PipelineTask = require('../../models/PipelineTask');
const pipelineTaskService = require('../../src/services/pipelineTaskService');
const pipelineRoutes = require('../../routes/pipeline');

function createApp() {
  const app = express();
  app.use(express.json());
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
        'planningItemIds', 'scheduleEntryIds', 'createdAt', 'updatedAt'
      ].join(' ')
    );
    expect(res.body.status).toBe('success');
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.tasks[0].pipelineId).toBe('0326');
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
});

describe('POST /api/pipeline/tasks/:id/feedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
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
