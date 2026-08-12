'use strict';
/**
 * Host Capacity Service
 *
 * Answers one question per host: is it UNDERUSED, BALANCED, VRAM_CONSTRAINED,
 * or COMPUTE_SATURATED? Composes three trustworthy signal sources:
 *
 *   - Live `Host` record         → per-GPU VRAM/util/temp, Ollama service status
 *   - `HostMetricsSnapshot` hist → VRAM% p95 (reliable) + GPU-util p50/p95 (clean
 *                                  once the `?? null` fix in hostMonitorService
 *                                  accrues — historical util may be sparse)
 *   - `InferenceLog` aggregate   → call share, error rate, latency p95, top models
 *   - Live Ollama `/api/ps`      → resident models + per-model VRAM (best-effort)
 *
 * The classifier (`classifyCapacity`) is a pure function so the verdict rules are
 * unit-testable in isolation from Mongo/HTTP.
 */

const Host = require('../../models/Host');
const HostMetricsSnapshot = require('../../models/HostMetricsSnapshot');
const InferenceLog = require('../../models/InferenceLog');
const Alert = require('../../models/Alert');
const logger = require('../../config/logger');
const {
  getConfiguredHosts,
  validateHostUrl,
  parseHostIp,
  hostUrlKey,
} = require('../helpers/ollamaHostConfig');

// ── Verdict thresholds (operator-tunable defaults) ──────────────────────────
const DEFAULT_THRESHOLDS = {
  vramConstrainedPct: 90,    // VRAM p95 at/above → constrained
  vramSingleCardPct: 95,     // any one card at/above → constrained
  vramHeadroomPct: 70,       // VRAM p95 below → ample headroom (supports UNDERUSED)
  utilUnderusedP95: 40,      // GPU-util p95 below → not compute-bound
  utilUnderusedMean: 30,     // GPU-util mean below → idle-leaning
  utilSaturatedP95: 85,      // GPU-util p95 at/above → compute saturated
  errorRateHighPct: 10,      // inference error rate at/above → load failures
  latencySpikeMs: 30000,     // latency p95 at/above → contributes to constrained signal
  gpuImbalancePct: 60,       // |maxUtil - minUtil| above (multi-GPU) → imbalance
  callShareUnderusedPct: 25, // util-absent fallback: call share below → idle-leaning
  utilCoverageMin: 0.6,      // min util-sample coverage of the window to trust util (legacy-bug guard)
};

const VERDICTS = {
  UNDERUSED: 'UNDERUSED',
  BALANCED: 'BALANCED',
  VRAM_CONSTRAINED: 'VRAM_CONSTRAINED',
  COMPUTE_SATURATED: 'COMPUTE_SATURATED',
};

// ── Small math helpers ──────────────────────────────────────────────────────
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}
function round1(v) {
  return v == null ? null : Math.round(v * 10) / 10;
}
function round0(v) {
  return v == null ? null : Math.round(v);
}
const GENERIC_CONFIG_NAME_IDS = new Set(['localollama', 'ollama2', 'ollama3']);

function machineIdFromConfiguredName(name) {
  const id = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  if (!id || GENERIC_CONFIG_NAME_IDS.has(id)) return null;
  return id;
}

function buildCapacityHostIdentity(target = {}, host = null) {
  const configuredMachineId = machineIdFromConfiguredName(target.name);
  const hostRecordId = host?.hostId || null;
  const hostId = configuredMachineId || hostRecordId || target.id || null;
  const hostname = configuredMachineId ? target.name : (host?.hostname || target.name || null);
  const hostIdentityDrift = configuredMachineId && hostRecordId && hostRecordId !== configuredMachineId
    ? {
        type: 'host_id_mismatch',
        persisted: hostRecordId,
        configured: configuredMachineId,
        message: `Host record id ${hostRecordId} differs from configured machine id ${configuredMachineId}`
      }
    : null;

  return {
    hostId,
    hostname,
    persistedHostId: hostRecordId,
    hostIdentitySource: configuredMachineId ? 'configured_host_name' : (hostRecordId ? 'host_record' : 'configured_host_id'),
    hostIdentityDrift
  };
}
function percentile(values, p) {
  const arr = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v)).sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil((p / 100) * arr.length) - 1));
  return arr[idx];
}
function mean(values) {
  const arr = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}
