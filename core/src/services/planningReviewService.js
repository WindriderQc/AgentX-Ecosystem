const planningService = require('./planningService');
const planningAutomationService = require('./planningAutomationService');

const DEFAULT_REVIEW_MS = 7 * 24 * 60 * 60 * 1000;
const REVIEW_LIMIT = 10;
const COMMITTED_STATUSES = new Set(['planned', 'active', 'at_risk', 'blocked', 'completed']);
const COMMITMENT_TYPES = new Set(['outcome', 'milestone']);

function timestamp(value) {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;
}

function isRecent(value, since) {
  return timestamp(value) >= since.getTime();
}

function itemSummary(item) {
  return {
    id: item.id || String(item._id || ''),
    key: item.key || '',
    type: item.type,
    title: item.title,
    status: item.status,
    priority: item.priority,
    owner: item.owner || '',
    targetAt: item.dates?.targetAt || null,
    progress: Number(item.computedProgress || item.health?.progress?.value || 0)
  };
}

function priorityRank(priority) {
  return {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
    someday: 4
  }[priority] ?? 5;
}

function riskRows(items) {
  return items
    .filter((item) =>
      ['blocked', 'at_risk'].includes(item.status)
      || ['blocked', 'at_risk'].includes(item.health?.level)
      || item.isOverdue
    )
    .map((item) => ({
      ...itemSummary(item),
      level: item.health?.level || item.status,
      reasons: (item.health?.reasons || []).map((reason) => ({
        code: reason.code,
        severity: reason.severity,
        label: reason.label
      }))
    }))
    .sort((a, b) =>
      Number(b.level === 'blocked') - Number(a.level === 'blocked')
      || priorityRank(a.priority) - priorityRank(b.priority)
      || timestamp(a.targetAt) - timestamp(b.targetAt)
    )
    .slice(0, REVIEW_LIMIT);
}

function evidenceRows(items, since) {
  const rows = [];
  for (const item of items) {
    if (item.status === 'completed' && isRecent(item.dates?.completedAt || item.updatedAt, since)) {
      rows.push({
        kind: 'completion',
        item: itemSummary(item),
        label: `${item.title} completed`,
        occurredAt: item.dates?.completedAt || item.updatedAt
      });
    }
    for (const evidence of item.evidence || []) {
      if (!isRecent(evidence.addedAt, since)) continue;
      rows.push({
        kind: evidence.kind || 'note',
        item: itemSummary(item),
        label: evidence.label,
        ref: evidence.ref || '',
        occurredAt: evidence.addedAt
      });
    }
  }
  return rows
    .sort((a, b) => timestamp(b.occurredAt) - timestamp(a.occurredAt))
    .slice(0, REVIEW_LIMIT);
}

function decisionRows(items, since) {
  return items
    .filter((item) =>
      item.type === 'decision'
      && (
        item.status === 'proposed'
        || isRecent(item.decision?.decidedAt || item.updatedAt, since)
      )
    )
    .map((item) => ({
      ...itemSummary(item),
      choice: item.decision?.choice || '',
      rationale: item.decision?.rationale || '',
      decidedAt: item.decision?.decidedAt || null
    }))
    .sort((a, b) =>
      Number(a.status !== 'proposed') - Number(b.status !== 'proposed')
      || timestamp(b.decidedAt) - timestamp(a.decidedAt)
    )
    .slice(0, REVIEW_LIMIT);
}

function metricRows(automation) {
  return (automation?.items || [])
    .map((item) => ({
      itemId: item.itemId,
      key: item.key || '',
      title: item.title,
      adapter: item.adapter,
      value: item.value,
      status: item.status,
      observedAt: item.observedAt || null,
      error: item.error || ''
    }))
    .sort((a, b) =>
      Number(['stale', 'degraded', 'unavailable'].includes(b.status))
      - Number(['stale', 'degraded', 'unavailable'].includes(a.status))
      || a.title.localeCompare(b.title)
    )
    .slice(0, REVIEW_LIMIT);
}

