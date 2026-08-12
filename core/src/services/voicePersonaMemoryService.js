const crypto = require('crypto');
const { getRagServiceClient } = require('./ragServiceClient');
const { assertMemoryText, NestorMemoryError } = require('./nestorMemoryService');
const { getPack } = require('./voicePersonaPacks');

const DEFAULT_RAG_TIMEOUT_MS = Math.max(
  1000,
  Math.min(30000, Number(process.env.VOICE_PERSONA_MEMORY_RAG_TIMEOUT_MS) || 5000)
);

const SOURCE = 'voice-persona-memory';

class VoicePersonaMemoryError extends Error {
  constructor(message, { status = 400, code = 'VOICE_PERSONA_MEMORY_ERROR' } = {}) {
    super(message);
    this.name = 'VoicePersonaMemoryError';
    this.status = status;
    this.code = code;
  }
}

function cleanTag(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function requireTag(value, label) {
  const cleaned = cleanTag(value);
  if (!cleaned) {
    throw new VoicePersonaMemoryError(`${label} is required`, {
      status: 400,
      code: 'INVALID_MEMORY_SCOPE'
    });
  }
  return cleaned;
}

function validatePackMode(packId, modeId) {
  const pack = getPack(packId);
  if (!modeId) return { pack, mode: null };
  const mode = pack.modes.find((entry) => entry.id === modeId);
  if (!mode) {
    throw new VoicePersonaMemoryError(`Unknown modeId for ${packId}: ${modeId}`, {
      status: 400,
      code: 'INVALID_MEMORY_SCOPE'
    });
  }
  return { pack, mode };
}

function stableDocumentId({ type, packId, scopeId, topic, text, id }) {
  if (typeof id === 'string' && id.trim()) {
    const safe = cleanTag(id);
    if (safe) return `${SOURCE}:${safe}`;
  }
  const digest = crypto.createHash('sha256')
    .update([type, packId, scopeId, topic, text.replace(/\s+/g, ' ').trim()].join('\n'))
    .digest('hex')
    .slice(0, 32);
  return `${SOURCE}:${digest}`;
}

function buildMemoryDocument({ text, type, packId, scopeId, modeId, topic, createdAt }) {
  return [
    `# Voice Persona Memory: ${topic || 'general'}`,
    '',
    `Type: ${type}`,
    `Persona: ${packId}`,
    `Scope: ${scopeId}`,
    modeId ? `Mode: ${modeId}` : null,
    `Created: ${createdAt}`,
    '',
    text,
    ''
  ].filter(Boolean).join('\n');
}

function normalizeMemoryInput(input = {}) {
  let text;
  try {
    text = assertMemoryText(input.text || input.summary);
  } catch (err) {
    if (err instanceof NestorMemoryError) {
      throw new VoicePersonaMemoryError(err.message, { status: err.status, code: err.code });
    }
    throw err;
  }

  const type = input.type === 'summary' ? 'summary' : 'fact';
  const packId = requireTag(input.packId || input.personaId, 'packId');
  const scopeId = requireTag(input.scopeId || 'default', 'scopeId');
  const modeId = cleanTag(input.modeId || '');
  validatePackMode(packId, modeId);
  const topic = cleanTag(input.topic || 'general') || 'general';
  const extraTags = Array.isArray(input.tags) ? input.tags.map(cleanTag).filter(Boolean) : [];

  return {
    text,
    type,
    packId,
    scopeId,
    modeId,
    topic,
    id: input.id,
    tags: Array.from(new Set([
      SOURCE,
      `persona:${packId}`,
      `scope:${scopeId}`,
      `type:${type}`,
      `topic:${topic}`,
      ...(modeId ? [`mode:${modeId}`] : []),
      ...extraTags
    ]))
  };
}

async function saveScopedMemory(input, opts = {}) {
  const normalized = normalizeMemoryInput(input);
  const createdAt = new Date().toISOString();
  const documentId = stableDocumentId({ ...normalized, id: input?.id });
  const documentText = buildMemoryDocument({ ...normalized, createdAt });
  const ragClient = opts.ragClient || getRagServiceClient();
  const rag = await ragClient.upsertDocumentWithChunks(documentText, {
    source: SOURCE,
    tags: normalized.tags,
    documentId,
    chunkSize: 500,
    chunkOverlap: 50,
    timeoutMs: opts.timeoutMs || DEFAULT_RAG_TIMEOUT_MS
  });

  return {
    saved: true,
    source: SOURCE,
    documentId,
    type: normalized.type,
    packId: normalized.packId,
    scopeId: normalized.scopeId,
    modeId: normalized.modeId || null,
    topic: normalized.topic,
    tags: normalized.tags,
    rag
  };
}

async function searchScopedMemory({ packId, scopeId, query, topK = 4, ragClient } = {}) {
  const persona = cleanTag(packId);
  const scope = cleanTag(scopeId || 'default');
  if (!persona || !scope) return { results: [], warning: 'missing memory scope' };
  validatePackMode(persona, '');
  const q = typeof query === 'string' ? query.trim() : '';
  if (!q) return { results: [], warning: '' };

  try {
    const client = ragClient || getRagServiceClient();
    const results = await client.searchSimilarChunks(q, {
      topK: Math.max(1, Math.min(Number(topK) || 4, 10)),
      filters: {
        tags: [SOURCE, `persona:${persona}`, `scope:${scope}`]
      }
    });
    return { results, warning: '' };
  } catch (err) {
    return { results: [], warning: err.message };
  }
}

module.exports = {
  SOURCE,
  DEFAULT_RAG_TIMEOUT_MS,
  VoicePersonaMemoryError,
  cleanTag,
  validatePackMode,
  normalizeMemoryInput,
  saveScopedMemory,
  searchScopedMemory,
  stableDocumentId,
  buildMemoryDocument
};
