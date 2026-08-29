/**
 * Alert Management Routes - Track 1: Alerts & Notifications
 *
 * Provides endpoints for creating, managing, and querying alerts
 * Integrates with AlertService for rule-based alerting
 */

const express = require('express');
const router = express.Router();
const alertService = require('../src/services/alertService');
const Alert = require('../models/Alert');
const logger = require('../config/logger');
const { validateObjectId } = require('../src/helpers/objectIdValidator');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');

/**
 * POST /api/alerts
 * Create a new alert manually
 * Body: { ruleId, ruleName, severity, title, message, context, channels }
 */
router.post('/', async (req, res) => {
  try {
    const {
      ruleId,
      ruleName,
      severity,
      title,
      message,
      source,
      context = {},
      channels = ['local_log'],
      channelConfig = {},
      tags = [],
      metadata = {}
    } = req.body;

    // Validate required fields
    if (!title || !message || !severity || !source) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: title, message, severity, source'
      });
    }

    // Validate severity
    const validSeverities = ['info', 'warning', 'critical'];
    if (!validSeverities.includes(severity)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid severity. Must be: info, warning, or critical'
      });
    }

    const requestedChannels = Array.isArray(channels) ? channels : [];
    if (requestedChannels.some((channel) => channel !== 'local_log')
      || Object.keys(channelConfig || {}).length > 0) {
      return res.status(410).json({
        status: 'error',
        message: 'External alert delivery moved to separately deployed adapters.',
        code: 'ADAPTER_REQUIRED'
      });
    }
    const filteredChannels = ['local_log'];

    // Generate fingerprint
    const crypto = require('crypto');
    const fingerprint = crypto
      .createHash('md5')
      .update(`${ruleId || 'manual'}|${context.component || ''}|${context.metric || ''}`)
      .digest('hex');

    // Create alert
    const alert = new Alert({
      ruleId: ruleId || 'manual',
      ruleName: ruleName || 'Manual Alert',
      severity,
      title,
      message,
      context,
      channels: filteredChannels,
      channelConfig: {},
      fingerprint,
      source: source || 'manual',
      tags,
      metadata
    });

    await alert.save();

    // Send notifications
    await alertService._sendNotifications(alert, filteredChannels);

    const alertSev = alert.severity || 'info';
    const significance = alertSev === 'critical' ? 'high' : alertSev === 'warning' ? 'normal' : 'low';
    emitBuddyEvent('alert_' + alertSev, 'infrastructure', alertSev.toUpperCase() + ' alert: ' + (alert.message || alert.title || 'unnamed'), significance);

    logger.info('Alert created manually', {
      alertId: alert._id
    });

    res.status(201).json({
      status: 'success',
      message: 'Alert created',
      data: {
        alert: {
          _id: alert._id.toString(),
          ruleId: alert.ruleId,
          severity: alert.severity,
          title: alert.title,
          status: alert.status,
          createdAt: alert.createdAt
        }
      }
    });
  } catch (error) {
    logger.error('Failed to create alert', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to create alert',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/evaluate
 * Evaluate an event against configured alert rules
 * Body: { component, metric, value, threshold, trend, source, additionalData }
 */
router.post('/evaluate', async (req, res) => {
  try {
    const event = req.body;

    // Accept events in either format:
    // - { component, metric, value, ... }
    // - { source, data: { ...facts } }
    if (!event || typeof event !== 'object') {
      return res.status(400).json({
        status: 'error',
        message: 'Event payload is required'
      });
    }

    const alerts = await alertService.evaluateEvent(event);
    const matched = alerts.length > 0;

    res.json({
      status: 'success',
      data: {
        matched,
        alert: matched ? alerts[0] : null
      }
    });
  } catch (error) {
    logger.error('Failed to evaluate event', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to evaluate event',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts
 * List alerts with filtering
 * Query params: severity, status, ruleId, limit, offset
 */
router.get('/', async (req, res) => {
  try {
    const {
      severity,
      status,
      ruleId,
      limit = 50,
      skip = 0
    } = req.query;

    const filters = {};
    if (severity) filters.severity = severity;
    if (status) filters.status = status;
    if (ruleId) filters.ruleId = ruleId;

    const snapshot = await alertService.getAlertSnapshot({
      filters,
      limit,
      skip,
      sort: 'severity'
    });

    res.json({
      status: 'success',
      data: snapshot
    });
  } catch (error) {
    logger.error('Failed to list alerts', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to list alerts',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/statistics
 * Get comprehensive alert statistics for analytics dashboard
 * Query params: from, to (ISO date strings)
 * NOTE: Must be defined BEFORE /:id route to avoid parameter matching
 */
router.get('/statistics', async (req, res) => {
  try {
    const { from, to } = req.query;

    // Build date filter
    const dateFilter = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);

    const matchFilter = Object.keys(dateFilter).length > 0
      ? { createdAt: dateFilter }
      : {};

    // Comprehensive aggregation pipeline
    const results = await Alert.aggregate([
      { $match: matchFilter },
      {
        $facet: {
          // Overall summary
          summary: [
            {
              $group: {
                _id: null,
                totalAlerts: { $sum: 1 },
                activeAlerts: {
                  $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
                },
                acknowledgedAlerts: {
                  $sum: { $cond: [{ $eq: ['$status', 'acknowledged'] }, 1, 0] }
                },
                resolvedAlerts: {
                  $sum: { $cond: [{ $eq: ['$status', 'resolved'] }, 1, 0] }
                },
                avgResolutionTime: {
                  $avg: {
                    $cond: [
                      { $and: [
                        { $eq: ['$resolution.resolved', true] },
                        { $ne: ['$resolution.resolvedAt', null] }
                      ]},
                      { $subtract: ['$resolution.resolvedAt', '$createdAt'] },
                      null
                    ]
                  }
                },
                avgAcknowledgmentTime: {
                  $avg: {
                    $cond: [
                      { $and: [
                        { $eq: ['$acknowledgment.acknowledged', true] },
                        { $ne: ['$acknowledgment.acknowledgedAt', null] }
                      ]},
                      { $subtract: ['$acknowledgment.acknowledgedAt', '$createdAt'] },
                      null
                    ]
                  }
                }
              }
            }
          ],

          // By severity
          bySeverity: [
            { $group: { _id: '$severity', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ],

          // By status
          byStatus: [
            { $group: { _id: '$status', count: { $sum: 1 } } },
            { $sort: { count: -1 } }
          ],

          // By source/component
          bySource: [
            { $group: { _id: '$source', count: { $sum: 1 } } },
            { $sort: { count: -1 } },
            { $limit: 20 }
          ],

          // By rule
          byRule: [
            {
              $group: {
                _id: '$ruleName',
                count: { $sum: 1 },
                avgOccurrences: { $avg: '$occurrenceCount' }
              }
            },
            { $sort: { count: -1 } },
            { $limit: 10 }
          ],

          // Delivery stats by channel
          deliveryStats: [
            { $unwind: { path: '$delivery', preserveNullAndEmptyArrays: true } },
            {
              $group: {
                _id: '$delivery.k',
                sent: {
                  $sum: { $cond: [{ $eq: ['$delivery.v.sent', true] }, 1, 0] }
                },
                failed: {
                  $sum: { $cond: [{ $eq: ['$delivery.v.sent', false] }, 1, 0] }
                }
              }
            }
          ],

          // Time series data (hourly buckets)
          timeSeries: [
            {
              $group: {
                _id: {
                  year: { $year: '$createdAt' },
                  month: { $month: '$createdAt' },
                  day: { $dayOfMonth: '$createdAt' },
                  hour: { $hour: '$createdAt' }
                },
                count: { $sum: 1 },
                critical: {
                  $sum: { $cond: [{ $eq: ['$severity', 'critical'] }, 1, 0] }
                },
                high: {
                  $sum: { $cond: [{ $eq: ['$severity', 'high'] }, 1, 0] }
                },
                warning: {
                  $sum: { $cond: [
                    { $or: [
                      { $eq: ['$severity', 'warning'] },
                      { $eq: ['$severity', 'medium'] }
                    ]},
                    1,
                    0
                  ]}
                },
                info: {
                  $sum: { $cond: [
                    { $or: [
                      { $eq: ['$severity', 'info'] },
                      { $eq: ['$severity', 'low'] }
                    ]},
                    1,
                    0
                  ]}
                }
              }
            },
            { $sort: { '_id.year': 1, '_id.month': 1, '_id.day': 1, '_id.hour': 1 } }
          ],

          // Recurrence heatmap (day of week x hour of day)
          heatmap: [
            {
              $group: {
                _id: {
                  dayOfWeek: { $dayOfWeek: '$createdAt' },
                  hour: { $hour: '$createdAt' }
                },
                count: { $sum: 1 }
              }
            }
          ]
        }
      }
    ]);

    // Format the response
    const stats = results[0];

    // Convert arrays to objects for easier consumption
    const bySeverity = stats.bySeverity.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    const byStatus = stats.byStatus.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    const bySource = stats.bySource.reduce((acc, item) => {
      acc[item._id] = item.count;
      return acc;
    }, {});

    res.json({
      status: 'success',
      data: {
        summary: stats.summary[0] || {
          totalAlerts: 0,
          activeAlerts: 0,
          acknowledgedAlerts: 0,
          resolvedAlerts: 0,
          avgResolutionTime: null,
          avgAcknowledgmentTime: null
        },
        bySeverity,
        byStatus,
        bySource,
        byRule: stats.byRule,
        deliveryStats: stats.deliveryStats,
        timeSeries: stats.timeSeries,
        heatmap: stats.heatmap,
        generatedAt: new Date().toISOString()
      }
    });

  } catch (error) {
    logger.error('Failed to get alert statistics', { error: error.message, stack: error.stack });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get alert statistics',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/:id
 * Get a specific alert by ID
 */

// Alert operations (CRUD by ID, rules, notifications) mounted as sub-router
router.use('/', require('./alerts-ops'));

module.exports = router;
