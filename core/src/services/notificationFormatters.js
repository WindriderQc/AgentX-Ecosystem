'use strict';

function formatOngoingPrefix(alert) {
  const reminders = Number(alert?.notificationCount) || 0;
  if (reminders <= 1) return '';
  const startedAt = alert.createdAt ? new Date(alert.createdAt).getTime() : null;
  const forHours = startedAt ? ((Date.now() - startedAt) / 3600000).toFixed(1) : '?';
  return `STILL UNRESOLVED after ${forHours}h — reminder #${reminders - 1}, `
    + `${alert.occurrenceCount || 1} occurrences since first seen.\n\n`;
}

/** Plain-text representation used by the product-owned local alert log. */
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
  `.trim();
}

module.exports = { formatAlertText, formatOngoingPrefix };
