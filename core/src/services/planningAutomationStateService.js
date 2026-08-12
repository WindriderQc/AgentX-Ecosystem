const PlanningAutomationState = require('../../models/PlanningAutomationState');

const DEFAULT_LEASE_MS = 120000;

function sanitizeError(error) {
  const raw = error?.message || error;
  if (!raw) return '';
  return String(raw)
    .replace(/\b(token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .slice(0, 500);
}

async function acquireLease(collector, owner, now, leaseMs = DEFAULT_LEASE_MS) {
  const expiresAt = new Date(now.getTime() + leaseMs);
  const existing = await PlanningAutomationState.findOne({ collector });
  if (
    existing?.lease?.owner
    && existing.lease.owner !== owner
    && existing.lease.expiresAt
    && existing.lease.expiresAt > now
  ) {
    return { acquired: false, reason: 'lease held by another reconciler' };
  }
  if (existing) {
    const state = await PlanningAutomationState.findOneAndUpdate({
      _id: existing._id,
      $or: [
        { 'lease.owner': owner },
        { 'lease.owner': '' },
        { 'lease.expiresAt': null },
        { 'lease.expiresAt': { $lte: now } }
      ]
    }, {
      $set: {
        'lease.owner': owner,
        'lease.expiresAt': expiresAt,
        lastRunAt: now,
        status: 'running',
        error: ''
      }
    }, { new: true });
    return state
      ? { acquired: true, state }
      : { acquired: false, reason: 'lease held by another reconciler' };
  }
  try {
    const state = await PlanningAutomationState.create({
      collector,
      lease: { owner, expiresAt },
      lastRunAt: now,
      status: 'running'
    });
    return { acquired: true, state };
  } catch (error) {
    if (error?.code === 11000 || /duplicate key/i.test(error?.message || '')) {
      return { acquired: false, reason: 'lease held by another reconciler' };
    }
    throw error;
  }
}

async function finishLease(collector, owner, {
  status,
  error = '',
  statistics,
  cursor,
  now = new Date()
}) {
  const update = {
    'lease.owner': '',
    'lease.expiresAt': null,
    status,
    error: sanitizeError(error),
    statistics
  };
  if (status === 'ok') {
    update.lastSuccessAt = now;
    if (cursor !== undefined) update.cursor = cursor;
  }
  await PlanningAutomationState.updateOne(
    { collector, 'lease.owner': owner },
    { $set: update }
  );
}

module.exports = {
  DEFAULT_LEASE_MS,
  sanitizeError,
  acquireLease,
  finishLease
};
