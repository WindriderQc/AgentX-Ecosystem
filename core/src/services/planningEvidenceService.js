const crypto = require('crypto');
const mongoose = require('mongoose');
const PlanningItem = require('../../models/PlanningItem');
const PipelineTask = require('../../models/PipelineTask');
const Alert = require('../../models/Alert');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');
const PlanningAutomationState = require('../../models/PlanningAutomationState');
const {
  DEFAULT_LEASE_MS,
  sanitizeError,
  acquireLease,
  finishLease
} = require('./planningAutomationStateService');

const EVIDENCE_SOURCES = ['pipeline', 'alerts', 'schedule'];
const DEFAULT_INITIAL_LOOKBACK_MS = 24 * 60 * 60 * 1000;
const MAX_EVENTS_PER_SOURCE = 100;
const MAX_CANDIDATES_PER_SOURCE = 500;
const EVENT_RULES = {
  pipeline: ['feedback', 'done', 'review', 'blocked'],
  alerts: ['resolved', 'acknowledged'],
  schedule: ['run']
};
const DEFAULT_EVENTS = {
  pipeline: ['feedback', 'done', 'review', 'blocked'],
  alerts: ['resolved', 'acknowledged'],
  schedule: ['run']
};
const ALERT_SEVERITIES = ['info', 'warning', 'error', 'critical'];

function catalog() {
  return EVIDENCE_SOURCES.map((source) => ({
    source,
    reconcileSource: `evidence.${source}`,
    events: EVENT_RULES[source],
    filters: source === 'alerts'
      ? ['severity', 'ruleId', 'component', 'fingerprint']
      : [],
    ownership: source === 'pipeline'
      ? 'linked PipelineTask records'
      : (source === 'alerts' ? 'Alert lifecycle records' : 'linked ClusterScheduleEntry run state')
  }));
}

class PlanningEvidenceError extends Error {
  constructor(message, code = 'INVALID_PLANNING_EVIDENCE_BINDING') {
    super(message);
    this.name = 'PlanningEvidenceError';
    this.code = code;
    this.status = 400;
  }
}

function bounded(value, max) {
  return String(value || '').trim().slice(0, max);
}

