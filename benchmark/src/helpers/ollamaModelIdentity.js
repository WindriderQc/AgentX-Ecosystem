'use strict';

function normalizeOllamaModelName(name) {
  return String(name || '').trim().replace(/:latest$/i, '').toLowerCase();
}

function isSameOllamaModel(a, b) {
  const normalizedA = normalizeOllamaModelName(a);
  const normalizedB = normalizeOllamaModelName(b);
  if (!normalizedA || !normalizedB) return false;
  return normalizedA === normalizedB;
}

module.exports = {
  normalizeOllamaModelName,
  isSameOllamaModel
};
