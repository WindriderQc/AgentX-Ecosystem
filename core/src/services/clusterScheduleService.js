/**
 * Cluster Schedule Service
 *
 * Manages scheduled task entries across the cluster.
 * Resolves cron expressions to timelines and upcoming occurrences.
 */
const { CronExpressionParser } = require('cron-parser');
const logger = require('../../config/logger');
const ClusterScheduleEntry = require('../../models/ClusterScheduleEntry');
const ClusterScheduleClaim = require('../../models/ClusterScheduleClaim');
const { randomUUID } = require('crypto');
const { defaultPlanningTimeZone } = require('./planningDateService');

function normalizeRoutedModelName(modelName) {
  return String(modelName || '').trim().toLowerCase().replace(/:latest$/i, '');
}

function sameRoutedModel(left, right) {
  const normalizedLeft = normalizeRoutedModelName(left);
  const normalizedRight = normalizeRoutedModelName(right);
  return normalizedLeft.length > 0 && normalizedLeft === normalizedRight;
}

/**
 * Get all schedule entries with optional filters.
 * @param {Object} filters - { host, taskType, source, enabled }
 * @returns {Promise<Array>}
 */
async function getAllEntries(filters = {}) {
  const query = {};
  if (filters.host) query.host = filters.host;
  if (filters.taskType) query.taskType = filters.taskType;
  if (filters.source) query.source = filters.source;
  if (filters.enabled !== undefined) query.enabled = filters.enabled;
  return ClusterScheduleEntry.find(query).sort({ priority: 1, name: 1 }).lean();
}

/**
 * Resolve all enabled entries into time slots for a given date.
 * Note: day boundaries use UTC (00:00Z–23:59Z). Cron expressions are resolved
 * in the requested timezone. Late-night local tasks may fall outside the UTC day
 * window — a known limitation for v1.
 * @param {string} dateStr - ISO date string (YYYY-MM-DD)
 * @param {string} timezone - IANA timezone
 * @returns {Promise<Array>} - Array of { entry, slots: [{ start, end }] }
 */
async function getTimeline(dateStr, timezone = defaultPlanningTimeZone()) {
  const entries = await ClusterScheduleEntry.find({ enabled: true }).lean();
  const dayStart = new Date(`${dateStr}T00:00:00Z`);
  const dayEnd = new Date(`${dateStr}T23:59:59Z`);
  const timeline = [];

  for (const entry of entries) {
    const slots = resolveSlots(entry, dayStart, dayEnd, timezone);
    if (slots.length > 0) {
      timeline.push({
        id: entry._id,
        name: entry.name,
        source: entry.source,
        sourceId: entry.sourceId,
        taskType: entry.taskType,
        host: entry.host,
        model: entry.model,
        agent: entry.agent,
        priority: entry.priority,
        estimatedDurationMs: entry.estimatedDurationMs,
        vramMb: entry.vramMb,
        scheduleType: entry.schedule?.type || null,
        metadata: entry.metadata || {},
        slots
      });
    }
  }

  return timeline;
}

/**
 * Resolve time slots for a single entry within a day range.
 */