function freqTop(items, n) {
  const freq = {};
  for (const m of items || []) freq[m] = (freq[m] || 0) + 1;
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([model, count]) => ({ model, count }));
}
function clampHours(h) {
  const n = parseInt(h, 10);
  if (!Number.isFinite(n) || n <= 0) return 24;
  return Math.min(n, 168); // cap at 7 days
}

/**
 * Pure verdict classifier. Given the rolled-up metrics, return
 * `{ verdict, reasons }`. Priority order: problems first (constrained, then
 * saturated), then underused, else balanced.
 *
 * Reliable-now signals (VRAM%, error rate, call share) can carry the verdict
 * even when GPU-util history is sparse; util tightens it when present.
 */
function classifyCapacity(m, thresholds = DEFAULT_THRESHOLDS) {
  const t = { ...DEFAULT_THRESHOLDS, ...thresholds };
  const reasons = [];

  const vramP95 = num(m.vramP95Pct);
  const maxCardVram = num(m.maxCardVramPct);
  const utilP95 = num(m.utilP95);
  const utilMean = num(m.utilMean);
  const errorRate = num(m.errorRate);
  const latencyP95 = num(m.latencyP95Ms);
  const callShare = num(m.callSharePct);
  // Coverage guard for the util-zero-preservation bug's legacy data: idle (0%)
  // snapshots were stored as null and dropped, biasing recorded util toward busy
  // moments (inflated p95). Trust util only when it covers enough of the window;
  // otherwise fall back to call share (always reliable).
  const utilSampleCount = m.utilSampleCount || 0;
  const snapshotCount = m.snapshotCount || 0;
  const utilCoverage = snapshotCount > 0 ? utilSampleCount / snapshotCount : 0;
  const hasReliableUtil = utilSampleCount > 0 && utilCoverage >= t.utilCoverageMin;

  // 1) VRAM constrained — highest-priority problem
  if (vramP95 != null && vramP95 >= t.vramConstrainedPct) {
    reasons.push(`VRAM p95 ${vramP95.toFixed(0)}% ≥ ${t.vramConstrainedPct}%`);
    return { verdict: VERDICTS.VRAM_CONSTRAINED, reasons };
  }
  if (maxCardVram != null && maxCardVram >= t.vramSingleCardPct) {
    reasons.push(`one card at ${maxCardVram.toFixed(0)}% VRAM ≥ ${t.vramSingleCardPct}%`);
    return { verdict: VERDICTS.VRAM_CONSTRAINED, reasons };
  }
  if (errorRate != null && errorRate >= t.errorRateHighPct &&
      latencyP95 != null && latencyP95 >= t.latencySpikeMs) {
    reasons.push(`error rate ${errorRate.toFixed(1)}% with latency p95 ${Math.round(latencyP95)}ms (load failures)`);
    return { verdict: VERDICTS.VRAM_CONSTRAINED, reasons };
  }

  // 2) Compute saturated (requires reliable util evidence — biased legacy data
  //    must not trigger a false saturation)
  if (hasReliableUtil && utilP95 != null && utilP95 >= t.utilSaturatedP95) {
    reasons.push(`GPU-util p95 ${utilP95.toFixed(0)}% ≥ ${t.utilSaturatedP95}%`);
    return { verdict: VERDICTS.COMPUTE_SATURATED, reasons };
  }

  // 3) Underused — ample VRAM headroom + low errors + low compute load.
  //    Compute-idle evidence: GPU-util when available, else low call share.
  const vramHeadroom = vramP95 == null || vramP95 < t.vramHeadroomPct;
  const lowError = errorRate == null || errorRate < t.errorRateHighPct;
  const computeIdle = hasReliableUtil
    ? (utilP95 != null && utilP95 < t.utilUnderusedP95 && utilMean != null && utilMean < t.utilUnderusedMean)
    : (callShare != null && callShare < t.callShareUnderusedPct);

  if (vramHeadroom && lowError && computeIdle) {
    if (hasReliableUtil) {
      reasons.push(`GPU-util p95 ${utilP95.toFixed(0)}% < ${t.utilUnderusedP95}% and mean ${utilMean.toFixed(0)}% < ${t.utilUnderusedMean}%`);
    } else if (callShare != null) {
      reasons.push(`call share ${callShare.toFixed(0)}% < ${t.callShareUnderusedPct}% (GPU-util history sparse — ${Math.round(utilCoverage * 100)}% coverage)`);
    }
    if (vramP95 != null) reasons.push(`VRAM p95 ${vramP95.toFixed(0)}% < ${t.vramHeadroomPct}% (ample headroom)`);
    return { verdict: VERDICTS.UNDERUSED, reasons };
  }

  // 4) Balanced default
  reasons.push('within balanced operating band');
  return { verdict: VERDICTS.BALANCED, reasons };
}

