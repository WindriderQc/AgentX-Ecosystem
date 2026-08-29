'use strict';

const ACTIVE_ALERT_STATUS = 'active';
const TEMPLATE_PATTERN = /\{\{\s*([\w.]+)\s*\}\}/g;

function asPlainObject(record) {
  if (!record) return {};
  if (typeof record.toObject === 'function') {
    return record.toObject({ virtuals: true });
  }
  return { ...record };
}

function valueAtPath(value, path) {
  return String(path).split('.').reduce((current, part) => current?.[part], value);
}

function alertTemplateData(alert) {
  const context = alert.context || {};
  const additionalData = context.additionalData || {};
  return {
    ...additionalData,
    source: alert.source ?? additionalData.source,
    component: context.component ?? additionalData.component,
    metric: context.metric ?? additionalData.metric,
    value: context.currentValue ?? additionalData.value,
    currentValue: context.currentValue ?? additionalData.currentValue,
    threshold: context.threshold ?? additionalData.threshold,
    trend: context.trend ?? additionalData.trend,
    context,
    additionalData
  };
}

function normalizeTemplateText(value, data) {
  if (value === undefined || value === null) {
    return { text: value, hadTemplate: false, missing: [] };
  }

  const missing = new Set();
  let hadTemplate = false;
  const text = String(value).replace(TEMPLATE_PATTERN, (_match, key) => {
    hadTemplate = true;
    const replacement = valueAtPath(data, key);
    if (replacement === undefined || replacement === null || String(replacement).trim() === '') {
      missing.add(key);
      return `[missing:${key}]`;
    }
    return String(replacement);
  });

  return { text, hadTemplate, missing: [...missing] };
}

/**
 * Present a persisted alert without mutating it. Historic rows created before
 * strict template rendering can contain literal {{field}} tokens; resolve
 * those from persisted context or label the evidence gap explicitly.
 */
function normalizeAlertForRead(record) {
  const alert = asPlainObject(record);
  const templateData = alertTemplateData(alert);
  const fields = ['title', 'message', 'ruleName'];
  const normalized = { ...alert };
  const missing = new Set();
  let hadTemplate = false;

  for (const field of fields) {
    const result = normalizeTemplateText(alert[field], templateData);
    normalized[field] = result.text;
    hadTemplate = hadTemplate || result.hadTemplate;
    result.missing.forEach(key => missing.add(key));
  }

  normalized.presentation = {
    ...(alert.presentation || {}),
    templateStatus: !hadTemplate ? 'stored' : (missing.size > 0 ? 'incomplete' : 'resolved'),
    missingTemplateFields: [...missing]
  };
  return normalized;
}

function canonicalText(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/cancelled/g, 'canceled')
    .replace(/\s+/g, ' ');
}

function isCancellation(log) {
  return /\bcancel(?:ed|led|lation)\b/i.test(`${log.error || ''} ${log.fallbackReason || ''}`);
}

function timestampMs(value) {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : 0;
}

function alertToEvent(record) {
  const alert = normalizeAlertForRead(record);
  const context = alert.context || {};
  const extra = context.additionalData || {};
  const detailBits = [];
  if (extra.model) detailBits.push(extra.model + (extra.host ? ` on ${extra.host}` : ''));
  if (context.metric) {
    detailBits.push(context.currentValue !== undefined && context.currentValue !== null
      ? `${context.metric} = ${context.currentValue}`
      : context.metric);
  }
  if (context.threshold !== undefined && context.threshold !== null) {
    detailBits.push(`threshold ${context.threshold}`);
  }

  const id = alert._id ? String(alert._id) : null;
  const status = alert.status || alert.state || ACTIVE_ALERT_STATUS;
  const fingerprint = alert.fingerprint || null;
  const semanticIdentity = [
    alert.ruleId || alert.ruleName || 'alert',
    context.component || alert.source || 'unknown',
    canonicalText(alert.title || alert.message)
  ].join('|');

  return {
    type: 'alert',
    severity: alert.severity || alert.level || 'info',
    source: context.component || alert.source || 'alerts',
    title: alert.title || alert.message || 'Alert',
    description: [alert.message !== alert.title ? alert.message : '', detailBits.join(' · ')]
      .filter(Boolean).join(' — '),
    ruleName: alert.ruleName || null,
    occurrenceCount: Math.max(1, Number(alert.occurrenceCount) || 1),
    groupedCount: 1,
    status,
    lifecycle: status === ACTIVE_ALERT_STATUS ? 'active' : 'history',
    timestamp: alert.lastOccurrence || alert.createdAt || alert.timestamp,
    firstSeen: alert.createdAt || alert.timestamp || alert.lastOccurrence,
    lastSeen: alert.lastOccurrence || alert.createdAt || alert.timestamp,
    id,
    memberIds: id ? [id] : [],
    expandable: true,
    presentation: alert.presentation,
    _groupKey: `alert:${status}:${fingerprint || semanticIdentity}`
  };
}

