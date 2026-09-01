'use strict';

const mockOutcomeFind = jest.fn();
const mockTaskFind = jest.fn();
const mockLogFind = jest.fn();

jest.mock('../../models/LlmOutcome', () => ({ find: mockOutcomeFind }));
jest.mock('../../models/PipelineTask', () => ({ find: mockTaskFind }));
jest.mock('../../models/InferenceLog', () => ({ find: mockLogFind }));

const { readEffectivenessSnapshot } = require('../../src/services/llmEffectivenessService');

function emptyQuery() {
  return {
    select() { return this; },
    sort() { return this; },
    limit() { return this; },
    lean() { return Promise.resolve([]); },
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
    expect(mockOutcomeFind).not.toHaveBeenCalled();
    expect(mockTaskFind).not.toHaveBeenCalled();
    expect(mockLogFind).not.toHaveBeenCalled();
  });
});
