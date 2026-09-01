'use strict';

const mockOutcomeFind = jest.fn();
const mockTaskFind = jest.fn();
const mockLogFind = jest.fn();

jest.mock('../../models/LlmOutcome', () => ({ find: mockOutcomeFind }));
jest.mock('../../models/PipelineTask', () => ({ find: mockTaskFind }));
jest.mock('../../models/InferenceLog', () => ({ find: mockLogFind }));

const { readEffectivenessSnapshot } = require('../../src/services/llmEffectivenessService');

function emptyQuery(rows = []) {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve(rows); },
  };
}

describe('exact effectiveness storage window', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockOutcomeFind.mockImplementation(() => emptyQuery());
    mockTaskFind.mockImplementation(() => emptyQuery());
    mockLogFind.mockImplementation(() => emptyQuery());
  });

  test('uses one half-open interval for outcomes, tasks, and inference logs', async () => {
    const from = new Date('2026-08-30T04:00:00.000Z');
    const to = new Date('2026-08-31T04:00:00.000Z');
    const snapshot = await readEffectivenessSnapshot({
      from: '2026-08-30T00:00:00-04:00',
      to: '2026-08-31T00:00:00-04:00',
      runtime: 'external',
      now: Date.parse('2026-09-01T00:00:00.000Z'),
    });

    expect(mockOutcomeFind).toHaveBeenCalledWith({
      completedAt: { $gte: from, $lt: to },
      runtime: 'external',
    });
    expect(mockTaskFind).toHaveBeenCalledWith({
      status: { $in: ['done', 'review', 'blocked'] },
      updatedAt: { $gte: from, $lt: to },
    });
    expect(mockLogFind).toHaveBeenCalledWith({ timestamp: { $gte: from, $lt: to } });
    expect(snapshot.window).toEqual({
      key: 'exact',
      from: from.toISOString(),
      to: to.toISOString(),
      endExclusive: true,
    });
    expect(snapshot.collection).toEqual({
      complete: true,
      truncated: { outcomes: false, pipelineTasks: false, inferenceLogs: false },
      limits: { outcomes: 5000, pipelineTasks: 5000, inferenceLogs: 50000 },
    });
  });

  test('marks an exact snapshot incomplete instead of silently accepting a storage cap', async () => {
    const rows = Array.from({ length: 5001 }, (_unused, index) => ({
      outcomeId: `outcome-${index}`,
      runtime: 'external',
      completedAt: new Date('2026-08-30T12:00:00.000Z'),
      verified: false,
      verdict: 'unknown',
    }));
    mockOutcomeFind.mockImplementation(() => emptyQuery(rows));
    const snapshot = await readEffectivenessSnapshot({
      from: '2026-08-30T00:00:00-04:00',
      to: '2026-08-31T00:00:00-04:00',
      runtime: 'external',
      now: Date.parse('2026-09-01T00:00:00.000Z'),
    });
    expect(snapshot.collection.complete).toBe(false);
    expect(snapshot.collection.truncated.outcomes).toBe(true);
    expect(snapshot.summary.reportedOutcomes).toBe(5000);
  });

  test('binds an outcome cohort to server-attested consumer-contract logs', async () => {
    mockLogFind.mockImplementation(() => emptyQuery([{
      _id: 'log-1', runtime: 'external', workItemId: 'task-1', correlationId: 'corr-1',
      consumerContract: 'openclaw-pipeline-runtime-v1', status: 'success', timestamp: new Date('2026-08-30T12:00:00Z'),
    }]));
    await readEffectivenessSnapshot({
      from: '2026-08-30T00:00:00-04:00', to: '2026-08-31T00:00:00-04:00',
      runtime: 'external', consumerContract: 'openclaw-pipeline-runtime-v1',
      now: Date.parse('2026-09-01T00:00:00.000Z'),
    });
    expect(mockLogFind).toHaveBeenCalledWith({
      timestamp: { $gte: new Date('2026-08-30T04:00:00.000Z'), $lt: new Date('2026-08-31T04:00:00.000Z') },
      consumerContract: 'openclaw-pipeline-runtime-v1',
    });
    expect(mockOutcomeFind).toHaveBeenCalledWith(expect.objectContaining({
      runtime: 'external',
      $or: [{ workItemId: { $in: ['task-1'] } }, { correlationId: { $in: ['corr-1'] } }],
    }));
    expect(mockTaskFind).toHaveBeenCalledWith(expect.objectContaining({ pipelineId: { $in: ['task-1'] } }));
  });

  test('rejects mixed and partial intervals before querying storage', async () => {
    await expect(readEffectivenessSnapshot({
      window: '7d',
      from: '2026-08-30T00:00:00-04:00',
      to: '2026-08-31T00:00:00-04:00',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_EFFECTIVENESS_WINDOW' });
    await expect(readEffectivenessSnapshot({
      from: '2026-08-30T00:00:00-04:00',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_EFFECTIVENESS_WINDOW' });
    await expect(readEffectivenessSnapshot({ from: '', to: '' }))
      .rejects.toMatchObject({ status: 400, code: 'INVALID_EFFECTIVENESS_WINDOW' });
    await expect(readEffectivenessSnapshot({
      from: '2026-08-30T00:00:00-04:00',
      to: '2026-08-31T00:00:00-04:00',
      consumerContract: '../untrusted',
    })).rejects.toMatchObject({ status: 400, code: 'INVALID_EFFECTIVENESS_COHORT' });
    expect(mockOutcomeFind).not.toHaveBeenCalled();
    expect(mockTaskFind).not.toHaveBeenCalled();
    expect(mockLogFind).not.toHaveBeenCalled();
  });
});