/** Resolve a caller key/name/IP/URL → { ollamaUrl, id, name, host(record), message }. */
async function resolveHostTarget(input) {
  const configured = getConfiguredHosts();
  const raw = String(input == null ? '' : input).trim();
  let ollamaUrl = null;
  let id = null;
  let name = null;
  let message = null;

  // Configured-host id match (primary/secondary/tertiary)
  const byId = configured.find((h) => h.id === raw.toLowerCase());
  if (byId) {
    ollamaUrl = byId.url; id = byId.id; name = byId.name;
  } else {
    const v = validateHostUrl(raw);
    if (v.valid && v.host) {
      ollamaUrl = v.host;
      const match = configured.find((h) => hostUrlKey(h.url) === hostUrlKey(v.host));
      if (match) { id = match.id; name = match.name; }
    } else {
      message = v.message;
    }
  }

  // Find the live Host record by ollamaUrl / ip
  let host = null;
  if (ollamaUrl) {
    const ip = parseHostIp(ollamaUrl);
    const or = [{ ollamaUrl }];
    if (ip) or.push({ ip });
    host = await Host.findOne({ $or: or }).lean();
  }

  // Fallback: caller named a Host directly (e.g. 'Host Gamma') not a configured Ollama id
  if (!host && raw) {
    host = await Host.findOne({ $or: [{ hostId: raw }, { hostname: raw }] }).lean();
    if (host && !ollamaUrl) {
      ollamaUrl = host.ollamaUrl || null;
      message = null;
    }
  }

  return { ollamaUrl, id, name, host, message };
}