function resolveSlots(entry, dayStart, dayEnd, timezone) {
  const schedType = entry.schedule?.type;

  if (schedType === 'continuous') {
    return [{ start: dayStart.toISOString(), end: dayEnd.toISOString(), continuous: true }];
  }

  if (schedType === 'interval') {
    const intervalMs = entry.schedule.intervalMs;
    if (!intervalMs || intervalMs < 60000) {
      return [{ start: dayStart.toISOString(), end: dayEnd.toISOString(), continuous: true }];
    }
    const slots = [];
    let cursor = new Date(dayStart);
    while (cursor < dayEnd) {
      const end = new Date(cursor.getTime() + (entry.estimatedDurationMs || intervalMs));
      slots.push({
        start: cursor.toISOString(),
        end: (end > dayEnd ? dayEnd : end).toISOString()
      });
      cursor = new Date(cursor.getTime() + intervalMs);
    }
    return slots;
  }

  if (schedType === 'cron' && entry.schedule.cron) {
    try {
      const options = {
        currentDate: dayStart,
        endDate: dayEnd,
        tz: timezone || entry.schedule.timezone || defaultPlanningTimeZone()
      };
      const interval = CronExpressionParser.parse(entry.schedule.cron, options);
      const slots = [];
      while (true) {
        try {
          const next = interval.next();
          const start = next.toDate ? next.toDate() : new Date(next);
          const durationMs = entry.estimatedDurationMs || 300000; // default 5 min
          const end = new Date(start.getTime() + durationMs);
          slots.push({
            start: start.toISOString(),
            end: (end > dayEnd ? dayEnd : end).toISOString()
          });
        } catch {
          break; // iteration complete
        }
      }
      return slots;
    } catch (err) {
      logger.warn('Failed to parse cron expression', {
        name: entry.name,
        cron: entry.schedule.cron,
        error: err.message
      });
      return [];
    }
  }

  return [];
}

/**
 * Get the next N upcoming tasks across all enabled cron entries.
 * @param {number} count - Max results
 * @returns {Promise<Array>}
 */
async function getNextTasks(count = 5) {
  const entries = await ClusterScheduleEntry.find({
    enabled: true,
    'schedule.type': { $in: ['cron', 'interval'] }
  }).lean();

  const now = new Date();
  const upcoming = [];

  for (const entry of entries) {
    const next = getNextOccurrence(entry, now);
    if (next) {
      upcoming.push({
        id: entry._id,
        name: entry.name,
        source: entry.source,
        taskType: entry.taskType,
        host: entry.host,
        model: entry.model,
        priority: entry.priority,
        nextRun: next.toISOString(),
        msFromNow: next.getTime() - now.getTime(),
        scheduleType: entry.schedule.type,
        intervalMs: entry.schedule.intervalMs || null,
        dailyCount: estimateDailyCount(entry)
      });
    }
  }

  upcoming.sort((a, b) => a.msFromNow - b.msFromNow);
  return upcoming.slice(0, count);
}

/**
 * Estimate how many times an entry fires per day.
 * Used to classify service ticks vs meaningful scheduled jobs.
 */
function estimateDailyCount(entry) {
  if (entry.schedule?.type === 'interval' && entry.schedule.intervalMs > 0) {
    return Math.round(86400000 / entry.schedule.intervalMs);
  }
  if (entry.schedule?.type === 'cron' && entry.schedule.cron) {
    try {
      const tz = entry.schedule.timezone || defaultPlanningTimeZone();
      const now = new Date();
      const iter = CronExpressionParser.parse(entry.schedule.cron, { currentDate: now, tz });
      const t1raw = iter.next();
      const t2raw = iter.next();
      const t1 = t1raw.toDate ? t1raw.toDate().getTime() : new Date(t1raw).getTime();
      const t2 = t2raw.toDate ? t2raw.toDate().getTime() : new Date(t2raw).getTime();
      const gapMs = t2 - t1;
      return gapMs > 0 ? Math.round(86400000 / gapMs) : 1;
    } catch { return 1; }
  }
  return 1;
}

/**
 * Get next occurrence for a single entry.
 */
function getNextOccurrence(entry, now) {
  if (entry.schedule?.type === 'cron' && entry.schedule.cron) {
    try {
      const interval = CronExpressionParser.parse(entry.schedule.cron, {
        currentDate: now,
        tz: entry.schedule.timezone || defaultPlanningTimeZone()
      });
      const next = interval.next();
      return next.toDate ? next.toDate() : new Date(next);
    } catch {
      return null;
    }
  }

  if (entry.schedule?.type === 'interval' && entry.schedule.intervalMs) {
    const lastRun = entry.lastRun ? new Date(entry.lastRun) : now;
    const next = new Date(lastRun.getTime() + entry.schedule.intervalMs);
    return next > now ? next : new Date(now.getTime() + entry.schedule.intervalMs);
  }

  return null;
}

