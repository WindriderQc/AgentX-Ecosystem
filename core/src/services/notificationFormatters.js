'use strict';
/**
 * Notification Service Formatters
 *
 * Pure helper functions extracted from notificationService.js.
 * Covers header parsing, the template engine, alert formatters,
 * and webhook config/payload builders.
 *
 * Consumed by: src/services/notificationService.js
 */

const logger = require('../../config/logger');

// ── Header Parsing ─────────────────────────────────────────────────────────────

/**
 * Parse webhook headers from env string or JSON.
 * Accepts JSON object string or "Key1:Value1,Key2:Value2" format.
 *
 * @param {string|null} headersStr
 * @returns {Object}
 */
function parseHeaders(headersStr) {
  if (!headersStr) return {};
  try {
    return JSON.parse(headersStr);
  } catch {
    // Format: "Key1:Value1,Key2:Value2"
    const headers = {};
    headersStr.split(',').forEach(pair => {
      const [key, value] = pair.split(':').map(s => s.trim());
      if (key && value) headers[key] = value;
    });
    return headers;
  }
}

/**
 * Normalize a headers value (string, object, or null) to a plain object.
 *
 * @param {string|Object|null} headers
 * @returns {Object}
 */
function normalizeHeaders(headers) {
  if (!headers) return {};
  if (typeof headers === 'string') {
    return parseHeaders(headers);
  }
  if (typeof headers === 'object') {
    return headers;
  }
  return {};
}

// ── Template Engine ────────────────────────────────────────────────────────────

/**
 * Build template data from an alert document.
 * Normalizes Mongoose documents (.toObject) and guarantees context/delivery.
 *
 * @param {Object|null} alert
 * @returns {Object}
 */
function buildTemplateData(alert) {
  if (!alert) {
    return { context: {}, delivery: {} };
  }
  const base = typeof alert?.toObject === 'function' ? alert.toObject() : { ...alert };
  return {
    ...base,
    context: base.context || alert?.context || {},
    delivery: base.delivery || alert?.delivery || {}
  };
}

/**
 * Resolve a dot-notation key against a data object.
 * Depth is capped at 3; prototype-related keys are blocked.
 *
 * @param {Object} data
 * @param {string} key - e.g. "context.metric"
 * @returns {*}
 */
function getTemplateValue(data, key) {
  if (!key) return '';
  const parts = key.split('.');
  const MAX_DEPTH = 3;
  if (parts.length > MAX_DEPTH) {
    return '';
  }
  let value = data;
  for (const part of parts) {
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      return '';
    }
    if (value && Object.prototype.hasOwnProperty.call(value, part)) {
      value = value[part];
    } else {
      return '';
    }
  }
  return value === null || value === undefined ? '' : value;
}

/**
 * Render a Mustache-style template string ({{ key }}) against data.
 *
 * @param {string} template
 * @param {Object} data
 * @returns {string}
 */
function renderTemplate(template, data) {
  if (!template) return '';
  return String(template).replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = getTemplateValue(data, key);
    return value === undefined || value === null ? '' : String(value);
  });
}

/**
 * Recursively apply template rendering to arrays and nested objects.
 *
 * @param {*} template
 * @param {Object} data
 * @returns {*}
 */
function applyTemplateObject(template, data) {
  if (Array.isArray(template)) {
    // Optimize for primitive arrays — no need to recurse
    if (template.length > 0 && typeof template[0] !== 'object') {
      return template.map(item =>
        typeof item === 'string' ? renderTemplate(item, data) : item
      );
    }
    return template.map(item => applyTemplateObject(item, data));
  }
  if (template && typeof template === 'object') {
    return Object.entries(template).reduce((acc, [key, value]) => {
      acc[key] = applyTemplateObject(value, data);
      return acc;
    }, {});
  }
  if (typeof template === 'string') {
    return renderTemplate(template, data);
  }
  return template;
}

