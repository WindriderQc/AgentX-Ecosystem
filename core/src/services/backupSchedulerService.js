'use strict';

const backupService = require('./backupService');
const logger = require('../../config/logger');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000;
const DEFAULT_MAX_RETRIES = 3;

// Failures that cannot heal by themselves: retrying them only recreates the
// artifacts of the layers that already succeeded. They wait for the normal
// cadence (and an operator) instead of the short retry loop.
const NON_RETRYABLE_CODES = Object.freeze([
  'RECOVERY_AUTH_REQUIRED',
  'INVALID_CONFIG',
  'CONFIG_MISSING'
]);

const OPERATION_NAMES = Object.freeze(['mongo', 'config', 'qdrant']);

function flagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function positiveMs(value, fallback, minimum = 1000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
}

function nonNegativeInt(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function configSource(value) {
  return value === undefined || value === null || String(value).trim() === '' ? 'default' : 'env';
}

function isRetryableError(error) {
  const code = String(error?.code || '').trim();
  return !NON_RETRYABLE_CODES.includes(code);
}

function createBackupScheduler(options = {}) {
  const env = options.env || process.env;
  const service = options.backupService || backupService;
  const log = options.logger || logger;
  const scheduleTimeout = options.setTimeout || setTimeout;
  const cancelTimeout = options.clearTimeout || clearTimeout;
  const now = options.now || (() => new Date());

  const config = Object.freeze({
    enabled: flagEnabled(env.BACKUP_SCHEDULE_ENABLED),
    enabledSource: configSource(env.BACKUP_SCHEDULE_ENABLED),
    intervalMs: positiveMs(env.BACKUP_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    intervalMsSource: configSource(env.BACKUP_INTERVAL_MS),
    startupDelayMs: positiveMs(env.BACKUP_STARTUP_DELAY_MS, DEFAULT_STARTUP_DELAY_MS, 0),
    startupDelayMsSource: configSource(env.BACKUP_STARTUP_DELAY_MS),
    retryDelayMs: positiveMs(env.BACKUP_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS),
    retryDelayMsSource: configSource(env.BACKUP_RETRY_DELAY_MS),
    maxRetries: nonNegativeInt(env.BACKUP_MAX_RETRIES, DEFAULT_MAX_RETRIES),
    maxRetriesSource: configSource(env.BACKUP_MAX_RETRIES)
  });

  let timer = null;
  let running = false;
  let stopped = false;
  const state = {
    startedAt: null,
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: 'never',
    nextRunAt: null,
    nextRunReason: null,
    consecutiveRetries: 0,
    lastCycleMode: null,
    lastFailures: [],
    results: []
  };

  function snapshot() {
    return {
      ...config,
      ...state,
      running,
      lastFailures: state.lastFailures.map(entry => ({ ...entry })),
      results: state.results.map(result => ({ ...result }))
    };
  }

  function operationsFor(names) {
    const all = [
      ['mongo', () => service.createBackup()],
      ['config', () => service.createConfigBackup()],
      ['qdrant', () => service.createQdrantBackup()]
    ];
    if (!Array.isArray(names) || names.length === 0) return all;
    return all.filter(([name]) => names.includes(name));
  }

  /**
   * Run one backup cycle.
   *
   * @param {object} [cycleOptions]
   * @param {string[]} [cycleOptions.only] - restrict the cycle to these
   *   operations (used by the retry path so layers that already succeeded are
   *   not recreated every hour while another layer keeps failing).
   */
  async function runCycle(cycleOptions = {}) {
    if (running) {
      log.warn('Scheduled backup cycle skipped because another cycle is running');
      return { ...snapshot(), status: 'skipped', reason: 'already_running' };
    }

    const only = Array.isArray(cycleOptions.only)
      ? cycleOptions.only.filter(name => OPERATION_NAMES.includes(name))
      : null;
    const isRetry = Boolean(only && only.length > 0 && only.length < OPERATION_NAMES.length);
    const previousResults = isRetry ? state.results : [];

    running = true;
    state.lastStartedAt = now().toISOString();
    state.lastStatus = 'running';
    state.lastCycleMode = isRetry ? 'retry' : 'full';
    state.results = [];

    for (const [name, operation] of operationsFor(isRetry ? only : null)) {
      const startedAt = now();
      try {
        const result = await operation();
        state.results.push({
          name,
          status: 'success',
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          artifact: result?.name || null
        });
      } catch (error) {
        const retryable = isRetryableError(error);
        state.results.push({
          name,
          status: 'error',
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          error: error.message,
          code: error?.code ? String(error.code) : null,
          retryable
        });
        log.error('Scheduled backup operation failed', {
          operation: name,
          error: error.message,
          code: error?.code || null,
          retryable
        });
      }
    }

    if (isRetry) {
      // Carry forward every layer that was not re-run so the cycle status still
      // describes the whole backup set. This deliberately includes a previous
      // non-retryable failure: a successful retry of another layer must not
      // erase an operator-action-required failure from status/evidence.
      const rerun = new Set(state.results.map(result => result.name));
      for (const previous of previousResults) {
        if (!rerun.has(previous.name)) {
          state.results.push({ ...previous, carriedForward: true });
        }
      }
      state.results.sort((a, b) => OPERATION_NAMES.indexOf(a.name) - OPERATION_NAMES.indexOf(b.name));
    }

    const failures = state.results.filter(result => result.status === 'error');
    const successes = state.results.length - failures.length;
    state.lastStatus = failures.length === 0 ? 'success' : (successes > 0 ? 'partial' : 'failed');
    state.lastFinishedAt = now().toISOString();
    state.lastFailures = failures.map(result => ({
      name: result.name,
      error: result.error,
      code: result.code || null,
      retryable: result.retryable !== false
    }));
    running = false;

    const message = 'Scheduled backup cycle completed';
    const meta = { status: state.lastStatus, mode: state.lastCycleMode, successes, failures: failures.length };
    if (failures.length > 0) log.warn(message, meta);
    else log.info(message, meta);

    return snapshot();
  }

  /**
   * Decide what the next scheduled run looks like after a cycle.
   * Returns { delayMs, reason, only }.
   */
  function planNext(result) {
    const failed = ['partial', 'failed'].includes(result.lastStatus);
    if (!failed) {
      state.consecutiveRetries = 0;
      return { delayMs: config.intervalMs, reason: 'normal', only: null };
    }

    const retryableFailures = (result.lastFailures || []).filter(entry => entry.retryable !== false);
    if (retryableFailures.length === 0) {
      state.consecutiveRetries = 0;
      log.warn('Backup failure is not retryable; waiting for the normal cadence and an operator', {
        failures: result.lastFailures
      });
      return { delayMs: config.intervalMs, reason: 'non-retryable-failure', only: null };
    }

    if (state.consecutiveRetries >= config.maxRetries) {
      log.warn('Backup retry budget exhausted; waiting for the normal cadence', {
        consecutiveRetries: state.consecutiveRetries,
        maxRetries: config.maxRetries,
        failures: result.lastFailures
      });
      state.consecutiveRetries = 0;
      return { delayMs: config.intervalMs, reason: 'retry-exhausted', only: null };
    }

    state.consecutiveRetries += 1;
    return {
      delayMs: config.retryDelayMs,
      reason: 'retry',
      only: retryableFailures.map(entry => entry.name)
    };
  }

  function scheduleNext(delayMs, reason = 'normal', only = null) {
    if (stopped || !config.enabled) return;
    if (timer) cancelTimeout(timer);
    state.nextRunAt = new Date(now().getTime() + delayMs).toISOString();
    state.nextRunReason = reason;
    timer = scheduleTimeout(async () => {
      timer = null;
      state.nextRunAt = null;
      state.nextRunReason = null;
      const result = await runCycle(only ? { only } : {});
      const next = planNext(result);
      scheduleNext(next.delayMs, next.reason, next.only);
    }, delayMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function start() {
    if (!config.enabled) return false;
    if (timer || running) return true;
    stopped = false;
    state.startedAt = state.startedAt || now().toISOString();
    scheduleNext(config.startupDelayMs, 'startup');
    log.info('Backup scheduler started', config);
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) cancelTimeout(timer);
    timer = null;
    state.nextRunAt = null;
    state.nextRunReason = null;
  }

  return {
    start,
    stop,
    runNow: () => runCycle(),
    getStatus: snapshot,
    isEnabled: () => config.enabled
  };
}

// Keep default runtime reads explicit so the feature-conservation manifest can
// track the complete deployment contract.
const defaultScheduler = createBackupScheduler({
  env: {
    BACKUP_SCHEDULE_ENABLED: process.env.BACKUP_SCHEDULE_ENABLED,
    BACKUP_INTERVAL_MS: process.env.BACKUP_INTERVAL_MS,
    BACKUP_STARTUP_DELAY_MS: process.env.BACKUP_STARTUP_DELAY_MS,
    BACKUP_RETRY_DELAY_MS: process.env.BACKUP_RETRY_DELAY_MS,
    BACKUP_MAX_RETRIES: process.env.BACKUP_MAX_RETRIES
  }
});

module.exports = {
  ...defaultScheduler,
  createBackupScheduler,
  flagEnabled,
  positiveMs,
  configSource,
  isRetryableError,
  NON_RETRYABLE_CODES,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  DEFAULT_RETRY_DELAY_MS,
  DEFAULT_MAX_RETRIES
};
