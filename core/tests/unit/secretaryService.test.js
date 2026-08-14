/**
 * Unit tests for the secretary lane (task 0457).
 * Mongoose model + Counter are mocked; this covers the logic that makes the
 * lane usable by voice: light capture, urgency ordering, natural-reference
 * resolution, and the refusal to guess between ambiguous matches.
 */

jest.mock('../../models/PipelineTask', () => {
  const fn = jest.fn();
  fn.create = jest.fn();
  fn.find = jest.fn();
  fn.findOne = jest.fn();
  return fn;
});
jest.mock('../../models/Counter', () => ({ next: jest.fn() }));

const PipelineTask = require('../../models/PipelineTask');
const Counter = require('../../models/Counter');
const {
  SecretaryError,
  addPersonalTask,
  listPersonalTasks,
  completePersonalTask,
  parseDueAt
} = require('../../src/services/secretaryService');

/** Chainable find() stub ending in .lean() */
function findReturning(rows) {
  const chain = {
    select: () => chain,
    limit: () => chain,
    lean: async () => rows
  };
  return chain;
}

beforeEach(() => {
  jest.clearAllMocks();
  Counter.next.mockResolvedValue(462);
});

describe('parseDueAt', () => {
  test('accepts ISO dates, rejects natural language', () => {
    expect(parseDueAt('2026-08-01')).toBeInstanceOf(Date);
    expect(parseDueAt('')).toBeNull();
    expect(parseDueAt(undefined)).toBeNull();
    expect(() => parseDueAt('next friday')).toThrow(SecretaryError);
  });
});

describe('addPersonalTask', () => {
  test('captures with only a title — no dev-task ceremony', async () => {
    PipelineTask.create.mockImplementation(async (doc) => ({ ...doc, createdAt: new Date() }));

    const task = await addPersonalTask({ title: 'Call the plumber' });

    expect(task.id).toBe('0462');
    expect(task.title).toBe('Call the plumber');
    expect(task.status).toBe('queued');
    const doc = PipelineTask.create.mock.calls[0][0];
    expect(doc.service).toBe('personal');
    expect(doc.epic).toBe('Personal');
    expect(doc.priority).toBe(3);
    expect(doc.dueAt).toBeNull();
  });

  test('stores note, due date, clamped priority', async () => {
    PipelineTask.create.mockImplementation(async (doc) => ({ ...doc, createdAt: new Date() }));

    await addPersonalTask({
      title: 'Renew plates',
      note: 'SAAQ before month end',
      dueAt: '2026-08-31',
      priority: 99
    });

    const doc = PipelineTask.create.mock.calls[0][0];
    expect(doc.spec).toBe('SAAQ before month end');
    expect(doc.dueAt.toISOString()).toContain('2026-08-31');
    expect(doc.priority).toBe(5);
  });

  test('rejects an empty title', async () => {
    await expect(addPersonalTask({})).rejects.toMatchObject({ code: 'SECRETARY_TITLE_REQUIRED' });
    expect(PipelineTask.create).not.toHaveBeenCalled();
  });
});

describe('listPersonalTasks', () => {
  test('sorts overdue/soonest first and counts urgency', async () => {
    const past = new Date(Date.now() - 5 * 86_400_000);
    const future = new Date(Date.now() + 30 * 86_400_000);
    PipelineTask.find.mockReturnValue(findReturning([
      { pipelineId: '0310', title: 'No date, low prio', status: 'queued', priority: 5 },
      { pipelineId: '0311', title: 'Far off', status: 'queued', priority: 3, dueAt: future },
      { pipelineId: '0312', title: 'Overdue thing', status: 'queued', priority: 3, dueAt: past },
      { pipelineId: '0313', title: 'No date, high prio', status: 'queued', priority: 1 }
    ]));

    const result = await listPersonalTasks();

    expect(result.tasks.map((t) => t.id)).toEqual(['0312', '0311', '0313', '0310']);
    expect(result.overdueCount).toBe(1);
    expect(result.tasks[0].overdue).toBe(true);
    expect(result.tasks[1].overdue).toBe(false);
    expect(PipelineTask.find.mock.calls[0][0]).toEqual({
      service: 'personal',
      status: { $in: ['queued', 'in_progress', 'review', 'blocked'] }
    });
  });

  test('includeDone drops the status filter', async () => {
    PipelineTask.find.mockReturnValue(findReturning([]));
    await listPersonalTasks({ includeDone: true });
    expect(PipelineTask.find.mock.calls[0][0]).toEqual({ service: 'personal' });
  });
});

describe('completePersonalTask', () => {
  function personalDoc(overrides = {}) {
    return {
      pipelineId: '0319',
      title: 'Cancel Spotify subscription',
      status: 'queued',
      service: 'personal',
      priority: 3,
      feedback: [],
      save: jest.fn().mockResolvedValue(true),
      ...overrides
    };
  }

  test('completes by 4-digit id', async () => {
    const doc = personalDoc();
    PipelineTask.findOne.mockResolvedValue(doc);

    const result = await completePersonalTask({ ref: '0319', by: 'operator' });

    expect(doc.status).toBe('done');
    expect(doc.save).toHaveBeenCalled();
    expect(doc.feedback[0].by).toBe('operator');
    expect(result.alreadyDone).toBe(false);
    expect(result.task.status).toBe('done');
  });

  test('completes by natural title phrase — the voice path', async () => {
    const doc = personalDoc();
    PipelineTask.find.mockResolvedValue([doc, personalDoc({ pipelineId: '0320', title: 'Book dentist' })]);

    const result = await completePersonalTask({ ref: 'spotify' });

    expect(result.task.id).toBe('0319');
    expect(doc.status).toBe('done');
  });

  test('refuses to guess between ambiguous matches, returns candidates', async () => {
    PipelineTask.find.mockResolvedValue([
      personalDoc({ pipelineId: '0330', title: 'Call the plumber' }),
      personalDoc({ pipelineId: '0331', title: 'Call the accountant' })
    ]);

    await expect(completePersonalTask({ ref: 'call' })).rejects.toMatchObject({
      code: 'SECRETARY_AMBIGUOUS_REF',
      details: { candidates: [{ id: '0330' }, { id: '0331' }].map((c) => expect.objectContaining(c)) }
    });
  });

  test('404s when nothing matches', async () => {
    PipelineTask.find.mockResolvedValue([]);
    await expect(completePersonalTask({ ref: 'nonexistent' })).rejects.toMatchObject({
      code: 'SECRETARY_TASK_NOT_FOUND',
      status: 404
    });
  });

  test('refuses to close a dev-lane task by id', async () => {
    PipelineTask.findOne.mockResolvedValue(personalDoc({ pipelineId: '0453', service: 'core' }));
    await expect(completePersonalTask({ ref: '0453' })).rejects.toMatchObject({
      code: 'SECRETARY_NOT_PERSONAL',
      status: 409
    });
  });

  test('is idempotent on an already-done task', async () => {
    const doc = personalDoc({ status: 'done' });
    PipelineTask.findOne.mockResolvedValue(doc);
    const result = await completePersonalTask({ ref: '0319' });
    expect(result.alreadyDone).toBe(true);
    expect(doc.save).not.toHaveBeenCalled();
  });
});
