const crypto = require('crypto');
const fetch = require('node-fetch');
const VoicePersonaSession = require('../../models/VoicePersonaSession');
const {
  DEFAULT_PACK_ID,
  getPack,
  packSummary,
  resolveMode,
  resolvePrompt
} = require('./voicePersonaPacks');
const { assessTurn, buildEscalationReply } = require('./voicePersonaSafety');
const {
  buildVoicePersonaMessages,
  extractReplyText
} = require('./voicePersonaPrompt');
const { searchScopedMemory } = require('./voicePersonaMemoryService');
const { recordTurnAudit } = require('./voicePersonaAuditService');
const { guardKidxReaderReply } = require('./kidxReaderReplyGuard');
const {
  buildPromptContext: buildKidxLexiconContext,
  lookupReaderRequest,
  missReply: buildKidxLexiconMissReply
} = require('./kidxLexiconService');

const DEFAULT_INFERENCE_TIMEOUT_MS = Math.max(
  5000,
  Math.min(900000, Number(process.env.VOICE_PERSONA_INFERENCE_TIMEOUT_MS) || 600000)
);
const VALID_TURN_CHANNELS = new Set(['text', 'voice']);

class VoicePersonaRuntimeError extends Error {
  constructor(message, { status = 400, code = 'VOICE_PERSONA_RUNTIME_ERROR', cause } = {}) {
    super(message);
    this.name = 'VoicePersonaRuntimeError';
    this.status = status;
    this.code = code;
    this.cause = cause;
  }
}

function nowMs() {
  return Date.now();
}

function serializeSession(session) {
  if (!session) return null;
  const doc = typeof session.toObject === 'function' ? session.toObject() : session;
  return {
    id: String(doc._id || ''),
    sessionId: doc.sessionId,
    packId: doc.packId,
    modeId: doc.modeId,
    scopeId: doc.scopeId,
    label: doc.label || '',
    status: doc.status,
    turnCount: doc.turnCount || 0,
    lastTurnAt: doc.lastTurnAt || null,
    createdAt: doc.createdAt || null,
    updatedAt: doc.updatedAt || null
  };
}

function cleanScope(value, fallback) {
  const text = String(value || fallback || 'default')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return text || 'default';
}