/**
 * Upsert entries by source+sourceId. Idempotent.
 * @param {Array} entries - Array of entry objects
 * @returns {Promise<{ created: number, updated: number, unchanged: number }>}
 */
async function syncEntries(entries) {
  const stats = { created: 0, updated: 0, unchanged: 0 };

  for (const entry of entries) {
    if (!entry.source || !entry.sourceId) {
      logger.warn('Skipping entry missing source/sourceId', { name: entry.name });
      continue;
    }

    const existing = await ClusterScheduleEntry.findOne({
      source: entry.source,
      sourceId: entry.sourceId
    });

    if (!existing) {
      await ClusterScheduleEntry.create(entry);
      stats.created++;
    } else {
      const changed = hasChanges(existing, entry);
      if (changed) {
        await ClusterScheduleEntry.updateOne(
          { source: entry.source, sourceId: entry.sourceId },
          { $set: entry }
        );
        stats.updated++;
      } else {
        stats.unchanged++;
      }
    }
  }

  logger.info('Cluster schedule sync complete', stats);
  return stats;
}

/**
 * Check if an entry has meaningful changes compared to existing.
 */
function hasChanges(existing, incoming) {
  const fields = ['name', 'taskType', 'host', 'model', 'agent', 'estimatedDurationMs', 'vramMb', 'priority', 'enabled'];
  for (const f of fields) {
    if (incoming[f] === undefined) continue;
    const a = existing[f] == null ? null : existing[f];
    const b = incoming[f] == null ? null : incoming[f];
    if (String(a) !== String(b)) return true;
  }
  if (incoming.schedule) {
    const es = existing.schedule || {};
    if ((incoming.schedule.cron || null) !== (es.cron || null)) return true;
    if ((incoming.schedule.intervalMs || null) !== (es.intervalMs || null)) return true;
    if (incoming.schedule.type !== es.type) return true;
    if (incoming.schedule.timezone !== undefined
      && (incoming.schedule.timezone || null) !== (es.timezone || null)) return true;
  }
  if (incoming.lastRun !== undefined) {
    const existingLastRun = existing.lastRun ? new Date(existing.lastRun).getTime() : null;
    const incomingLastRun = incoming.lastRun ? new Date(incoming.lastRun).getTime() : null;
    if (existingLastRun !== incomingLastRun) return true;
  }
  if (incoming.metadata !== undefined) {
    const existingMetadata = existing.metadata?.toObject
      ? existing.metadata.toObject()
      : (existing.metadata || {});
    if (JSON.stringify(existingMetadata) !== JSON.stringify(incoming.metadata || {})) return true;
  }
  return false;
}

/**
 * Pivot timeline data by host — rows are hosts, each containing their tasks.
 * Includes unassigned tasks (host=null) in a separate bucket.
 */
async function getTimelineByHost(dateStr, timezone = defaultPlanningTimeZone()) {
  const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
  const timeline = await getTimeline(dateStr, timezone);
  const hosts = getConfiguredHosts();

  const hostMap = {};
  for (const h of hosts) {
    hostMap[h.id] = { hostId: h.id, hostName: h.name, vramCapacityMb: h.vramMb || null, tasks: [] };
  }
  hostMap['unassigned'] = { hostId: 'unassigned', hostName: 'Unassigned', vramCapacityMb: null, tasks: [] };

  for (const entry of timeline) {
    const key = entry.host && hostMap[entry.host] ? entry.host : 'unassigned';
    hostMap[key].tasks.push(entry);
  }

  // Only return hosts that have tasks or are configured
  return Object.values(hostMap).filter(h => h.tasks.length > 0 || hosts.some(c => c.id === h.hostId));
}

/**
 * Detect scheduling conflicts: overlapping time slots on the same host.
 */
