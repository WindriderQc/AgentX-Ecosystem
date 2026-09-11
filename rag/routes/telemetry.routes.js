/**
 * Telemetry Routes
 *
 * GET /telemetry/ingest          — List recent ingest jobs
 * GET /telemetry/ingest/summary  — Aggregate ingest stats
 * GET /telemetry/search/summary  — Bounded search evidence (Signal Evidence Contract)
 */

const express = require('express');
const router = express.Router();
const IngestJob = require('../models/IngestJob');
const SearchEvent = require('../models/SearchEvent');
const logger = require('../config/logger');
const {
  averageSignal,
  buildSignal,
  countSignal,
  ratioSignal,
  serializeSignal
} = require('../../shared/signalEvidence');

const LIMIT_DEFAULT = 50;
const LIMIT_MAX = 200;

/**
 * Search evidence window keys and the freshness rule of the summary. Empty
 * and failure rates are reported only on at least this many searches.
 */
const SEARCH_WINDOWS = { '24h': 24, '7d': 24 * 7, '30d': 24 * 30 };
const SEARCH_MIN_SAMPLE = 5;
const SEARCH_SUMMARY_TTL_MS = 5 * 60 * 1000;
// Zero milliseconds is measured; missing, nonnumeric and negative values are not.
const HAS_SEARCH_DURATION = {
  $and: [{ $isNumber: '$durationMs' }, { $gte: ['$durationMs', 0] }]
};

// ── GET /telemetry/search/summary ───────────────────────

router.get('/telemetry/search/summary', async (req, res) => {
  try {
    const windowKey = SEARCH_WINDOWS[req.query.window] ? req.query.window : '7d';
    const to = new Date();
    const from = new Date(to.getTime() - SEARCH_WINDOWS[windowKey] * 60 * 60 * 1000);

    const [rows, lastEvent] = await Promise.all([
      SearchEvent.aggregate([
        { $match: { createdAt: { $gte: from, $lte: to } } },
        {
          $group: {
            _id: null,
            searches: { $sum: 1 },
            empty: { $sum: { $cond: [{ $eq: ['$status', 'empty'] }, 1, 0] } },
            failed: { $sum: { $cond: [{ $eq: ['$status', 'failed'] }, 1, 0] } },
            durationMs: { $sum: { $cond: [HAS_SEARCH_DURATION, '$durationMs', 0] } },
            timed: { $sum: { $cond: [HAS_SEARCH_DURATION, 1, 0] } },
            resultCount: { $sum: { $ifNull: ['$resultCount', 0] } },
            answered: { $sum: { $cond: [{ $eq: ['$status', 'success'] }, 1, 0] } },
            hybrid: { $sum: { $cond: ['$hybrid', 1, 0] } },
            rerank: { $sum: { $cond: ['$rerank', 1, 0] } }
          }
        }
      ]),
      SearchEvent.findOne().sort({ createdAt: -1 }).select('createdAt').lean()
    ]);

    const t = rows[0] || { searches: 0, empty: 0, failed: 0, durationMs: 0, timed: 0, resultCount: 0, answered: 0, hybrid: 0, rerank: 0 };
    const base = {
      scope: { window: windowKey, from: from.toISOString(), to: to.toISOString() },
      source: 'ragsearchevents',
      observedAt: to,
      ttlMs: SEARCH_SUMMARY_TTL_MS
    };
    const lastSearchAt = lastEvent?.createdAt ? new Date(lastEvent.createdAt).toISOString() : null;
    const signals = {
      searches: countSignal({ ...base, id: 'rag.search.count', value: t.searches, unit: 'count' }),
      emptyRate: ratioSignal({
        ...base, id: 'rag.search.empty_rate', numerator: t.empty, denominator: t.searches,
        minimum: SEARCH_MIN_SAMPLE, unit: 'percent', reason: t.searches > 0 ? null : 'no_searches'
      }),
      failureRate: ratioSignal({
        ...base, id: 'rag.search.failure_rate', numerator: t.failed, denominator: t.searches,
        minimum: SEARCH_MIN_SAMPLE, unit: 'percent', reason: t.searches > 0 ? null : 'no_searches'
      }),
      avgDurationMs: averageSignal({
        ...base, id: 'rag.search.avg_duration_ms', sum: t.durationMs, count: t.timed, unit: 'ms',
        reason: t.timed > 0 ? null : 'no_timed_searches'
      }),
      avgResultsPerAnsweredSearch: averageSignal({
        ...base, id: 'rag.search.avg_results', sum: t.resultCount, count: t.answered, unit: 'count',
        reason: t.answered > 0 ? null : 'no_answered_searches'
      }),
      lastSearch: buildSignal({
        id: 'rag.search.last_observed',
        kind: 'measure',
        state: lastSearchAt ? 'observed' : 'missing',
        value: lastSearchAt ? 1 : null,
        basis: 'census',
        sample: { n: lastSearchAt ? 1 : 0 },
        source: 'ragsearchevents',
        observedAt: lastSearchAt,
        ttlMs: SEARCH_WINDOWS[windowKey] * 60 * 60 * 1000,
        reason: lastSearchAt ? null : 'never_searched',
        detail: lastSearchAt ? null : 'No retrieval search has been recorded.'
      })
    };

    res.json({
      ok: true,
      data: {
        window: { key: windowKey, from: from.toISOString(), to: to.toISOString() },
        totals: {
          searches: t.searches,
          empty: t.empty,
          failed: t.failed,
          answered: t.answered,
          hybrid: t.hybrid,
          rerank: t.rerank
        },
        lastSearchAt,
        signals: Object.fromEntries(Object.entries(signals).map(([key, signal]) => [key, serializeSignal(signal)]))
      }
    });
  } catch (err) {
    logger.error('Telemetry search summary error:', err);
    res.status(500).json({ ok: false, error: 'Failed to fetch search summary' });
  }
});

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
