'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));

jest.mock('../../models/Roundtable', () => ({
  create: jest.fn(async (doc) => doc),
  updateOne: jest.fn(async () => ({ acknowledged: true })),
  updateMany: jest.fn(async () => ({ acknowledged: true, modifiedCount: 0 })),
  findById: jest.fn(async () => null),
  find: jest.fn(() => ({ sort: () => ({ skip: () => ({ limit: async () => [] }) }) })),
  countDocuments: jest.fn(async () => 0)
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  getByHost: jest.fn(),
  resolvePinnedRuntimeOptions: jest.fn()
}));

jest.mock('../../src/services/roundtable/runtimeParticipantAdapter', () => ({
  callRuntimeParticipant: jest.fn()
}));

const Roundtable = require('../../models/Roundtable');
const {
  reconcileStaleRoundtables,
  getRoundtable,
  listRoundtables,
  emitterRegistry,
  STALE_ERROR
} = require('../../src/services/roundtable/orchestrator');
const { DEFAULT_TOTAL_TIMEOUT_MS } = require('../../src/services/roundtable/defaults');

describe('Council stale session reconciliation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    emitterRegistry.clear();
  });

  test('closes pending/running sessions older than the total ceiling as failed with a reason', async () => {
    Roundtable.updateMany.mockResolvedValueOnce({ modifiedCount: 2 });
    const now = Date.parse('2026-09-02T12:00:00.000Z');

    const result = await reconcileStaleRoundtables({ now });

    expect(result.reconciled).toBe(2);
    const [filter, update] = Roundtable.updateMany.mock.calls[0];
    expect(filter.status).toEqual({ $in: ['pending', 'running'] });
    expect(filter.updatedAt.$lt.getTime()).toBe(now - DEFAULT_TOTAL_TIMEOUT_MS - 60 * 1000);
    expect(filter._id).toBeUndefined();
    expect(update.$set).toMatchObject({ status: 'failed', error: STALE_ERROR });
    expect(update.$set.completedAt.getTime()).toBe(now);
  });

  test('never touches a session this process is still driving', async () => {
    emitterRegistry.set('abc123', {});

    await reconcileStaleRoundtables();

    const [filter] = Roundtable.updateMany.mock.calls[0];
    expect(filter._id).toEqual({ $nin: ['abc123'] });
  });

  test('reads reconcile before returning sessions so a stale RUNNING is never served', async () => {
    await getRoundtable('abc123');
    await listRoundtables();

    expect(Roundtable.updateMany).toHaveBeenCalledTimes(2);
    expect(Roundtable.findById).toHaveBeenCalledWith('abc123');
  });

  test('a reconcile failure does not block reads', async () => {
    Roundtable.updateMany.mockRejectedValueOnce(new Error('mongo down'));
    await expect(getRoundtable('abc123')).resolves.toBeNull();
  });
});