function nextActions(items, dashboard, risks, metrics, decisions) {
  const actions = [];
  const blocked = risks.filter((item) => item.level === 'blocked' || item.status === 'blocked');
  const staleMetrics = metrics.filter((item) => ['stale', 'degraded', 'unavailable'].includes(item.status));
  const proposed = decisions.filter((item) => item.status === 'proposed');
  const unowned = items.filter((item) =>
    COMMITMENT_TYPES.has(item.type)
    &&
    COMMITTED_STATUSES.has(item.status)
    && item.status !== 'completed'
    && !item.owner
  );
  const unlinkedTasks = Number(dashboard?.summary?.unlinkedTasks || 0);

  if (blocked.length) actions.push({ code: 'unblock', count: blocked.length, label: `Unblock ${blocked.length} commitment(s)` });
  if (staleMetrics.length) actions.push({ code: 'refresh_metrics', count: staleMetrics.length, label: `Restore ${staleMetrics.length} stale/degraded metric(s)` });
  if (proposed.length) actions.push({ code: 'decide', count: proposed.length, label: `Resolve ${proposed.length} proposed decision(s)` });
  if (unowned.length) actions.push({ code: 'assign_owner', count: unowned.length, label: `Assign owners to ${unowned.length} commitment(s)` });
  if (unlinkedTasks) actions.push({ code: 'link_delivery', count: unlinkedTasks, label: `Triage ${unlinkedTasks} unlinked pipeline task(s)` });
  if (!actions.length) actions.push({ code: 'none', count: 0, label: 'No Planning intervention required' });
  return actions.slice(0, 5);
}

function buildReviewFromDashboard(dashboard = {}, {
  automation = {},
  since = new Date(Date.now() - DEFAULT_REVIEW_MS),
  now = new Date()
} = {}) {
  const items = Array.isArray(dashboard.items) ? dashboard.items : [];
  const risks = riskRows(items);
  const wins = evidenceRows(items, since);
  const decisions = decisionRows(items, since);
  const metrics = metricRows(automation);
  const commitments = items.filter((item) => COMMITMENT_TYPES.has(item.type));
  const staleOrOverdue = risks.filter((item) =>
    item.reasons.some((reason) => [
      'target_overdue',
      'stale_task_heartbeat',
      'metric_stale',
      'metric_degraded'
    ].includes(reason.code))
  );
  const pulse = {
    total: items.length,
    committed: commitments.filter((item) => COMMITTED_STATUSES.has(item.status)).length,
    active: commitments.filter((item) => item.status === 'active').length,
    atRisk: risks.filter((item) => item.level === 'at_risk' || item.status === 'at_risk').length,
    blocked: risks.filter((item) => item.level === 'blocked' || item.status === 'blocked').length,
    completed: commitments.filter((item) => item.status === 'completed').length,
    overdue: commitments.filter((item) => item.isOverdue).length,
    proposedDecisions: decisions.filter((item) => item.status === 'proposed').length,
    evidenceAdded: wins.filter((row) => row.kind !== 'completion').length
  };
  const actions = nextActions(items, dashboard, risks, metrics, decisions);
  const collectors = (automation?.collectors || []).map((collector) => ({
    collector: collector.collector,
    status: collector.status,
    lastSuccessAt: collector.lastSuccessAt || null,
    error: collector.error || ''
  }));
  return {
    generatedAt: now.toISOString(),
    periodStart: since.toISOString(),
    pulse,
    metrics,
    wins,
    risks,
    staleOrOverdue,
    decisions,
    nextActions: actions,
    automation: {
      status: collectors.some((collector) => collector.status === 'degraded') ? 'degraded' : 'ok',
      collectors
    },
    summary: `Planning: ${pulse.active} active, ${pulse.blocked} blocked, ${pulse.atRisk} at risk, ${wins.length} recent proof/win(s).`
  };
}

async function buildWeeklyReview({
  since = new Date(Date.now() - DEFAULT_REVIEW_MS),
  now = new Date()
} = {}) {
  const [dashboard, automation] = await Promise.all([
    planningService.getDashboard(),
    planningAutomationService.getStatus({ now }).catch(() => ({ collectors: [], items: [] }))
  ]);
  return buildReviewFromDashboard(dashboard, { automation, since, now });
}

module.exports = {
  DEFAULT_REVIEW_MS,
  REVIEW_LIMIT,
  buildReviewFromDashboard,
  buildWeeklyReview
};
