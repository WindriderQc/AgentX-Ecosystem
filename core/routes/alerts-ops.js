'use strict';
/**
 * Alert Operations Routes (CRUD by ID, rules, test, notifications)
 * Extracted from alerts.js — mounted via router.use() in alerts.js.
 *
 * Note: isValidWebhookUrl / sanitizeWebhookHeaders / normalizeChannelConfig
 * are only needed by the POST /create and POST /evaluate routes that remain
 * in the parent alerts.js. No helpers are required here.
 */

const express = require('express');
const router = express.Router();
const alertService = require('../src/services/alertService');
const Alert = require('../models/Alert');
const AlertRule = require('../models/AlertRule');
const logger = require('../config/logger');
const { getNotificationService } = require('../src/services/notificationService');
const { seedDefaultRules, syncRulesToEngine } = require('../src/services/alertRuleSeeder');
const { validateObjectId } = require('../src/helpers/objectIdValidator');
const { getStatusProjection } = require('../src/services/laneObservabilityService');

/**
 * PUT /api/alerts/:id/acknowledge
 * Acknowledge an alert
 * Body: { comment }
 */
router.put('/:id/acknowledge', async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Alert ID')) return;

    const { acknowledgedBy } = req.body;

    if (!acknowledgedBy) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: acknowledgedBy'
      });
    }

    await alertService.acknowledgeAlert(req.params.id, acknowledgedBy, req.body.comment);

    const alert = await Alert.findById(req.params.id);

    res.json({
      status: 'success',
      message: 'Alert acknowledged',
      data: {
        alert: {
          ...alert.toObject(),
          acknowledgedBy: alert.acknowledgment?.acknowledgedBy,
          acknowledgedAt: alert.acknowledgment?.acknowledgedAt
        }
      }
    });
  } catch (error) {
    logger.error('Failed to acknowledge alert', { error: error.message });

    if (error.message === 'Alert not found') {
      return res.status(404).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to acknowledge alert',
      error: error.message
    });
  }
});

/**
 * PUT /api/alerts/:id/resolve
 * Resolve an alert
 * Body: { method, comment }
 */
