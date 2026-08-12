const {
  acquireOrRenewLease,
  flagEnabled,
  releaseLease,
  startSingletonDaemon
} = require('../../src/services/leaderLeaseService');

function makeMockDb(initial = []) {
  const docs = new Map(initial.map(doc => [doc._id, { ...doc }]));
  const collection = {
    findOneAndUpdate: jest.fn(async (filter, update) => {
      const doc = docs.get(filter._id);
      if (!doc) return null;
      const canOwn = (filter.$or || []).some((branch) => {
        if (branch.ownerId && branch.ownerId === doc.ownerId) return true;
        const lte = branch.expiresAt?.$lte;
        return lte && doc.expiresAt <= lte;
      });
      if (!canOwn) return null;
      const next = { ...doc, ...(update.$set || {}) };
      docs.set(filter._id, next);
      return next;
    }),
    insertOne: jest.fn(async (doc) => {
      if (docs.has(doc._id)) {
        const err = new Error('duplicate key');
        err.code = 11000;
        throw err;
      }
      docs.set(doc._id, { ...doc });
      return { insertedId: doc._id };
    }),
    deleteOne: jest.fn(async (filter) => {
      const doc = docs.get(filter._id);
      if (doc && doc.ownerId === filter.ownerId) {
        docs.delete(filter._id);
        return { deletedCount: 1 };
      }
      return { deletedCount: 0 };
    })
  };
  return {
    docs,
    collection: jest.fn(() => collection)
  };
}

describe('leaderLeaseService', () => {
  test('flagEnabled accepts explicit truthy values only', () => {
    expect(flagEnabled('1')).toBe(true);
    expect(flagEnabled('true')).toBe(true);
    expect(flagEnabled('on')).toBe(true);
    expect(flagEnabled('0')).toBe(false);
    expect(flagEnabled(undefined)).toBe(false);
  });

  test('startSingletonDaemon preserves single-instance behavior when disabled', async () => {
    const start = jest.fn(async () => {});
    const stop = jest.fn(async () => {});

    const controller = await startSingletonDaemon({
      name: 'reaper',
      enabled: false,
      start,
      stop
    });

    expect(controller.mode).toBe('local-single-instance');
    expect(controller.isLeader).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);

    await controller.stop();
    expect(stop).toHaveBeenCalledTimes(1);
  });

  test('acquireOrRenewLease inserts, blocks active contenders, and allows expired takeover', async () => {
    const db = makeMockDb();
    const now = new Date('2026-07-03T15:00:00.000Z');

    await expect(acquireOrRenewLease(db, {
      name: 'reaper',
      ownerId: 'a',
      ttlMs: 30_000,
      now
    })).resolves.toMatchObject({ acquired: true });

    await expect(acquireOrRenewLease(db, {
      name: 'reaper',
      ownerId: 'b',
      ttlMs: 30_000,
      now: new Date('2026-07-03T15:00:10.000Z')
    })).resolves.toMatchObject({ acquired: false });

    await expect(acquireOrRenewLease(db, {
      name: 'reaper',
      ownerId: 'b',
      ttlMs: 30_000,
      now: new Date('2026-07-03T15:00:31.000Z')
    })).resolves.toMatchObject({ acquired: true });

    expect(db.docs.get('reaper').ownerId).toBe('b');
  });

  test('startSingletonDaemon with enabled lease starts only for the lease owner and releases on stop', async () => {
    const db = makeMockDb();
    const start = jest.fn(async () => {});
    const stop = jest.fn(async () => {});

    const controller = await startSingletonDaemon({
      name: 'reaper',
      db,
      enabled: true,
      ownerId: 'owner-a',
      ttlMs: 30_000,
      renewMs: 60_000,
      start,
      stop,
      logger: { info: jest.fn(), warn: jest.fn() }
    });

    expect(controller.mode).toBe('leader-lease');
    expect(controller.isLeader).toBe(true);
    expect(start).toHaveBeenCalledTimes(1);
    expect(db.docs.get('reaper').ownerId).toBe('owner-a');

    await controller.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(db.docs.has('reaper')).toBe(false);
  });

  test('releaseLease does not release another owner', async () => {
    const db = makeMockDb([{ _id: 'reaper', ownerId: 'other', expiresAt: new Date(Date.now() + 60_000) }]);

    await expect(releaseLease(db, {
      name: 'reaper',
      ownerId: 'owner-a'
    })).resolves.toEqual({ released: false });

    expect(db.docs.has('reaper')).toBe(true);
  });
});
