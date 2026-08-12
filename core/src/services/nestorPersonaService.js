'use strict';

const fs = require('fs').promises;
const logger = require('../../config/logger');
const { resolveAgentxNestorRole } = require('./nestorConsumerPersonalityService');

const IDENTITY_START = '<!-- agentx:nestor-identity:start -->';
const IDENTITY_END = '<!-- agentx:nestor-identity:end -->';
const FALLBACK_IDENTITY = [
  "You are Nestor, Example User's unflappable majordomo and personal assistant:",
  'polite, warm, concise, and a little dry. Lead with the useful answer.',
  "Reply in the user's language. Charm never replaces accuracy. Separate",
  'verified facts, inference, and unknowns.'
].join(' ');

let cachedPath = null;
let cachedKernel = null;

function stripMarkdownEmphasis(value) {
  return String(value || '').replace(/\*\*/g, '');
}

function extractIdentityKernel(source) {
  const text = String(source || '');
  const start = text.indexOf(IDENTITY_START);
  const end = text.indexOf(IDENTITY_END);
  if (start === -1 || end === -1 || end <= start) return '';
  return stripMarkdownEmphasis(text.slice(start + IDENTITY_START.length, end)).trim();
}

async function loadNestorIdentityKernel(options = {}) {
  const rolePath = options.rolePath || resolveAgentxNestorRole(options.env || process.env);
  if (!options.readFile && cachedPath === rolePath && cachedKernel) return cachedKernel;

  const readFile = options.readFile || fs.readFile;
  try {
    const source = await readFile(rolePath, 'utf8');
    const kernel = extractIdentityKernel(source);
    if (!kernel) throw new Error('canonical identity markers are missing or malformed');
    if (!options.readFile) {
      cachedPath = rolePath;
      cachedKernel = kernel;
    }
    return kernel;
  } catch (error) {
    logger.warn('Nestor identity kernel unavailable; using the built-in safe fallback', {
      rolePath,
      error: error.message
    });
    return FALLBACK_IDENTITY;
  }
}

function composeNestorPrompt(identity, laneInstructions) {
  return [identity, laneInstructions].filter(Boolean).join('\n\n');
}

function clearNestorIdentityCache() {
  cachedPath = null;
  cachedKernel = null;
}

module.exports = {
  IDENTITY_START,
  IDENTITY_END,
  FALLBACK_IDENTITY,
  extractIdentityKernel,
  loadNestorIdentityKernel,
  composeNestorPrompt,
  clearNestorIdentityCache
};
