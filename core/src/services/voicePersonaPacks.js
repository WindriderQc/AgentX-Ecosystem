const fs = require('fs');
const path = require('path');
const PromptConfig = require('../../models/PromptConfig');

const PACK_DIR = path.join(__dirname, '..', '..', 'personas', 'voice-packs');
const DEFAULT_PACK_ID = 'personal_operator';

let packCache = null;

class VoicePersonaPackError extends Error {
  constructor(message, { status = 400, code = 'VOICE_PERSONA_PACK_ERROR' } = {}) {
    super(message);
    this.name = 'VoicePersonaPackError';
    this.status = status;
    this.code = code;
  }
}

function assertPackShape(pack, file) {
  if (!pack || typeof pack !== 'object') {
    throw new VoicePersonaPackError(`Invalid voice persona pack in ${file}`, { status: 500 });
  }
  if (!pack.id || !pack.name || !pack.systemPrompt) {
    throw new VoicePersonaPackError(`Voice persona pack is missing id, name, or systemPrompt: ${file}`, { status: 500 });
  }
  if (!Array.isArray(pack.modes) || pack.modes.length === 0) {
    throw new VoicePersonaPackError(`Voice persona pack has no modes: ${file}`, { status: 500 });
  }
}

function readPackFiles() {
  const files = fs.readdirSync(PACK_DIR)
    .filter((name) => name.endsWith('.json'))
    .sort((left, right) => left.localeCompare(right));

  const packs = files.map((fileName) => {
    const file = path.join(PACK_DIR, fileName);
    const pack = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertPackShape(pack, file);
    return {
      ...pack,
      modes: pack.modes.map((mode) => ({
        ...mode,
        id: String(mode.id || '').trim(),
        label: String(mode.label || mode.id || '').trim()
      }))
    };
  });

  const byId = new Map();
  for (const pack of packs) {
    if (byId.has(pack.id)) {
      throw new VoicePersonaPackError(`Duplicate voice persona pack id: ${pack.id}`, { status: 500 });
    }
    byId.set(pack.id, pack);
  }
  return byId;
}

function loadPacks({ force = false } = {}) {
  if (!packCache || force) {
    packCache = readPackFiles();
  }
  return packCache;
}

function packSummary(pack) {
  return {
    id: pack.id,
    name: pack.name,
    description: pack.description || '',
    defaultMode: pack.defaultMode || pack.modes[0].id,
    defaultScopeId: pack.defaultScopeId || 'default',
    promptConfigName: pack.promptConfigName || '',
    language: pack.language || {},
    voice: pack.voice || {},
    safety: {
      enabled: pack.safety?.enabled !== false,
      mode: pack.safety?.mode || 'standard',
      parentAlertFlags: pack.safety?.parentAlertFlags || [],
      deterministicEscalationFlags: pack.safety?.deterministicEscalationFlags || []
    },
    modes: pack.modes.map((mode) => ({
      id: mode.id,
      label: mode.label,
      description: mode.description || ''
    }))
  };
}

function listPacks() {
  return Array.from(loadPacks().values()).map(packSummary);
}

function getPack(packId = DEFAULT_PACK_ID) {
  const id = String(packId || DEFAULT_PACK_ID).trim();
  const pack = loadPacks().get(id);
  if (!pack) {
    throw new VoicePersonaPackError(`Unknown voice persona pack: ${id}`, {
      status: 404,
      code: 'VOICE_PERSONA_PACK_NOT_FOUND'
    });
  }
  return pack;
}

function resolveMode(pack, modeId) {
  const wanted = String(modeId || pack.defaultMode || '').trim();
  return pack.modes.find((mode) => mode.id === wanted) || pack.modes[0];
}

async function resolvePrompt(pack) {
  const promptName = pack.promptConfigName || '';
  if (!promptName) {
    return {
      source: 'manifest',
      prompt: pack.systemPrompt,
      promptConfig: null
    };
  }

  try {
    const promptConfig = await PromptConfig.getActive(promptName);
    if (promptConfig?.systemPrompt) {
      return {
        source: 'prompt_config',
        prompt: promptConfig.systemPrompt,
        promptConfig: {
          id: promptConfig._id,
          name: promptConfig.name,
          version: promptConfig.version
        }
      };
    }
  } catch (_err) {
    // File-backed packs remain usable before Mongo is connected.
  }

  return {
    source: 'manifest',
    prompt: pack.systemPrompt,
    promptConfig: null
  };
}

function _resetPackCacheForTests() {
  packCache = null;
}

module.exports = {
  DEFAULT_PACK_ID,
  VoicePersonaPackError,
  loadPacks,
  listPacks,
  getPack,
  packSummary,
  resolveMode,
  resolvePrompt,
  _resetPackCacheForTests
};
