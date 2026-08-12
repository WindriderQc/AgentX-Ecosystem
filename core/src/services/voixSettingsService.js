/**
 * Voice Settings — runtime-configurable defaults for the Voix client and the
 * browser chat voice surface.
 *
 * Resolution order: runtime override file > env > code default.
 * Overrides persist to ${configDir}/.voice-config.json.
 */

const path = require('path');
const fs = require('fs');
const logger = require('../../config/logger');

const CONFIG_DIR = path.resolve(__dirname, '..', '..', 'config');
const RUNTIME_FILE = path.join(CONFIG_DIR, '.voice-config.json');

const DEFAULTS = Object.freeze({
  voiceMode: 'browser',
  baseUrl: 'http://127.0.0.1:8091',
  timeoutMs: 10000,
  longTimeoutMs: 120000,
  features: {
    stt: {
      enabled: true,
      provider: 'browser',
      language: 'en',
      model: ''
    },
    tts: {
      enabled: false,
      provider: 'browser',
      voice: '',
      responseFormat: 'mp3'
    },
    convoMode: {
      enabled: false,
      provider: 'voix',
      autoSpeak: true,
      keepSession: true
    }
  }
});

const ENV_VARS = Object.freeze([
  { key: 'VOICE_MODE', path: 'voiceMode', defaultValue: DEFAULTS.voiceMode, description: 'AgentX voice mode preset: browser, hybrid, or native.' },
  { key: 'VOIX_BASE_URL', path: 'baseUrl', defaultValue: DEFAULTS.baseUrl, description: 'Voix service base URL used by the AgentX proxy.' },
  { key: 'VOIX_TIMEOUT_MS', path: 'timeoutMs', defaultValue: DEFAULTS.timeoutMs, description: 'Short Voix proxy timeout for health/config/device calls.' },
  { key: 'VOIX_LONG_TIMEOUT_MS', path: 'longTimeoutMs', defaultValue: DEFAULTS.longTimeoutMs, description: 'Long Voix proxy timeout for STT/TTS and smoke tests.' },
  { key: 'VOICE_STT_ENABLED', path: 'features.stt.enabled', defaultValue: DEFAULTS.features.stt.enabled, description: 'Default STT availability in chat.' },
  { key: 'VOICE_STT_PROVIDER', path: 'features.stt.provider', defaultValue: DEFAULTS.features.stt.provider, description: 'Default STT provider: browser or voix.' },
  { key: 'VOICE_STT_LANGUAGE', path: 'features.stt.language', defaultValue: DEFAULTS.features.stt.language, description: 'Default STT language code.' },
  { key: 'VOICE_STT_MODEL', path: 'features.stt.model', defaultValue: DEFAULTS.features.stt.model, description: 'Optional Whisper model override sent to Voix.' },
  { key: 'VOICE_TTS_ENABLED', path: 'features.tts.enabled', defaultValue: DEFAULTS.features.tts.enabled, description: 'Default response read-aloud state.' },
  { key: 'VOICE_TTS_PROVIDER', path: 'features.tts.provider', defaultValue: DEFAULTS.features.tts.provider, description: 'Default TTS provider: browser or voix.' },
  { key: 'VOICE_TTS_VOICE', path: 'features.tts.voice', defaultValue: DEFAULTS.features.tts.voice, description: 'Default TTS voice name. Empty means provider default.' },
  { key: 'VOICE_TTS_RESPONSE_FORMAT', path: 'features.tts.responseFormat', defaultValue: DEFAULTS.features.tts.responseFormat, description: 'Audio format requested from Voix TTS.' },
  { key: 'VOICE_CONVO_MODE_ENABLED', path: 'features.convoMode.enabled', defaultValue: DEFAULTS.features.convoMode.enabled, description: 'Default ConvoMode availability in chat.' },
  { key: 'VOICE_CONVO_MODE_AUTO_SPEAK', path: 'features.convoMode.autoSpeak', defaultValue: DEFAULTS.features.convoMode.autoSpeak, description: 'Speak ConvoMode replies by default.' },
  { key: 'VOICE_CONVO_MODE_KEEP_SESSION', path: 'features.convoMode.keepSession', defaultValue: DEFAULTS.features.convoMode.keepSession, description: 'Reuse the same Voix session while ConvoMode is active.' }
]);

const VOICE_MODES = Object.freeze([
  { id: 'browser', label: 'Browser', description: 'Browser STT and browser TTS; ConvoMode off.' },
  { id: 'hybrid', label: 'Hybrid', description: 'VoiX STT and VoiX TTS through Core proxy; ConvoMode off.' },
  { id: 'native', label: 'Native VoiX', description: 'VoiX STT, VoiX TTS, and VoiX ConvoMode enabled.' }
]);

