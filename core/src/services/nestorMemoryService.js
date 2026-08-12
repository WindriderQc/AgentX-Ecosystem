const crypto = require('crypto');
const { getRagServiceClient } = require('./ragServiceClient');

const DEFAULT_RAG_TIMEOUT_MS = Math.max(
  1000,
  Math.min(30000, Number(process.env.NESTOR_MEMORY_RAG_TIMEOUT_MS) || 5000)
);

class NestorMemoryError extends Error {
  constructor(message, { status = 400, code = 'NESTOR_MEMORY_ERROR' } = {}) {
    super(message);
    this.name = 'NestorMemoryError';
    this.status = status;
    this.code = code;
  }
}

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
  /\b(sk-[A-Za-z0-9_-]{20,})\b/,
  /\b(ghp_[A-Za-z0-9_]{20,})\b/,
  /\b(xox[baprs]-[A-Za-z0-9-]{20,})\b/,
  /\b(api[_-]?key|secret|token|password|passwd)\s*[:=]\s*['"]?[A-Za-z0-9_./+=-]{12,}/i,
];

function assertMemoryText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    throw new NestorMemoryError('text is required', { code: 'INVALID_MEMORY_INPUT' });
  }
  const trimmed = text.trim();
  if (trimmed.length > 4000) {
    throw new NestorMemoryError('text exceeds 4000 characters', { code: 'INVALID_MEMORY_INPUT' });
  }
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(trimmed)) {
      throw new NestorMemoryError('memory text looks secret-like; refusing to ingest', { code: 'SECRET_LIKE_MEMORY_REFUSED' });
    }
  }
  return trimmed;
}

function cleanTag(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function stableDocumentId({ type, agent, topic, text, id }) {
  if (typeof id === 'string' && id.trim()) {
    const safe = cleanTag(id);
    if (safe) return `nestor-memory:${safe}`;
  }
  const digest = crypto.createHash('sha256')
    .update([type, agent, topic, text.replace(/\s+/g, ' ').trim()].join('\n'))
    .digest('hex')
    .slice(0, 32);
  return `nestor-memory:${digest}`;
}

function buildMemoryDocument({ text, type, agent, topic, createdAt }) {
  return [
    `# Nestor Memory: ${topic || 'general'}`,
    '',
    `Type: ${type}`,
    `Agent: ${agent}`,
    `Created: ${createdAt}`,
    '',
    text,
    '',
  ].join('\n');
}

async function saveMemory(input, opts = {}) {
  const text = assertMemoryText(input?.text);
  const type = ['fact', 'summary'].includes(input?.type) ? input.type : 'fact';
  const agent = cleanTag(input?.agent || 'nestor') || 'nestor';
  const topic = cleanTag(input?.topic || 'general') || 'general';
  const createdAt = new Date().toISOString();
  const tags = Array.from(new Set([
    'nestor-memory',
    `type:${type}`,
    `agent:${agent}`,
    `topic:${topic}`,
    ...(Array.isArray(input?.tags) ? input.tags.map(cleanTag).filter(Boolean) : []),
  ]));
  const documentId = stableDocumentId({ type, agent, topic, text, id: input?.id });
  const documentText = buildMemoryDocument({ text, type, agent, topic, createdAt });
  const ragClient = opts.ragClient || getRagServiceClient();
  const result = await ragClient.upsertDocumentWithChunks(documentText, {
    source: 'nestor-memory',
    tags,
    documentId,
    chunkSize: 500,
    chunkOverlap: 50,
    timeoutMs: opts.timeoutMs || DEFAULT_RAG_TIMEOUT_MS,
  });
  return {
    saved: true,
    source: 'nestor-memory',
    documentId,
    type,
    agent,
    topic,
    tags,
    rag: result,
  };
}

module.exports = {
  NestorMemoryError,
  saveMemory,
  assertMemoryText,
  stableDocumentId,
  buildMemoryDocument,
  DEFAULT_RAG_TIMEOUT_MS,
  // Base secret patterns, exported so memory-review's contentGuard can extend
  // the SAME set instead of drifting its own copy (tools/agent-memory mirrors it too).
  SECRET_PATTERNS,
};
