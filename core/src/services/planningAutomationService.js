const crypto = require('crypto');
const mongoose = require('mongoose');
const PlanningItem = require('../../models/PlanningItem');
const PlanningAutomationState = require('../../models/PlanningAutomationState');
const planningMetricRegistry = require('./planningMetricRegistry');
const planningMetricAdapterService = require('./planningMetricAdapterService');
const planningEvidenceService = require('./planningEvidenceService');
const {
  DEFAULT_LEASE_MS,
  sanitizeError,
  acquireLease,
  finishLease
} = require('./planningAutomationStateService');

function itemScopeQuery(itemId) {
  if (!itemId) return {};
  if (mongoose.isValidObjectId(itemId)) return { _id: new mongoose.Types.ObjectId(itemId) };
  return { key: String(itemId).trim() };
}

function effectiveObservationStatus(metric, now = new Date()) {
  const observation = metric?.observation || {};
  if (!metric?.adapter) return 'unconfigured';
  if (['degraded', 'unavailable'].includes(observation.status)) return observation.status;
  if (!observation.observedAt) return 'unavailable';
  const staleAfterMs = Number(metric.staleAfterMs || 21600000);
  return now.getTime() - new Date(observation.observedAt).getTime() > staleAfterMs
    ? 'stale'
    : (observation.status || 'fresh');
}

function isDue(item, now, force) {
  if (force) return true;
  const observedAt = item.progress?.metric?.observation?.observedAt;
  if (!observedAt) return true;
  const refreshEveryMs = Number(item.progress?.metric?.refreshEveryMs || 3600000);
  return now.getTime() - new Date(observedAt).getTime() >= refreshEveryMs;
}

function compactResult(item, result, status, error = '') {
  return {
    itemId: String(item._id),
    key: item.key || '',
    title: item.title,
    adapter: item.progress.metric.adapter,
    status,
    value: result?.value ?? item.progress.metric.observation?.value ?? null,
    observedAt: result?.observedAt || item.progress.metric.observation?.observedAt || null,
    error: error ? sanitizeError(error) : '',
    metadata: result?.metadata || {}
  };
}

async function applySuccess(item, result) {
  item.progress.metric.current = result.value;
  item.progress.metric.observation = {
    value: result.value,
    observedAt: result.observedAt,
    status: 'fresh',
    error: ''
  };
  await item.save();
}

async function applyFailure(item, error) {
  const current = item.progress.metric.observation?.toObject
    ? item.progress.metric.observation.toObject()
    : (item.progress.metric.observation || {});
  item.progress.metric.observation = {
    value: current.value ?? null,
    observedAt: current.observedAt || null,
    status: current.observedAt ? 'degraded' : 'unavailable',
    error: sanitizeError(error)
  };
  await item.save();
}

async function reconcileGroup(adapter, items, options) {
  const { dryRun, force, owner, now, leaseMs } = options;
  const collector = `metric:${adapter}`;
  const statistics = { scanned: items.length, updated: 0, failed: 0, skipped: 0 };
  const results = [];
  let lease = { acquired: true };
  if (!dryRun) lease = await acquireLease(collector, owner, now, leaseMs);
  if (!lease.acquired) {
    return {
      adapter,
      collector,
      status: 'leased',
      reason: lease.reason,
      statistics: { ...statistics, skipped: items.length },
      results
    };
  }
  for (const item of items) {
    if (!isDue(item, now, force)) {
      statistics.skipped += 1;
      results.push(compactResult(item, null, 'skipped'));
      continue;
    }
    try {
      const result = await planningMetricAdapterService.execute(adapter, item, { now });
      if (!dryRun) await applySuccess(item, result);
      statistics.updated += 1;
      results.push(compactResult(item, result, dryRun ? 'preview' : 'fresh'));
    } catch (error) {
      if (!dryRun) await applyFailure(item, error);
      statistics.failed += 1;
      results.push(compactResult(item, null, dryRun ? 'preview_error' : 'degraded', error));
    }
  }
  const status = statistics.failed ? 'degraded' : 'ok';
  if (!dryRun) {
    await finishLease(collector, owner, {
      status,
      error: statistics.failed ? `${statistics.failed} metric refresh(es) failed` : '',
      statistics,
      now
    });
  }
  return { adapter, collector, status, statistics, results };
}

