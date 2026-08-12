const crypto = require('crypto');
const VoicePersonaAudit = require('../../models/VoicePersonaAudit');

function hashText(text) {
  return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}

function textRecord(text, options = {}) {
  const normalized = String(text || '').replace(/\s+/g, ' ').trim();
  const rawEnabled = options.rawTranscriptRetention === 'enabled';
  const previewChars = Number.isFinite(Number(options.previewChars))
    ? Number(options.previewChars)
    : 160;

  const record = {
    length: normalized.length,
    sha256: hashText(normalized)
  };

  if (rawEnabled) {
    record.text = normalized;
  } else if (previewChars > 0) {
    record.preview = normalized.slice(0, previewChars);
  }

  return record;
}

async function recordTurnAudit(input) {
  const audit = await VoicePersonaAudit.create({
    traceId: input.traceId,
    sessionId: input.sessionId,
    packId: input.packId,
    modeId: input.modeId,
    scopeId: input.scopeId || 'default',
    channel: input.channel || 'text',
    input: textRecord(input.inputText, input.auditOptions),
    reply: textRecord(input.replyText, input.auditOptions),
    safety: {
      mode: input.safety?.mode || '',
      flags: input.safety?.flagIds || [],
      requiresAttention: Boolean(input.safety?.requiresAttention || input.safety?.requiresParentAttention),
      deterministicEscalation: Boolean(input.safety?.deterministicEscalation)
    },
    memory: {
      chunks: Number(input.memory?.chunks) || 0,
      warning: input.memory?.warning || ''
    },
    timings: input.timings || {},
    model: input.model || {},
    routing: input.routing || {},
    upstream: input.upstream || {}
  });
  return audit;
}

function buildAuditQuery(filters = {}) {
  const query = {};
  if (filters.packId) query.packId = String(filters.packId);
  if (filters.scopeId) query.scopeId = String(filters.scopeId);
  if (filters.sessionId) query.sessionId = String(filters.sessionId);
  return query;
}

async function getRecentAudit(filters = {}) {
  const limit = Math.max(1, Math.min(Number(filters.limit) || 20, 100));
  return VoicePersonaAudit.find(buildAuditQuery(filters))
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

module.exports = {
  hashText,
  textRecord,
  recordTurnAudit,
  getRecentAudit,
  buildAuditQuery
};
