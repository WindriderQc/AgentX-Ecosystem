/**
 * Telegram topic publisher for Roundtable v2.
 *
 * Telegram is the human-visible chamber, not the agent transport. Agent turns
 * are produced through native runtimes, persisted in Mongo, then mirrored here
 * as plain text. Thinking fields and credentials are never rendered.
 */

const fetch = require('node-fetch');
const logger = require('../../../config/logger');

const TELEGRAM_TEXT_LIMIT = 4096;

function normalizeTelegramConfig(value) {
  if (!value) return null;
  const config = typeof value === 'string' ? { chatId: value } : value;
  const chatId = String(config.chatId || config.chat_id || '').trim();
  if (!/^-?\d{1,30}$/.test(chatId)) throw new Error('telegram.chatId must be a numeric chat id');
  const rawThreadId = config.threadId ?? config.thread_id;
  const threadId = rawThreadId == null || rawThreadId === '' ? null : Number(rawThreadId);
  if (threadId !== null && (!Number.isInteger(threadId) || threadId <= 0)) {
    throw new Error('telegram.threadId must be a positive integer');
  }
  return {
    chatId,
    threadId,
    publishTurns: config.publishTurns !== false,
    publishLifecycle: config.publishLifecycle !== false
  };
}

function truncateTelegram(text) {
  const value = String(text || '').trim();
  if (value.length <= TELEGRAM_TEXT_LIMIT) return value;
  return `${value.slice(0, TELEGRAM_TEXT_LIMIT - 24)}\n\n[message truncated]`;
}

function roundtableLabel(doc) {
  const id = String(doc?._id || 'pending');
  return `#${id.slice(-8)}`;
}

function buildTelegramText(doc, event) {
  const label = roundtableLabel(doc);
  if (event.type === 'started') {
    return truncateTelegram([
      `🗣 Roundtable ${label} opened`,
      String(doc.question || ''),
      '',
      `Rounds: ${doc.rounds || 1} · Participants: ${(doc.panelConfig || []).map((a) => a.role || a.agentId).join(', ')}`,
      doc.governance?.requireApproval
        ? 'Outcome policy: advisory until explicitly approved.'
        : 'Outcome policy: advisory; no actions execute from this discussion.'
    ].join('\n'));
  }
  if (event.type === 'turn') {
    const turn = event.turn || {};
    return truncateTelegram([
      `🪑 ${turn.role || turn.agentId} · round ${turn.round} · ${turn.runtime || 'model'}`,
      turn.error ? `Error: ${turn.error}` : String(turn.response || 'No response')
    ].join('\n\n'));
  }
  if (event.type === 'interjections-applied') {
    const count = Number(event.count || 0);
    return `💬 ${count} chair interjection${count === 1 ? '' : 's'} entered the next deliberation phase.`;
  }
  if (event.type === 'synthesis') {
    const decision = doc.governance?.decisionStatus || 'advisory';
    const lines = [
      `⚖️ Roundtable ${label} synthesis`,
      String(doc.synthesis?.response || event.response || 'No synthesis returned.'),
      '',
      `Decision state: ${decision}`
    ];
    if (decision === 'awaiting_approval') {
      lines.push('Chair commands: /approve or /reject, optionally followed by a note.');
    }
    return truncateTelegram(lines.join('\n'));
  }
  if (event.type === 'decision') {
    const status = event.status || doc.governance?.decisionStatus || 'advisory';
    const actor = event.actor || doc.governance?.decidedBy || 'chair';
    const icon = status === 'rejected' ? '❌' : '✅';
    return truncateTelegram(`${icon} Roundtable ${label} decision: ${status}\nBy: ${actor}${event.note ? `\nNote: ${event.note}` : ''}`);
  }
  if (event.type === 'failed') {
    return truncateTelegram(`❌ Roundtable ${label} ${doc.status || 'failed'}\n${event.error || doc.error || 'Unknown error'}`);
  }
  throw new Error(`Unsupported Telegram roundtable event: ${event.type}`);
}

async function sendTelegramText(telegram, text, options = {}) {
  const config = normalizeTelegramConfig(telegram);
  const env = options.env || process.env;
  const token = env.ROUNDTABLE_TELEGRAM_BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error('ROUNDTABLE_TELEGRAM_BOT_TOKEN or TELEGRAM_BOT_TOKEN is not set');
  const payload = {
    chat_id: config.chatId,
    text: truncateTelegram(text),
    disable_web_page_preview: true
  };
  if (config.threadId) payload.message_thread_id = config.threadId;
  const fetchImpl = options.fetchImpl || fetch;
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    timeout: 10000
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(body.description || `Telegram returned ${response.status}`);
  }
  return body.result || body;
}

async function publishRoundtableEvent(doc, event, options = {}) {
  const telegram = normalizeTelegramConfig(doc?.telegram);
  if (!telegram) return { published: false, reason: 'not-configured' };
  if (event.type === 'turn' && !telegram.publishTurns) {
    return { published: false, reason: 'turn-publishing-disabled' };
  }
  if (event.type !== 'turn' && !telegram.publishLifecycle) {
    return { published: false, reason: 'lifecycle-publishing-disabled' };
  }
  try {
    const result = await sendTelegramText(telegram, buildTelegramText(doc, event), options);
    return { published: true, result };
  } catch (err) {
    logger.warn('Roundtable Telegram publish failed', {
      roundtableId: String(doc?._id || ''),
      event: event.type,
      error: err.message
    });
    return { published: false, reason: err.message };
  }
}

module.exports = {
  TELEGRAM_TEXT_LIMIT,
  buildTelegramText,
  normalizeTelegramConfig,
  publishRoundtableEvent,
  sendTelegramText,
  truncateTelegram
};
