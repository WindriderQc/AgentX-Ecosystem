const PipelineTask = require('../../models/PipelineTask');
const preparation = require('../../src/services/pipelineTaskPreparationService');
beforeEach(async () => { await PipelineTask.deleteMany({}); });

async function create(changes = {}) {
  const task = await PipelineTask.create({ pipelineId: '0991', title: 'A coding task', service: 'core', status: 'queued', spec: 'Keep this specification', ...changes });
  return task.toObject();
}
async function apply(task, changes) {
  return preparation.apply({ pipelineId: task.pipelineId, expectedUpdatedAt: task.updatedAt.toISOString(), ...changes });
}
test('planning question and operator answer persist together without replacing the task', async () => {
  const task = await create();
  const blocked = await apply(task, { question: 'Which layout?', answer: 'On the Pipeline page.' });
  expect(blocked.status).toBe('blocked');
  expect(blocked.spec).toBe(task.spec);
  expect(blocked.feedback.map(e => e.text)).toEqual(['On the Pipeline page.', 'Which layout?']);
  const resumed = await apply(blocked, { answer: 'Compact.' });
  expect(resumed.status).toBe('queued');
  expect(resumed.feedback.at(-1).text).toBe('Compact.');
});
test('prepared local intent is normalized by Core with review and merge decisions', async () => {
  const task = await create();
  const automation = { schema: 'agentx.pipeline-automation/v1', mode: 'review_only', policyRef: 'product.core-code/v1', dataClassification: 'internal',
    operations: ['create', 'update'], scope: ['core/public/js/example.js'], sourceFiles: ['AGENTS.md'], lockKeys: ['repo:product:code'],
    executionProfile: 'worker/v1', verificationProfile: 'tests/v1', humanGates: ['review', 'merge'],
    budgets: { maxDurationMs: 600000, maxAttempts: 2, maxCostNanodollars: 0 } };
  const prepared = await apply(task, { automation, plan: 'Implement and verify the requested behavior.' });
  expect(prepared).toMatchObject({ status: 'queued', risk: 'low', automationAttemptCount: 0 });
  expect(prepared.automation.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  expect(prepared.automation.humanGates).toEqual(['merge', 'review']);
});
test('concurrent preparation cannot overwrite a new question or operator edit', async () => {
  const task = await create();
  const results = await Promise.allSettled([apply(task, { question: 'A?' }), apply(task, { question: 'B?' })]);
  expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(results.find(r => r.status === 'rejected').reason.statusCode).toBe(409);
  expect((await preparation.read(task.pipelineId)).task.feedback).toHaveLength(1);
});
test.each([{ status: 'in_progress' }, { assignee: 'another-worker' }, { service: 'family' }])('preparation preserves incompatible lifecycle and ownership: %j', async changes => {
  const task = await create(changes);
  await expect(apply(task, { question: 'Should not be saved' })).rejects.toMatchObject({ statusCode: 409 });
  expect((await preparation.read(task.pipelineId)).task.feedback).toHaveLength(0);
});
test('resume releases a blocked automated claim and records the attempt decision', async () => {
  await create();
  await PipelineTask.updateOne({ pipelineId: '0991' }, { $set: { status: 'blocked', assignee: 'worker', automation: { mode: 'review_only' }, automationAttemptCount: 1,
    automationAttempts: [{ attempt: 1, leaseId: 'old', finalState: 'blocked', assignee: 'worker', acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date() }] } });
  const { task } = await preparation.read('0991');
  const resumed = await apply(task, { answer: 'Keep the existing layout.' });
  expect(resumed).toMatchObject({ status: 'queued', assignee: null, automationAttemptCount: 1 });
  expect(resumed.automationAttempts[0]).toMatchObject({ finalState: 'blocked', reviewOutcome: 'requeued' });
  expect(resumed.automationAttempts[0].reviewedAt).toBeInstanceOf(Date);
});
