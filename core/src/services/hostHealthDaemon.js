'use strict';
/**
 * Host Health Daemon
 *
 * Owns the periodic health-check interval that drives the pin reconciler.
 * Extracted from hostPreferenceService.js in task 0227 — that file was 1042
 * lines (cap 700) and mixed pin CRUD, this health-check daemon, the
 * pin-reconciler grace-period state machine, and benchmark-claim re-exports.
 *
 * Responsibilities:
 *   - startHealthCheck / stopHealthCheck — the setInterval lifecycle.
 *   - getHealthCheckIntervalMs / setHealthCheckIntervalMs — the interval
 *     getter/setter (the setter restarts the timer when running).
 *
 * The per-tick reconciliation work (checkAndReloadDefaults + the grace-period
 * state machine) lives in pinReconciler.js. This module only schedules it.
 *
 * The function bodies are copied VERBATIM — this is a pure structural split,
 * no behavior change. Symbol stability: hostPreferenceService.js re-exports
 * startHealthCheck, stopHealthCheck, getHealthCheckIntervalMs, and
 * setHealthCheckIntervalMs so existing callers keep working.
 */

const logger = require('../../config/logger');
const { checkAndReloadDefaults } = require('./pinReconciler');

let healthCheckInterval = null;
let healthCheckIntervalMs = parseInt(process.env.HEALTH_CHECK_INTERVAL_MS, 10) || 60_000;

function startHealthCheck() {
  if (healthCheckInterval) return;
  healthCheckInterval = setInterval(() => {
    checkAndReloadDefaults().catch(err => {
      logger.warn(`[HostPreference] Health check error: ${err.message}`);
    });
  }, healthCheckIntervalMs);
  logger.info(`[HostPreference] Health check started (interval: ${healthCheckIntervalMs / 1000}s)`);
}

function stopHealthCheck() {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    logger.info('[HostPreference] Health check stopped');
  }
}

function getHealthCheckIntervalMs() {
  return healthCheckIntervalMs;
}

function setHealthCheckIntervalMs(ms) {
  const parsed = parseInt(ms, 10);
  if (!Number.isFinite(parsed) || parsed < 10_000) return;
  healthCheckIntervalMs = parsed;
  if (healthCheckInterval) {
    stopHealthCheck();
    startHealthCheck();
  }
}

module.exports = {
  startHealthCheck,
  stopHealthCheck,
  getHealthCheckIntervalMs,
  setHealthCheckIntervalMs
};