function inferenceLogToEvent(record) {
  const log = asPlainObject(record);
  const cancelled = isCancellation(log);
  const host = log.hostKey || log.host || 'unknown host';
  const model = log.model || 'unknown model';
  const id = log._id ? String(log._id) : null;
  const reason = log.error || log.fallbackReason || '';
  const type = cancelled ? 'inference_cancelled' : (log.fallbackUsed ? 'failover' : 'inference_error');
  const severity = cancelled ? 'info' : (log.status === 'timeout' ? 'warning' : 'error');
  const title = cancelled
    ? `Inference cancelled: ${model} on ${host}`
    : (log.fallbackUsed ? `Failover: ${model} on ${host}` : `${log.status}: ${model} on ${host}`);
  const failureKind = cancelled
    ? 'cancelled'
    : (log.status === 'timeout' ? 'timeout' : canonicalText(reason));
  const scope = [model, host, log.caller || '', log.taskType || ''].map(canonicalText).join('|');

  return {
    type,
    severity,
    source: 'inferenceLog',
    title,
    description: reason,
    occurrenceCount: 1,
    groupedCount: 1,
    status: log.status || 'error',
    lifecycle: 'history',
    outcome: cancelled ? 'cancelled' : (log.status || 'error'),
    timestamp: log.timestamp,
    firstSeen: log.timestamp,
    lastSeen: log.timestamp,
    id,
    memberIds: id ? [id] : [],
    expandable: Boolean(reason),
    _groupKey: `inference:${type}:${scope}:${failureKind}`
  };
}

function mergeEvent(group, event) {
  group.groupedCount += event.groupedCount || 1;
  group.occurrenceCount += event.occurrenceCount || 1;
  group.memberIds.push(...(event.memberIds || []));

  if (timestampMs(event.firstSeen) < timestampMs(group.firstSeen)) {
    group.firstSeen = event.firstSeen;
  }
  if (timestampMs(event.lastSeen) > timestampMs(group.lastSeen)) {
    group.lastSeen = event.lastSeen;
    group.timestamp = event.timestamp;
  }
  return group;
}

/**
 * Group equivalent feed rows in memory. Persisted Alert and InferenceLog rows
 * remain untouched and their identifiers stay available in memberIds.
 */
function projectHealthFeed({ alerts = [], inferenceLogs = [], limit = 30 } = {}) {
  const boundedLimit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rawCandidates = [
    ...(Array.isArray(alerts) ? alerts.map(alertToEvent) : []),
    ...(Array.isArray(inferenceLogs) ? inferenceLogs.map(inferenceLogToEvent) : [])
  ].sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));

  // Active snapshots and recent-history snapshots can legitimately overlap.
  // Do not misreport the same persisted id as two grouped history rows.
  const seenPersistedIds = new Set();
  const candidates = rawCandidates.filter(event => {
    if (!event.id) return true;
    const identity = `${event.type}:${event.id}`;
    if (seenPersistedIds.has(identity)) return false;
    seenPersistedIds.add(identity);
    return true;
  });

  const groups = new Map();
  for (const event of candidates) {
    if (groups.has(event._groupKey)) mergeEvent(groups.get(event._groupKey), event);
    else groups.set(event._groupKey, { ...event, memberIds: [...event.memberIds] });
  }

  const groupedEvents = [...groups.values()].sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));
  const selected = [
    ...groupedEvents.filter(event => event.lifecycle === 'active'),
    ...groupedEvents.filter(event => event.lifecycle !== 'active')
  ].slice(0, boundedLimit).sort((a, b) => timestampMs(b.timestamp) - timestampMs(a.timestamp));

  const projected = selected
    .map(event => {
      const result = { ...event };
      delete result._groupKey;
      result.grouping = {
        grouped: result.groupedCount > 1,
        persistedRows: result.groupedCount,
        preservedIds: result.memberIds.length
      };
      return result;
    });

  return {
    events: projected,
    meta: {
      candidateRows: candidates.length,
      duplicateInputsIgnored: rawCandidates.length - candidates.length,
      presentedRows: projected.length,
      groupedRows: candidates.length - groups.size,
      truncatedGroups: Math.max(0, groups.size - projected.length)
    }
  };
}

module.exports = {
  ACTIVE_ALERT_STATUS,
  normalizeTemplateText,
  normalizeAlertForRead,
  alertToEvent,
  inferenceLogToEvent,
  projectHealthFeed
};