async function getConflicts(dateStr, timezone = defaultPlanningTimeZone()) {
  const timeline = await getTimeline(dateStr, timezone);
  const byHost = {};

  for (const entry of timeline) {
    // Entries with no model consume no GPU — skip from conflict detection
    if (!entry.model) continue;
    const h = entry.host || 'unassigned';
    if (!byHost[h]) byHost[h] = [];
    byHost[h].push(entry);
  }

  const conflicts = [];
  for (const [hostId, entries] of Object.entries(byHost)) {
    // Flatten all slots with their parent entry info
    const allSlots = [];
    for (const entry of entries) {
      for (const slot of entry.slots) {
        if (slot.continuous) continue; // continuous tasks always overlap, skip
        allSlots.push({ start: new Date(slot.start), end: new Date(slot.end), entryId: entry.id, name: entry.name, taskType: entry.taskType });
      }
    }
    for (let i = 0; i < allSlots.length; i++) {
      for (let j = i + 1; j < allSlots.length; j++) {
        const a = allSlots[i];
        const b = allSlots[j];
        if (a.start < b.end && b.start < a.end) {
          conflicts.push({
            hostId,
            taskA: { id: a.entryId, name: a.name, taskType: a.taskType, start: a.start.toISOString(), end: a.end.toISOString() },
            taskB: { id: b.entryId, name: b.name, taskType: b.taskType, start: b.start.toISOString(), end: b.end.toISOString() }
          });
        }
      }
    }
  }

  return conflicts;
}

// ── Placement Service (Phase 2) ──────────────────────────────────────────

const ModelRegistry = require('../../models/ModelRegistry');
const clusterLiveService = require('./clusterLiveService');

/**
 * Soft-claims are persisted in Mongo so multiple Core replicas score the same
 * advisory placement pressure. The compatibility map below remains only for
 * older tests/helpers that still call _getClaimsMap().clear().
 */
const _claims = new Map();
const CLAIM_DEFAULT_TTL_MS = 30000;

/** Purge expired claims. Called before reads. */
async function _purgeExpiredClaims(now = new Date()) {
  for (const [id, claim] of _claims) {
    if (claim.expiresAt <= now.getTime()) _claims.delete(id);
  }
  await ClusterScheduleClaim.deleteMany({ expiresAt: { $lte: now } });
}

/** Expose claims map for testing */
function _getClaimsMap() { return _claims; }

async function _clearClaimsForTests() {
  _claims.clear();
  await ClusterScheduleClaim.deleteMany({});
}

/**
 * Report measured VRAM required to load a model, in MiB.
 * Artifact size and parameter names do not reveal runtime KV/context memory,
 * so an unmeasured model remains unknown.
 * @param {string} modelName
 * @returns {Promise<{ estimatedMiB: number, confidence: string }>}
 */
async function getModelVramEstimate(modelName) {
  const reg = await ModelRegistry.findOne({ modelName }).lean();
  if (reg?.hostPerformance?.length > 0) {
    const passing = reg.hostPerformance.filter(s => s.status === 'pass' && s.vramUsedMiB > 0);
    if (passing.length > 0) {
      const avgVram = Math.ceil(passing.reduce((s, p) => s + p.vramUsedMiB, 0) / passing.length);
      return { estimatedMiB: avgVram, confidence: 'measured' };
    }
  }

  return { estimatedMiB: null, confidence: 'unknown' };
}

/**
 * Recommend the best host for running a model right now.
 * @param {string} modelName
 * @param {number} durationMs - Expected duration (default 30000)
 * @param {string} priority - 'low' | 'normal' | 'high' (default 'normal')
 * @returns {Promise<{ host: string, hostUrl: string, reason: string, confidence: string, warnings: string[] }>}
 */
