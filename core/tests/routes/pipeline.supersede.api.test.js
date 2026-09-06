/**
 * Mark superseded: a two-step, signed, immutable closure that never
 * re-queues and cannot be reopened by accident.
 */
const express = require('express');
const request = require('supertest');

jest.mock('../../models/PipelineTask', () => ({
  find: jest.fn(),
  aggregate: jest.fn(),
  findOne: jest.fn(),
  findOneAndUpdate: jest.fn(),
  updateOne: jest.fn(),
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
const pipelineRoutes = require('../../routes/pipeline');

function createApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.defineProperty(req, 'ip', { value: '127.0.0.1', configurable: true }); next(); });
  app.use('/api/pipeline', pipelineRoutes);
  return app;
}

const task = (over = {}) => ({
  pipelineId: '0614', title: 'Old approach', status: 'blocked', assignee: 'codex', heartbeatAt: new Date('2026-09-01T00:00:00Z'),
  feedback: [], automationLease: undefined, resolution: undefined, ...over,
});
const replacement = (over = {}) => ({ pipelineId: '0620', title: 'New approach', status: 'queued', resolution: undefined, ...over });

function mockTasks(byId) {
  PipelineTask.findOne.mockImplementation(async (query) => byId[query.pipelineId] || null);
}

describe('POST /api/pipeline/tasks/:id/supersede', () => {
  beforeEach(() => jest.clearAllMocks());

  test('previews the exact transition and checks without touching the task', async () => {
    mockTasks({ '0614': task(), '0620': replacement() });
    const res = await request(createApp()).post('/api/pipeline/tasks/0614/supersede')
      .send({ supersededBy: '0620', reason: 'Replaced by the evidence-contract approach', by: 'yanik' });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ preview: true, applied: false, ok: true, blocked: [] });
    expect(res.body.data.transition).toMatchObject({ pipelineId: '0614', from: 'blocked', to: 'done', requeue: false, keepsAssignee: 'codex', clearsHeartbeat: true });
    expect(res.body.data.transition.resolution).toMatchObject({ kind: 'superseded', supersededBy: '0620', by: 'yanik' });
    expect(res.body.data.checks.map((c) => [c.id, c.ok])).toEqual([
      ['replacement_required', true], ['replacement_differs', true], ['replacement_exists', true], ['replacement_not_superseded', true],
      ['reason_required', true], ['decision_signed', true], ['not_already_closed', true], ['no_active_automation_lease', true],
    ]);
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
    expect(PipelineTask.updateOne).not.toHaveBeenCalled();
  });

  test('a preview names every blocker: self, missing replacement, short reason, unsigned, closed, superseded replacement, lease', async () => {
    mockTasks({ '0614': task({ status: 'done', automationLease: { leaseId: 'l1' } }), '0700': replacement({ resolution: { kind: 'superseded', supersededBy: '0701' } }) });
    const self = await request(createApp()).post('/api/pipeline/tasks/0614/supersede').send({ supersededBy: '0614', reason: 'short', by: '' });
    expect(self.body.data.ok).toBe(false);
    expect(self.body.data.blocked).toEqual(expect.arrayContaining(['replacement_differs', 'replacement_exists', 'reason_required', 'decision_signed', 'not_already_closed', 'no_active_automation_lease']));

    const chained = await request(createApp()).post('/api/pipeline/tasks/0614/supersede').send({ supersededBy: '0700', reason: 'long enough reason', by: 'yanik' });
    expect(chained.body.data.blocked).toEqual(expect.arrayContaining(['replacement_not_superseded']));
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test('confirm applies the transition, records both audit trails, and refuses when blocked', async () => {
    mockTasks({ '0614': task(), '0620': replacement() });
    PipelineTask.findOneAndUpdate.mockResolvedValue(task({ status: 'done', resolution: { kind: 'superseded', supersededBy: '0620' } }));
    PipelineTask.updateOne.mockResolvedValue({ acknowledged: true });

    const res = await request(createApp()).post('/api/pipeline/tasks/0614/supersede')
      .send({ supersededBy: '0620', reason: 'Replaced by the evidence-contract approach', by: 'yanik', confirm: true });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ preview: false, applied: true });
    const [filter, update] = PipelineTask.findOneAndUpdate.mock.calls[0];
    expect(filter).toEqual({ pipelineId: '0614', status: 'blocked' });
    expect(update.$set).toMatchObject({ status: 'done', heartbeatAt: null, resolution: { kind: 'superseded', supersededBy: '0620', by: 'yanik', reason: 'Replaced by the evidence-contract approach' } });
    expect(update.$set.assignee).toBeUndefined();
    expect(update.$push.feedback.text).toBe('Superseded by 0620: Replaced by the evidence-contract approach');
    expect(PipelineTask.updateOne).toHaveBeenCalledWith({ pipelineId: '0620' }, { $push: { feedback: expect.objectContaining({ by: 'yanik', text: 'Supersedes 0614: Replaced by the evidence-contract approach' }) } });

    mockTasks({ '0614': task({ status: 'done' }), '0620': replacement() });
    const blocked = await request(createApp()).post('/api/pipeline/tasks/0614/supersede')
      .send({ supersededBy: '0620', reason: 'Replaced by the evidence-contract approach', by: 'yanik', confirm: true });
    expect(blocked.status).toBe(409);
    expect(blocked.body.code).toBe('SUPERSEDE_BLOCKED');
  });

  test('a concurrent change between preview and confirm is refused instead of applied', async () => {
    mockTasks({ '0614': task(), '0620': replacement() });
    PipelineTask.findOneAndUpdate.mockResolvedValue(null);
    const res = await request(createApp()).post('/api/pipeline/tasks/0614/supersede')
      .send({ supersededBy: '0620', reason: 'Replaced by the evidence-contract approach', by: 'yanik', confirm: true });
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('SUPERSEDE_CONFLICT');
    expect(PipelineTask.updateOne).not.toHaveBeenCalled();
  });
});

describe('POST /api/pipeline/tasks/:id/status on a superseded task', () => {
  beforeEach(() => jest.clearAllMocks());

  test('refuses an accidental re-queue and allows only an explicit reopen', async () => {
    PipelineTask.findOne.mockResolvedValue(task({ status: 'done', resolution: { kind: 'superseded', supersededBy: '0620', reason: 'r', by: 'yanik', at: new Date() } }));
    const requeue = await request(createApp()).post('/api/pipeline/tasks/0614/status').send({ status: 'queued' });
    expect(requeue.status).toBe(409);
    expect(requeue.body.code).toBe('TASK_SUPERSEDED');
    expect(PipelineTask.findOneAndUpdate).not.toHaveBeenCalled();

    PipelineTask.findOneAndUpdate.mockResolvedValue(task({ status: 'queued' }));
    const reopen = await request(createApp()).post('/api/pipeline/tasks/0614/status').send({ status: 'queued', reopen: true, by: 'yanik' });
    expect(reopen.status).toBe(200);
    const [, update] = PipelineTask.findOneAndUpdate.mock.calls[0];
    expect(update.$unset).toMatchObject({ resolution: 1 });
    expect(update.$push.feedback.text).toBe('Reopened after supersession by 0620.');
  });
});