function evidenceNote(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, '[code omitted]')
    .replace(/\b(token|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function objectIdScope(itemId) {
  if (!itemId) return {};
  if (mongoose.isValidObjectId(itemId)) return { _id: new mongoose.Types.ObjectId(itemId) };
  return { key: bounded(itemId, 160) };
}

function validateBinding(binding) {
  const source = bounded(binding?.source, 40);
  if (!EVIDENCE_SOURCES.includes(source)) {
    throw new PlanningEvidenceError(`Unsupported Planning evidence source: ${source || 'empty'}`);
  }
  const params = binding?.params && typeof binding.params === 'object' && !Array.isArray(binding.params)
    ? binding.params
    : {};
  const allowedKeys = source === 'alerts'
    ? ['events', 'severity', 'ruleId', 'component', 'fingerprint']
    : ['events'];
  const unknown = Object.keys(params).filter((key) => !allowedKeys.includes(key));
  if (unknown.length) {
    throw new PlanningEvidenceError(`Unsupported ${source} evidence parameter(s): ${unknown.join(', ')}`);
  }
  const events = params.events === undefined ? DEFAULT_EVENTS[source] : params.events;
  if (!Array.isArray(events) || !events.length) {
    throw new PlanningEvidenceError(`${source} evidence events must be a non-empty array`);
  }
  const normalizedEvents = [...new Set(events.map((event) => bounded(event, 40)))];
  const invalidEvents = normalizedEvents.filter((event) => !EVENT_RULES[source].includes(event));
  if (invalidEvents.length) {
    throw new PlanningEvidenceError(`Unsupported ${source} evidence event(s): ${invalidEvents.join(', ')}`);
  }
  const normalized = { events: normalizedEvents };
  if (source === 'alerts') {
    if (params.severity && !ALERT_SEVERITIES.includes(params.severity)) {
      throw new PlanningEvidenceError(`alerts severity must be one of ${ALERT_SEVERITIES.join('|')}`);
    }
    for (const key of ['severity', 'ruleId', 'component', 'fingerprint']) {
      if (params[key]) normalized[key] = bounded(params[key], 160);
    }
  }
  return { source, enabled: binding.enabled !== false, params: normalized };
}

function bindingsFor(item, source) {
  return (item.automation?.evidenceBindings || [])
    .filter((binding) => binding.source === source)
    .map(validateBinding)
    .filter((binding) => binding.enabled);
}

function eventKey(parts) {
  return parts.map((part) => bounded(part, 180)).join(':').slice(0, 300);
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 16);
}

function evidence({
  kind,
  label,
  ref,
  note = '',
  metadata = {},
  externalKey,
  source,
  occurredAt,
  now
}) {
  return {
    kind,
    label: bounded(label, 200),
    ref: bounded(ref, 500),
    note: evidenceNote(note),
    metadata,
    externalKey: bounded(externalKey, 300),
    source,
    occurredAt,
    addedAt: now,
    addedBy: 'planning-automation'
  };
}

function occurred(value, now) {
  const date = value ? new Date(value) : null;
  return Boolean(date && !Number.isNaN(date.getTime()) && date <= now);
}

function sourceCursor(rows, field, now) {
  if (rows.length < MAX_EVENTS_PER_SOURCE) return now;
  const value = rows[rows.length - 1]?.[field];
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date : now;
}

function alertMatches(alert, binding) {
  const params = binding.params;
  if (params.severity && alert.severity !== params.severity) return false;
  if (params.ruleId && alert.ruleId !== params.ruleId) return false;
  if (params.component && alert.context?.component !== params.component) return false;
  if (params.fingerprint && alert.fingerprint !== params.fingerprint) return false;
  return true;
}

async function pipelineCandidates(items, { since, now }) {
  const byId = new Map(items.map((item) => [String(item._id), item]));
  const tasks = await PipelineTask.find({
    planningItemIds: { $in: items.map((item) => item._id) },
    updatedAt: { $gt: since, $lte: now }
  }).select('pipelineId title status planningItemIds feedback updatedAt')
    .sort({ updatedAt: 1 }).limit(MAX_EVENTS_PER_SOURCE).lean();
  const candidates = [];
  for (const task of tasks) {
    for (const planningId of task.planningItemIds || []) {
      const item = byId.get(String(planningId));
      if (!item) continue;
      const bindings = bindingsFor(item, 'pipeline');
      const events = new Set(bindings.flatMap((binding) => binding.params.events));
      if (events.has('feedback')) {
        for (const feedback of (task.feedback || []).slice(-3)) {
          if (!occurred(feedback.at, now)) continue;
          const hash = shortHash(`${feedback.at}|${feedback.by}|${feedback.text}`);
          candidates.push({
            item,
            evidence: evidence({
              kind: 'task_feedback',
              label: `Pipeline ${task.pipelineId} feedback`,
              ref: task.pipelineId,
              note: feedback.text,
              metadata: { pipelineId: task.pipelineId, status: task.status, by: bounded(feedback.by, 120) },
              externalKey: eventKey(['pipeline', task.pipelineId, 'feedback', feedback.at, hash]),
              source: 'pipeline',
              occurredAt: feedback.at,
              now
            })
          });
        }
      }
      if (events.has(task.status) && occurred(task.updatedAt, now)) {
        candidates.push({
          item,
          evidence: evidence({
            kind: 'task_feedback',
            label: `Pipeline ${task.pipelineId} entered ${task.status}`,
            ref: task.pipelineId,
            note: task.title,
            metadata: { pipelineId: task.pipelineId, status: task.status },
            externalKey: eventKey(['pipeline', task.pipelineId, 'status', task.status, task.updatedAt]),
            source: 'pipeline',
            occurredAt: task.updatedAt,
            now
          })
        });
      }
    }
  }
  return { scanned: tasks.length, candidates, cursorThrough: sourceCursor(tasks, 'updatedAt', now) };
}

async function alertCandidates(items, { since, now }) {
  const alerts = await Alert.find({
    updatedAt: { $gt: since, $lte: now },
    $or: [
      { 'resolution.resolvedAt': { $ne: null } },
      { 'acknowledgment.acknowledgedAt': { $ne: null } }
    ]
  }).select(
    'ruleId ruleName severity status title message context fingerprint occurrenceCount '
    + 'acknowledgment resolution updatedAt'
  ).sort({ updatedAt: 1 }).limit(MAX_EVENTS_PER_SOURCE).lean();
  const candidates = [];
  for (const item of items) {
    for (const binding of bindingsFor(item, 'alerts')) {
      for (const alert of alerts) {
        if (!alertMatches(alert, binding)) continue;
        if (
          binding.params.events.includes('acknowledged')
          && occurred(alert.acknowledgment?.acknowledgedAt, now)
        ) {
          const at = alert.acknowledgment.acknowledgedAt;
          candidates.push({
            item,
            evidence: evidence({
              kind: 'alert',
              label: `Alert acknowledged: ${alert.title}`,
              ref: String(alert._id),
              note: alert.acknowledgment?.comment || alert.message,
              metadata: {
                alertId: String(alert._id),
                fingerprint: bounded(alert.fingerprint, 160),
                severity: alert.severity,
                event: 'acknowledged'
              },
              externalKey: eventKey(['alerts', alert._id, 'acknowledged', at]),
              source: 'alerts',
              occurredAt: at,
              now
            })
          });
        }
        if (
          binding.params.events.includes('resolved')
          && occurred(alert.resolution?.resolvedAt, now)
        ) {
          const at = alert.resolution.resolvedAt;
          candidates.push({
            item,
            evidence: evidence({
              kind: 'alert',
              label: `Alert resolved: ${alert.title}`,
              ref: String(alert._id),
              note: alert.resolution?.comment || alert.message,
              metadata: {
                alertId: String(alert._id),
                fingerprint: bounded(alert.fingerprint, 160),
                severity: alert.severity,
                event: 'resolved',
                resolutionMethod: bounded(alert.resolution?.resolutionMethod, 80)
              },
              externalKey: eventKey(['alerts', alert._id, 'resolved', at]),
              source: 'alerts',
              occurredAt: at,
              now
            })
          });
        }
      }
    }
  }
  return { scanned: alerts.length, candidates, cursorThrough: sourceCursor(alerts, 'updatedAt', now) };
}

async function scheduleCandidates(items, { since, now }) {
  const sourceIds = [...new Set(items.flatMap((item) =>
    (item.scheduleRefs || []).map((ref) => ref.sourceId)
  ))];
  const schedules = await ClusterScheduleEntry.find({
    sourceId: { $in: sourceIds },
    lastRun: { $ne: null },
    updated_at: { $gt: since, $lte: now }
  }).select('source sourceId name lastRun metadata updated_at')
    .sort({ updated_at: 1 }).limit(MAX_EVENTS_PER_SOURCE).lean();
  const bySourceId = new Map(schedules.map((schedule) => [schedule.sourceId, schedule]));
  const candidates = [];
  for (const item of items) {
    const events = new Set(bindingsFor(item, 'schedule').flatMap((binding) => binding.params.events));
    if (!events.has('run')) continue;
    for (const ref of item.scheduleRefs || []) {
      const schedule = bySourceId.get(ref.sourceId);
      if (!schedule) continue;
      const status = bounded(
        schedule.metadata?.lastStatus || schedule.metadata?.lastRunStatus || 'unknown',
        40
      );
      candidates.push({
        item,
        evidence: evidence({
          kind: 'schedule_run',
          label: `${schedule.name} run ${status}`,
          ref: schedule.sourceId,
          metadata: {
            source: schedule.source,
            sourceId: schedule.sourceId,
            status,
            consecutiveErrors: Number(schedule.metadata?.consecutiveErrors || 0)
          },
          externalKey: eventKey(['schedule', schedule.sourceId, schedule.lastRun]),
          source: 'schedule',
          occurredAt: schedule.lastRun,
          now
        })
      });
    }
  }
  return {
    scanned: schedules.length,
    candidates,
    cursorThrough: sourceCursor(schedules, 'updated_at', now)
  };
}

const COLLECTORS = {
  pipeline: pipelineCandidates,
  alerts: alertCandidates,
  schedule: scheduleCandidates
};

async function applyCandidates(candidates, dryRun) {
  const unique = [...new Map(candidates.map((candidate) => [
    `${candidate.item._id}:${candidate.evidence.externalKey}`,
    candidate
  ])).values()];
  if (unique.length > MAX_CANDIDATES_PER_SOURCE) {
    throw new PlanningEvidenceError(
      `Evidence source produced ${unique.length} candidates; narrow bindings below ${MAX_CANDIDATES_PER_SOURCE}`
    );
  }
  const limited = unique
    .sort((a, b) => new Date(a.evidence.occurredAt) - new Date(b.evidence.occurredAt))
    .slice(0, MAX_CANDIDATES_PER_SOURCE);
  let updated = 0;
  let skipped = Math.max(0, candidates.length - unique.length);
  const results = [];
  for (const candidate of limited) {
    let inserted = true;
    if (!dryRun) {
      const result = await PlanningItem.updateOne({
        _id: candidate.item._id,
        'evidence.externalKey': { $ne: candidate.evidence.externalKey }
      }, {
        $push: { evidence: candidate.evidence }
      });
      inserted = result.modifiedCount === 1;
    }
    if (inserted) updated += 1;
    else skipped += 1;
    results.push({
      itemId: String(candidate.item._id),
      title: candidate.item.title,
      externalKey: candidate.evidence.externalKey,
      kind: candidate.evidence.kind,
      label: candidate.evidence.label,
      occurredAt: candidate.evidence.occurredAt,
      status: dryRun ? 'preview' : (inserted ? 'added' : 'duplicate')
    });
  }
  return { updated, skipped, results };
}

function cursorDate(cursor, now, force) {
  if (!force && cursor?.through) {
    const value = new Date(cursor.through);
    if (!Number.isNaN(value.getTime())) return value;
  }
  return new Date(now.getTime() - DEFAULT_INITIAL_LOOKBACK_MS);
}

async function reconcileSource(source, items, {
  dryRun,
  force,
  owner,
  now,
  leaseMs
}) {
  const collector = `evidence:${source}`;
  let lease = { acquired: true, state: null };
  if (dryRun) {
    lease.state = await PlanningAutomationState.findOne({ collector }).lean();
  } else {
    lease = await acquireLease(collector, owner, now, leaseMs);
  }
  if (!lease.acquired) {
    return {
      source,
      collector,
      status: 'leased',
      reason: lease.reason,
      statistics: { scanned: 0, updated: 0, failed: 0, skipped: items.length },
      results: []
    };
  }
  const since = cursorDate(lease.state?.cursor, now, force);
  try {
    const collected = await COLLECTORS[source](items, { since, now });
    const applied = await applyCandidates(collected.candidates, dryRun);
    const statistics = {
      scanned: collected.scanned,
      updated: applied.updated,
      failed: 0,
      skipped: applied.skipped
    };
    if (!dryRun) {
      await finishLease(collector, owner, {
        status: 'ok',
        statistics,
        cursor: { through: collected.cursorThrough.toISOString() },
        now
      });
    }
    return {
      source,
      collector,
      status: dryRun ? 'preview' : 'ok',
      window: { since: since.toISOString(), through: now.toISOString() },
      statistics,
      results: applied.results
    };
  } catch (error) {
    const statistics = { scanned: 0, updated: 0, failed: 1, skipped: 0 };
    if (!dryRun) {
      await finishLease(collector, owner, {
        status: 'degraded',
        error,
        statistics,
        now
      });
    }
    return {
      source,
      collector,
      status: 'degraded',
      error: sanitizeError(error),
      statistics,
      results: []
    };
  }
}

async function reconcile({
  dryRun = true,
  source = '',
  itemId = '',
  force = false,
  owner,
  now = new Date(),
  leaseMs = DEFAULT_LEASE_MS
} = {}) {
  const normalizedSource = bounded(source, 40);
  if (normalizedSource && !EVIDENCE_SOURCES.includes(normalizedSource)) {
    throw new PlanningEvidenceError(`Unsupported Planning evidence source: ${normalizedSource}`);
  }
  const query = {
    status: { $ne: 'archived' },
    'automation.evidenceBindings': {
      $elemMatch: {
        enabled: { $ne: false },
        ...(normalizedSource ? { source: normalizedSource } : { source: { $in: EVIDENCE_SOURCES } })
      }
    },
    ...objectIdScope(itemId)
  };
  const items = await PlanningItem.find(query).sort({ key: 1, _id: 1 }).lean();
  const sources = normalizedSource
    ? [normalizedSource]
    : EVIDENCE_SOURCES.filter((candidate) =>
      items.some((item) => (item.automation?.evidenceBindings || [])
        .some((binding) => binding.enabled !== false && binding.source === candidate))
    );
  const groups = [];
  for (const candidate of sources) {
    const scopedItems = items.filter((item) =>
      (item.automation?.evidenceBindings || [])
        .some((binding) => binding.enabled !== false && binding.source === candidate)
    );
    groups.push(await reconcileSource(candidate, scopedItems, {
      dryRun,
      force,
      owner,
      now,
      leaseMs
    }));
  }
  const totals = groups.reduce((sum, group) => ({
    scanned: sum.scanned + group.statistics.scanned,
    updated: sum.updated + group.statistics.updated,
    failed: sum.failed + group.statistics.failed,
    skipped: sum.skipped + group.statistics.skipped
  }), { scanned: 0, updated: 0, failed: 0, skipped: 0 });
  return { dryRun, source: normalizedSource || 'all', itemId: itemId || '', totals, groups };
}

module.exports = {
  EVIDENCE_SOURCES,
  DEFAULT_INITIAL_LOOKBACK_MS,
  MAX_EVENTS_PER_SOURCE,
  MAX_CANDIDATES_PER_SOURCE,
  catalog,
  PlanningEvidenceError,
  validateBinding,
  bindingsFor,
  alertMatches,
  cursorDate,
  reconcile
};
