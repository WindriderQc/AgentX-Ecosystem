/**
 * Roundtable Notifier
 *
 * Supported destinations (any combination can be configured per run):
 *   - Telegram   — via Bot API sendMessage (requires TELEGRAM_BOT_TOKEN env)
 *   - Slack      — via incoming webhook
 *   - Webhook    — generic JSON POST to any URL
 */

const fetch = require('node-fetch');
const logger = require('../../../config/logger');
const { formatCompactSummary } = require('./formatters');

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;

/**
 * Fire all configured notifications for a completed roundtable.
 * notifyConfig shape: { telegram?: string|number, slack?: string, webhook?: string }
 * Failures are logged but never throw.
 */
async function notifyCompletion(doc, notifyConfig) {
  if (!notifyConfig) return;

  const durationSec = doc.totalDurationMs ? (doc.totalDurationMs / 1000).toFixed(1) : '?';
  const turnsCount = (doc.turns || []).length;
  const question = (doc.question || '').substring(0, 200);
  const status = doc.status;

  const tasks = [];

  if (notifyConfig.telegram) {
    tasks.push(sendTelegram(notifyConfig.telegram, doc));
  }
  if (notifyConfig.slack) {
    tasks.push(sendSlack(notifyConfig.slack, { question, status, durationSec, turnsCount, doc }));
  }
  if (notifyConfig.webhook) {
    tasks.push(sendWebhook(notifyConfig.webhook, { question, status, durationSec, turnsCount, doc }));
  }

  const settled = await Promise.allSettled(tasks);
  const failures = settled.filter((r) => r.status === 'rejected');
  if (failures.length > 0) {
    logger.warn('Some roundtable notifications failed', {
      roundtableId: doc._id,
      failures: failures.map((f) => f.reason?.message || 'unknown')
    });
  }
}

async function sendTelegram(chatId, doc) {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error('TELEGRAM_BOT_TOKEN env is not set');
  }
  const text = formatCompactSummary(doc);
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
    timeout: 10000
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Telegram ${resp.status}: ${body.substring(0, 200)}`);
  }
  logger.info('Roundtable Telegram notification sent', { roundtableId: doc._id, chatId });
}

async function sendSlack(webhookUrl, { question, status, durationSec, turnsCount, doc }) {
  const emoji = status === 'completed' ? ':white_check_mark:' : ':x:';
  const color = status === 'completed' ? '#4ade80' : '#f87171';
  let verdict = '';
  if (doc.synthesis?.response) {
    verdict = doc.synthesis.response.split(/[.!?]\s/)[0].substring(0, 200);
  }
  const payload = {
    text: `${emoji} Roundtable ${status}`,
    attachments: [{
      color,
      fields: [
        { title: 'Question', value: question, short: false },
        { title: 'Status', value: status, short: true },
        { title: 'Duration', value: `${durationSec}s`, short: true },
        { title: 'Turns', value: `${turnsCount}`, short: true },
        ...(verdict ? [{ title: 'Verdict', value: verdict, short: false }] : [])
      ]
    }]
  };
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 10000
  });
  if (!resp.ok) throw new Error(`Slack webhook failed: ${resp.status}`);
  logger.info('Roundtable Slack notification sent', { roundtableId: doc._id });
}

async function sendWebhook(webhookUrl, { question, status, durationSec, turnsCount, doc }) {
  const payload = {
    event: 'roundtable.completed',
    roundtableId: doc._id,
    question,
    status,
    durationSec: parseFloat(durationSec),
    turnsCount,
    rounds: doc.rounds,
    synthesis: doc.synthesis?.response || null,
    completedAt: doc.completedAt || new Date().toISOString()
  };
  const resp = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 10000
  });
  if (!resp.ok) throw new Error(`Webhook failed: ${resp.status}`);
  logger.info('Roundtable webhook notification sent', { roundtableId: doc._id });
}

module.exports = { notifyCompletion };
