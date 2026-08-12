'use strict';
/**
 * Proxy RAG reflex (task 0271) — server-side retrieve-before-answer for the
 * AgentX front-door proxies (openclaw-ollama, hermes-openai).
 *
 * The Fastlane / Nestor design (docs/ai-ops/fastlane-nestor-design.md) makes
 * retrieval a *reflex*: every chat turn through a proxy retrieves the top-K
 * relevant chunks and injects them as a `## Relevant knowledge` system block,
 * with NO dependence on the model deciding to call a tool. This is the
 * Answer·Light disposition's spine — it routes around the broken local
 * tool-calling primitive by never asking the model to *choose* to retrieve.
 *
 * Reuses the existing chat retrieval (`buildRagContext`, built by roadmap 0015)
 * rather than reinventing retrieval.
 *
 * Contract:
 *   - Flag-gated by env PROXY_RAG_REFLEX (default OFF). Off => no-op; the caller
 *     forwards the ORIGINAL body reference, byte-for-byte.
 *   - Graceful-degrade: any retrieval failure/timeout/empty result returns the
 *     ORIGINAL body unchanged. RAG being down never blocks the call.
 *   - Only augments chat-style requests (an array `messages` with a user turn).
 *     Raw-prompt / embeddings bodies are passed through untouched.
 *   - No model tool-call — pure server-side injection.
 */
const logger = require('../../config/logger');
const { buildRagContext } = require('./chat/ragContextBuilder');
const { getRagServiceClient } = require('./ragServiceClient');

const RAG_BLOCK_HEADING = '## Relevant knowledge';

function reflexEnabled() {
  return String(process.env.PROXY_RAG_REFLEX || '').trim().toLowerCase() === 'true';
}

function reflexTopK() {
  const n = parseInt(process.env.PROXY_RAG_REFLEX_TOPK, 10);
  return Number.isFinite(n) && n > 0 ? n : 4;
}

function reflexTimeoutMs() {
  const n = parseInt(process.env.PROXY_RAG_REFLEX_TIMEOUT_MS, 10);
  return Number.isFinite(n) && n > 0 ? n : 4000;
}

// Pull plain text out of a message `content` that may be a string or an
// OpenAI-style array of content parts ({ type, text }). Anything else => ''.
function messageText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

// The query for retrieval = the latest user turn. Searching the most recent
// user message mirrors the chat prelude's behaviour (it retrieves on `message`).
function latestUserQuery(messages) {
  if (!Array.isArray(messages)) return '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') {
      return messageText(m.content).trim();
    }
  }
  return '';
}

function formatRagBlock(ragContext) {
  return `${RAG_BLOCK_HEADING}\n\n${ragContext}\n\n`
    + 'Use the retrieved knowledge above only when it is relevant to the request; '
    + 'otherwise ignore it. Cite a source by its [n] tag when you rely on it.';
}

// Insert the RAG block as its own system message, immediately after the leading
// run of system messages — so the persona's primary system prompt stays first
// (highest priority) and the retrieved knowledge sits with the other context.
// Returns a NEW array; the caller's original `messages` is never mutated.
function injectSystemBlock(messages, blockContent) {
  const next = messages.slice();
  let idx = 0;
  while (idx < next.length && next[idx] && next[idx].role === 'system') idx++;
  next.splice(idx, 0, { role: 'system', content: blockContent });
  return next;
}

// Race a promise against a timeout that resolves to `fallbackValue`. The losing
// promise is abandoned (buildRagContext catches its own errors), so a slow RAG
// never blocks the forward.
async function withTimeout(promise, ms, fallbackValue) {
  let timer;
  const timeout = new Promise(resolve => {
    timer = setTimeout(() => resolve(fallbackValue), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Apply the RAG reflex to a proxy request body. On ANY condition that is not a
 * clean augmentation (flag off, non-chat body, no user query, RAG empty / down /
 * slow), returns the ORIGINAL body reference unchanged so the proxy forwards it
 * byte-for-byte.
 *
 * @param {Object} body - parsed request body (Ollama-native or OpenAI shape)
 * @param {Object} [opts]
 * @param {Object} [opts.ragStore] - injectable store for tests; defaults to the RAG service client
 * @param {string} [opts.caller] - telemetry label for logs
 * @returns {Promise<{ body: Object, ragInjected: boolean, ragSources: Array }>}
 */
async function applyRagReflex(body, opts = {}) {
  const unchanged = { body, ragInjected: false, ragSources: [] };
  if (!reflexEnabled()) return unchanged;
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) return unchanged;

  const query = latestUserQuery(body.messages);
  if (!query) return unchanged;

  try {
    const store = opts.ragStore || getRagServiceClient();
    const ragResult = await withTimeout(
      buildRagContext(query, store, { ragTopK: reflexTopK() }),
      reflexTimeoutMs(),
      { ragUsed: false, ragSources: [], ragContext: null }
    );

    if (!ragResult || !ragResult.ragUsed || !ragResult.ragContext) return unchanged;

    const messages = injectSystemBlock(body.messages, formatRagBlock(ragResult.ragContext));
    logger.info('[proxy-rag-reflex] injected knowledge block', {
      caller: opts.caller || null,
      sources: Array.isArray(ragResult.ragSources) ? ragResult.ragSources.length : 0
    });
    return {
      body: { ...body, messages },
      ragInjected: true,
      ragSources: ragResult.ragSources || []
    };
  } catch (err) {
    logger.warn('[proxy-rag-reflex] retrieval failed; forwarding unaugmented', {
      caller: opts.caller || null,
      error: err.message
    });
    return unchanged;
  }
}

module.exports = {
  applyRagReflex,
  reflexEnabled,
  // exported for unit tests / reuse
  latestUserQuery,
  messageText,
  formatRagBlock,
  injectSystemBlock,
  RAG_BLOCK_HEADING
};
