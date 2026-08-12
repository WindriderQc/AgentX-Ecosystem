/**
 * Telemetry Routes
 *
 * GET /telemetry/ingest          — List recent ingest jobs
 * GET /telemetry/ingest/summary  — Aggregate ingest stats
 */

const express = require('express');
const router = express.Router();
const IngestJob = require('../models/IngestJob');
const logger = require('../config/logger');

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

// ── GET /telemetry/ingest ───────────────────────────────

router.get('/telemetry/ingest', async (req, res) => {
  try {
    let limit = req.query.limit !== undefined ? Math.floor(Number(req.query.limit)) : LIMIT_DEFAULT;
    if (!Number.isFinite(limit) || limit < 1) limit = LIMIT_DEFAULT;
    limit = Math.min(limit, LIMIT_MAX);

    const filter = {};
    if (req.query.source) filter.source = String(req.query.source);
    if (req.query.status) filter.status = String(req.query.status);

    const jobs = await IngestJob.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    res.json({ ok: true, data: { jobs, count: jobs.length } });
  } catch (err) {
    logger.error('Telemetry ingest list error:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch ingest telemetry' });
  }
});

// ── GET /telemetry/ingest/summary ───────────────────────

router.get('/telemetry/ingest/summary', async (req, res) => {
  try {
    const now = new Date();
    const oneDayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [allTimeStats, last24hStats, lastJob] = await Promise.all([
      IngestJob.aggregate([
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            successCount: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            avgTotalTimeMs: {
              $avg: { $cond: [{ $eq: ['$status', 'success'] }, '$totalTimeMs', null] }
            }
          }
        }
      ]),
      IngestJob.aggregate([
        { $match: { createdAt: { $gte: oneDayAgo } } },
        {
          $group: {
            _id: null,
            total: { $sum: 1 },
            success: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } }
          }
        }
      ]),
      IngestJob.findOne().sort({ createdAt: -1 }).select('createdAt').lean()
    ]);

    const all = allTimeStats[0] || { total: 0, successCount: 0, avgTotalTimeMs: null };
    const day = last24hStats[0] || { total: 0, success: 0, failed: 0 };
    const successRate = all.total > 0 ? Math.round((all.successCount / all.total) * 10000) / 100 : 0;

    res.json({
      ok: true,
      data: {
        totalIngests: all.total,
        successRate,
        avgTotalTimeMs: all.avgTotalTimeMs !== null ? Math.round(all.avgTotalTimeMs) : null,
        last24h: { total: day.total, success: day.success, failed: day.failed },
        lastIngestAt: lastJob ? lastJob.createdAt : null
      }
    });
  } catch (err) {
    logger.error('Telemetry ingest summary error:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch ingest summary' });
  }
});

module.exports = router;
