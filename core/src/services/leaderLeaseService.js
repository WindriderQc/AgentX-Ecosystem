'use strict';

const os = require('os');

const DEFAULT_COLLECTION = 'core_leader_leases';
const DEFAULT_TTL_MS = 30_000;
const DEFAULT_RENEW_MS = 10_000;

function flagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function defaultOwnerId() {
  return `${os.hostname()}:${process.pid}`;
}

function leaseCollection(db, collectionName = DEFAULT_COLLECTION) {
  if (!db || typeof db.collection !== 'function') {
    throw new Error('leader lease requires a Mongo db handle');
  }
  return db.collection(collectionName);
}

async function acquireOrRenewLease(db, options = {}) {
  const {
    name,
    ownerId = defaultOwnerId(),
    ttlMs = DEFAULT_TTL_MS,
    collectionName = DEFAULT_COLLECTION,
    now = new Date()
  } = options;
  if (!name) throw new Error('leader lease name is required');

  const col = leaseCollection(db, collectionName);
  const expiresAt = new Date(now.getTime() + ttlMs);
  const update = {
    $set: { ownerId, expiresAt, updatedAt: now },
    $setOnInsert: { createdAt: now }
  };

  const existing = await col.findOneAndUpdate(
    { _id: name, $or: [{ ownerId }, { expiresAt: { $lte: now } }] },
    update,
    { returnDocument: 'after' }
  );
  const renewed = existing?.value || existing;
  if (renewed && renewed.ownerId === ownerId) {
    return { acquired: true, lease: renewed };
  }

  try {
    await col.insertOne({ _id: name, ownerId, expiresAt, createdAt: now, updatedAt: now });
    return { acquired: true, lease: { _id: name, ownerId, expiresAt, createdAt: now, updatedAt: now } };
  } catch (err) {
    if (err && (err.code === 11000 || /duplicate key/i.test(err.message || ''))) {
      return { acquired: false, reason: 'lease held by another owner' };
    }
    throw err;
  }
}

async function releaseLease(db, options = {}) {
  const {
    name,
    ownerId = defaultOwnerId(),
    collectionName = DEFAULT_COLLECTION
  } = options;
  if (!name) throw new Error('leader lease name is required');
  const result = await leaseCollection(db, collectionName).deleteOne({ _id: name, ownerId });
  return { released: result.deletedCount === 1 };
}

async function startSingletonDaemon(options = {}) {
  const {
    name,
    db,
    enabled = flagEnabled(process.env.CORE_LEADER_LEASE_ENABLED),
    ownerId = defaultOwnerId(),
    ttlMs = DEFAULT_TTL_MS,
    renewMs = DEFAULT_RENEW_MS,
    collectionName = DEFAULT_COLLECTION,
    start,
    stop,
    logger = console
  } = options;
  if (!name) throw new Error('singleton daemon name is required');
  if (typeof start !== 'function') throw new Error('singleton daemon start callback is required');

  if (!enabled) {
    await start();
    return {
      mode: 'local-single-instance',
      isLeader: true,
      stop: async () => { if (typeof stop === 'function') await stop(); }
    };
  }

  let active = false;
  let closed = false;
  let renewTimer = null;

  const demote = async (reason) => {
    if (!active) return;
    active = false;
    logger.warn?.('[leader-lease] daemon demoted', { name, ownerId, reason });
    if (typeof stop === 'function') await stop();
  };

  const tick = async () => {
    if (closed) return;
    try {
      const result = await acquireOrRenewLease(db, { name, ownerId, ttlMs, collectionName });
      if (result.acquired) {
        if (!active) {
          await start();
          active = true;
          logger.info?.('[leader-lease] daemon promoted', { name, ownerId });
        }
        return;
      }
      await demote(result.reason || 'lease unavailable');
    } catch (err) {
      logger.warn?.('[leader-lease] daemon lease error', { name, ownerId, error: err.message });
      await demote(err.message);
    }
  };

  await tick();
  renewTimer = setInterval(() => { tick().catch(() => {}); }, Math.max(1000, renewMs));
  if (typeof renewTimer.unref === 'function') renewTimer.unref();

  return {
    mode: 'leader-lease',
    get isLeader() { return active; },
    stop: async () => {
      closed = true;
      if (renewTimer) clearInterval(renewTimer);
      if (active && typeof stop === 'function') await stop();
      active = false;
      await releaseLease(db, { name, ownerId, collectionName }).catch(() => ({ released: false }));
    }
  };
}

module.exports = {
  DEFAULT_COLLECTION,
  DEFAULT_TTL_MS,
  DEFAULT_RENEW_MS,
  flagEnabled,
  defaultOwnerId,
  acquireOrRenewLease,
  releaseLease,
  startSingletonDaemon
};
