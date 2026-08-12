const { dateOnlyKey, zonedDateOnly } = require('./planningDateService');

const DEFAULT_STALE_HEARTBEAT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_DUE_SOON_DAYS = 7;

function countByStatus(tasks = []) {
  const counts = { total: tasks.length, queued: 0, in_progress: 0, review: 0, blocked: 0, done: 0 };
  for (const task of tasks) {
    if (Object.prototype.hasOwnProperty.call(counts, task.status)) counts[task.status] += 1;
  }
  return counts;
}

function dateKeyToUtc(value) {
  const key = dateOnlyKey(value);
  if (!key) return NaN;
  const [year, month, day] = key.split('-').map(Number);
  return Date.UTC(year, month - 1, day);
}

function dueSoon(targetAt, now, days, timeZone) {
  const target = dateKeyToUtc(targetAt);
  const today = dateKeyToUtc(zonedDateOnly(now, timeZone));
  if (!Number.isFinite(target) || !Number.isFinite(today) || target < today) return false;
  return target - today <= days * 86400000;
}

function staleInProgressTasks(tasks, now, staleHeartbeatMs) {
  return tasks.filter((task) => {
    if (task.status !== 'in_progress') return false;
    const heartbeat = new Date(task.heartbeatAt || task.updatedAt || task.createdAt || 0);
    return Number.isNaN(heartbeat.getTime()) || now.getTime() - heartbeat.getTime() > staleHeartbeatMs;
  });
}

function scheduleErrorCount(schedules = []) {
  return schedules.filter((schedule) =>
    Number(schedule.metadata?.consecutiveErrors || 0) > 0
    || ['error', 'failed'].includes(String(
      schedule.metadata?.lastStatus || schedule.metadata?.lastRunStatus || schedule.metadata?.status || ''
    ).toLowerCase())
  ).length;
}

function deriveProgressBreakdown(item, tasks = []) {
  const metric = item.progress?.metric || {};
  return {
    mode: item.progress?.mode || 'tasks',
    value: Math.max(0, Math.min(100, Number(item.computedProgress) || 0)),
    tasks: countByStatus(tasks),
    metric: {
      label: metric.label || '',
      baseline: metric.baseline ?? null,
      current: metric.current ?? null,
      target: metric.target ?? null,
      unit: metric.unit || '',
      sourceRef: metric.sourceRef || ''
    }
  };
}

function derivePlanningHealth(item, {
  tasks = [],
  schedules = [],
  now = new Date(),
  timeZone,
  staleHeartbeatMs = DEFAULT_STALE_HEARTBEAT_MS,
  dueSoonDays = DEFAULT_DUE_SOON_DAYS
} = {}) {
  const progress = deriveProgressBreakdown(item, tasks);
  const reasons = [];
  const blockedTasks = tasks.filter((task) => task.status === 'blocked');
  const staleTasks = staleInProgressTasks(tasks, now, staleHeartbeatMs);
  const scheduleErrors = scheduleErrorCount(schedules);
  const metric = item.progress?.metric || {};
  const observation = metric.observation || {};

  if (item.status === 'blocked') {
    reasons.push({ code: 'item_blocked', severity: 'critical', label: 'Planning item is blocked' });
  } else if (item.status === 'at_risk') {
    reasons.push({ code: 'item_at_risk', severity: 'warning', label: 'Planning item is at risk' });
  }
  if (item.isOverdue) {
    reasons.push({ code: 'target_overdue', severity: 'critical', label: 'Target date is overdue' });
  }
  if (blockedTasks.length) {
    reasons.push({
      code: 'blocked_tasks',
      severity: 'critical',
      label: `${blockedTasks.length} linked pipeline task(s) are blocked`,
      count: blockedTasks.length
    });
  }
  if (staleTasks.length) {
    reasons.push({
      code: 'stale_task_heartbeat',
      severity: 'warning',
      label: `${staleTasks.length} in-progress task heartbeat(s) are stale`,
      count: staleTasks.length
    });
  }
  if (scheduleErrors) {
    reasons.push({
      code: 'schedule_errors',
      severity: 'warning',
      label: `${scheduleErrors} linked schedule(s) report errors`,
      count: scheduleErrors
    });
  }
  if (item.status !== 'draft' && item.progress?.mode === 'metric' && metric.adapter) {
    const observedAt = observation.observedAt ? new Date(observation.observedAt) : null;
    const staleAfterMs = Number(metric.staleAfterMs || 21600000);
    if (['degraded', 'unavailable'].includes(observation.status) || !observedAt) {
      reasons.push({
        code: 'metric_degraded',
        severity: 'warning',
        label: observation.status === 'degraded'
          ? 'Metric refresh is degraded; showing the last good value'
          : 'Metric source has not produced an observation'
      });
    } else if (
      observation.status === 'stale'
      || Number.isNaN(observedAt.getTime())
      || now.getTime() - observedAt.getTime() > staleAfterMs
    ) {
      reasons.push({
        code: 'metric_stale',
        severity: 'warning',
        label: 'Metric observation is stale'
      });
    }
  }
  if (
    !reasons.length
    && item.dates?.targetAt
    && progress.value === 0
    && dueSoon(item.dates.targetAt, now, dueSoonDays, timeZone)
  ) {
    reasons.push({
      code: 'due_soon_no_progress',
      severity: 'warning',
      label: `Target is due within ${dueSoonDays} days with no progress`
    });
  }

  let level = 'on_track';
  if (item.status === 'completed') level = 'complete';
  else if (item.status === 'draft') level = 'draft';
  if (reasons.some((reason) => reason.severity === 'critical')) level = 'blocked';
  else if (reasons.length) level = 'at_risk';

  return {
    level,
    reasons,
    progress,
    evaluatedAt: now.toISOString()
  };
}

module.exports = {
  DEFAULT_STALE_HEARTBEAT_MS,
  DEFAULT_DUE_SOON_DAYS,
  countByStatus,
  deriveProgressBreakdown,
  derivePlanningHealth
};
