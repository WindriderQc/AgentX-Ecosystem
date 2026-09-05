'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const LOGICAL_OPERATIONS_PER_CYCLE = 3;

function finiteNonNegative(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

const SAFE_NEXT_RUN_REASONS = new Set(['startup', 'normal', 'retry', 'retry-exhausted', 'non-retryable-failure']);
const OPERATION_NAMES = ['mongo', 'config', 'qdrant'];

function projectFailures(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => entry && OPERATION_NAMES.includes(entry.name))
    .map(entry => ({
      name: entry.name,
      error: typeof entry.error === 'string' ? entry.error.slice(0, 200) : 'unknown error',
      code: typeof entry.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(entry.code) ? entry.code : null,
      retryable: entry.retryable !== false
    }));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function projectBackupPolicy(config = {}, schedule = {}, observedAt = new Date().toISOString()) {
  const retentionDays = Math.floor(finiteNonNegative(config.retentionDays));
  const enabled = schedule.enabled === true;
  const intervalMs = finiteNonNegative(schedule.intervalMs, DAY_MS);
  const retryDelayMs = finiteNonNegative(schedule.retryDelayMs, 60 * 60 * 1000);
  const startupDelayMs = finiteNonNegative(schedule.startupDelayMs, 5 * 60 * 1000);
  const unbounded = retentionDays === 0;
  const normalCyclesPerDay = enabled && intervalMs > 0 ? round(DAY_MS / intervalMs) : 0;
  const logicalOperationsPerDay = round(normalCyclesPerDay * LOGICAL_OPERATIONS_PER_CYCLE);
  const reasons = [];
  const warnings = [];
  let level = 'low';

  if (unbounded && enabled) {
    level = 'high';
    reasons.push('Scheduled creation is enabled while retention is unbounded.');
    warnings.push('Backups will accumulate until an operator changes retention or explicitly deletes artifacts.');
  } else if (unbounded) {
    level = 'watch';
    reasons.push('Retention is unbounded, but only manual backup creation is currently enabled.');
    warnings.push('Every manually created artifact is retained indefinitely.');
  } else {
    reasons.push(`Recognized current-format artifacts are retained for ${retentionDays} days.`);
  }

  if (enabled && intervalMs < 60 * 60 * 1000) {
    if (level === 'low') level = 'watch';
    reasons.push('The normal schedule creates backup sets more often than hourly.');
  }
  if (enabled && retryDelayMs < intervalMs) {
    warnings.push('After a partial or failed cycle, the retry cadence is shorter than the normal cadence.');
  }

  const lastFailures = projectFailures(schedule.lastFailures);
  const nextRunReason = SAFE_NEXT_RUN_REASONS.has(schedule.nextRunReason) ? schedule.nextRunReason : null;
  const blockedLayers = lastFailures.filter(entry => entry.retryable === false);
  if (lastFailures.length > 0 && level === 'low') level = 'watch';
  if (blockedLayers.length > 0) {
    reasons.push(
      `${blockedLayers.map(entry => entry.name).join(', ')} backup${blockedLayers.length > 1 ? 's are' : ' is'} failing with a non-retryable error; automatic retries are suspended for that layer until an operator fixes the configuration.`
    );
    for (const entry of blockedLayers) {
      warnings.push(`${entry.name}: ${entry.error}${entry.code ? ` (${entry.code})` : ''}`);
    }
  } else if (lastFailures.length > 0) {
    warnings.push(
      `Last cycle left ${lastFailures.map(entry => entry.name).join(', ')} without a fresh artifact; only the failed layer${lastFailures.length > 1 ? 's are' : ' is'} retried.`
    );
  }
  if (nextRunReason === 'retry-exhausted') {
    warnings.push('The retry budget for the last failure was exhausted; the scheduler is back on the normal cadence.');
  }
  warnings.push('Legacy uncompressed MongoDB backup directories are listed but excluded from automatic retention pruning.');

  return {
    authority: 'core.backup-policy',
    observedAt,
    schedule: {
      enabled,
      enabledSource: schedule.enabledSource || 'unknown',
      normalEveryMs: intervalMs,
      normalEverySource: schedule.intervalMsSource || 'unknown',
      failureRetryEveryMs: retryDelayMs,
      failureRetrySource: schedule.retryDelayMsSource || 'unknown',
      startupDelayMs,
      startupDelaySource: schedule.startupDelayMsSource || 'unknown',
      nextRunAt: schedule.nextRunAt || null,
      lastStartedAt: schedule.lastStartedAt || null,
      lastFinishedAt: schedule.lastFinishedAt || null,
      lastStatus: schedule.lastStatus || 'never',
      lastCycleMode: schedule.lastCycleMode === 'retry' ? 'retry' : (schedule.lastCycleMode === 'full' ? 'full' : null),
      lastFailures,
      nextRunReason,
      consecutiveRetries: Math.floor(finiteNonNegative(schedule.consecutiveRetries)),
      maxRetries: Math.floor(finiteNonNegative(schedule.maxRetries, 3)),
      maxRetriesSource: schedule.maxRetriesSource || 'unknown',
      logicalOperationsPerCycle: LOGICAL_OPERATIONS_PER_CYCLE,
      operationNames: ['mongo', 'config', 'qdrant'],
      normalCyclesPerDay,
      logicalOperationsPerDay,
      note: 'Qdrant can also retain a local copy of its server-side snapshot.'
    },
    retention: {
      days: retentionDays,
      source: config.retentionDaysSource || 'unknown',
      mode: unbounded ? 'unbounded' : 'bounded',
      automaticCleanup: !unbounded,
      enforcement: unbounded ? 'disabled' : 'after each successful backup operation',
      coveredArtifacts: [
        'current MongoDB tarballs',
        'configuration tarballs',
        'local Qdrant snapshot copies',
        'Qdrant server snapshots (best effort)'
      ],
      excludedArtifacts: ['legacy uncompressed MongoDB backup directories']
    },
    growthRisk: {
      level,
      reasons,
      warnings
    }
  };
}

function summarizeInventory(items, options = {}, observedAt = new Date().toISOString()) {
  const records = Array.isArray(items) ? items : [];
  const dateField = options.dateField || 'date';
  let knownSizeCount = 0;
  let totalKnownBytes = 0;
  const dates = [];

  for (const record of records) {
    const rawSize = record?.size;
    if (rawSize !== null && rawSize !== undefined && rawSize !== '') {
      const size = Number(rawSize);
      if (Number.isFinite(size) && size >= 0) {
        knownSizeCount += 1;
        totalKnownBytes += size;
      }
    }
    const rawDate = record?.[dateField];
    if (rawDate !== null && rawDate !== undefined && rawDate !== '') {
      const timestamp = new Date(rawDate).getTime();
      if (Number.isFinite(timestamp)) dates.push(timestamp);
    }
  }

  dates.sort((a, b) => a - b);
  return {
    authority: options.authority || 'core.backup-inventory',
    source: options.source || 'unknown',
    scope: options.scope || 'Complete recognized inventory returned by the backing store',
    countBasis: 'All recognized records returned by the source; no date window or pagination',
    count: records.length,
    knownSizeCount,
    totalKnownBytes,
    oldestAt: dates.length ? new Date(dates[0]).toISOString() : null,
    newestAt: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
    observedAt
  };
}

module.exports = {
  DAY_MS,
  LOGICAL_OPERATIONS_PER_CYCLE,
  projectBackupPolicy,
  projectFailures,
  summarizeInventory
};