// ── Alert Formatters ───────────────────────────────────────────────────────────

/**
 * Format alert as plain-text email body.
 *
 * @param {Object} alert
 * @returns {string}
 */
/**
 * Describe an incident that is being re-announced rather than opened.
 *
 * Without this a re-notification is byte-identical to the original — same
 * title, same "Triggered" timestamp — so it reads as a duplicate and gets
 * dismissed, which defeats the point of sending it. Says how long the
 * condition has been unresolved and how many times it has recurred, because
 * "still broken 9 hours later" is different information from "broken".
 */
function formatOngoingPrefix(alert) {
  const reminders = Number(alert?.notificationCount) || 0;
  if (reminders <= 1) return '';
  const startedAt = alert.createdAt ? new Date(alert.createdAt).getTime() : null;
  const forHours = startedAt ? ((Date.now() - startedAt) / 3600000).toFixed(1) : '?';
  return `STILL UNRESOLVED after ${forHours}h — reminder #${reminders - 1}, `
    + `${alert.occurrenceCount || 1} occurrences since first seen.\n\n`;
}

function formatAlertText(alert) {
  return `
${formatOngoingPrefix(alert)}ALERT: ${alert.title}

Severity: ${alert.severity.toUpperCase()}
Rule: ${alert.ruleName}
Component: ${alert.context?.component || 'N/A'}
Source: ${alert.source || 'agentx'}

Message:
${alert.message}

Details:
- Current Value: ${alert.context?.currentValue}
- Threshold: ${alert.context?.threshold}
- Metric: ${alert.context?.metric || 'N/A'}

Triggered: ${alert.createdAt}
Alert ID: ${alert._id}

---
AgentX Alert System
    `.trim();
}

/**
 * Map severity to a hex colour for UI / email styling.
 *
 * @param {string} severity
 * @returns {string} hex colour
 */
function getSeverityColor(severity) {
  const colors = {
    critical: '#dc3545',
    high: '#fd7e14',
    medium: '#ffc107',
    low: '#17a2b8',
    info: '#6c757d'
  };
  return colors[severity] || colors.medium;
}

/**
 * Format alert as HTML email body.
 *
 * @param {Object} alert
 * @returns {string}
 */