function cleanMode(value, fallback) {
  const text = String(value || fallback || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return text || fallback || '';
}

function coreInferenceUrl() {
  const configured = process.env.CORE_INTERNAL_URL || process.env.CORE_PUBLIC_URL;
  if (configured) return configured.replace(/\/+$/, '') + '/api/inference/generate';
  const port = process.env.PORT || process.env.CORE_PORT || 3080;
  return `http://127.0.0.1:${port}/api/inference/generate`;
}

function headerValue(headers, name) {
  if (!headers || typeof headers.get !== 'function') return '';
  return headers.get(name) || headers.get(name.toLowerCase()) || '';
}

function buildInferencePayload({ pack, messages }) {
  const inference = pack.inference || {};
  const options = {};
  if (Number.isFinite(Number(inference.temperature))) options.temperature = Number(inference.temperature);
  if (Number.isFinite(Number(inference.topP))) options.top_p = Number(inference.topP);
  if (Number.isFinite(Number(inference.maxReplyTokens))) options.num_predict = Number(inference.maxReplyTokens);

  return {
    taskType: inference.taskType || 'voice_persona_chat',
    callerDetail: `${inference.callerDetail || 'chat-voice-personas'}/${pack.id}`,
    messages,
    stream: false,
    responseMode: 'normalized',
    thinkingMode: 'off',
    options
  };
}

function normalizeTurnChannel(channel) {
  const value = String(channel || 'text').trim().toLowerCase();
  if (VALID_TURN_CHANNELS.has(value)) return value;
  throw new VoicePersonaRuntimeError('channel must be one of: text, voice', {
    status: 400,
    code: 'VOICE_PERSONA_INVALID_CHANNEL'
  });
}

async function createSession(input = {}) {
  const pack = getPack(input.packId || DEFAULT_PACK_ID);
  const mode = resolveMode(pack, input.modeId || pack.defaultMode);
  const scopeId = cleanScope(input.scopeId, pack.defaultScopeId || 'default');
  const session = await VoicePersonaSession.create({
    sessionId: crypto.randomUUID(),
    packId: pack.id,
    modeId: mode.id,
    scopeId,
    label: typeof input.label === 'string' ? input.label.trim().slice(0, 120) : '',
    status: 'active',
    metadata: input.metadata && typeof input.metadata === 'object' ? input.metadata : {}
  });

  return {
    session: serializeSession(session),
    pack: packSummary(pack),
    mode: {
      id: mode.id,
      label: mode.label,
      description: mode.description || ''
    }
  };
}

async function loadSession(sessionId) {
  const session = await VoicePersonaSession.findOne({ sessionId: String(sessionId || '') });
  if (!session) {
    throw new VoicePersonaRuntimeError('Voice persona session not found', {
      status: 404,
      code: 'VOICE_PERSONA_SESSION_NOT_FOUND'
    });
  }
  if (session.status !== 'active') {
    throw new VoicePersonaRuntimeError('Voice persona session is closed', {
      status: 409,
      code: 'VOICE_PERSONA_SESSION_CLOSED'
    });
  }
  return session;
}

async function callCoreInference(payload, timeoutMs = DEFAULT_INFERENCE_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(coreInferenceUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (_err) {
      data = { response: text };
    }
    if (!response.ok) {
      throw new VoicePersonaRuntimeError(data?.message || data?.error || `Inference failed with HTTP ${response.status}`, {
        status: response.status >= 500 ? 502 : response.status,
        code: 'VOICE_PERSONA_INFERENCE_FAILED'
      });
    }
    return { data, response };
  } catch (err) {
    if (err instanceof VoicePersonaRuntimeError) throw err;
    const timedOut = err.name === 'AbortError';
    throw new VoicePersonaRuntimeError(timedOut ? 'Voice persona inference timed out' : err.message, {
      status: timedOut ? 504 : 502,
      code: timedOut ? 'VOICE_PERSONA_INFERENCE_TIMEOUT' : 'VOICE_PERSONA_INFERENCE_UNAVAILABLE',
      cause: err
    });
  } finally {
    clearTimeout(timer);
  }
}

function routingFromResponse(response, payload) {
  return {
    taskType: headerValue(response.headers, 'x-routing-task-type') || payload.taskType,
    source: headerValue(response.headers, 'x-routing-source'),
    lane: headerValue(response.headers, 'x-inference-lane')
  };
}

function modelFromResponse(response) {
  return {
    model: headerValue(response.headers, 'x-resolved-model'),
    host: headerValue(response.headers, 'x-routed-host'),
    hostKey: headerValue(response.headers, 'x-routed-host-key')
  };
}

function lexiconMetadata(lookup) {
  if (!lookup) return null;
  return {
    status: lookup.status,
    reason: lookup.reason || '',
    hit: lookup.hit,
    target: lookup.target,
    normalized: lookup.normalized,
    entryCount: lookup.entryCount,
    lookupMs: lookup.lookupMs,
    generatedAt: lookup.generatedAt || '',
    sourceAgeDays: lookup.sourceAgeDays,
    source: lookup.sources?.wiktionary?.name || ''
  };
}

async function runTextTurn({ sessionId, text, history, channel = 'text' } = {}) {
  const userText = typeof text === 'string' ? text.trim() : '';
  if (!userText) {
    throw new VoicePersonaRuntimeError('text is required', {
      status: 400,
      code: 'VOICE_PERSONA_TEXT_REQUIRED'
    });
  }
  const normalizedChannel = normalizeTurnChannel(channel);

  const traceId = crypto.randomUUID();
  const startedAt = nowMs();
  const session = await loadSession(sessionId);
  const pack = getPack(session.packId);
  const mode = resolveMode(pack, cleanMode(session.modeId, pack.defaultMode));
  const safety = assessTurn(userText, pack);
  let memoryMs = 0;
  let lexicon = null;
  let memory = { results: [], warning: '' };
  let promptInfo = null;
  let replyText = '';
  let model = {};
  let routing = {
    taskType: pack.inference?.taskType || 'voice_persona_chat',
    source: 'deterministic',
    lane: 'local'
  };
  let upstream = {};

  if (!safety.deterministicEscalation && pack.id === 'kidx_reader') {
    lexicon = lookupReaderRequest(userText);
  }

  if (safety.deterministicEscalation) {
    replyText = buildEscalationReply(pack, safety);
    upstream = { skipped: true, reason: 'deterministic_escalation' };
  } else if (lexicon?.status === 'ready' && lexicon.hit && lexicon.entry.kidDefinition) {
    replyText = `${lexicon.entry.word} : ${lexicon.entry.kidDefinition}`;
    upstream = {
      skipped: true,
      reason: 'lexicon_direct',
      lexicon: lexiconMetadata(lexicon)
    };
  } else if (lexicon?.status === 'ready' && !lexicon.hit) {
    replyText = buildKidxLexiconMissReply(lexicon.target);
    upstream = {
      skipped: true,
      reason: 'lexicon_miss',
      lexicon: lexiconMetadata(lexicon)
    };
  } else {
    const memoryConfig = pack.memory || {};
    if (memoryConfig.enabled !== false) {
      const memoryStartedAt = nowMs();
      memory = await searchScopedMemory({
        packId: pack.id,
        scopeId: session.scopeId,
        query: userText,
        topK: memoryConfig.topK || 4
      });
      memoryMs = nowMs() - memoryStartedAt;
    }
    promptInfo = await resolvePrompt(pack);
    const messages = await buildVoicePersonaMessages({
      pack,
      mode,
      prompt: promptInfo.prompt,
      promptSource: promptInfo.source,
      promptConfig: promptInfo.promptConfig,
      scopeId: session.scopeId,
      memoryResults: memory.results,
      safety,
      history,
      userText
    });
    const lexicalContext = buildKidxLexiconContext(lexicon);
    if (lexicalContext) messages[0].content += `\n\n${lexicalContext}`;
    const payload = buildInferencePayload({ pack, messages });
    const inferenceStartedAt = nowMs();
    const { data, response } = await callCoreInference(payload);
    replyText = extractReplyText(data) || 'I could not produce a useful reply.';
    model = modelFromResponse(response);
    routing = routingFromResponse(response, payload);
    upstream = {
      status: response.status,
      durationMs: nowMs() - inferenceStartedAt,
      promptSource: promptInfo.source,
      promptConfig: promptInfo.promptConfig,
      ...(lexicon ? { lexicon: lexiconMetadata(lexicon) } : {})
    };
    if (pack.id === 'kidx_reader') {
      const guarded = guardKidxReaderReply({ userText, replyText });
      replyText = guarded.replyText;
      if (guarded.guarded) {
        upstream.replyGuard = {
          applied: true,
          reason: guarded.reason,
          target: guarded.target
        };
      }
    }
  }

  const timings = {
    totalMs: nowMs() - startedAt,
    memoryMs,
    lexiconMs: lexicon?.lookupMs || 0,
    upstreamMs: upstream.durationMs || 0
  };
  const auditConfig = pack.audit || pack.memory || {};
  const auditOptions = {
    rawTranscriptRetention: auditConfig.rawTranscriptRetention || 'disabled',
    previewChars: auditConfig.previewChars
  };

  const audit = await recordTurnAudit({
    traceId,
    sessionId: session.sessionId,
    packId: pack.id,
    modeId: mode.id,
    scopeId: session.scopeId,
    channel: normalizedChannel,
    inputText: userText,
    replyText,
    safety,
    memory: {
      chunks: Array.isArray(memory.results) ? memory.results.length : 0,
      warning: memory.warning || ''
    },
    timings,
    model,
    routing,
    upstream,
    auditOptions
  });

  const updated = await VoicePersonaSession.findOneAndUpdate(
    { sessionId: session.sessionId },
    { $inc: { turnCount: 1 }, $set: { lastTurnAt: new Date() } },
    { new: true }
  );

  return {
    traceId,
    session: serializeSession(updated || session),
    pack: packSummary(pack),
    mode: {
      id: mode.id,
      label: mode.label,
      description: mode.description || ''
    },
    reply: {
      text: replyText
    },
    safety,
    memory: {
      chunks: Array.isArray(memory.results) ? memory.results.length : 0,
      warning: memory.warning || '',
      results: (memory.results || []).slice(0, 6)
    },
    timings,
    model,
    routing,
    upstream,
    audit: {
      id: String(audit._id),
      traceId: audit.traceId,
      createdAt: audit.createdAt
    }
  };
}

module.exports = {
  DEFAULT_INFERENCE_TIMEOUT_MS,
  VoicePersonaRuntimeError,
  createSession,
  runTextTurn,
  serializeSession,
  buildInferencePayload,
  coreInferenceUrl,
  normalizeTurnChannel
};
