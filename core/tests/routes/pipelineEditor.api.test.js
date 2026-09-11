const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const PlanningItem = require('../../models/PlanningItem');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const routes = require('../../routes/pipeline');
let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '512kb' }));
  app.use('/api/pipeline', routes);
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
async function create(input = {}) {
  const response = await harness.request.post('/api/pipeline/tasks').send({ title: 'A task', spec: '', ...input }).expect(201);
  return response.body.data.task.pipelineId;
}
async function read(id) { return (await harness.request.get(`/api/pipeline/tasks/${id}`).expect(200)).body.data; }
function patch(id, token, changes) { return harness.request.patch(`/api/pipeline/tasks/${id}`).send({ editToken: token, changes }); }

test('creation stores freeform Markdown, dates and roadmap links, with durable retry identity', async () => {
  const roadmap = await PlanningItem.create({ type: 'outcome', title: 'A usable pipeline' });
  const dependency = await create();
  const input = { title: 'New task', spec: '\n# Old format\r\nKeep [links](https://example.org) and whitespace.\n', source: 'pipeline-ui', sourceKey: 'editor-retry', dependsOn: [dependency], planningItemIds: [String(roadmap._id)], dueAt: '2026-10-02T18:00:00.000Z', priority: 2 };
  const id = await create(input);
  expect(await create(input)).toBe(id);
  expect(await PipelineTask.countDocuments({ source: input.source, sourceKey: input.sourceKey })).toBe(1);
  expect((await read(id)).task).toMatchObject({ title: input.title, spec: input.spec, status: 'queued', dueAt: input.dueAt, dependsOn: [dependency], planningItemIds: input.planningItemIds, priority: 2 });
  expect((await read(dependency)).task.spec).toBe('');
});

test('content edits retain assignment, live heartbeat, status, receipts and existing feedback', async () => {
  const id = await create({ spec: 'Existing spec' });
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { status: 'in_progress', assignee: 'other-worker', automationAttemptCount: 4, feedback: [{ by: 'reviewer', text: 'Existing receipt' }] } });
  const snapshot = await read(id);
  const heartbeat = new Date('2026-09-11T15:01:02.333Z');
  await PipelineTask.updateOne({ pipelineId: id }, { $set: { heartbeatAt: heartbeat }, $push: { feedback: { by: 'worker', text: 'Still working' } } });
  const response = await patch(id, snapshot.editToken, { title: 'Clarified task', spec: '' }).expect(200);
  expect(response.body.data.task).toMatchObject({ status: 'in_progress', assignee: 'other-worker', heartbeatAt: heartbeat.toISOString(), automationAttemptCount: 4, spec: '' });
  expect(response.body.data.task.feedback.map(item => item.text)).toEqual(['Existing receipt', 'Still working', 'Edited task: title, spec.']);
  const updated = response.body.data;
  await patch(id, updated.editToken, { title: 'Clarified task' }).expect(200);
  expect((await read(id)).task.feedback).toHaveLength(3);
});

test('simultaneous editors cannot silently overwrite each other', async () => {
  const id = await create();
  const { editToken } = await read(id);
  const responses = await Promise.all([patch(id, editToken, { spec: 'Editor A' }), patch(id, editToken, { spec: 'Editor B' })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  expect(responses.find(r => r.status === 409).body.code).toBe('TASK_EDIT_CONFLICT');
  const saved = await read(id);
  expect(saved.task.spec).toBe(responses.find(r => r.status === 200).body.data.task.spec);
  await patch(id, editToken, { title: 'Stale edit' }).expect(409);
  await patch(id, saved.editToken, { title: 'Compared edit' }).expect(200);
});

test.each([{ status: 'done' }, { assignee: 'new-owner' }, { feedback: [] }, { automation: {} }, { title: '' }, { priority: 6 }, { dueAt: 'not a date' }, { dependsOn: ['999999'] }, { planningItemIds: ['bad-id'] }, { spec: 'x'.repeat(100001) }].map(changes => [Object.keys(changes)[0], changes]))('rejects invalid or lifecycle edits: %s', async (_field, changes) => {
  const id = await create();
  const before = await read(id);
  await patch(id, before.editToken, changes).expect(400);
  expect((await read(id)).task).toEqual(before.task);
});

test('dependency edits reject unknown tasks, self references and cycles', async () => {
  const a = await create();
  const b = await create({ dependsOn: [a] });
  const snapshot = await read(a);
  for (const dependsOn of [['9999'], [a], [b]]) await patch(a, snapshot.editToken, { dependsOn }).expect(400);
  expect((await read(a)).task.dependsOn).toEqual([]);
});

test('existing archived roadmap links survive edits, but cannot be newly attached', async () => {
  const item = await PlanningItem.create({ type: 'outcome', title: 'Historical outcome' });
  const a = await create({ planningItemIds: [String(item._id)] });
  await PlanningItem.updateOne({ _id: item._id }, { $set: { status: 'archived' } });
  const snapshot = await read(a);
  await patch(a, snapshot.editToken, { title: 'Still editable', planningItemIds: [String(item._id)] }).expect(200);
  await harness.request.post('/api/pipeline/tasks').send({ title: 'Cannot attach archived item', planningItemIds: [String(item._id)] }).expect(400);
});

test('simultaneous dependency edits on different tasks cannot create a cycle', async () => {
  const a = await create(); const b = await create();
  const snapshots = await Promise.all([read(a), read(b)]);
  const responses = await Promise.all([patch(a, snapshots[0].editToken, { dependsOn: [b] }), patch(b, snapshots[1].editToken, { dependsOn: [a] })]);
  expect(responses.map(r => r.status).sort()).toEqual([200, 400]);
  expect(responses.find(r => r.status === 400).body.code).toBe('TASK_DEPENDENCY_CYCLE');
  expect((await read(a)).task.dependsOn.length + (await read(b)).task.dependsOn.length).toBe(1);
});

test('draft endpoint returns a proposal without persisting a task', async () => {
  const draftService = require('../../src/services/pipelineDraftService');
  const propose = jest.spyOn(draftService, 'proposeDraft').mockResolvedValue({ draft: { title: 'Proposal', spec: 'Draft only', service: 'core', priority: 3 } });
  const count = await PipelineTask.countDocuments();
  try {
    const response = await harness.request.post('/api/pipeline/draft').send({ instruction: 'A useful task' }).expect(200);
    expect(response.body.data.draft.title).toBe('Proposal');
    expect(await PipelineTask.countDocuments()).toBe(count);
    expect(propose.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  } finally { propose.mockRestore(); }
});