async function reconcile({
  dryRun = true,
  source = '',
  itemId = '',
  force = false,
  owner = `planning-api:${process.pid}:${crypto.randomUUID()}`,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS
} = {}) {
  const normalizedSource = String(source || '').trim();
  const normalizedOwner = String(owner || `planning-api:${process.pid}:${crypto.randomUUID()}`)
    .trim()
    .slice(0, 160);
  const evidenceSource = normalizedSource.startsWith('evidence.')
    ? normalizedSource.slice('evidence.'.length)
    : '';
  if (normalizedSource && !evidenceSource) planningMetricRegistry.getDefinition(normalizedSource);
  const items = evidenceSource
    ? []
    : await PlanningItem.find({
      status: { $ne: 'archived' },
      'progress.mode': 'metric',
      'progress.metric.adapter': normalizedSource || { $nin: ['', null] },
      ...itemScopeQuery(itemId)
    }).sort({ 'progress.metric.adapter': 1, key: 1, _id: 1 });
  const groups = new Map();
  for (const item of items) {
    const adapter = item.progress.metric.adapter;
    if (!groups.has(adapter)) groups.set(adapter, []);
    groups.get(adapter).push(item);
  }
  const groupResults = [];
  for (const [adapter, rows] of groups) {
    groupResults.push(await reconcileGroup(adapter, rows, {
      dryRun, force, owner: normalizedOwner, now, leaseMs
    }));
  }
  const metricTotals = groupResults.reduce((sum, group) => ({
    scanned: sum.scanned + group.statistics.scanned,
    updated: sum.updated + group.statistics.updated,
    failed: sum.failed + group.statistics.failed,
    skipped: sum.skipped + group.statistics.skipped
  }), { scanned: 0, updated: 0, failed: 0, skipped: 0 });
  const evidence = (!normalizedSource || evidenceSource)
    ? await planningEvidenceService.reconcile({
      dryRun,
      source: evidenceSource,
      itemId,
      force,
      owner: normalizedOwner,
      now,
      leaseMs
    })
    : { dryRun, source: 'skipped', itemId: itemId || '', totals: {
      scanned: 0, updated: 0, failed: 0, skipped: 0
    }, groups: [] };
  const totals = {
    scanned: metricTotals.scanned + evidence.totals.scanned,
    updated: metricTotals.updated + evidence.totals.updated,
    failed: metricTotals.failed + evidence.totals.failed,
    skipped: metricTotals.skipped + evidence.totals.skipped
  };
  return {
    dryRun,
    source: normalizedSource || 'all',
    itemId: itemId || '',
    totals,
    groups: groupResults,
    evidence
  };
}

async function getStatus({ now = new Date() } = {}) {
  const [states, items] = await Promise.all([
    PlanningAutomationState.find({}).sort({ collector: 1 }).lean(),
    PlanningItem.find({
      status: { $ne: 'archived' },
      'progress.mode': 'metric',
      'progress.metric.adapter': { $nin: ['', null] }
    }).select('key title progress.metric').sort({ key: 1, _id: 1 }).lean()
  ]);
  return {
    collectors: states.map((state) => ({
      collector: state.collector,
      status: state.status,
      lastRunAt: state.lastRunAt,
      lastSuccessAt: state.lastSuccessAt,
      cursor: state.cursor,
      lease: state.lease,
      error: state.error,
      statistics: state.statistics
    })),
    items: items.map((item) => ({
      itemId: String(item._id),
      key: item.key || '',
      title: item.title,
      adapter: item.progress.metric.adapter,
      status: effectiveObservationStatus(item.progress.metric, now),
      value: item.progress.metric.observation?.value ?? null,
      observedAt: item.progress.metric.observation?.observedAt || null,
      error: item.progress.metric.observation?.error || ''
    }))
  };
}

module.exports = {
  DEFAULT_LEASE_MS,
  sanitizeError,
  effectiveObservationStatus,
  isDue,
  acquireLease,
  finishLease,
  reconcile,
  getStatus
};
