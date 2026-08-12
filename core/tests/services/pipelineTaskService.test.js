const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const {
  reconcile,
  normalizeTaskRoutingMetadata,
  createTaskInMongo,
  findNextEligibleTask,
  claimEligibleTask,
  assertNoDependencyCycle,
} = require('../../src/services/pipelineTaskService');

describe('pipelineTaskService.reconcile (bidirectional decision)', () => {
  // statuses are Leantime numeric: 3 New, 4 In Progress, 2 Review/Waiting, 1 Blocked, 0 Done
  it('creates when there is no card', () => expect(reconcile(3, null, null)).toBe('create'));
  it('is aligned when card matches want', () => expect(reconcile(4, 4, 4)).toBe('aligned'));
  it('pulls when only Leantime changed (human dragged the card)', () => expect(reconcile(3, 4, 3)).toBe('pull'));
  it('pushes when only Mongo changed (agent updated status)', () => expect(reconcile(4, 3, 3)).toBe('pushStatus'));
  it('conflicts — human wins — when both sides changed', () => expect(reconcile(4, 1, 3)).toBe('conflict'));
  it('conflicts on mismatch with no watermark', () => expect(reconcile(4, 3, null)).toBe('conflict'));
});

describe('pipeline task eligibility and metadata', () => {
  beforeEach(async () => {
    await PipelineTask.deleteMany({});
    await Counter.deleteMany({ _id: 'pipelineTask' });
  });

  test('normalizes priority, dependencies, dates, risk, and the surface_after alias', () => {
    const metadata = normalizeTaskRoutingMetadata({
      priority: '1',
      dependsOn: ['0042', '0042', '0043'],
      surface_after: '2026-08-07T12:00:00Z',
      dueAt: '2026-08-08T12:00:00Z',
      risk: 'HIGH',
    });

    expect(metadata).toMatchObject({
      priority: 1,
      dependsOn: ['0042', '0043'],
      risk: 'high',
    });
    expect(metadata.notBefore.toISOString()).toBe('2026-08-07T12:00:00.000Z');
    expect(metadata.dueAt.toISOString()).toBe('2026-08-08T12:00:00.000Z');
  });

  test.each([
    [{ priority: 0 }, 'INVALID_TASK_PRIORITY'],
    [{ dependsOn: ['abc'] }, 'INVALID_TASK_DEPENDENCIES'],
    [{ notBefore: 'tomorrow-ish' }, 'INVALID_TASK_DATE'],
    [{ risk: 'extreme' }, 'INVALID_TASK_RISK'],
  ])('rejects invalid routing metadata %#', (input, code) => {
    expect(() => normalizeTaskRoutingMetadata(input)).toThrow(
      expect.objectContaining({ code })
    );
  });

  test('persists creation metadata and requires referenced dependencies to exist', async () => {
    await PipelineTask.create({ pipelineId: '0042', title: 'prerequisite', status: 'done' });

    const created = await createTaskInMongo({
      title: 'scheduled work',
      service: 'core',
      priority: 2,
      dependsOn: ['0042'],
      notBefore: '2026-08-07T12:00:00Z',
      dueAt: '2026-08-08T12:00:00Z',
      risk: 'medium',
    });
    const stored = await PipelineTask.findOne({ pipelineId: created.pipelineId }).lean();

    expect(stored).toMatchObject({
      priority: 2,
      dependsOn: ['0042'],
      risk: 'medium',
    });
    expect(stored.notBefore.toISOString()).toBe('2026-08-07T12:00:00.000Z');
    await expect(createTaskInMongo({ title: 'bad dependency', dependsOn: ['0999'] }))
      .rejects.toMatchObject({ code: 'UNKNOWN_TASK_DEPENDENCY', status: 400 });
  });

  test('source-scoped idempotency keys return the existing task on retry', async () => {
    const first = await createTaskInMongo({
      title: 'memory follow-up', source: 'memory-review', sourceKey: 'candidate:abc',
    });
    const second = await createTaskInMongo({
      title: 'memory follow-up retry', source: 'memory-review', sourceKey: 'candidate:abc',
    });
    expect(second.pipelineId).toBe(first.pipelineId);
    expect(second.alreadyExisting).toBe(true);
    expect(await PipelineTask.countDocuments({ source: 'memory-review' })).toBe(1);
  });

  test('distinguishes an absent date gate from an explicitly cleared one', () => {
    // Absent: leave whatever is stored alone.
    expect(normalizeTaskRoutingMetadata({})).not.toHaveProperty('notBefore');
    expect(normalizeTaskRoutingMetadata({})).not.toHaveProperty('dueAt');

    // Explicitly cleared: surface the task now. Collapsing this to "absent"
    // silently keeps an old gate and the card stays invisible.
    expect(normalizeTaskRoutingMetadata({ notBefore: '' })).toHaveProperty('notBefore', null);
    expect(normalizeTaskRoutingMetadata({ notBefore: null })).toHaveProperty('notBefore', null);
    expect(normalizeTaskRoutingMetadata({ dueAt: '' })).toHaveProperty('dueAt', null);

    // An explicit null must not fall through to the surface_after alias.
    expect(normalizeTaskRoutingMetadata({
      notBefore: null,
      surface_after: '2026-08-07T12:00:00Z',
    })).toHaveProperty('notBefore', null);

    // The alias still applies when notBefore is genuinely absent.
    const aliased = normalizeTaskRoutingMetadata({ surface_after: '2026-08-07T12:00:00Z' });
    expect(aliased.notBefore.toISOString()).toBe('2026-08-07T12:00:00.000Z');
  });

  test('rejects self-dependencies and cycles that would make a task unclaimable', async () => {
    await expect(assertNoDependencyCycle('0500', ['0500']))
      .rejects.toMatchObject({ code: 'TASK_DEPENDENCY_CYCLE', status: 400 });

    // 0501 -> 0502 -> 0503. Closing the loop means giving 0503 a dependency
    // that reaches back to it, which is only visible two hops out.
    await PipelineTask.create([
      { pipelineId: '0501', title: 'a', dependsOn: ['0502'] },
      { pipelineId: '0502', title: 'b', dependsOn: ['0503'] },
      { pipelineId: '0503', title: 'c' },
    ]);
    await expect(assertNoDependencyCycle('0503', ['0501']))
      .rejects.toMatchObject({ code: 'TASK_DEPENDENCY_CYCLE' });

    // A shortcut edge across the same chain is acyclic and must stay allowed.
    await expect(assertNoDependencyCycle('0501', ['0503'])).resolves.toBeUndefined();
    // A brand-new task depending on the head of the chain terminates cleanly.
    await expect(assertNoDependencyCycle('0504', ['0501'])).resolves.toBeUndefined();
    await expect(assertNoDependencyCycle('0504', [])).resolves.toBeUndefined();
  });

  test('a task that depends on itself is never returned as eligible work', async () => {
    // Reachable today only by a hand-edited row, which is exactly the case the
    // guard exists for. Left undetected it reads as "no work available".
    await PipelineTask.create({ pipelineId: '0600', title: 'self blocked', dependsOn: ['0600'] });
    expect(await findNextEligibleTask({}, new Date('2026-08-06T12:00:00Z'))).toBeNull();
  });

  test('selects only eligible work by priority, due date, then pipeline id', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    await PipelineTask.create([
      { pipelineId: '0100', title: 'done dependency', status: 'done' },
      { pipelineId: '0101', title: 'open dependency', status: 'queued' },
      { pipelineId: '0200', title: 'blocked high priority', priority: 1, dependsOn: ['0101'] },
      { pipelineId: '0201', title: 'later due', priority: 1, dependsOn: ['0100'], dueAt: '2026-08-09T00:00:00Z' },
      { pipelineId: '0202', title: 'earlier due', priority: 1, dueAt: '2026-08-08T00:00:00Z' },
      { pipelineId: '0203', title: 'future', priority: 1, notBefore: '2026-08-07T00:00:00Z' },
      { pipelineId: '0204', title: 'lower priority', priority: 5 },
    ]);

    const next = await findNextEligibleTask({}, now);
    expect(next.pipelineId).toBe('0202');
  });

  test('claim rechecks time and dependencies, then permits only one concurrent winner', async () => {
    const now = new Date('2026-08-06T12:00:00Z');
    await PipelineTask.create([
      { pipelineId: '0300', title: 'future', notBefore: '2026-08-07T00:00:00Z' },
      { pipelineId: '0301', title: 'dependency', status: 'queued' },
      { pipelineId: '0302', title: 'blocked', dependsOn: ['0301'] },
      { pipelineId: '0303', title: 'claimable' },
    ]);

    await expect(claimEligibleTask('0300', 'worker-a', now))
      .rejects.toMatchObject({ code: 'TASK_NOT_READY', status: 409 });
    await expect(claimEligibleTask('0302', 'worker-a', now))
      .rejects.toMatchObject({ code: 'TASK_DEPENDENCIES_BLOCKED', status: 409 });

    const results = await Promise.allSettled([
      claimEligibleTask('0303', 'worker-a', now),
      claimEligibleTask('0303', 'worker-b', now),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason.code).toBe('TASK_UNAVAILABLE');
  });
});