function formatAlertHtml(alert) {
  const severityColor = getSeverityColor(alert.severity);
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; line-height: 1.6; color: #333; max-width: 600px; margin: 0 auto; }
    .header { background-color: ${severityColor}; color: white; padding: 20px; border-radius: 5px 5px 0 0; }
    .content { padding: 20px; border: 1px solid #ddd; border-top: none; background: #fff; }
    .field { margin: 10px 0; }
    .label { font-weight: bold; color: #555; }
    .footer { padding: 20px; color: #888; font-size: 12px; text-align: center; background: #f9f9f9; border: 1px solid #ddd; border-top: none; border-radius: 0 0 5px 5px; }
    .details-box { background: #f5f5f5; padding: 10px; border-radius: 4px; margin-top: 5px; }
    ul { margin: 0; padding-left: 20px; }
    .alert-id { font-family: monospace; color: #666; }
  </style>
</head>
<body>
  <div class="header">
    <h1 style="margin:0; font-size: 24px;">${alert.title}</h1>
    <p style="margin:5px 0 0 0; opacity: 0.9;">Severity: ${alert.severity.toUpperCase()}</p>
  </div>
  <div class="content">
    <div class="field">
      <span class="label">Rule:</span> ${alert.ruleName}
    </div>
    <div class="field">
      <span class="label">Component:</span> ${alert.context?.component || 'N/A'}
    </div>
    <div class="field">
      <span class="label">Source:</span> ${alert.source || 'agentx'}
    </div>
    <div class="field" style="margin-top: 20px;">
      <span class="label">Message:</span><br>
      <div style="font-size: 1.1em; color: #000;">${alert.message}</div>
    </div>
    <div class="field">
      <span class="label">Details:</span>
      <div class="details-box">
        <ul>
          <li><strong>Current Value:</strong> ${alert.context?.currentValue}</li>
          <li><strong>Threshold:</strong> ${alert.context?.threshold}</li>
          <li><strong>Metric:</strong> ${alert.context?.metric || 'N/A'}</li>
        </ul>
      </div>
    </div>
    <div class="field" style="margin-top: 20px; border-top: 1px solid #eee; padding-top: 10px;">
      <span class="label">Triggered:</span> ${alert.createdAt}<br>
      <span class="label">Alert ID:</span> <span class="alert-id">${alert._id}</span>
    </div>
  </div>
  <div class="footer">
    Sent by <strong>AgentX Alert System</strong><br>
    <a href="#" style="color: #666; text-decoration: none;">View in Dashboard</a>
  </div>
</body>
</html>
    `.trim();
}

// ── Webhook / Email Helpers ────────────────────────────────────────────────────

/**
 * Resolve email recipients for an alert.
 * Prefers per-alert channelConfig, falls back to env ALERT_EMAIL_RECIPIENTS.
 *
 * @param {Object} alert
 * @returns {string|undefined}
 */
function resolveEmailRecipients(alert) {
  const recipients = alert.channelConfig?.email?.recipients || alert.emailRecipients || process.env.ALERT_EMAIL_RECIPIENTS;
  if (Array.isArray(recipients)) {
    return recipients.filter(Boolean).join(', ');
  }
  return recipients;
}

/**
 * Resolve effective webhook config for an alert.
 * Per-alert channelConfig overrides the service-level webhookConfig.
 *
 * @param {Object} alert
 * @param {Object} webhookConfig - this.config.webhook from NotificationService
 * @returns {{ url, method, headers, template }}
 */
function resolveWebhookConfig(alert, webhookConfig) {
  const normalizedHeaders = normalizeHeaders(alert.channelConfig?.webhook?.headers);
  const resolvedHeaders = Object.keys(normalizedHeaders || {}).length > 0
    ? normalizedHeaders
    : webhookConfig.headers;
  return {
    url: alert.channelConfig?.webhook?.url || webhookConfig.url,
    method: alert.channelConfig?.webhook?.method || webhookConfig.method,
    headers: resolvedHeaders,
    template: alert.channelConfig?.webhook?.template
  };
}

/**
 * Build the JSON payload for a webhook notification.
 * Applies template if provided; falls back to default alert shape.
 *
 * @param {Object} alert
 * @param {string|Object|null} template - optional Mustache template
 * @returns {Object}
 */
function buildWebhookPayload(alert, template) {
  const templateData = buildTemplateData(alert);
  if (template) {
    if (typeof template === 'string') {
      const rendered = renderTemplate(template, templateData);
      try {
        return JSON.parse(rendered);
      } catch (err) {
        logger.warn('[NotificationService] Failed to parse webhook template as JSON, falling back to text payload', {
          error: err && err.message ? err.message : String(err),
          alertId: alert && alert._id ? alert._id : undefined
        });
        return { text: rendered };
      }
    }
    if (typeof template === 'object') {
      return applyTemplateObject(template, templateData);
    }
  }

  return {
    alert: {
      id: alert._id,
      title: alert.title,
      message: alert.message,
      severity: alert.severity,
      ruleName: alert.ruleName,
      ruleId: alert.ruleId,
      source: alert.source,
      context: alert.context,
      createdAt: alert.createdAt,
      status: alert.status
    },
    timestamp: new Date().toISOString(),
    source: 'agentx'
  };
}

module.exports = {
  parseHeaders,
  normalizeHeaders,
  buildTemplateData,
  getTemplateValue,
  renderTemplate,
  applyTemplateObject,
  formatAlertText,
  getSeverityColor,
  formatAlertHtml,
  resolveEmailRecipients,
  resolveWebhookConfig,
  buildWebhookPayload
};
