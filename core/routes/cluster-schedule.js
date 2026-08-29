/**
 * Cluster Schedule Routes
 *
 * Unified view of Agent X timers, bounded external schedules, and persistent
 * GPU loads. External schedulers remain outside this repository.
 *
 * Mounted at /api/cluster
 */
const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const clusterScheduleService = require('../src/services/clusterScheduleService');
const clusterLiveService = require('../src/services/clusterLiveService');
const HostUsageLedger = require('../models/HostUsageLedger');
const { getUtilizationHeatmap } = require('../src/services/hostUsageAggregator');
const { defaultPlanningTimeZone } = require('../src/services/planningDateService');
const { requireScheduleMachineAccess } = require('../src/helpers/scheduleMachineAccess');

/**
 * GET /schedule
 * List all schedule entries with optional filters.
 * Query params: host, taskType, source, enabled
 */
router.get('/schedule', async (req, res) => {
  try {
    const filters = {};
    if (req.query.host) filters.host = req.query.host;
    if (req.query.taskType) filters.taskType = req.query.taskType;
    if (req.query.source) filters.source = req.query.source;
    if (req.query.enabled !== undefined) filters.enabled = req.query.enabled === 'true';

    const entries = await clusterScheduleService.getAllEntries(filters);
    res.json({ status: 'success', data: { entries, count: entries.length } });
  } catch (err) {
    logger.error('Failed to get cluster schedule entries', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/timeline
 * Resolve entries into time slots for a given date.
 * Query params: date (YYYY-MM-DD, defaults to today), timezone
 */
router.get('/schedule/timeline', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const timezone = req.query.timezone || defaultPlanningTimeZone();
    const timeline = await clusterScheduleService.getTimeline(date, timezone);
    res.json({ status: 'success', data: { date, timezone, timeline } });
  } catch (err) {
    logger.error('Failed to get cluster timeline', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/timeline-by-host
 * Pivot timeline by host — rows are GPU hosts, each with their tasks.
 * Query params: date (YYYY-MM-DD, defaults to today), timezone
 */
router.get('/schedule/timeline-by-host', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const timezone = req.query.timezone || defaultPlanningTimeZone();
    const hosts = await clusterScheduleService.getTimelineByHost(date, timezone);
    res.json({ status: 'success', data: { date, timezone, hosts } });
  } catch (err) {
    logger.error('Failed to get host timeline', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/conflicts
 * Detect overlapping tasks on the same host for a given date.
 * Query params: date (YYYY-MM-DD, defaults to today), timezone
 */
router.get('/schedule/conflicts', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const timezone = req.query.timezone || defaultPlanningTimeZone();
    const conflicts = await clusterScheduleService.getConflicts(date, timezone);
    res.json({ status: 'success', data: { date, timezone, conflicts, count: conflicts.length } });
  } catch (err) {
    logger.error('Failed to get schedule conflicts', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/live
 * Real-time state of all Ollama hosts (loaded models, status).
 */
router.get('/schedule/live', async (req, res) => {
  try {
    const liveState = await clusterLiveService.getLiveState();
    res.json({ status: 'success', data: liveState });
  } catch (err) {
    logger.error('Failed to get cluster live state', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/next
 * Get the next N upcoming scheduled tasks.
 * Query params: count (default 5)
 */
router.get('/schedule/next', async (req, res) => {
  try {
    const count = Math.min(parseInt(req.query.count) || 5, 50);
    const tasks = await clusterScheduleService.getNextTasks(count);
    const observedAt = new Date().toISOString();
    res.json({
      status: 'success',
      data: {
        tasks,
        count: tasks.length,
        evidence: {
          authority: 'agentx.cluster-schedule',
          scope: 'upcoming-assignment-projection',
          observedAt
        }
      }
    });
  } catch (err) {
    logger.error('Failed to get next cluster tasks', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * POST /schedule/sync
 * Upsert entries by source+sourceId. Idempotent.
 * Body: { entries: [...] }
 */
router.post('/schedule/sync', requireScheduleMachineAccess, async (req, res) => {
  try {
    const entries = req.body.entries;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(400).json({ status: 'error', error: 'entries array required' });
    }
    const stats = await clusterScheduleService.syncEntries(entries);
    res.json({ status: 'success', data: stats });
  } catch (err) {
    logger.error('Failed to sync cluster schedule', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/actual
 * Actual inference load per host from HostUsageLedger for a given date.
 * Query params: date (YYYY-MM-DD, defaults today), hours (default 24)
 */
router.get('/schedule/actual', async (req, res) => {
  try {
    const hours = Math.min(parseInt(req.query.hours || '24', 10), 168);
    const since = new Date(Date.now() - hours * 3600 * 1000);

    const records = await HostUsageLedger.find({ hour: { $gte: since } })
      .sort({ hour: 1 }).lean();

    // Group by host
    const byHost = {};
    for (const r of records) {
      const label = r.hostLabel || r.hostKey || r.host;
      if (!byHost[label]) byHost[label] = [];
      byHost[label].push({
        hour: r.hour,
        totalCalls: r.totalCalls,
        totalTokensOut: r.totalTokensOut,
        totalDurationMs: r.totalDurationMs,
        avgDurationMs: r.avgDurationMs,
        utilizationPct: r.utilizationPct,
        fallbackCalls: r.fallbackCalls,
        uniqueModels: r.uniqueModels,
        callerBreakdown: r.callerBreakdown
      });
    }

    res.json({ status: 'success', data: { windowHours: hours, since, byHost } });
  } catch (err) {
    logger.error('Failed to get actual usage', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/heatmap
 * Utilization heatmap for the past N days (days × 24 hours per host).
 * Query params: days (default 7, max 30)
 */
router.get('/schedule/heatmap', async (req, res) => {
  try {
    const days = Math.min(parseInt(req.query.days || '7', 10), 30);
    const data = await getUtilizationHeatmap(days);
    res.json({ status: 'success', data });
  } catch (err) {
    logger.error('Failed to get utilization heatmap', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/actual-vs-planned
 * Overlay actual usage ledger on top of the planned schedule for a date.
 * Query params: date (YYYY-MM-DD), timezone
 */
router.get('/schedule/actual-vs-planned', async (req, res) => {
  try {
    const date = req.query.date || new Date().toISOString().slice(0, 10);
    const timezone = req.query.timezone || defaultPlanningTimeZone();

    // Get planned timeline
    const planned = await clusterScheduleService.getTimelineByHost(date, timezone);

    // Get actual for same day
    const dayStart = new Date(`${date}T00:00:00Z`);
    const dayEnd = new Date(dayStart.getTime() + 86400 * 1000);
    const actual = await HostUsageLedger.find({
      hour: { $gte: dayStart, $lt: dayEnd }
    }).sort({ hour: 1 }).lean();

    // Build actual by host
    const actualByHost = {};
    for (const r of actual) {
      const label = r.hostLabel || r.hostKey || r.host;
      if (!actualByHost[label]) actualByHost[label] = [];
      actualByHost[label].push({
        hour: r.hour.getUTCHours(),
        utilizationPct: r.utilizationPct,
        totalCalls: r.totalCalls,
        avgDurationMs: r.avgDurationMs
      });
    }

    res.json({
      status: 'success',
      data: { date, timezone, planned, actualByHost }
    });
  } catch (err) {
    logger.error('Failed to get actual-vs-planned', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * POST /schedule/sync/system-cron
 * Read the current user's system crontab and sync entries into ClusterScheduleEntry.
 * Idempotent — safe to call repeatedly. Marks non-LLM jobs automatically.
 */
router.post('/schedule/sync/system-cron', async (req, res) => {
  try {
    const { execFile } = require('child_process');
    const { promisify } = require('util');
    const execFilePromise = promisify(execFile);

    // Read system crontab
    let lines = [];
    try {
      const { stdout } = await execFilePromise('crontab', ['-l'], { maxBuffer: 1024 * 1024 });
      lines = String(stdout || '').split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 0 && !l.startsWith('#'));
    } catch (err) {
      const msg = `${err?.stderr || ''} ${err?.message || ''}`.toLowerCase();
      if (!msg.includes('no crontab')) throw err;
    }

    if (lines.length === 0) {
      return res.json({ status: 'success', data: { created: 0, updated: 0, unchanged: 0, lines: 0 } });
    }

    // Parse and transform each cron line
    const entries = lines.map((line, idx) => {
      const parts = line.trim().split(/\s+/);
      const hasStandardCron = parts.length >= 6;
      const schedule = hasStandardCron ? parts.slice(0, 5).join(' ') : null;
      const command = hasStandardCron ? parts.slice(5).join(' ') : line;

      // Derive a human name from the command
      const scriptMatch = command.match(/\/([^/\s]+\.(?:js|sh|py))/) ;
      const name = scriptMatch
        ? scriptMatch[1].replace(/[-_]/g, ' ').replace(/\.(js|sh|py)$/, '').replace(/\b\w/g, c => c.toUpperCase())
        : `System Cron ${idx + 1}`;

      // Classify task type
      const cmd = command.toLowerCase();
      let taskType = 'monitoring';
      if (/sync|bisync/.test(cmd)) taskType = 'sync';
      else if (/backup/.test(cmd)) taskType = 'backup';
      else if (/telemetry|aggregate/.test(cmd)) taskType = 'monitoring';
      else if (/clean|purge/.test(cmd)) taskType = 'cleanup';
      else if (/ingest|rag/.test(cmd)) taskType = 'ingestion';
      else if (/benchmark/.test(cmd)) taskType = 'benchmark';

      return {
        source: 'agentx-system',
        sourceId: `syscron-${Buffer.from(line).toString('base64').slice(0, 20)}`,
        name,
        taskType,
        host: 'primary',          // system crons run on this host
        model: null,               // no model = no GPU/LLM
        agent: null,
        schedule: schedule ? { type: 'cron', cron: schedule, timezone: defaultPlanningTimeZone() } : null,
        estimatedDurationMs: null,
        enabled: true,
        metadata: { command, raw: line }
      };
    }).filter(e => e.schedule); // skip lines we couldn't parse

    const stats = await clusterScheduleService.syncEntries(entries);
    res.json({ status: 'success', data: { ...stats, lines: lines.length } });
  } catch (err) {
    logger.error('Failed to sync system crontab', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

// ── Phase 2: Placement Service routes ──────────────────────────────────────

/**
 * GET /schedule/recommend
 * Recommend the best host for a given model + workload.
 * Query params: model (required), durationMs (default 30000),
 *               priority (low/normal/high), caller (string)
 */
router.get('/schedule/recommend', async (req, res) => {
  try {
    const { model, durationMs, priority, caller } = req.query;
    if (!model) {
      return res.status(400).json({ status: 'error', error: 'model query param is required' });
    }

    const duration = Math.max(parseInt(durationMs) || 30000, 1000);
    const prio = ['low', 'normal', 'high'].includes(priority) ? priority : 'normal';

    const recommendation = await clusterScheduleService.recommendHost(model, duration, prio);

    res.json({
      status: 'success',
      data: {
        model,
        caller: caller || 'unknown',
        duration,
        priority: prio,
        recommendation
      }
    });
  } catch (err) {
    logger.error('Failed to get host recommendation', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * POST /schedule/claim
 * Soft-lock a host for a model. Prevents duplicate recommendations for
 * the same time window. Mongo-backed with TTL.
 * Body: { host, model, caller, ttlMs }
 */
router.post('/schedule/claim', requireScheduleMachineAccess, async (req, res) => {
  try {
    const { host, model, caller, ttlMs } = req.body;
    if (!host || !model || !caller) {
      return res.status(400).json({ status: 'error', error: 'host, model, and caller are required' });
    }

    const ttl = Math.min(Math.max(parseInt(ttlMs) || 30000, 5000), 300000);
    const claim = await clusterScheduleService.createClaim(host, model, caller, ttl);

    res.json({ status: 'success', data: claim });
  } catch (err) {
    logger.error('Failed to create schedule claim', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * DELETE /schedule/claim/:claimId
 * Release a soft-claim early.
 */
router.delete('/schedule/claim/:claimId', requireScheduleMachineAccess, async (req, res) => {
  try {
    const released = await clusterScheduleService.releaseClaim(req.params.claimId);
    res.json({ status: 'success', data: { released } });
  } catch (err) {
    logger.error('Failed to release schedule claim', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

/**
 * GET /schedule/claims
 * List all active (non-expired) claims.
 */
router.get('/schedule/claims', async (req, res) => {
  try {
    const claims = await clusterScheduleService.getActiveClaims();
    res.json({ status: 'success', data: { claims, count: claims.length } });
  } catch (err) {
    logger.error('Failed to get active claims', { error: err.message });
    res.status(500).json({ status: 'error', error: err.message });
  }
});

module.exports = router;