async function recommendHost(modelName, durationMs = 30000, priority = 'normal') {
  const { getConfiguredHosts } = require('../helpers/ollamaHostConfig');
  const warnings = [];

  // Gather data in parallel. benchmarkClaims tells us which hosts are
  // currently running a benchmark batch. Consumer traffic must not route to
  // those hosts; benchmark/profiler callers bypass advisory with explicit
  // host overrides.
  const hostPrefService = require('./hostPreferenceService');
  const [liveState, vramEstimate, configuredHosts, defaultModelsMap, benchmarkClaims, scheduleClaims] = await Promise.all([
    clusterLiveService.getLiveState(),
    getModelVramEstimate(modelName),
    Promise.resolve(getConfiguredHosts()),
    hostPrefService.getPinnedModelsMap(),
    hostPrefService.listBenchmarkClaims().catch(() => []),
    getActiveClaims().catch(() => [])
  ]);
  const benchmarkingHostUrls = new Set(benchmarkClaims.map(c => c.hostUrl));

  if (configuredHosts.length === 0) {
    return { host: null, hostUrl: null, reason: 'No configured hosts', confidence: 'none', warnings: ['No Ollama hosts configured'] };
  }

  // Build host candidate list with scored attributes
  const candidates = configuredHosts.map(cfg => {
    const live = liveState.hosts.find(h => h.id === cfg.id);
    const online = live?.status === 'online';
    const loadedModels = live?.models || [];
    const modelLoaded = loadedModels.some(m =>
      sameRoutedModel(m.name, modelName) || sameRoutedModel(m.model, modelName)
    );

    // Compute used VRAM from loaded models (sizeVram in bytes)
    let usedVramMiB = 0;
    for (const m of loadedModels) {
      if (m.sizeVram) usedVramMiB += m.sizeVram / (1024 * 1024);
    }
    const totalVramMiB = cfg.vramMb || 0;
    const freeVramMiB = totalVramMiB - usedVramMiB;

    // If the model is already loaded, it doesn't need additional VRAM
    const additionalVramNeeded = modelLoaded ? 0 : vramEstimate.estimatedMiB;
    const fits = modelLoaded
      ? true
      : (additionalVramNeeded == null ? null : freeVramMiB >= additionalVramNeeded);

    // Count active claims on this host
    const activeClaims = scheduleClaims.filter(claim => claim.host === cfg.id);

    return {
      id: cfg.id, name: cfg.name, url: cfg.url,
      online, modelLoaded, loadedModels,
      totalVramMiB, usedVramMiB: Math.round(usedVramMiB), freeVramMiB: Math.round(freeVramMiB),
      additionalVramNeeded, fits,
      activeClaims: activeClaims.length,
      priority: cfg.priority,
      benchmarking: benchmarkingHostUrls.has(cfg.url)
    };
  });

  const onlineCandidates = candidates.filter(c => c.online);
  const routableCandidates = onlineCandidates.filter(c => !c.benchmarking);
  if (onlineCandidates.length > 0 && routableCandidates.length === 0) {
    warnings.push('All online Ollama hosts are held by active benchmark claims');
    return {
      host: null,
      hostUrl: null,
      reason: 'All online Ollama hosts are held by active benchmark claims',
      confidence: 'none',
      vramEstimate,
      warnings,
      blockedByBenchmarkClaim: true,
      _scored: candidates.map(s => ({
        host: s.id,
        name: s.name,
        score: null,
        reasons: s.benchmarking ? ['benchmarking in progress'] : [s.online ? 'not selected' : 'offline']
      }))
    };
  }

  // Score candidates (higher = better)
  const scored = routableCandidates
    .map(c => {
      let score = 0;
      const reasons = [];

      // Strong preference: model already loaded (avoids load/unload churn)
      if (c.modelLoaded) {
        score += 100;
        reasons.push('model already loaded');
      }

      // Must fit in VRAM
      if (c.fits === true) {
        score += 50;
        // Prefer hosts with more headroom
        score += Math.min(c.freeVramMiB / 100, 30);
        reasons.push(`${c.freeVramMiB} MiB free`);
      } else if (c.fits === false) {
        score -= 200;
        reasons.push(`insufficient VRAM (need ${c.additionalVramNeeded} MiB, have ${c.freeVramMiB} MiB free)`);
      } else {
        reasons.push('model VRAM requirement is unmeasured');
      }

      // Fewer active claims = less contention
      score -= c.activeClaims * 15;
      if (c.activeClaims > 0) reasons.push(`${c.activeClaims} active claims`);

      // Fewer loaded models = less eviction risk
      score -= c.loadedModels.length * 5;

      // Prefer hosts where this model is the configured default
      const hostDefaults = defaultModelsMap.get(c.url) || [];
      if (hostDefaults.some(defaultModel => sameRoutedModel(defaultModel, modelName))) {
        score += 25;
        reasons.push('host default model');
      }

      return { ...c, score, reasons };
    })
    .sort((a, b) => b.score - a.score);

  if (scored.length === 0) {
    warnings.push('All configured hosts are unreachable; no placement is available');
    return {
      host: null,
      hostUrl: null,
      reason: 'No reachable host',
      confidence: 'none', warnings
    };
  }

  const best = scored[0];

  if (best.fits === false && !best.modelLoaded) {
    warnings.push(`Model may not fit on ${best.name} — ${best.additionalVramNeeded} MiB needed, ${best.freeVramMiB} MiB free`);
  } else if (best.fits == null && !best.modelLoaded) {
    warnings.push(`Model VRAM requirement is unmeasured; placement on ${best.name} is advisory only`);
  }
  const excludedBenchmarking = onlineCandidates
    .filter(c => c.benchmarking)
    .map(s => ({ host: s.id, name: s.name, score: null, reasons: ['benchmarking in progress'] }));

  return {
    host: best.id,
    hostUrl: best.url,
    reason: best.reasons.join('; '),
    confidence: vramEstimate.confidence,
    vramEstimate,
    warnings,
    _scored: [
      ...scored.map(s => ({ host: s.id, name: s.name, score: s.score, reasons: s.reasons })),
      ...excludedBenchmarking
    ]
  };
}