/** Best-effort live `/api/ps` (resident models + per-model VRAM). Allowlist-gated. */
async function fetchLoadedModels(ollamaUrl, timeoutMs = 4000) {
  const v = validateHostUrl(ollamaUrl);
  if (!v.valid || !v.host) return { models: [], error: 'host not in allowlist' };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${v.host.replace(/\/$/, '')}/api/ps`, { signal: ctrl.signal });
    if (!resp.ok) return { models: [], error: `HTTP ${resp.status}` };
    const json = await resp.json();
    const models = (json.models || []).map((mdl) => ({
      name: mdl.name || mdl.model || '',
      sizeVramMiB: Math.round((mdl.size_vram || 0) / (1024 * 1024)),
      contextLength: mdl.context_length || null,
    }));
    return { models, error: null };
  } catch (err) {
    return { models: [], error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

function isOllamaReachableProbe(ollamaUrl, loadedResult) {
  return Boolean(ollamaUrl) && loadedResult && loadedResult.error == null;
}

function isCapacityHostCritical(report) {
  const host = report?.host || {};
  const serviceStatus = host.ollamaServiceStatus || '';
  const serviceDown = ['stopped', 'failed'].includes(serviceStatus);

  // Configured Ollama reachability is stronger than stale host-agent telemetry.
  // A host-agent can report offline/stopped while Ollama itself is serving; that
  // should not page as a capacity critical.
  if (host.ollamaUrl) {
    if (host.ollamaReachable === true) return false;
    if (host.ollamaReachable === false) return true;
  }

  return host.online === false || serviceDown;
}

function collectCapacityAlertIdentities(report, input) {
  const host = report?.host || {};
  return Array.from(new Set([
    input,
    report?.input,
    host.configId,
    host.hostId,
    host.hostname,
    host.ollamaUrl,
  ]
    .filter((v) => v !== undefined && v !== null)
    .map((v) => String(v).trim())
    .filter(Boolean)));
}

async function resolveStaleCapacityHostCriticalAlerts(report, input, now = new Date()) {
  const identities = collectCapacityAlertIdentities(report, input);
  if (!identities.length) return { matchedCount: 0, modifiedCount: 0 };

  return Alert.updateMany(
    {
      ruleId: 'capacity-host-critical',
      source: 'host-capacity',
      status: 'active',
      $or: [
        { 'context.component': { $in: identities } },
        { 'context.additionalData.component': { $in: identities } },
        { 'context.additionalData.host': { $in: identities } },
      ],
    },
    {
      $set: {
        status: 'resolved',
        'resolution.resolved': true,
        'resolution.resolvedAt': now,
        'resolution.resolvedBy': 'host-capacity',
        'resolution.resolutionMethod': 'auto-reachable',
        'resolution.comment': 'Resolved automatically because current Ollama reachability is healthy.',
      },
    }
  );
}

/**
 * Compute the full capacity report + verdict for a host.
 * @param {string} input host key/name/IP/URL (e.g. 'secondary', 'local-gpu', '192.0.2.10')
 * @param {number} hours lookback window (default 24, capped at 168)
 */
async function computeHostCapacity(input, hours = 24, opts = {}) {
  const windowHours = clampHours(hours);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(opts.thresholds || {}) };
  const target = await resolveHostTarget(input);

  if (!target.ollamaUrl && !target.host) {
    return { error: 'unresolved_host', input, message: target.message || 'host not found', generatedAt: new Date().toISOString() };
  }

  const host = target.host;
  const ollamaUrl = target.ollamaUrl || host?.ollamaUrl || null;
  const since = new Date(Date.now() - windowHours * 3600 * 1000);

  // ── Live per-GPU snapshot from Host record ──
  const liveGpus = (host?.gpus || []).map((g) => ({
    index: g.index ?? 0,
    name: g.name || '',
    vramTotalMiB: g.vramTotal || 0,
    vramUsedMiB: g.vramUsed || 0,
    usedPct: g.vramTotal ? round1((g.vramUsed / g.vramTotal) * 100) : null,
    utilization: g.utilization ?? null,
    temperature: g.temperature ?? null,
  }));
  const summedTotalMiB = liveGpus.reduce((s, g) => s + g.vramTotalMiB, 0);
  const summedUsedMiB = liveGpus.reduce((s, g) => s + g.vramUsedMiB, 0);
  const totalVramMiB = (host?.ollamaVram?.totalMiB || 0) || summedTotalMiB;
  const usedVramMiB = (host?.ollamaVram?.usedMiB || 0) || summedUsedMiB;
  const maxCardVramPct = liveGpus.reduce((mx, g) => (g.usedPct != null && g.usedPct > mx ? g.usedPct : mx), liveGpus.length ? 0 : null);

  // ── Snapshot history → util + VRAM% percentiles ──
  let utilSeries = [];
  let vramPctSeries = [];
  let vramPct15m = [];
  let snapshotCount = 0;
  if (host) {
    const snaps = await HostMetricsSnapshot.find({ hostId: host.hostId, timestamp: { $gte: since } })
      .select('gpus timestamp')
      .sort({ timestamp: 1 })
      .lean();
    snapshotCount = snaps.length;
    const cutoff15 = Date.now() - 15 * 60 * 1000;
    for (const s of snaps) {
      const cards = s.gpus || [];
      const utils = cards.map((c) => c.utilization).filter((u) => typeof u === 'number');
      if (utils.length) utilSeries.push(utils.reduce((a, b) => a + b, 0) / utils.length);
      if (totalVramMiB > 0) {
        const used = cards.reduce((a, c) => a + (c.vramUsed || 0), 0);
        const pct = (used / totalVramMiB) * 100;
        vramPctSeries.push(pct);
        if (new Date(s.timestamp).getTime() >= cutoff15) vramPct15m.push(pct);
      }
    }
  }
  const utilP50 = round0(percentile(utilSeries, 50));
  const utilP95 = round0(percentile(utilSeries, 95));
  const utilMax = round0(utilSeries.length ? Math.max(...utilSeries) : null);
  const utilMeanV = round0(mean(utilSeries));
  const vramP95Pct = round1(percentile(vramPctSeries, 95));
  const vramP95Recent15mPct = round1(percentile(vramPct15m, 95));

  // ── Inference telemetry: this host + fleet (one aggregation) ──
  const fleetRows = await InferenceLog.aggregate([
    { $match: { timestamp: { $gte: since } } },
    { $group: {
      _id: '$host',
      callCount: { $sum: 1 },
      errorCount: { $sum: { $cond: [{ $eq: ['$status', 'error'] }, 1, 0] } },
      avgLatencyMs: { $avg: '$durationMs' },
      totalTokensIn: { $sum: { $ifNull: ['$tokensIn', 0] } },
      totalTokensOut: { $sum: { $ifNull: ['$tokensOut', 0] } },
      models: { $push: '$model' },
    } },
  ]);
  const hostKey = ollamaUrl ? hostUrlKey(ollamaUrl) : null;
  const fleetCalls = fleetRows.reduce((s, r) => s + (r.callCount || 0), 0);
  const hostRow = hostKey ? fleetRows.find((r) => hostUrlKey(r._id) === hostKey) : null;
  const callCount = hostRow?.callCount || 0;
  const errorCount = hostRow?.errorCount || 0;
  const errorRate = callCount ? round1((errorCount / callCount) * 100) : 0;
  const callSharePct = fleetCalls ? round1((callCount / fleetCalls) * 100) : 0;
  const busierPeerExists = fleetRows.some((r) => hostUrlKey(r._id) !== hostKey && (r.callCount || 0) > callCount);

  // p95 latency from a bounded recent sample (avoids huge $push / version-specific $percentile)
  let latencyP95Ms = null;
  let avgLatencyMs = hostRow ? round0(hostRow.avgLatencyMs) : null;
  if (ollamaUrl) {
    const durs = await InferenceLog.find({ host: ollamaUrl, timestamp: { $gte: since }, status: { $ne: 'error' } })
      .select('durationMs')
      .sort({ timestamp: -1 })
      .limit(5000)
      .lean();
    const series = durs.map((d) => d.durationMs).filter((v) => typeof v === 'number');
    latencyP95Ms = round0(percentile(series, 95));
    if (avgLatencyMs == null && series.length) avgLatencyMs = round0(mean(series));
  }

  // ── Live resident models ──
  const loaded = ollamaUrl ? await fetchLoadedModels(ollamaUrl, opts.timeoutMs) : { models: [], error: 'no ollama url' };
  const hostAgentOnline = host ? host.status !== 'offline' : false;
  const ollamaReachable = isOllamaReachableProbe(ollamaUrl, loaded);
  const telemetryStale = Boolean(ollamaReachable && host && host.status === 'offline');

  // ── Imbalance (live instantaneous per-card util) ──
  const liveUtils = liveGpus.map((g) => g.utilization).filter((u) => typeof u === 'number');
  const maxGpuUtil = liveUtils.length ? Math.max(...liveUtils) : null;
  const minGpuUtil = liveUtils.length ? Math.min(...liveUtils) : null;
  const spread = maxGpuUtil != null && minGpuUtil != null ? maxGpuUtil - minGpuUtil : null;
  const imbalance = {
    multiGpu: liveGpus.length > 1,
    maxGpuUtil,
    minGpuUtil,
    spread,
    imbalanced: spread != null && liveGpus.length > 1 && spread >= thresholds.gpuImbalancePct,
  };

  // ── Verdict ──
  const metrics = {
    vramP95Pct, maxCardVramPct: round1(maxCardVramPct),
    utilP95, utilMean: utilMeanV, utilSampleCount: utilSeries.length, snapshotCount,
    errorRate, latencyP95Ms, callSharePct,
  };
  const { verdict, reasons } = classifyCapacity(metrics, thresholds);

  const online = hostAgentOnline || ollamaReachable;
  const ollamaServiceStatus = host?.ollamaService?.status || '';
  const hostIdentity = buildCapacityHostIdentity(target, host);

  return {
    input,
    windowHours,
    host: {
      hostId: hostIdentity.hostId,
      hostname: hostIdentity.hostname,
      persistedHostId: hostIdentity.persistedHostId,
      hostIdentitySource: hostIdentity.hostIdentitySource,
      hostIdentityDrift: hostIdentity.hostIdentityDrift,
      ip: host?.ip || (ollamaUrl ? parseHostIp(ollamaUrl) : null),
      ollamaUrl,
      configId: target.id,
      online,
      hostAgentOnline,
      ollamaReachable,
      telemetryStale,
      hostStatus: host?.status || 'unknown',
      ollamaServiceStatus,
      lastSeen: host?.lastSeen || null,
    },
    vram: {
      totalMiB: totalVramMiB,
      usedMiB: usedVramMiB,
      freeMiB: Math.max(0, totalVramMiB - usedVramMiB),
      usedPct: totalVramMiB ? round1((usedVramMiB / totalVramMiB) * 100) : null,
      p95Pct: vramP95Pct,
      p95Recent15mPct: vramP95Recent15mPct,
      maxCardPct: round1(maxCardVramPct),
      sampleCount: vramPctSeries.length,
      perGpu: liveGpus,
    },
    compute: {
      utilP50, utilP95, utilMax, utilMean: utilMeanV,
      sampleCount: utilSeries.length,
      snapshotCount,
      utilCoveragePct: snapshotCount ? round1((utilSeries.length / snapshotCount) * 100) : null,
    },
    inference: {
      callCount,
      errorCount,
      errorRate,
      callSharePct,
      fleetCallCount: fleetCalls,
      busierPeerExists,
      avgLatencyMs,
      latencyP95Ms,
      totalTokensIn: hostRow?.totalTokensIn || 0,
      totalTokensOut: hostRow?.totalTokensOut || 0,
      topModels: hostRow ? freqTop(hostRow.models, 5) : [],
    },
    loadedModels: loaded.models,
    loadedModelsError: loaded.error,
    imbalance,
    verdict,
    verdictReasons: reasons,
    thresholds,
    generatedAt: new Date().toISOString(),
  };
}

// ── Periodic alert checker ──────────────────────────────────────────────────
// In-memory throttle so the info/critical signals can't spam regardless of the
// engine's global dedup window. Keyed `<kind>:<host>` → last-emitted ms.
const _alertThrottle = new Map();
const _criticalFailureStreak = new Map();
function _throttled(key, minIntervalMs, nowMs) {
  const last = _alertThrottle.get(key) || 0;
  if (nowMs - last < minIntervalMs) return true;
  _alertThrottle.set(key, nowMs);
  return false;
}

function recordCapacityCriticalProbe(key, down, minFailures = 2) {
  if (!down) {
    _criticalFailureStreak.delete(key);
    return { count: 0, shouldEmit: false };
  }

  const count = (_criticalFailureStreak.get(key) || 0) + 1;
  _criticalFailureStreak.set(key, count);
  return { count, shouldEmit: count >= Math.max(1, minFailures) };
}

/**
 * Evaluate capacity for the configured hosts and emit alert events. Threshold
 * filtering for the numeric metrics (vram pressure, imbalance) is left to the
 * AlertRules (operator-tunable); the composite critical + info-underused signals
 * are pre-filtered here and throttled.
 */
async function checkCapacityAlerts(opts = {}) {
  const alertService = require('./alertService');
  const hours = opts.hours || 24;
  const targets = opts.hosts || getConfiguredHosts().map((h) => h.id);
  const criticalConsecutiveFailures = opts.criticalConsecutiveFailures || 2;
  const nowMs = Date.now();
  const results = [];

  for (const tgt of targets) {
    try {
      const rep = await computeHostCapacity(tgt, hours, { timeoutMs: 4000 });
      if (rep.error) continue;
      const comp = rep.host.hostId || rep.host.ollamaUrl || String(tgt);

      // Critical — host offline / Ollama service down (pre-filtered, 15-min throttle)
      const down = isCapacityHostCritical(rep);
      let criticalProbe = { count: 0, shouldEmit: false };
      if (!down) {
        recordCapacityCriticalProbe(comp, false, criticalConsecutiveFailures);
      } else {
        criticalProbe = recordCapacityCriticalProbe(comp, true, criticalConsecutiveFailures);
      }

      if (!down || !criticalProbe.shouldEmit) {
        await resolveStaleCapacityHostCriticalAlerts(rep, tgt);
      }

      if (down && criticalProbe.shouldEmit && !_throttled(`crit:${comp}`, 15 * 60 * 1000, nowMs)) {
        await alertService.evaluateEvent({
          source: 'host-capacity', component: comp, host: comp,
          metric: 'capacity_host_critical', value: 100,
          detail: rep.host.online ? `Ollama service ${rep.host.ollamaServiceStatus}` : 'host offline',
        });
      }

      // Warning — sustained VRAM pressure (rule thresholds the value at >90)
      if (rep.vram.p95Recent15mPct != null) {
        await alertService.evaluateEvent({
          source: 'host-capacity', component: comp, host: comp,
          metric: 'capacity_vram_pressure', value: rep.vram.p95Recent15mPct,
        });
      }

      // Warning — dual-GPU imbalance (rule thresholds the spread at >60)
      if (rep.imbalance.multiGpu && rep.imbalance.spread != null) {
        await alertService.evaluateEvent({
          source: 'host-capacity', component: comp, host: comp,
          metric: 'capacity_gpu_imbalance', value: rep.imbalance.spread,
        });
      }

      // Info — underused while a busier peer exists (pre-filtered, 12-hour throttle)
      if (rep.verdict === VERDICTS.UNDERUSED && rep.inference.busierPeerExists &&
          !_throttled(`under:${comp}`, 12 * 60 * 60 * 1000, nowMs)) {
        await alertService.evaluateEvent({
          source: 'host-capacity', component: comp, host: comp,
          metric: 'capacity_underused', value: rep.inference.callSharePct ?? 0,
        });
      }

      results.push({ host: comp, verdict: rep.verdict });
    } catch (err) {
      logger.warn('[hostCapacity] alert check failed', { host: String(tgt), error: err.message });
    }
  }
  return results;
}

module.exports = {
  computeHostCapacity,
  classifyCapacity,
  checkCapacityAlerts,
  resolveHostTarget,
  machineIdFromConfiguredName,
  buildCapacityHostIdentity,
  isCapacityHostCritical,
  collectCapacityAlertIdentities,
  resolveStaleCapacityHostCriticalAlerts,
  recordCapacityCriticalProbe,
  DEFAULT_THRESHOLDS,
  VERDICTS,
};