function ensureConfigDir() {
  if (!fs.existsSync(CONFIG_DIR)) fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function readOverride() {
  try {
    if (fs.existsSync(RUNTIME_FILE)) {
      return JSON.parse(fs.readFileSync(RUNTIME_FILE, 'utf8'));
    }
  } catch (err) {
    logger.warn('Failed to read voice runtime config, using env/defaults', { error: err.message });
  }
  return {};
}

function normalizeUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim().replace(/\/+$/, '');
  if (!trimmed) return null;
  if (!/^https?:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function getAllowedBaseUrls() {
  const allowed = new Set([DEFAULTS.baseUrl]);
  const envBase = normalizeUrl(process.env.VOIX_BASE_URL);
  if (envBase) allowed.add(envBase);

  String(process.env.VOIX_ALLOWED_BASE_URLS || '')
    .split(',')
    .map(normalizeUrl)
    .filter(Boolean)
    .forEach((url) => allowed.add(url));

  return Array.from(allowed);
}

function validateBaseUrlOverride(url) {
  const normalized = normalizeUrl(url);
  if (!normalized) {
    return {
      valid: false,
      baseUrl: null,
      allowed: getAllowedBaseUrls(),
      message: 'baseUrl must be http:// or https:// URL'
    };
  }

  const allowed = getAllowedBaseUrls();
  if (!allowed.includes(normalized)) {
    return {
      valid: false,
      baseUrl: null,
      allowed,
      message: `baseUrl is not in the configured VoiX allowlist; set VOIX_BASE_URL or VOIX_ALLOWED_BASE_URLS to permit it (${allowed.join(', ')})`
    };
  }

  return { valid: true, baseUrl: normalized, allowed, message: null };
}

function positiveInt(v) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function booleanValue(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v === 1 ? true : v === 0 ? false : null;
  if (typeof v !== 'string') return null;
  const normalized = v.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
}

function optionalString(v) {
  if (v == null) return null;
  const trimmed = String(v).trim();
  return trimmed;
}

function providerValue(v, allowed) {
  const value = optionalString(v);
  if (!value) return null;
  return allowed.includes(value) ? value : null;
}

function responseFormatValue(v) {
  const value = optionalString(v);
  if (!value) return null;
  return ['mp3', 'wav', 'opus', 'flac'].includes(value) ? value : null;
}

function voiceModeValue(v) {
  const value = optionalString(v);
  if (!value) return null;
  return ['browser', 'hybrid', 'native'].includes(value) ? value : null;
}

function sourceLabel(runtimeValue, envValue) {
  if (runtimeValue !== null && runtimeValue !== undefined) return 'runtime';
  if (envValue !== null && envValue !== undefined) return 'env';
  return 'default';
}

function field(runtimeValue, envValue, defaultValue) {
  const runtimeDefined = runtimeValue !== null && runtimeValue !== undefined;
  const envDefined = envValue !== null && envValue !== undefined;
  return {
    value: runtimeDefined ? runtimeValue : (envDefined ? envValue : defaultValue),
    source: sourceLabel(runtimeDefined ? runtimeValue : null, envDefined ? envValue : null)
  };
}

function getNested(obj, pathExpression) {
  return pathExpression.split('.').reduce((value, key) => {
    if (!value || typeof value !== 'object') return undefined;
    return value[key];
  }, obj);
}

function setNested(obj, pathExpression, value) {
  const parts = pathExpression.split('.');
  let cursor = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') cursor[part] = {};
    cursor = cursor[part];
  }
  cursor[parts[parts.length - 1]] = value;
}

function deleteNested(obj, pathExpression) {
  const parts = pathExpression.split('.');
  let cursor = obj;
  for (const part of parts.slice(0, -1)) {
    if (!cursor[part] || typeof cursor[part] !== 'object') return;
    cursor = cursor[part];
  }
  delete cursor[parts[parts.length - 1]];
}

function pruneEmptyObjects(obj) {
  Object.keys(obj).forEach((key) => {
    if (obj[key] && typeof obj[key] === 'object' && !Array.isArray(obj[key])) {
      pruneEmptyObjects(obj[key]);
      if (!Object.keys(obj[key]).length) delete obj[key];
    }
  });
  return obj;
}

function parseByPath(pathExpression, value) {
  if (pathExpression === 'voiceMode') return voiceModeValue(value);
  if (pathExpression === 'baseUrl') return normalizeUrl(value);
  if (pathExpression === 'timeoutMs' || pathExpression === 'longTimeoutMs') return positiveInt(value);
  if (pathExpression.endsWith('.enabled') || pathExpression.endsWith('.autoSpeak') || pathExpression.endsWith('.keepSession')) {
    return booleanValue(value);
  }
  if (pathExpression === 'features.stt.provider') return providerValue(value, ['browser', 'voix']);
  if (pathExpression === 'features.tts.provider') return providerValue(value, ['browser', 'voix']);
  if (pathExpression === 'features.convoMode.provider') return providerValue(value, ['voix']);
  if (pathExpression === 'features.tts.responseFormat') return responseFormatValue(value);
  if (pathExpression.endsWith('.language') || pathExpression.endsWith('.model') || pathExpression.endsWith('.voice')) {
    return optionalString(value);
  }
  return value;
}

function parseEnv(pathExpression, envKey) {
  const raw = process.env[envKey];
  if (raw == null || raw === '') return null;
  return parseByPath(pathExpression, raw);
}

function invalidMessage(pathExpression) {
  if (pathExpression === 'voiceMode') return 'voiceMode must be browser, hybrid, or native';
  if (pathExpression === 'baseUrl') return 'baseUrl must be an http:// or https:// URL';
  if (pathExpression === 'timeoutMs' || pathExpression === 'longTimeoutMs') return `${pathExpression} must be a positive integer`;
  if (pathExpression.includes('provider')) return `${pathExpression} must be one of the supported providers`;
  if (pathExpression === 'features.tts.responseFormat') return 'features.tts.responseFormat must be mp3, wav, opus, or flac';
  if (pathExpression.endsWith('.enabled') || pathExpression.endsWith('.autoSpeak') || pathExpression.endsWith('.keepSession')) {
    return `${pathExpression} must be a boolean`;
  }
  return `${pathExpression} is invalid`;
}

function applyVoiceModePreset(target, mode) {
  if (mode === 'browser') {
    setNested(target, 'features.stt.enabled', true);
    setNested(target, 'features.stt.provider', 'browser');
    setNested(target, 'features.tts.enabled', true);
    setNested(target, 'features.tts.provider', 'browser');
    setNested(target, 'features.convoMode.enabled', false);
    setNested(target, 'features.convoMode.autoSpeak', false);
    setNested(target, 'features.convoMode.keepSession', true);
    return;
  }

  if (mode === 'hybrid') {
    setNested(target, 'features.stt.enabled', true);
    setNested(target, 'features.stt.provider', 'voix');
    setNested(target, 'features.tts.enabled', true);
    setNested(target, 'features.tts.provider', 'voix');
    setNested(target, 'features.convoMode.enabled', false);
    setNested(target, 'features.convoMode.autoSpeak', false);
    setNested(target, 'features.convoMode.keepSession', true);
    return;
  }

  if (mode === 'native') {
    setNested(target, 'features.stt.enabled', true);
    setNested(target, 'features.stt.provider', 'voix');
    setNested(target, 'features.tts.enabled', true);
    setNested(target, 'features.tts.provider', 'voix');
    setNested(target, 'features.convoMode.enabled', true);
    setNested(target, 'features.convoMode.autoSpeak', true);
    setNested(target, 'features.convoMode.keepSession', true);
  }
}

function buildFeatureSettings(override, sources) {
  const features = {
    stt: {},
    tts: {},
    convoMode: {}
  };

  const featureVars = ENV_VARS.filter((item) => item.path.startsWith('features.'));
  featureVars.forEach((item) => {
    const runtimeValue = parseByPath(item.path, getNested(override, item.path));
    const envValue = parseEnv(item.path, item.key);
    const defaultValue = getNested(DEFAULTS, item.path);
    const resolved = field(runtimeValue, envValue, defaultValue);
    setNested(features, item.path.replace(/^features\./, ''), resolved.value);
    sources[item.path] = resolved.source;
  });

  features.convoMode.provider = 'voix';
  sources['features.convoMode.provider'] = 'default';
  return features;
}

/**
 * Return effective voice config with source labels per field.
 */
function getSettings() {
  const override = readOverride();
  const runtimeVoiceMode = parseByPath('voiceMode', override.voiceMode);
  const envVoiceMode = parseEnv('voiceMode', 'VOICE_MODE');
  const envBase = normalizeUrl(process.env.VOIX_BASE_URL);
  const envTimeout = positiveInt(process.env.VOIX_TIMEOUT_MS);
  const envLongTimeout = positiveInt(process.env.VOIX_LONG_TIMEOUT_MS);

  const baseUrl = normalizeUrl(override.baseUrl) || envBase || DEFAULTS.baseUrl;
  const timeoutMs = positiveInt(override.timeoutMs) || envTimeout || DEFAULTS.timeoutMs;
  const longTimeoutMs = positiveInt(override.longTimeoutMs) || envLongTimeout || DEFAULTS.longTimeoutMs;
  const sources = {
    baseUrl: normalizeUrl(override.baseUrl) ? 'runtime' : (envBase ? 'env' : 'default'),
    timeoutMs: positiveInt(override.timeoutMs) ? 'runtime' : (envTimeout ? 'env' : 'default'),
    longTimeoutMs: positiveInt(override.longTimeoutMs) ? 'runtime' : (envLongTimeout ? 'env' : 'default')
  };
  const features = buildFeatureSettings(override, sources);
  const voiceMode = field(runtimeVoiceMode, envVoiceMode, DEFAULTS.voiceMode);
  sources.voiceMode = voiceMode.source;

  return {
    voiceMode: voiceMode.value,
    voiceModeSource: voiceMode.source,
    baseUrl,
    baseUrlSource: normalizeUrl(override.baseUrl) ? 'runtime' : (envBase ? 'env' : 'default'),
    timeoutMs,
    timeoutSource: positiveInt(override.timeoutMs) ? 'runtime' : (envTimeout ? 'env' : 'default'),
    longTimeoutMs,
    longTimeoutSource: positiveInt(override.longTimeoutMs) ? 'runtime' : (envLongTimeout ? 'env' : 'default'),
    features,
    sources,
    env: ENV_VARS,
    defaults: DEFAULTS,
    voiceModes: VOICE_MODES,
    allowedBaseUrls: getAllowedBaseUrls(),
    runtimeFile: RUNTIME_FILE
  };
}

/**
 * Persist runtime overrides. Only whitelisted keys are written.
 * Passing null for a field clears that specific override (falls back to env/default).
 */
function setSettings(partial) {
  ensureConfigDir();
  const existing = readOverride();
  const next = { ...existing };

  if (partial && 'voiceMode' in partial) {
    if (partial.voiceMode === null || partial.voiceMode === '') {
      delete next.voiceMode;
    } else {
      const mode = voiceModeValue(partial.voiceMode);
      if (!mode) throw Object.assign(new Error(invalidMessage('voiceMode')), { code: 'INVALID' });
      next.voiceMode = mode;
      applyVoiceModePreset(next, mode);
    }
  }

  if (partial && 'baseUrl' in partial) {
    if (partial.baseUrl === null || partial.baseUrl === '') {
      delete next.baseUrl;
    } else {
      const validation = validateBaseUrlOverride(partial.baseUrl);
      if (!validation.valid) throw Object.assign(new Error(validation.message), { code: 'INVALID' });
      next.baseUrl = validation.baseUrl;
    }
  }

  if (partial && 'timeoutMs' in partial) {
    if (partial.timeoutMs === null || partial.timeoutMs === '') {
      delete next.timeoutMs;
    } else {
      const n = positiveInt(partial.timeoutMs);
      if (!n) throw Object.assign(new Error('timeoutMs must be a positive integer'), { code: 'INVALID' });
      next.timeoutMs = n;
    }
  }

  if (partial && 'longTimeoutMs' in partial) {
    if (partial.longTimeoutMs === null || partial.longTimeoutMs === '') {
      delete next.longTimeoutMs;
    } else {
      const n = positiveInt(partial.longTimeoutMs);
      if (!n) throw Object.assign(new Error('longTimeoutMs must be a positive integer'), { code: 'INVALID' });
      next.longTimeoutMs = n;
    }
  }

  if (partial && partial.features && typeof partial.features === 'object') {
    ENV_VARS
      .filter((item) => item.path.startsWith('features.'))
      .forEach((item) => {
        const value = getNested(partial, item.path);
        if (value === undefined) return;
        if (value === null || value === '') {
          deleteNested(next, item.path);
          return;
        }
        const parsed = parseByPath(item.path, value);
        if (parsed === null) throw Object.assign(new Error(invalidMessage(item.path)), { code: 'INVALID' });
        setNested(next, item.path, parsed);
      });
  }

  pruneEmptyObjects(next);
  fs.writeFileSync(RUNTIME_FILE, JSON.stringify(next, null, 2));
  logger.info('Voice settings updated', { override: next });
  return getSettings();
}

module.exports = {
  getSettings,
  setSettings,
  DEFAULTS,
  VOICE_MODES,
  ENV_VARS,
  RUNTIME_FILE,
  getAllowedBaseUrls,
  validateBaseUrlOverride
};
