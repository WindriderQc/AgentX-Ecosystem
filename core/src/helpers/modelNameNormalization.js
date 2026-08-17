'use strict';

const { normalizeModelTag } = require('../../../shared/modelNames');

/**
 * Canonical model-name normalization.
 *
 * The ecosystem stores registry / profile / pinned records under bare names
 * ("gemma4:26b"), but Ollama serves custom-built models under an "ax/" prefix
 * ("ax/gemma4:26b") — same underlying weights, just wrapped in a Modelfile.
 * Every layer that joins across these two worlds (catalog dedup, routing,
 * pinned-vs-loaded comparisons) must compare under a normalized form.
 *
 * Rule of thumb: **normalize for COMPARISON, not for STORAGE.** Never rewrite
 * the raw Ollama name on the server side — callers that need to know what is
 * actually deployed rely on the raw string being preserved elsewhere (e.g.
 * `deployment.resolvedName`).
 */

const WRAPPER_PREFIXES = ['ax/', 'library/', 'hf.co/'];

function normalizeModelName(name) {
  const trimmed = normalizeModelTag(name);
  if (!trimmed) return '';
  // Strip only known transport/wrapper prefixes. Owner namespaces such as
  // "igorls/gemma-4..." are part of the model identity and must be preserved.
  const lower = trimmed.toLowerCase();
  for (const prefix of WRAPPER_PREFIXES) {
    if (lower.startsWith(prefix) && trimmed.length > prefix.length) {
      return trimmed.slice(prefix.length);
    }
  }
  return trimmed;
}

function modelNameIdentityKey(name) {
  return normalizeModelName(name).toLowerCase();
}

function modelsMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const na = normalizeModelName(a);
  const nb = normalizeModelName(b);
  if (!na || !nb) return false;
  const ka = modelNameIdentityKey(na);
  const kb = modelNameIdentityKey(nb);
  if (ka === kb) return true;
  // Tag-prefix tolerance: a bare "gemma4" pin matches "gemma4:26b" and vice
  // versa. Does NOT collapse different tag variants (gemma4:e4b !=
  // gemma4:e4b-it-q8_0) — that is out of scope for now and would need
  // intentional canonicalTagSet() logic rather than a prefix heuristic.
  if (ka.startsWith(kb + ':') || kb.startsWith(ka + ':')) return true;
  return false;
}

function modelLookupNames(name) {
  const raw = String(name || '').trim().replace(/:latest$/i, '');
  if (!raw) return [];
  return Array.from(new Set([raw, normalizeModelName(raw)].filter(Boolean)));
}

module.exports = {
  normalizeModelName,
  modelNameIdentityKey,
  modelsMatch,
  modelLookupNames
};
