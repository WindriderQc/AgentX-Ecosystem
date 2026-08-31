/**
 * V4 Analytics Routes
 * Provides metrics endpoints for prompt performance tracking
 * Contract: specs/V4_ANALYTICS_ARCHITECTURE.md § 2
 */

const express = require('express');
const router = express.Router();
const Conversation = require('../models/Conversation');
const Feedback = require('../models/Feedback');
const logger = require('../config/logger');
const {
  activeMessageCostExpression,
  activeMessagesExpression,
  activityDayPipeline,
  conversationActivityFilter
} = require('../src/services/conversationActivityAnalytics');

/**
 * GET /api/analytics/usage
 * Returns conversation and message counts with optional grouping
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 *   - groupBy (optional: 'model' | 'promptVersion' | 'day')
 * Response: { totalConversations, totalMessages, breakdown: [...] }
 */
router.get('/usage', async (req, res) => {
  try {
    const { from, to, groupBy } = req.query;

    // Parse date range (default: last 7 days)
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = conversationActivityFilter(fromDate, toDate);
    const activeMessages = activeMessagesExpression(fromDate, toDate);
    const activeMessageCost = activeMessageCostExpression();

    // Total counts
    const totalConversations = await Conversation.countDocuments(dateFilter);

    const messageAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $project: { messageCount: { $size: activeMessages } } },
      { $group: { _id: null, total: { $sum: '$messageCount' } } }
    ]);
    const totalMessages = messageAgg.length > 0 ? messageAgg[0].total : 0;

    // Optional grouping
    let breakdown = [];
    if (groupBy === 'model') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $project: {
            model: 1,
            activeMessages,
            totalCost: 1
          }
        },
        { $group: {
            _id: '$model',
            conversations: { $sum: 1 },
            messages: { $sum: { $size: '$activeMessages' } },
            totalCost: { $sum: activeMessageCost }
          }
        },
        { $project: {
            _id: 0,
            model: '$_id',
            conversations: 1,
            messages: 1,
            totalCost: 1,
            avgCostPerConversation: {
              $cond: [
                { $gt: ['$conversations', 0] },
                { $divide: ['$totalCost', '$conversations'] },
                0
              ]
            }
          }
        },
        { $sort: { conversations: -1 } }
      ]);
    } else if (groupBy === 'promptVersion') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $project: {
            promptName: 1,
            promptVersion: 1,
            activeMessages,
            totalCost: 1
          }
        },
        { $group: {
            _id: { name: '$promptName', version: '$promptVersion' },
            conversations: { $sum: 1 },
            messages: { $sum: { $size: '$activeMessages' } },
            totalCost: { $sum: activeMessageCost }
          }
        },
        { $project: {
            _id: 0,
            promptName: '$_id.name',
            promptVersion: '$_id.version',
            conversations: 1,
            messages: 1,
            totalCost: 1,
            avgCostPerConversation: {
              $cond: [
                { $gt: ['$conversations', 0] },
                { $divide: ['$totalCost', '$conversations'] },
                0
              ]
            }
          }
        },
        { $sort: { promptVersion: -1 } }
      ]);
    } else if (groupBy === 'day') {
      breakdown = await Conversation.aggregate(activityDayPipeline(fromDate, toDate));
    }

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        currency: process.env.COST_CURRENCY || 'USD',
        basis: 'message_observed_at',
        totalConversations,
        totalMessages,
        breakdown
      }
    });
  } catch (err) {
    logger.error('Analytics usage error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/feedback
 * Returns feedback metrics (positive/negative counts and rates)
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 *   - groupBy (optional: 'promptVersion' | 'model')
 * Response: { totalFeedback, positive, negative, positiveRate, breakdown: [...] }
 */
router.get('/feedback', async (req, res) => {
  try {
    const { from, to, groupBy } = req.query;

    // Parse date range
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

    // Total feedback counts
    const feedbackAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: null,
          total: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
          negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
        }
      }
    ]);

    const totalFeedback = feedbackAgg.length > 0 ? feedbackAgg[0].total : 0;
    const positive = feedbackAgg.length > 0 ? feedbackAgg[0].positive : 0;
    const negative = feedbackAgg.length > 0 ? feedbackAgg[0].negative : 0;
    const positiveRate = totalFeedback > 0 ? positive / totalFeedback : 0;

    // Optional grouping
    let breakdown = [];
    if (groupBy === 'promptVersion') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        { $group: {
            _id: { name: '$promptName', version: '$promptVersion' },
            total: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        },
        { $project: {
            _id: 0,
            promptName: '$_id.name',
            promptVersion: '$_id.version',
            total: 1,
            positive: 1,
            negative: 1,
            positiveRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$positive', '$total'] }, 0] }
          }
        },
        { $sort: { promptVersion: -1 } }
      ]);
    } else if (groupBy === 'model') {
      breakdown = await Conversation.aggregate([
        { $match: dateFilter },
        { $unwind: '$messages' },
        { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
        { $group: {
            _id: '$model',
            total: { $sum: 1 },
            positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } },
            negative: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', -1] }, 1, 0] } }
          }
        },
        { $project: {
            _id: 0,
            model: '$_id',
            total: 1,
            positive: 1,
            negative: 1,
            positiveRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$positive', '$total'] }, 0] }
          }
        },
        { $sort: { total: -1 } }
      ]);
    } else if (groupBy === 'promptAndModel') {
      // Combined grouping: shows performance of each prompt version on each model
      breakdown = await Conversation.aggregate([
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
    }

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        totalFeedback,
        positive,
        negative,
        positiveRate,
        breakdown
      }
    });
  } catch (err) {
    logger.error('Analytics feedback error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/rag-stats
 * Returns RAG usage and performance metrics
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 * Response: { ragUsageRate, ragPositiveRate, noRagPositiveRate, ... }
 */
router.get('/rag-stats', async (req, res) => {
  try {
    const { from, to } = req.query;

    // Parse date range
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

    // RAG usage counts
    const totalConversations = await Conversation.countDocuments(dateFilter);
    // Backward compatible: older data may not have `ragRequested` persisted.
    // In that case, `ragUsed: true` implies it was requested/enabled.
    const ragRequestedConversations = await Conversation.countDocuments({
      ...dateFilter,
      $or: [{ ragRequested: true }, { ragUsed: true }]
    });
    const ragConversations = await Conversation.countDocuments({ ...dateFilter, ragUsed: true });
    const noRagConversations = totalConversations - ragConversations;
    const ragUsageRate = totalConversations > 0 ? ragConversations / totalConversations : 0;

    // Feedback for RAG vs non-RAG conversations
    const ragFeedback = await Conversation.aggregate([
      { $match: { ...dateFilter, ragUsed: true } },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: null,
          total: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } }
        }
      }
    ]);

    const noRagFeedback = await Conversation.aggregate([
      { $match: { ...dateFilter, ragUsed: { $ne: true } } },
      { $unwind: '$messages' },
      { $match: { 'messages.feedback.rating': { $in: [1, -1] } } },
      { $group: {
          _id: null,
          total: { $sum: 1 },
          positive: { $sum: { $cond: [{ $eq: ['$messages.feedback.rating', 1] }, 1, 0] } }
        }
      }
    ]);

    const ragTotal = ragFeedback.length > 0 ? ragFeedback[0].total : 0;
    const ragPositive = ragFeedback.length > 0 ? ragFeedback[0].positive : 0;
    const ragPositiveRate = ragTotal > 0 ? ragPositive / ragTotal : 0;

    const noRagTotal = noRagFeedback.length > 0 ? noRagFeedback[0].total : 0;
    const noRagPositive = noRagFeedback.length > 0 ? noRagFeedback[0].positive : 0;
    const noRagPositiveRate = noRagTotal > 0 ? noRagPositive / noRagTotal : 0;

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        totalConversations,
        ragRequestedConversations,
        ragConversations,
        noRagConversations,
        ragUsageRate,
        feedback: {
          rag: {
            total: ragTotal,
            positive: ragPositive,
            positiveRate: ragPositiveRate
          },
          noRag: {
            total: noRagTotal,
            positive: noRagPositive,
            positiveRate: noRagPositiveRate
          }
        }
      }
    });
  } catch (err) {
    logger.error('Analytics RAG stats error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/stats
 * Returns aggregated usage and performance statistics
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 *   - groupBy (optional: 'model', default: 'model')
 * Response: { totalTokens, avgDuration, breakdown: [...] }
 */
router.get('/stats', async (req, res) => {
  try {
    const { from, to, groupBy = 'model' } = req.query;

    // Parse date range
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = {
      createdAt: { $gte: fromDate, $lte: toDate }
    };

    // Grouping key selection
    let groupKey = '$model'; // Default to model
    if (groupBy === 'day') {
      groupKey = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
    }

    const statsAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      // Only assistant messages have generation stats
      { $match: {
          'messages.role': 'assistant',
          'messages.stats': { $exists: true }
        }
      },
      { $group: {
          _id: groupKey,
          messageCount: { $sum: 1 },
          totalPromptTokens: { $sum: '$messages.stats.usage.promptTokens' },
          totalCompletionTokens: { $sum: '$messages.stats.usage.completionTokens' },
          totalTokens: { $sum: '$messages.stats.usage.totalTokens' },
          totalDuration: { $sum: '$messages.stats.performance.totalDuration' }, // nanoseconds
          avgTokensPerSecond: { $avg: '$messages.stats.performance.tokensPerSecond' },
          // Cost aggregation
          totalCost: { $sum: { $ifNull: ['$messages.cost.totalCost', 0] } },
          promptTokenCost: { $sum: { $ifNull: ['$messages.cost.promptTokenCost', 0] } },
          completionTokenCost: { $sum: { $ifNull: ['$messages.cost.completionTokenCost', 0] } }
        }
      },
      { $project: {
          _id: 0,
          key: '$_id',
          messageCount: 1,
          usage: {
            promptTokens: '$totalPromptTokens',
            completionTokens: '$totalCompletionTokens',
            totalTokens: '$totalTokens'
          },
          performance: {
            totalDurationSec: { $divide: ['$totalDuration', 1e9] }, // Convert ns to seconds
            avgDurationSec: {
              $cond: [
                { $gt: ['$messageCount', 0] },
                { $divide: [{ $divide: ['$totalDuration', 1e9] }, '$messageCount'] },
                0
              ]
            },
            avgTokensPerSecond: '$avgTokensPerSecond'
          },
          cost: {
            totalCost: '$totalCost',
            promptTokenCost: '$promptTokenCost',
            completionTokenCost: '$completionTokenCost',
            avgCostPerMessage: {
              $cond: [
                { $gt: ['$messageCount', 0] },
                { $divide: ['$totalCost', '$messageCount'] },
                0
              ]
            },
            costPerThousandTokens: {
              $cond: [
                { $gt: ['$totalTokens', 0] },
                { $divide: ['$totalCost', { $divide: ['$totalTokens', 1000] }] },
                0
              ]
            }
          }
        }
      },
      { $sort: { 'usage.totalTokens': -1 } }
    ]);

    // Calculate global totals
    const totals = statsAgg.reduce((acc, curr) => {
      acc.promptTokens += curr.usage.promptTokens;
      acc.completionTokens += curr.usage.completionTokens;
      acc.totalTokens += curr.usage.totalTokens;
      acc.durationSec += curr.performance.totalDurationSec;
      acc.messages += curr.messageCount;
      acc.totalCost += curr.cost.totalCost;
      return acc;
    }, { promptTokens: 0, completionTokens: 0, totalTokens: 0, durationSec: 0, messages: 0, totalCost: 0 });

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        currency: process.env.COST_CURRENCY || 'USD',
        totals: {
            ...totals,
            avgDurationSec: totals.messages > 0 ? totals.durationSec / totals.messages : 0,
            avgCostPerMessage: totals.messages > 0 ? totals.totalCost / totals.messages : 0,
            costPerThousandTokens: totals.totalTokens > 0 ? totals.totalCost / (totals.totalTokens / 1000) : 0
        },
        breakdown: statsAgg
      }
    });
  } catch (err) {
    logger.error('Analytics stats error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/**
 * GET /api/analytics/costs
 * Dedicated cost analytics endpoint with flexible grouping
 * Query params:
 *   - from (ISO date, default: 7 days ago)
 *   - to (ISO date, default: now)
 *   - groupBy (optional: 'model' | 'day' | 'promptVersion', default: 'model')
 *   - minCost (number, default: 0) - Filter out entries below this cost
 * Response: { summary: {...}, breakdown: [...] }
 */
router.get('/costs', async (req, res) => {
  try {
    const { from, to, groupBy = 'model', minCost = 0 } = req.query;

    // Parse date range
    const toDate = to ? new Date(to) : new Date();
    const fromDate = from ? new Date(from) : new Date(toDate.getTime() - 7 * 24 * 60 * 60 * 1000);

    const dateFilter = { createdAt: { $gte: fromDate, $lte: toDate } };

    // Determine grouping key
    let groupKey;
    if (groupBy === 'day') {
      groupKey = { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } };
    } else if (groupBy === 'promptVersion') {
      groupKey = { name: '$promptName', version: '$promptVersion' };
    } else {
      groupKey = '$model';
    }

    // Aggregate cost data
    const costAgg = await Conversation.aggregate([
      { $match: dateFilter },
      { $unwind: '$messages' },
      { $match: { 'messages.role': 'assistant' } },
      { $group: {
          _id: groupKey,
          messageCount: { $sum: 1 },
          conversationCount: { $addToSet: '$_id' },
          totalPromptTokens: { $sum: { $ifNull: ['$messages.stats.usage.promptTokens', 0] } },
          totalCompletionTokens: { $sum: { $ifNull: ['$messages.stats.usage.completionTokens', 0] } },
          totalTokens: { $sum: { $ifNull: ['$messages.stats.usage.totalTokens', 0] } },
          totalCost: { $sum: '$messages.cost.totalCost' },
          promptTokenCost: { $sum: { $ifNull: ['$messages.cost.promptTokenCost', 0] } },
          completionTokenCost: { $sum: { $ifNull: ['$messages.cost.completionTokenCost', 0] } }
        }
      },
      { $project: {
          _id: 0,
          key: '$_id',
          messageCount: 1,
          conversationCount: { $size: '$conversationCount' },
          tokens: {
            prompt: '$totalPromptTokens',
            completion: '$totalCompletionTokens',
            total: '$totalTokens'
          },
          cost: {
            total: '$totalCost',
            prompt: '$promptTokenCost',
            completion: '$completionTokenCost',
            avgPerMessage: {
              $cond: [
                { $gt: ['$messageCount', 0] },
                { $divide: ['$totalCost', '$messageCount'] },
                0
              ]
            },
            avgPerConversation: {
              $cond: [
                { $gt: [{ $size: '$conversationCount' }, 0] },
                { $divide: ['$totalCost', { $size: '$conversationCount' }] },
                0
              ]
            },
            per1kTokens: {
              $cond: [
                { $gt: ['$totalTokens', 0] },
                { $divide: ['$totalCost', { $divide: ['$totalTokens', 1000] }] },
                0
              ]
            }
          }
        }
      },
      { $match: { 'cost.total': { $gte: parseFloat(minCost) } } },
      { $sort: { 'cost.total': -1 } }
    ]);

    // Calculate summary statistics
    const summary = costAgg.reduce((acc, curr) => {
      acc.totalCost += curr.cost.total;
      acc.totalMessages += curr.messageCount;
      acc.totalConversations += curr.conversationCount;
      acc.totalTokens += curr.tokens.total;
      acc.promptTokenCost += curr.cost.prompt;
      acc.completionTokenCost += curr.cost.completion;
      return acc;
    }, {
      totalCost: 0,
      totalMessages: 0,
      totalConversations: 0,
      totalTokens: 0,
      promptTokenCost: 0,
      completionTokenCost: 0
    });

    // Calculate averages
    summary.avgCostPerMessage = summary.totalMessages > 0
      ? summary.totalCost / summary.totalMessages
      : 0;
    summary.avgCostPerConversation = summary.totalConversations > 0
      ? summary.totalCost / summary.totalConversations
      : 0;
    summary.costPer1kTokens = summary.totalTokens > 0
      ? summary.totalCost / (summary.totalTokens / 1000)
      : 0;

    // Format all cost values to 6 decimal places
    const formatCost = (cost) => parseFloat((cost || 0).toFixed(6));

    summary.totalCost = formatCost(summary.totalCost);
    summary.promptTokenCost = formatCost(summary.promptTokenCost);
    summary.completionTokenCost = formatCost(summary.completionTokenCost);
    summary.avgCostPerMessage = formatCost(summary.avgCostPerMessage);
    summary.avgCostPerConversation = formatCost(summary.avgCostPerConversation);
    summary.costPer1kTokens = formatCost(summary.costPer1kTokens);

    // Format breakdown items
    const formattedBreakdown = costAgg.map(item => ({
      ...item,
      cost: {
        ...item.cost,
        total: formatCost(item.cost.total),
        prompt: formatCost(item.cost.prompt),
        completion: formatCost(item.cost.completion),
        avgPerMessage: formatCost(item.cost.avgPerMessage),
        avgPerConversation: formatCost(item.cost.avgPerConversation),
        per1kTokens: formatCost(item.cost.per1kTokens)
      }
    }));

    res.json({
      status: 'success',
      data: {
        from: fromDate.toISOString(),
        to: toDate.toISOString(),
        currency: process.env.COST_CURRENCY || 'USD',
        groupBy,
        minCost: parseFloat(minCost),
        summary,
        breakdown: formattedBreakdown
      }
    });
  } catch (err) {
    logger.error('Analytics costs error', { error: err.message, stack: err.stack });
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Sub-routers: prompt/feedback and cross-runtime effectiveness analytics
router.use('/', require('./analytics-prompt'));
router.use('/', require('./analytics-effectiveness'));
// Inference-log analytics: the lane that actually carries platform traffic.
router.use('/inference', require('./analytics-inference'));

module.exports = router;
