const planningMetricRegistry = require('./planningMetricRegistry');

const DEFAULT_REFRESH_MS = 3600000;
const DEFAULT_STALE_MS = 21600000;
const MIN_INTERVAL_MS = 60000;
const MAX_REFRESH_MS = 604800000;
const MAX_STALE_MS = 2592000000;

function interval(value, field, { fallback, max }) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  if (!Number.isFinite(number) || number < MIN_INTERVAL_MS || number > max) {
    const error = new Error(`${field} must be between ${MIN_INTERVAL_MS} and ${max}`);
    error.status = 400;
    error.code = 'INVALID_PLANNING_METRIC_BINDING';
    throw error;
  }
  return Math.round(number);
}

function cleanMetricAutomation(metric = {}, { partial = false } = {}) {
  const hasBinding = metric.adapter !== undefined || metric.params !== undefined;
  const hasTiming = metric.refreshEveryMs !== undefined || metric.staleAfterMs !== undefined;
  if (partial && !hasBinding && !hasTiming) return {};

  const payload = {};
  if (hasBinding || !partial) {
    if (partial && metric.params !== undefined && metric.adapter === undefined) {
      const error = new Error('progress.metric.adapter is required when params are updated');
      error.status = 400;
      error.code = 'INVALID_PLANNING_METRIC_BINDING';
      throw error;
    }
    const binding = planningMetricRegistry.validateBinding(metric.adapter, metric.params || {});
    payload.adapter = binding.adapter;
    payload.params = binding.params;
  }
  if (metric.refreshEveryMs !== undefined || !partial) {
    payload.refreshEveryMs = interval(metric.refreshEveryMs, 'progress.metric.refreshEveryMs', {
      fallback: DEFAULT_REFRESH_MS,
      max: MAX_REFRESH_MS
    });
  }
  if (metric.staleAfterMs !== undefined || !partial) {
    payload.staleAfterMs = interval(metric.staleAfterMs, 'progress.metric.staleAfterMs', {
      fallback: DEFAULT_STALE_MS,
      max: MAX_STALE_MS
    });
  }
  if (
    payload.refreshEveryMs !== undefined
    && payload.staleAfterMs !== undefined
    && payload.staleAfterMs < payload.refreshEveryMs
  ) {
    const error = new Error('progress.metric.staleAfterMs must be at least refreshEveryMs');
    error.status = 400;
    error.code = 'INVALID_PLANNING_METRIC_BINDING';
    throw error;
  }
  return payload;
}

module.exports = {
  DEFAULT_REFRESH_MS,
  DEFAULT_STALE_MS,
  MIN_INTERVAL_MS,
  MAX_REFRESH_MS,
  MAX_STALE_MS,
  cleanMetricAutomation
};
