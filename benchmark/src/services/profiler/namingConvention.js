'use strict';

const AX_PREFIX = 'ax/';

/**
 * Builds the Ollama-facing adapted model name.
 * Format: ax/<modelName>  (visible prefix, no hostId — each Ollama host is separate).
 *
 * @param {string} modelName - Base model name (e.g. gemma4:26b-a4b-it-q4_K_M)
 * @returns {string} Prefixed name (e.g. ax/gemma4:26b-a4b-it-q4_K_M)
 */
function buildAdaptedName(modelName) {
  if (!modelName) throw new Error('modelName is required');
  if (modelName.startsWith(AX_PREFIX)) return modelName; // already prefixed
  return `${AX_PREFIX}${modelName}`;
}

/**
 * Parses an adapted model name back to its base name.
 *
 * @param {string} adaptedName
 * @returns {{ baseName: string } | null}
 */
function parseAdaptedName(adaptedName) {
  if (!adaptedName || !adaptedName.startsWith(AX_PREFIX)) return null;
  return { baseName: adaptedName.slice(AX_PREFIX.length) };
}

function isAdaptedModel(name) {
  return typeof name === 'string' && name.startsWith(AX_PREFIX);
}

module.exports = { buildAdaptedName, parseAdaptedName, isAdaptedModel, AX_PREFIX };
