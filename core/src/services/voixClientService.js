const fetch = require('node-fetch');
const logger = require('../../config/logger');
const { normalizeHostUrl } = require('../helpers/ollamaHostConfig');
const {
  CrossServiceClientError,
  requestJson: coreRequestJson,
  buildUrl,
  parseResponseBody,
  extractErrorMessage
} = require('../helpers/crossServiceClient');
const voixSettings = require('./voixSettingsService');

const DEFAULT_VOIX_BASE_URL = voixSettings.DEFAULTS.baseUrl;
const DEFAULT_VOIX_TIMEOUT_MS = voixSettings.DEFAULTS.timeoutMs;
const DEFAULT_VOIX_LONG_TIMEOUT_MS = voixSettings.DEFAULTS.longTimeoutMs;

class VoixClientError extends CrossServiceClientError {
  constructor(message, { status = 500, code = 'VOIX_REQUEST_FAILED', body = null, cause = null } = {}) {
    super(message, { service: 'voix', status, code, body, cause });
    this.name = 'VoixClientError';
  }
}

function getVoixBaseUrl() {
  return normalizeHostUrl(voixSettings.getSettings().baseUrl) || DEFAULT_VOIX_BASE_URL;
}

function getVoixTimeoutMs() {
  return voixSettings.getSettings().timeoutMs;
}

function getVoixLongTimeoutMs() {
  return voixSettings.getSettings().longTimeoutMs;
}

function getClientConfig() {
  return {
    baseUrl: getVoixBaseUrl(),
    timeoutMs: getVoixTimeoutMs(),
    longTimeoutMs: getVoixLongTimeoutMs()
  };
}

function buildVoixUrl(pathname, query) {
  return buildUrl(getVoixBaseUrl(), pathname, query);
}

async function callVoix(method, pathname, { query, body, timeoutMs } = {}) {
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : getVoixTimeoutMs();

  try {
    return await coreRequestJson({
      baseUrl: getVoixBaseUrl(),
      path: pathname,
      method,
      query,
      body,
      timeoutMs: effectiveTimeoutMs,
      serviceName: 'VoiX service',
      errorCode: 'VOIX',
      ErrorClass: VoixClientError
    });
  } catch (error) {
    // coreRequestJson emits VoixClientError with code 'VOIX_TIMEOUT' /
    // 'VOIX_UNAVAILABLE' already (via the subclass). Log non-response errors
    // for parity with the previous implementation, and re-throw the structured
    // error untouched.
    if (error instanceof VoixClientError) {
      if (error.code === 'VOIX_TIMEOUT' || error.code === 'VOIX_UNAVAILABLE') {
        logger.warn('VoiX request failed', {
          method,
          pathname,
          url: buildVoixUrl(pathname, query),
          code: error.code,
          message: error.message
        });
      }
      throw error;
    }
    throw error;
  }
}

function health(options = {}) {
  return callVoix('GET', '/health', options);
}

function config(options = {}) {
  return callVoix('GET', '/config', options);
}

function updateConfig(payload = {}) {
  return callVoix('POST', '/config', { body: payload });
}

function devices(options = {}) {
  return callVoix('GET', '/devices', options);
}

function metrics(options = {}) {
  return callVoix('GET', '/metrics', options);
}

function voiceProfile(options = {}) {
  return callVoix('GET', '/voice-profile', options);
}

function sessionStatus(options = {}) {
  return callVoix('GET', '/sessions/status', options);
}

function startSession(payload = {}) {
  return callVoix('POST', '/sessions/start', { body: payload });
}

function stopSession(payload = {}) {
  return callVoix('POST', '/sessions/stop', { body: payload });
}

function cancelSession(payload = {}) {
  return callVoix('POST', '/sessions/cancel', { body: payload });
}

function listSessions(query = {}) {
  return callVoix('GET', '/sessions', { query });
}

function createSession(payload = {}) {
  return startSession(payload);
}

function getSession(sessionId) {
  if (!sessionId) {
    throw new VoixClientError('sessionId is required', {
      status: 400,
      code: 'VOIX_INVALID_REQUEST'
    });
  }

  return callVoix('GET', `/sessions/${encodeURIComponent(sessionId)}`);
}

