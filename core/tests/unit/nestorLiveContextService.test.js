jest.mock('../../models/PipelineTask', () => ({
  aggregate: jest.fn(),
  find: jest.fn()
}));

const PipelineTask = require('../../models/PipelineTask');
const {
  buildPipelineSnapshot,
  formatPipelineSnapshot
} = require('../../src/services/nestorLiveContextService');

function mockFindResult(tasks) {
  const chain = {
    select: jest.fn(),
    sort: jest.fn(),
    limit: jest.fn(),
    lean: jest.fn().mockResolvedValue(tasks)
  };
  chain.select.mockReturnValue(chain);
  chain.sort.mockReturnValue(chain);
  chain.limit.mockReturnValue(chain);
  PipelineTask.find.mockReturnValue(chain);
  return chain;
}

beforeEach(() => jest.clearAllMocks());

test('builds authoritative totals and a bounded active-task list', async () => {
  PipelineTask.aggregate.mockResolvedValue([
    { _id: 'queued', count: 14 },
    { _id: 'review', count: 3 },
    { _id: 'blocked', count: 1 },
    { _id: 'done', count: 431 }
  ]);
  const chain = mockFindResult([
    { pipelineId: '0454', title: '  Latency   hygiene  ', status: 'queued', assignee: null, priority: 1 },
    { pipelineId: '0401', title: 'Security review', status: 'review', assignee: 'clawdx-coder', priority: 2 }
  ]);

  const snapshot = await buildPipelineSnapshot({ maxActiveTasks: 2 });

  expect(PipelineTask.find).toHaveBeenCalledWith({
    status: { $in: ['queued', 'in_progress', 'review', 'blocked'] }
  });
  expect(chain.limit).toHaveBeenCalledWith(2);
  expect(snapshot).toMatchObject({
    sourceOfTruth: 'mongodb:pipelinetasks',
    total: 449,
    activeCount: 18,
    counts: { queued: 14, in_progress: 0, review: 3, blocked: 1, done: 431 },
    truncated: true
  });
  expect(snapshot.activeTasks[0].title).toBe('Latency hygiene');
});

test('formats facts for model grounding without inventing missing tasks', () => {
  const text = formatPipelineSnapshot({
    sourceOfTruth: 'mongodb:pipelinetasks',
    generatedAt: '2026-07-27T21:00:00.000Z',
    total: 2,
    activeCount: 0,
    counts: { queued: 0, in_progress: 0, review: 0, blocked: 0, done: 2 },
    activeTasks: [],
    truncated: false
  });

  expect(text).toContain('Pipeline total=2; active=0');
  expect(text).toContain('done=2');
  expect(text).toContain('Active pipeline tasks:\n- none');
});
