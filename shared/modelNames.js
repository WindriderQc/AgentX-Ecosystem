'use strict';

/** Normalize an Ollama tag for storage/lookups without changing namespaces. */
function normalizeModelTag(value) {
  return String(value || '').trim().replace(/:latest$/i, '');
}

module.exports = { normalizeModelTag };