function getSessionEvents(sessionId, query = {}) {
  if (!sessionId) {
    throw new VoixClientError('sessionId is required', {
      status: 400,
      code: 'VOIX_INVALID_REQUEST'
    });
  }

  return callVoix('GET', `/sessions/${encodeURIComponent(sessionId)}/events`, { query });
}

function diagnosticsSmoke(payload = {}) {
  return callVoix('POST', '/diagnostics/smoke', {
    body: payload,
    timeoutMs: getVoixLongTimeoutMs()
  });
}

function diagnosticsTtsSmoke(payload = {}) {
  return callVoix('POST', '/diagnostics/tts-smoke', {
    body: payload,
    timeoutMs: getVoixLongTimeoutMs()
  });
}

function textTurn(payload = {}) {
  return callVoix('POST', '/sessions/text-turn', {
    body: payload,
    timeoutMs: getVoixLongTimeoutMs()
  });
}

// transcribe/synthesize use non-JSON bodies and/or return raw Response objects, so
// they fall outside the shared JSON primitive. They still use the shared
// error class + URL builder to keep behaviour identical to callers.
async function transcribe(formData, { timeoutMs } = {}) {
  const effectiveTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : getVoixLongTimeoutMs();
  const url = buildVoixUrl('/v1/audio/transcriptions');

  try {
    const response = await fetch(url, {
      method: 'POST',
      body: formData,
      timeout: effectiveTimeoutMs
    });
    const parsed = await parseResponseBody(response);

    if (!response.ok) {
      throw new VoixClientError(
        extractErrorMessage(parsed, `VoiX transcription failed (${response.status})`),
        { status: response.status, code: 'VOIX_BAD_RESPONSE', body: parsed }
      );
    }

    return parsed;
  } catch (error) {
    if (error instanceof VoixClientError) throw error;
    if (error && error.name === 'AbortError') {
      throw new VoixClientError(`VoiX request timed out after ${effectiveTimeoutMs}ms`, {
        status: 504, code: 'VOIX_TIMEOUT', cause: error
      });
    }
    throw new VoixClientError(`VoiX service unavailable at ${url}`, {
      status: 503, code: 'VOIX_UNAVAILABLE', cause: error
    });
  }
}

async function synthesize(payload = {}) {
  const effectiveTimeoutMs = getVoixLongTimeoutMs();
  const url = buildVoixUrl('/api/tts');
  const text = payload.text || payload.input || '';
  const body = {
    text,
    voice: payload.voice || '',
    response_format: payload.response_format || 'wav',
    save: false
  };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      timeout: effectiveTimeoutMs
    });

    if (!response.ok) {
      const parsed = await parseResponseBody(response);
      throw new VoixClientError(
        extractErrorMessage(parsed, `VoiX TTS failed (${response.status})`),
        { status: response.status, code: 'VOIX_BAD_RESPONSE', body: parsed }
      );
    }

    return response;
  } catch (error) {
    if (error instanceof VoixClientError) throw error;
    if (error && error.name === 'AbortError') {
      throw new VoixClientError(`VoiX request timed out after ${effectiveTimeoutMs}ms`, {
        status: 504, code: 'VOIX_TIMEOUT', cause: error
      });
    }
    throw new VoixClientError(`VoiX service unavailable at ${url}`, {
      status: 503, code: 'VOIX_UNAVAILABLE', cause: error
    });
  }
}

function whisperModels() {
  return callVoix('GET', '/v1/models');
}

module.exports = {
  DEFAULT_VOIX_BASE_URL,
  DEFAULT_VOIX_TIMEOUT_MS,
  DEFAULT_VOIX_LONG_TIMEOUT_MS,
  VoixClientError,
  getVoixBaseUrl,
  getVoixTimeoutMs,
  getVoixLongTimeoutMs,
  getClientConfig,
  buildVoixUrl,
  requestJson: callVoix,
  health,
  config,
  updateConfig,
  devices,
  metrics,
  voiceProfile,
  sessionStatus,
  startSession,
  stopSession,
  cancelSession,
  listSessions,
  createSession,
  getSession,
  getSessionEvents,
  diagnosticsSmoke,
  diagnosticsTtsSmoke,
  textTurn,
  transcribe,
  synthesize,
  whisperModels
};
