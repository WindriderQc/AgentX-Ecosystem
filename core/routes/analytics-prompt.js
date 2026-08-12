'use strict';
/**
 * Analytics — Feedback Summary, Prompt Metrics & Trending Routes
 *
 * Sub-router mounted at root by routes/analytics.js.
 * All paths are relative to /api/analytics.
 *
 * Routes:
 *   GET  /feedback/summary — enhanced feedback aggregation for self-improving loop
 *   POST /feedback         — record message feedback
 *   GET  /prompt-metrics   — prompt performance metrics with model breakdown
 *   GET  /trending         — trending by comparing current vs previous period
 */

const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Feedback = require('../models/Feedback');
const logger = require('../config/logger');

/**
 * GET /api/analytics/feedback/summary
 * Enhanced feedback aggregation for self-improving loop
 * Returns overall metrics, per-model, per-prompt-version, and low performers
 * Query params:
 *   - from (ISO date, default: 30 days)
 *   - to (ISO date, default: now)
 *   - startDate (ISO date, alias for from)
 *   - endDate (ISO date, alias for to)
 *   - threshold (number, default: 0.7 - flag prompts below this)
 *   - promptName (string, optional) - filter by specific prompt name
 */
router.get('/feedback/summary', async (req, res) => {
  try {
    const { from, to, startDate, endDate, threshold = 0.7, promptName } = req.query;
    const minPositiveRate = parseFloat(threshold);

    // Default to 30 days for summary, support both from/to and startDate/endDate
    const toDate = to || endDate ? new Date(to || endDate) : new Date();
    const fromDate = from || startDate ? new Date(from || startDate) : new Date(toDate.getTime() - 30 * 24 * 60 * 60 * 1000);

    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

    // Optional prompt name filter
    if (promptName) {
      dateFilter.promptName = promptName;
    }

    // Summary includes both:
    //  - explicit Feedback documents (rating: 'positive'/'negative')
    //  - embedded Conversation message feedback (rating: 1/-1)

    // ── Source A: Feedback collection ──────────────────────────────────────
    const [overallAggA, byModelA, byPromptVersionA] = await Promise.all([
      Feedback.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: null,
            totalFeedback: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$rating', 'positive'] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$rating', 'negative'] }, 1, 0] } }
          }
        }
      ]),
      Feedback.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: '$model',
            positive: { $sum: { $cond: [{ $eq: ['$rating', 'positive'] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$rating', 'negative'] }, 1, 0] } }
          }
        },
        {
          $project: {
            _id: 1,
            model: '$_id',
            positive: 1,
            negative: 1,
            total: { $add: ['$positive', '$negative'] },
            rate: {
              $cond: [
                { $gt: [{ $add: ['$positive', '$negative'] }, 0] },
                { $divide: ['$positive', { $add: ['$positive', '$negative'] }] },
                0
              ]
            }
          }
        },
        { $sort: { total: -1 } }
      ]),
      Feedback.aggregate([
        { $match: dateFilter },
        {
          $group: {
            _id: { name: '$promptName', version: '$promptVersion' },
            positive: { $sum: { $cond: [{ $eq: ['$rating', 'positive'] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$rating', 'negative'] }, 1, 0] } }
          }
        },
        {
          $project: {
            _id: 0,
            promptName: '$_id.name',
            promptVersion: '$_id.version',
            positive: 1,
            negative: 1,
            total: { $add: ['$positive', '$negative'] },
            rate: {
              $cond: [
                { $gt: [{ $add: ['$positive', '$negative'] }, 0] },
                { $divide: ['$positive', { $add: ['$positive', '$negative'] }] },
                0
              ]
            }
          }
        },
        { $sort: { promptName: 1, promptVersion: -1 } }
      ])
    ]);

    const overallA = {
      totalFeedback: overallAggA[0]?.totalFeedback || 0,
      positive: overallAggA[0]?.positive || 0,
      negative: overallAggA[0]?.negative || 0
    };

    // ── Source B: Conversation embedded message feedback ───────────────────
    const convDateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

    if (promptName) {
      convDateFilter.promptName = promptName;
    }

    const [overallAggB, byModelB, byPromptVersionB] = await Promise.all([
      Conversation.aggregate([
        { $match: convDateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        {
          $group: {
            _id: null,
            totalFeedback: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        }
      ]),
      Conversation.aggregate([
        { $match: convDateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        {
          $group: {
            _id: '$model',
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        },
        {
          $project: {
            _id: 1,
            model: '$_id',
            positive: 1,
            negative: 1,
            total: { $add: ['$positive', '$negative'] },
            rate: {
              $cond: [
                { $gt: [{ $add: ['$positive', '$negative'] }, 0] },
                { $divide: ['$positive', { $add: ['$positive', '$negative'] }] },
                0
              ]
            }
          }
        },
        { $sort: { total: -1 } }
      ]),
      Conversation.aggregate([
        { $match: convDateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        {
          $group: {
            _id: { name: '$promptName', version: '$promptVersion' },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        },
        {
          $project: {
            _id: 0,
            promptName: '$_id.name',
            promptVersion: '$_id.version',
            positive: 1,
            negative: 1,
            total: { $add: ['$positive', '$negative'] },
            rate: {
              $cond: [
                { $gt: [{ $add: ['$positive', '$negative'] }, 0] },
                { $divide: ['$positive', { $add: ['$positive', '$negative'] }] },
                0
              ]
            }
          }
        },
        { $sort: { promptName: 1, promptVersion: -1 } }
      ])
    ]);

    const overallB = {
      totalFeedback: overallAggB[0]?.totalFeedback || 0,
      positive: overallAggB[0]?.positive || 0,
      negative: overallAggB[0]?.negative || 0
    };

    // ── Merge A + B ────────────────────────────────────────────────────────
    const overall = {
      totalFeedback: overallA.totalFeedback + overallB.totalFeedback,
      positive: overallA.positive + overallB.positive,
      negative: overallA.negative + overallB.negative,
      positiveRate: 0
    };
    overall.positiveRate = overall.totalFeedback > 0 ? overall.positive / overall.totalFeedback : 0;

    const byModelMap = new Map();
    [...byModelA, ...byModelB].forEach((row) => {
      const key = row?._id ?? row?.model ?? 'unknown';
      const existing = byModelMap.get(key) || { _id: key, model: key, positive: 0, negative: 0, total: 0, rate: 0 };
      existing.positive += row.positive || 0;
      existing.negative += row.negative || 0;
      existing.total = existing.positive + existing.negative;
      existing.rate = existing.total > 0 ? existing.positive / existing.total : 0;
      byModelMap.set(key, existing);
    });
    const byModel = Array.from(byModelMap.values()).sort((a, b) => (b.total || 0) - (a.total || 0));

    const byPromptVersionMap = new Map();
    [...byPromptVersionA, ...byPromptVersionB].forEach((row) => {
      const key = `${row.promptName}|${row.promptVersion}`;
      const existing = byPromptVersionMap.get(key) || {
        promptName: row.promptName,
        promptVersion: row.promptVersion,
        positive: 0,
        negative: 0,
        total: 0,
        rate: 0
      };
      existing.positive += row.positive || 0;
      existing.negative += row.negative || 0;
      existing.total = existing.positive + existing.negative;
      existing.rate = existing.total > 0 ? existing.positive / existing.total : 0;
      byPromptVersionMap.set(key, existing);
    });
    const byPromptVersion = Array.from(byPromptVersionMap.values()).sort((a, b) => {
      if (a.promptName !== b.promptName) return a.promptName.localeCompare(b.promptName);
      const av = typeof a.promptVersion === 'number' ? a.promptVersion : Number.NaN;
      const bv = typeof b.promptVersion === 'number' ? b.promptVersion : Number.NaN;
      if (!Number.isNaN(av) && !Number.isNaN(bv)) return bv - av;
      return String(b.promptVersion).localeCompare(String(a.promptVersion));
    });

    // Identify low performers (below threshold)
    const lowPerformingPrompts = byPromptVersion.filter(p => p.rate < minPositiveRate && p.total >= 5);

    // A/B comparison: group by promptName and compare versions
    const promptGroups = {};
    byPromptVersion.forEach(p => {
      if (!promptGroups[p.promptName]) promptGroups[p.promptName] = [];
      promptGroups[p.promptName].push(p);
    });

    const abComparisons = Object.entries(promptGroups)
      .filter(([_name, versions]) => versions.length > 1)
      .map(([name, versions]) => {
        const sorted = versions.sort((a, b) => b.rate - a.rate);
        const control = sorted.find(v => v.promptVersion === 'control') || sorted[sorted.length - 1];
        const variants = sorted.filter(v => v.promptVersion !== control.promptVersion);
        const bestVariant = variants[0];
        const improvement = control && bestVariant && control.rate > 0
          ? ((bestVariant.rate - control.rate) / control.rate) * 100
          : null;

        return {
          promptName: name,
          control: control,
          variants: variants,
          improvement: improvement,
          bestVersion: sorted[0],
          versions: sorted,
          recommendation: sorted[0].rate > minPositiveRate
            ? `Keep version ${sorted[0].promptVersion}`
            : 'All versions underperforming - needs prompt revision'
        };
      });

    res.json({
      status: 'success',
      dateRange: {
        start: fromDate.toISOString(),
        end: toDate.toISOString()
      },
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        dateRange: {
          start: fromDate.toISOString(),
          end: toDate.toISOString()
        },
        threshold: minPositiveRate,
        overall,
        byModel,
        byPromptVersion,
        lowPerformingPrompts,
        abComparisons
      }
    });
  } catch (err) {
    logger.error('Analytics feedback summary error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * POST /api/analytics/feedback
 * Records feedback for a message in a conversation
 * Body params:
 *   - conversationId (required)
 *   - messageId (required)
 *   - rating (required: 'positive' | 'negative' | 'neutral')
 *   - comment (optional)
 *   - model (optional)
 *   - promptVersion (optional)
 *   - promptName (optional)
 */
router.post('/feedback', async (req, res) => {
  try {
    const { conversationId, messageId, rating, comment, model, promptVersion, promptName } = req.body;

    if (!conversationId || !messageId || !rating) {
      return res.status(400).json({
        error: 'Missing required fields: conversationId, messageId, and rating are required'
      });
    }

    if (!['positive', 'negative', 'neutral'].includes(rating)) {
      return res.status(400).json({
        error: 'Invalid rating. Must be one of: positive, negative, neutral'
      });
    }

    const conversation = await Conversation.findById(conversationId);
    if (!conversation) {
      return res.status(404).json({ status: 'error', message: 'Conversation not found' });
    }

    const feedback = new Feedback({
      conversationId, messageId, rating, comment, model, promptVersion, promptName
    });
    await feedback.save();

    logger.info('Feedback recorded', {
      conversationId,
      messageId,
      rating
    });

    const feedbackPayload = {
      id: feedback._id,
      conversationId: feedback.conversationId,
      messageId: feedback.messageId,
      rating: feedback.rating,
      createdAt: feedback.createdAt
    };

    // Prefer consistent API shape, but keep legacy fields for compatibility.
    res.status(201).json({
      status: 'success',
      data: { feedback: feedbackPayload },
      success: true,
      feedback: feedbackPayload
    });
  } catch (err) {
    logger.error('Feedback recording error', { error: err.message });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/prompt-metrics
 * Returns prompt performance metrics with model breakdown
 * Optimized for Performance Metrics Dashboard display
 * Query params:
 *   - days (number, default: 7)
 *   - model (string, optional) - Filter by specific model
 * Response: { prompts: [{ name, version, overall, byModel: [...] }] }
 */
router.get('/prompt-metrics', async (req, res) => {
  try {
    const { days = 7, model: filterModel } = req.query;

    const toDate = new Date();
    const fromDate = new Date(toDate.getTime() - parseInt(days, 10) * 24 * 60 * 60 * 1000);

    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

    if (filterModel) {
      dateFilter.model = filterModel;
    }

    const rawData = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: {
            name: '$promptName',
            version: '$promptVersion',
            model: '$model'
          },
          total: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
          negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
        }
      },
      { $project: {
          _id: 0,
          promptName: '$_id.name',
          promptVersion: '$_id.version',
          model: '$_id.model',
          total: 1,
          positive: 1,
          negative: 1,
          positiveRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$positive', '$total'] }, 0] }
        }
      },
      { $sort: { promptName: 1, promptVersion: -1, model: 1 } }
    ]);

    const promptMap = {};
    rawData.forEach(item => {
      const key = `${item.promptName}_v${item.promptVersion}`;

      if (!promptMap[key]) {
        promptMap[key] = {
          promptName: item.promptName,
          promptVersion: item.promptVersion,
          overall: { total: 0, positive: 0, negative: 0, positiveRate: 0 },
          byModel: []
        };
      }

      promptMap[key].overall.total += item.total;
      promptMap[key].overall.positive += item.positive;
      promptMap[key].overall.negative += item.negative;

      promptMap[key].byModel.push({
        model: item.model || 'unknown',
        total: item.total,
        positive: item.positive,
        negative: item.negative,
        positiveRate: item.positiveRate
      });
    });

    Object.values(promptMap).forEach(prompt => {
      if (prompt.overall.total > 0) {
        prompt.overall.positiveRate = prompt.overall.positive / prompt.overall.total;
      }
      prompt.byModel.sort((a, b) => b.total - a.total);
    });

    const prompts = Object.values(promptMap).sort((a, b) => {
      if (a.promptName !== b.promptName) {
        return a.promptName.localeCompare(b.promptName);
      }
      return b.promptVersion - a.promptVersion;
    });

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        days: parseInt(days, 10),
        filterModel: filterModel || null,
        prompts
      }
    });
  } catch (err) {
    logger.error('Analytics prompt metrics error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/trending
 * Get trending data by comparing current period vs previous period
 * Query params:
 *   - days: number of days for current period (default: 7)
 *   - model: filter by specific model (optional)
 */
router.get('/trending', async (req, res) => {
  try {
    const { days = 7, model: filterModel } = req.query;
    const daysNum = parseInt(days, 10);

    const currentTo = new Date();
    const currentFrom = new Date(currentTo.getTime() - daysNum * 24 * 60 * 60 * 1000);
    const previousTo = currentFrom;
    const previousFrom = new Date(previousTo.getTime() - daysNum * 24 * 60 * 60 * 1000);

    const getMetricsForPeriod = async (fromDate, toDate) => {
      const dateFilter = { createdAt: { $gte: fromDate, $lte: toDate } };
      if (filterModel) {
        dateFilter.model = filterModel;
      }

      const data = await Conversation.aggregate([
        { $match: dateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        { $group: {
            _id: { name: '$promptName', version: '$promptVersion' },
            total: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        }
      ]);

      const metrics = {};
      data.forEach(item => {
        const key = `${item._id.name}_v${item._id.version}`;
        const positiveRate = item.total > 0 ? item.positive / item.total : 0;
        metrics[key] = {
          promptName: item._id.name,
          promptVersion: item._id.version,
          total: item.total,
          positive: item.positive,
          negative: item.negative,
          positiveRate
        };
      });

      return metrics;
    };

    const [currentMetrics, previousMetrics] = await Promise.all([
      getMetricsForPeriod(currentFrom, currentTo),
      getMetricsForPeriod(previousFrom, previousTo)
    ]);

    const trending = {};
    const allKeys = new Set([...Object.keys(currentMetrics), ...Object.keys(previousMetrics)]);

    allKeys.forEach(key => {
      const current = currentMetrics[key];
      const previous = previousMetrics[key];

      if (current && previous) {
        const delta = current.positiveRate - previous.positiveRate;
        const percentChange = previous.positiveRate > 0
          ? (delta / previous.positiveRate) * 100
          : 0;

        trending[key] = {
          promptName: current.promptName,
          promptVersion: current.promptVersion,
          current: { total: current.total, positiveRate: current.positiveRate },
          previous: { total: previous.total, positiveRate: previous.positiveRate },
          delta,
          percentChange,
          trend: delta > 0.05 ? 'up' : delta < -0.05 ? 'down' : 'stable',
          status: delta > 0.05 ? 'improving' : delta < -0.05 ? 'declining' : 'stable'
        };
      } else if (current) {
        trending[key] = {
          promptName: current.promptName,
          promptVersion: current.promptVersion,
          current: { total: current.total, positiveRate: current.positiveRate },
          previous: null,
          delta: null,
          percentChange: null,
          trend: 'new',
          status: 'new'
        };
      }
    });

    const trendingArray = Object.values(trending).sort((a, b) => {
      const deltaA = Math.abs(a.delta || 0);
      const deltaB = Math.abs(b.delta || 0);
      return deltaB - deltaA;
    });

    res.json({
      status: 'success',
      data: {
        periods: {
          current: { from: currentFrom.toISOString(), to: currentTo.toISOString() },
          previous: { from: previousFrom.toISOString(), to: previousTo.toISOString() }
        },
        days: daysNum,
        filterModel: filterModel || null,
        trending: trendingArray
      }
    });
  } catch (err) {
    logger.error('Analytics trending error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
