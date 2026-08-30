'use strict';

/**
 * Inference Health — composite snapshot for the Nerve Center "Inference Health"
 * section. Bundles data that would otherwise require 4 separate endpoint hits:
 *
 *   - hostGate stats            (admission queue depth)
 *   - benchmark claim list      (who owns which host right now)
 *   - watchdog summary          (probe state + recent events)
 *   - num_ctx drift             (aggregation from InferenceLog over a window)
 *
 * Kept deliberately small — this is a read-only dashboard feed, not a general
 * API. Don't put logic here that should live in its source service; just
 * shape the payload for the UI.
 */

const logger = require('../../config/logger');
const hostGate = require('./hostGate');
const watchdog = require('./ollamaWatchdogService');
const hostPrefService = require('./hostPreferenceService');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');

const DEFAULT_DRIFT_WINDOW_MS = 15 * 60 * 1000; // 15 min
function summarizeDriftRows(rows, windowMs = DEFAULT_DRIFT_WINDOW_MS, since = null) {
  const byCallerSource = rows.map(r => ({
    caller: r._id?.caller || null,
    source: r._id?.source || null,
    count: r.count,
    sampleHost: r.sampleHost,
    sampleModel: r.sampleModel
  }));

  // Host preference pins are an intentional deployment policy, not resolver
  // drift. Missing source data is unknown and must not silently enter either
  // the healthy numerator or the drift denominator.
  const totals = byCallerSource.reduce((acc, row) => {
    const source = row.source;
    const count = Number(row.count) || 0;
    if (source === 'n/a') acc.na += count;
    else if (!source) acc.unknown += count;
    else {
      acc.total += count;
      if (source === 'modelfile') acc.modelfile += count;
      else if (source === 'caller') acc.caller += count;
      else if (source === 'host_preference_pin') acc.pinned += count;
      else acc.resolved += count;
    }
    return acc;
  }, { total: 0, modelfile: 0, caller: 0, pinned: 0, resolved: 0, unknown: 0, na: 0 });

  return {
    windowMs,
    ...(since ? { since } : {}),
    byCallerSource,
    totals,
    hasSamples: totals.total > 0,
    driftPct: totals.total > 0
      ? Number(((totals.resolved / totals.total) * 100).toFixed(1))
      : null
  };
}

async function getDriftSummary(windowMs) {
  try {
    const InferenceLog = require('../../models/InferenceLog');
    const since = new Date(Date.now() - (windowMs || DEFAULT_DRIFT_WINDOW_MS));
    const rows = await InferenceLog.aggregate([
      { $match: { timestamp: { $gte: since } } },
      {
        $group: {
          _id: { caller: '$caller', source: '$num_ctx_source' },
          count: { $sum: 1 },
          sampleHost: { $last: '$host' },
          sampleModel: { $last: '$model' }
        }
      },
      { $sort: { count: -1 } },
      { $limit: 50 }
    ]).option({ maxTimeMS: 5000 });

    return summarizeDriftRows(rows, windowMs || DEFAULT_DRIFT_WINDOW_MS, since.toISOString());
  } catch (err) {
    logger.warn('[inferenceHealth] drift aggregation failed', { error: err.message });
    return {
      windowMs: windowMs || DEFAULT_DRIFT_WINDOW_MS,
      byCallerSource: [],
      totals: { total: 0, modelfile: 0, caller: 0, pinned: 0, resolved: 0, unknown: 0, na: 0 },
      hasSamples: false,
      driftPct: null,
      error: err.message
    };
  }
}

function getGateSnapshot() {
  try {
    const stats = hostGate.stats();
    const entries = Object.values(stats.entries || {}).map(e => ({
      host: e.host,
      model: e.model,
      inFlight: e.inFlight,
      peak: e.peak,
      waiters: e.waiters,
      maxWaiters: e.maxWaiters,
      totalAcquired: e.totalAcquired,
      totalReleased: e.totalReleased
    }));
    return {
      enabled: stats.enabled,
      maxInflight: stats.maxInflight,
      entries,
      totalInFlight: entries.reduce((n, e) => n + e.inFlight, 0),
      totalWaiters: entries.reduce((n, e) => n + e.waiters, 0)
    };
  } catch (err) {
    return { enabled: false, error: err.message, entries: [] };
  }
}

function getWatchdogSnapshot() {
  try {
    const stats = watchdog.getStats();
    // Normalise — the watchdog's getStats returns rich data; keep just what
    // the dashboard needs. Note the watchdog exposes `isRunning` and
    // `config.probeIntervalMs` — don't let that naming leak to the UI.
    return {
      running: !!stats.isRunning,
      probeIntervalMs: stats.config?.probeIntervalMs,
      probesSent: stats.probesSent || 0,
      probesOk: stats.probesOk || 0,
      probesFailed: stats.probesFailed || 0,
      jamsDetected: stats.jamsDetected || 0,
      unjamsDone: stats.unjamsDone || 0,
      lastProbeAt: stats.lastProbeAt,
      lastJamAt: stats.lastJamAt,
      recentEvents: (stats.history || []).slice(-10).reverse()
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Judge-drift snapshot proxied from benchmark (0156). Shape mirrors
 * benchmark's GET /api/benchmark/drift response (overall_status, per-category
 * ρ vs baseline, thresholds). Returns `{ unavailable: true, error }` when the
 * benchmark service is offline so the UI can render a muted cell instead of
 * a hard error — the row is informational, not a hard dependency.
 */
async function getJudgeDriftSnapshot() {
  try {
    const client = getBenchmarkServiceClient();
    const payload = await client.getJudgeDrift();
    if (!payload) {
      return { unavailable: true, reason: 'benchmark-unreachable' };
    }
    return payload;
  } catch (err) {
    logger.warn('[inferenceHealth] judge drift fetch failed', { error: err.message });
    return { unavailable: true, error: err.message };
  }
}

async function getInferenceHealth(opts = {}) {
  const [claims, drift, judgeDrift] = await Promise.all([
    hostPrefService.listBenchmarkClaims().catch(err => ({ error: err.message, claims: [] })),
    getDriftSummary(opts.driftWindowMs),
    getJudgeDriftSnapshot()
  ]);

  const claimsArr = Array.isArray(claims) ? claims : [];
  const now = Date.now();
  const enrichedClaims = claimsArr.map(c => ({
    ...c,
    ageMs: c.claimedAt ? now - new Date(c.claimedAt).getTime() : null
  }));

  return {
    generatedAt: new Date().toISOString(),
    gate: getGateSnapshot(),
    benchmarkClaims: enrichedClaims,
    watchdog: getWatchdogSnapshot(),
    drift,
    judgeDrift
  };
}

module.exports = {
  getInferenceHealth,
  getDriftSummary,
  summarizeDriftRows,
  getGateSnapshot,
  getWatchdogSnapshot,
  getJudgeDriftSnapshot
};
