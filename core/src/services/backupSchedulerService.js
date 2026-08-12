'use strict';

const backupService = require('./backupService');
const logger = require('../../config/logger');

const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_STARTUP_DELAY_MS = 5 * 60 * 1000;
const DEFAULT_RETRY_DELAY_MS = 60 * 60 * 1000;

function flagEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function positiveMs(value, fallback, minimum = 1000) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum ? Math.floor(parsed) : fallback;
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
    intervalMs: positiveMs(env.BACKUP_INTERVAL_MS, DEFAULT_INTERVAL_MS),
    startupDelayMs: positiveMs(env.BACKUP_STARTUP_DELAY_MS, DEFAULT_STARTUP_DELAY_MS, 0),
    retryDelayMs: positiveMs(env.BACKUP_RETRY_DELAY_MS, DEFAULT_RETRY_DELAY_MS)
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
    results: []
  };

  function snapshot() {
    return {
      ...config,
      ...state,
      running,
      results: state.results.map(result => ({ ...result }))
    };
  }

  async function runCycle() {
    if (running) {
      log.warn('Scheduled backup cycle skipped because another cycle is running');
      return { ...snapshot(), status: 'skipped', reason: 'already_running' };
    }

    running = true;
    state.lastStartedAt = now().toISOString();
    state.lastStatus = 'running';
    state.results = [];

    const operations = [
      ['mongo', () => service.createBackup()],
      ['config', () => service.createConfigBackup()],
      ['qdrant', () => service.createQdrantBackup()]
    ];

    for (const [name, operation] of operations) {
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
        state.results.push({
          name,
          status: 'error',
          durationMs: Math.max(0, now().getTime() - startedAt.getTime()),
          error: error.message
        });
        log.error('Scheduled backup operation failed', { operation: name, error: error.message });
      }
    }

    const failures = state.results.filter(result => result.status === 'error').length;
    const successes = state.results.length - failures;
    state.lastStatus = failures === 0 ? 'success' : (successes > 0 ? 'partial' : 'failed');
    state.lastFinishedAt = now().toISOString();
    running = false;

    const message = 'Scheduled backup cycle completed';
    const meta = { status: state.lastStatus, successes, failures };
    if (failures > 0) log.warn(message, meta);
    else log.info(message, meta);

    return snapshot();
  }

  function scheduleNext(delayMs) {
    if (stopped || !config.enabled) return;
    if (timer) cancelTimeout(timer);
    state.nextRunAt = new Date(now().getTime() + delayMs).toISOString();
    timer = scheduleTimeout(async () => {
      timer = null;
      state.nextRunAt = null;
      const result = await runCycle();
      const retry = ['partial', 'failed'].includes(result.lastStatus);
      scheduleNext(retry ? config.retryDelayMs : config.intervalMs);
    }, delayMs);
    if (typeof timer?.unref === 'function') timer.unref();
  }

  function start() {
    if (!config.enabled) return false;
    if (timer || running) return true;
    stopped = false;
    state.startedAt = state.startedAt || now().toISOString();
    scheduleNext(config.startupDelayMs);
    log.info('Backup scheduler started', config);
    return true;
  }

  function stop() {
    stopped = true;
    if (timer) cancelTimeout(timer);
    timer = null;
    state.nextRunAt = null;
  }

  return {
    start,
    stop,
    runNow: runCycle,
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
    BACKUP_RETRY_DELAY_MS: process.env.BACKUP_RETRY_DELAY_MS
  }
});

module.exports = {
  ...defaultScheduler,
  createBackupScheduler,
  flagEnabled,
  positiveMs,
  DEFAULT_INTERVAL_MS,
  DEFAULT_STARTUP_DELAY_MS,
  DEFAULT_RETRY_DELAY_MS
};