router.put('/:id/resolve', async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Alert ID')) return;

    const { resolvedBy, resolution, method = 'manual' } = req.body;

    if (!resolvedBy) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required field: resolvedBy'
      });
    }

    await alertService.resolveAlert(req.params.id, resolvedBy, method, resolution);

    const alert = await Alert.findById(req.params.id);

    res.json({
      status: 'success',
      message: 'Alert resolved',
      data: {
        alert: {
          ...alert.toObject(),
          resolvedBy: alert.resolution?.resolvedBy,
          resolvedAt: alert.resolution?.resolvedAt,
          resolution: alert.resolution?.comment
        }
      }
    });
  } catch (error) {
    logger.error('Failed to resolve alert', { error: error.message });

    if (error.message === 'Alert not found') {
      return res.status(404).json({
        status: 'error',
        message: error.message
      });
    }

    res.status(500).json({
      status: 'error',
      message: 'Failed to resolve alert',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/:id/delivery-status
 * Update delivery status for an alert (called by automation workflows)
 * Body: { channel, sent, error }
 */
router.post('/:id/delivery-status', async (req, res) => {
  try {
    // Validate ObjectId to prevent NoSQL injection
    if (!validateObjectId(req.params.id, res, 'Alert ID')) return;

    const { channel, status, error, timestamp } = req.body;

    if (!channel) {
      return res.status(400).json({
        status: 'error',
        message: 'Channel is required'
      });
    }

    const alert = await Alert.findById(req.params.id);

    if (!alert) {
      return res.status(404).json({
        status: 'error',
        message: 'Alert not found'
      });
    }

    const sent = status === 'sent';
    const sentAt = timestamp ? new Date(timestamp) : new Date();

    // Update delivery status (virtual alias deliveryStatus maps to delivery)
    const deliveryStatus = alert.deliveryStatus || {};
    deliveryStatus[channel] = deliveryStatus[channel] || {};
    deliveryStatus[channel].sent = sent;
    deliveryStatus[channel].sentAt = sent ? sentAt : undefined;
    deliveryStatus[channel].error = !sent ? (error || undefined) : undefined;
    alert.deliveryStatus = deliveryStatus;

    await alert.save();

    res.json({
      status: 'success',
      message: 'Delivery status updated',
      data: {
        alert
      }
    });
  } catch (error) {
    logger.error('Failed to update delivery status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to update delivery status',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/stats/summary
 * Get alert statistics
 * Query params: from, to, severity, status
 */
router.get('/stats/summary', async (req, res) => {
  try {
    const { from, to, severity, status } = req.query;

    const filters = {};
    if (from) filters.from = from;
    if (to) filters.to = to;
    if (severity) filters.severity = severity;
    if (status) filters.status = status;

    const statsArray = await alertService.getStatistics(filters);
    const stats = statsArray?.[0] || { total: 0, bySeverity: {}, byStatus: {} };

    res.json({
      status: 'success',
      data: {
        statistics: stats
      }
    });
  } catch (error) {
    logger.error('Failed to get alert statistics', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get alert statistics',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/lane-observability
 * Read-only detector/rule/coverage status. This route never runs a detector
 * or changes alert, routing, claim, pin, or residency state.
 */
router.get('/lane-observability', async (_req, res) => {
  try {
    const projection = await getStatusProjection();
    res.json({ status: 'success', data: projection });
  } catch (error) {
    logger.error('Failed to get lane observability status', { error: error.message });
    res.status(500).json({ status: 'error', message: 'Failed to get lane observability status' });
  }
});

/**
 * POST /api/alerts/rules/load
 * Load alert rules from configuration
 * Body: { rules: [...] } or reload from file if no body
 */
router.post('/rules/load', async (req, res) => {
  try {
    let rules;

    if (req.body.rules && Array.isArray(req.body.rules)) {
      rules = req.body.rules;
    } else {
      return res.status(400).json({
        status: 'error',
        message: 'File-based rule loading was removed. Please provide rules in the request body as { "rules": [...] }.'
      });
    }

    const count = alertService.loadRules(rules);
    const enabledCount = rules.filter(r => r.enabled !== false).length;

    logger.info('Alert rules loaded', { count });

    res.json({
      status: 'success',
      message: `Loaded ${count} alert rules`,
      data: {
        loadedCount: count,
        enabledCount: enabledCount
      }
    });
  } catch (error) {
    logger.error('Failed to load alert rules', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to load alert rules',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/test/config
 * Get current alert service configuration (for debugging)
 */
router.get('/test/config', async (req, res) => {
  try {
    const enabledChannels = [];
    if (alertService.config.email.enabled) enabledChannels.push('email');
    if (alertService.config.slack.enabled) enabledChannels.push('slack');
    if (alertService.config.webhook.enabled) enabledChannels.push('webhook');
    if (alertService.config.dataapi.enabled) enabledChannels.push('dataapi');

    const config = {
      email: {
        enabled: alertService.config.email.enabled,
        from: alertService.config.email.from,
        to: alertService.config.email.to
      },
      slack: {
        enabled: alertService.config.slack.enabled,
        webhookConfigured: !!alertService.config.slack.webhookUrl
      },
      webhook: {
        enabled: alertService.config.webhook.enabled,
        urlConfigured: !!alertService.config.webhook.url
      },
      dataapi: {
        enabled: alertService.config.dataapi.enabled,
        url: alertService.config.dataapi.url
      },
      testMode: alertService.testMode,
      cooldownMs: alertService.config.cooldownMs,
      maxOccurrences: alertService.config.maxOccurrences,
      rulesLoaded: alertService.rules.length,
      enabledChannels
    };

    res.json({
      status: 'success',
      data: { config }
    });
  } catch (error) {
    logger.error('Failed to get alert config', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get alert config',
      error: error.message
    });
  }
});

/**
 * GET /api/alerts/notifications/status
 * Get notification channels configuration status
 */
router.get('/notifications/status', async (req, res) => {
  try {
    const notificationService = getNotificationService();
    const status = notificationService.getStatus();

    res.json({
      status: 'success',
      data: status
    });
  } catch (error) {
    logger.error('Failed to get notification status', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to get notification status',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/notifications/test
 * Test a notification channel
 * Body: { channel: 'email' | 'slack' | 'telegram' | 'webhook' }
 */
router.post('/notifications/test', async (req, res) => {
  try {
    const { channel } = req.body;

    if (!channel) {
      return res.status(400).json({
        status: 'error',
        message: 'Channel parameter required'
      });
    }

    const validChannels = ['email', 'slack', 'telegram', 'webhook'];
    if (!validChannels.includes(channel)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid channel. Must be one of: ${validChannels.join(', ')}`
      });
    }

    const notificationService = getNotificationService();

    // Create test alert
    const testAlert = {
      _id: 'test-alert-id',
      title: 'Test Alert - AgentX Notification System',
      message: 'This is a test alert to verify notification channel configuration.',
      severity: 'info',
      ruleName: 'Test Rule',
      ruleId: 'test-rule',
      source: 'agentx-test',
      context: {
        component: 'notification-test',
        metric: 'test',
        currentValue: 100,
        threshold: 80
      },
      createdAt: new Date(),
      status: 'active'
    };

    // Send test notification
    const result = await notificationService.send(channel, testAlert);

    res.json({
      status: 'success',
      data: {
        channel,
        sent: result.sent,
        error: result.error,
        message: result.sent
          ? `Test notification sent successfully to ${channel}`
          : `Failed to send test notification: ${result.error}`
      }
    });
  } catch (error) {
    logger.error('Failed to test notification', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to test notification',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/notifications/verify
 * Verify notification channel configuration
 * Body: { channel: 'email' | 'slack' | 'telegram' | 'webhook' }
 */
router.post('/notifications/verify', async (req, res) => {
  try {
    const { channel } = req.body;

    if (!channel) {
      return res.status(400).json({
        status: 'error',
        message: 'Channel parameter required'
      });
    }

    const validChannels = ['email', 'slack', 'telegram', 'webhook'];
    if (!validChannels.includes(channel)) {
      return res.status(400).json({
        status: 'error',
        message: `Invalid channel. Must be one of: ${validChannels.join(', ')}`
      });
    }

    const notificationService = getNotificationService();
    const verificationResult = await notificationService.verifyChannel(channel);

    res.json({
      status: 'success',
      data: {
        channel,
        ...verificationResult
      }
    });
  } catch (error) {
    logger.error('Failed to verify notification channel', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to verify notification channel',
      error: error.message
    });
  }
});

/**
 * POST /api/alerts/bulk-resolve
 * Resolve all active alerts older than a given age
 * Body: { olderThanDays: 7 } (default: 7)
 */
router.post('/bulk-resolve', async (req, res) => {
  try {
    const days = Math.max(1, parseInt(req.body.olderThanDays, 10) || 7);
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

    const result = await Alert.updateMany(
      { status: 'active', createdAt: { $lt: cutoff } },
      { $set: {
        status: 'resolved',
        'resolution.resolved': true,
        'resolution.resolvedAt': new Date(),
        'resolution.resolvedBy': 'bulk-cleanup',
        'resolution.method': 'auto',
        'resolution.comment': `Bulk-resolved: active alerts older than ${days} days`,
      } }
    );

    logger.info('Bulk-resolved stale alerts', { days, count: result.modifiedCount });
    res.json({ status: 'success', data: { resolved: result.modifiedCount } });
  } catch (error) {
    logger.error('Failed to bulk-resolve alerts', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ========================================
// Alert Rules CRUD
// ========================================

/**
 * GET /api/alerts/rules
 * List all alert rules from MongoDB (+ in-memory defaults for backwards compat)
 */
router.get('/rules', async (req, res) => {
  try {
    const dbRules = await AlertRule.find().sort({ builtIn: -1, createdAt: 1 }).lean();
    res.json({ status: 'success', data: { rules: dbRules } });
  } catch (error) {
    logger.error('Failed to list alert rules', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/alerts/rules
 * Create a new alert rule
 */
router.post('/rules', async (req, res) => {
  try {
    const { ruleId, name, severity, conditions, channels, cooldownMs, renotifyMs, description, enabled } = req.body;
    if (!ruleId || !name || !severity) {
      return res.status(400).json({ status: 'error', message: 'ruleId, name, and severity are required' });
    }
    const validSeverities = ['info', 'warning', 'error', 'critical'];
    if (!validSeverities.includes(severity)) {
      return res.status(400).json({ status: 'error', message: 'Invalid severity' });
    }

    const rule = await AlertRule.create({
      ruleId, name, severity,
      conditions: conditions || { all: [] },
      channels: channels || ['dataapi_log'],
      cooldownMs: cooldownMs || 300000,
      renotifyMs: renotifyMs || 0,
      description: description || '',
      enabled: enabled !== false,
      builtIn: false,
    });

    // Reload in-memory rules
    await syncRulesToEngine();

    logger.info('Alert rule created', { ruleId });
    res.status(201).json({ status: 'success', data: { rule } });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ status: 'error', message: 'Rule with this ruleId already exists' });
    }
    logger.error('Failed to create alert rule', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * PUT /api/alerts/rules/:ruleId
 * Update an existing alert rule
 */
router.put('/rules/:ruleId', async (req, res) => {
  try {
    const { ruleId } = req.params;
    const updates = {};
    const allowed = ['name', 'severity', 'conditions', 'channels', 'cooldownMs', 'renotifyMs', 'description', 'enabled'];
    for (const key of allowed) {
      if (req.body[key] !== undefined) updates[key] = req.body[key];
    }

    const rule = await AlertRule.findOneAndUpdate({ ruleId }, { $set: updates }, { new: true, runValidators: true });
    if (!rule) {
      return res.status(404).json({ status: 'error', message: 'Rule not found' });
    }

    await syncRulesToEngine();

    logger.info('Alert rule updated', { ruleId });
    res.json({ status: 'success', data: { rule } });
  } catch (error) {
    logger.error('Failed to update alert rule', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * DELETE /api/alerts/rules/:ruleId
 * Delete an alert rule (cannot delete built-in rules)
 */
router.delete('/rules/:ruleId', async (req, res) => {
  try {
    const { ruleId } = req.params;
    const rule = await AlertRule.findOne({ ruleId });
    if (!rule) {
      return res.status(404).json({ status: 'error', message: 'Rule not found' });
    }
    if (rule.builtIn) {
      return res.status(403).json({ status: 'error', message: 'Cannot delete built-in rules. Disable it instead.' });
    }

    await AlertRule.deleteOne({ ruleId });
    await syncRulesToEngine();

    logger.info('Alert rule deleted', { ruleId });
    res.json({ status: 'success', message: 'Rule deleted' });
  } catch (error) {
    logger.error('Failed to delete alert rule', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

/**
 * POST /api/alerts/rules/seed-defaults
 * Ensure built-in default rules exist in MongoDB
 */
router.post('/rules/seed-defaults', async (req, res) => {
  try {
    const count = await seedDefaultRules();
    res.json({ status: 'success', message: `Seeded ${count} default rules` });
  } catch (error) {
    logger.error('Failed to seed default rules', { error: error.message });
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ── Parameterized routes MUST come AFTER all named routes ──

/**
 * GET /api/alerts/:id
 * Get a specific alert by ID
 */
router.get('/:id', async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (!mongoose.isValidObjectId(req.params.id)) {
      return res.status(400).json({ status: 'error', message: 'Invalid alert ID' });
    }
    const alert = await Alert.findById(req.params.id);
    if (!alert) {
      return res.status(404).json({ status: 'error', message: 'Alert not found' });
    }
    res.json({ status: 'success', data: { alert } });
  } catch (error) {
    logger.error('Failed to get alert', { error: error.message });
    res.status(500).json({ status: 'error', message: 'Failed to get alert', error: error.message });
  }
});

module.exports = router;