/**
 * Create a soft-claim: announce intent to use a host for a model.
 * @param {string} host - Host ID
 * @param {string} model - Model name
 * @param {string} caller - Consumer ID
 * @param {number} ttlMs - TTL in ms (default 30s)
 * @returns {Promise<{ claimId: string, expiresAt: string }>}
 */
async function createClaim(host, model, caller, ttlMs = CLAIM_DEFAULT_TTL_MS) {
  const ttl = Number.isFinite(Number(ttlMs)) ? Number(ttlMs) : CLAIM_DEFAULT_TTL_MS;
  const now = new Date();
  await _purgeExpiredClaims(now);

  const claimId = `${String(caller).replace(/[^a-zA-Z0-9_-]/g, '_')}-${String(host).replace(/[^a-zA-Z0-9_-]/g, '_')}-${randomUUID()}`;
  const expiresAt = new Date(now.getTime() + ttl);

  await ClusterScheduleClaim.create({
    _id: claimId,
    host,
    model,
    caller,
    expiresAt,
    ttlMs: ttl
  });

  return { claimId, expiresAt: expiresAt.toISOString() };
}

/**
 * Release a claim early (consumer finished before TTL).
 * @param {string} claimId
 * @returns {Promise<boolean>} true if claim was found and removed
 */
async function releaseClaim(claimId) {
  _claims.delete(claimId);
  const result = await ClusterScheduleClaim.deleteOne({ _id: claimId });
  return result.deletedCount === 1;
}

/**
 * List all active (non-expired) claims.
 * @returns {Promise<Array>}
 */
async function getActiveClaims() {
  const now = new Date();
  await _purgeExpiredClaims(now);
  const claims = await ClusterScheduleClaim.find({ expiresAt: { $gt: now } })
    .sort({ expiresAt: 1 })
    .lean();
  return claims.map(claim => ({
    claimId: claim._id,
    host: claim.host,
    model: claim.model,
    caller: claim.caller,
    ttlMs: claim.ttlMs ?? null,
    metadata: claim.metadata || {},
    createdAt: claim.createdAt ? new Date(claim.createdAt).toISOString() : null,
    expiresAt: new Date(claim.expiresAt).toISOString()
  }));
}

module.exports = {
  getAllEntries, getTimeline, getTimelineByHost, getConflicts, getNextTasks, syncEntries,
  // Phase 2: Placement
  getModelVramEstimate, recommendHost, createClaim, releaseClaim, getActiveClaims,
  _getClaimsMap, _clearClaimsForTests
};
