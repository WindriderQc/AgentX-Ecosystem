const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const voixClient = require('../src/services/voixClientService');
const voixSettings = require('../src/services/voixSettingsService');
const { buildAgentXVoiceContract } = require('../src/services/agentxVoiceContractService');
const multer = require('multer');
const FormData = require('form-data');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function respondOk(res, data) {
  return res.json({
    status: 'success',
    data
  });
}

function handleVoixError(res, err, context) {
  logger.warn('VoiX proxy request failed', {
    context,
    status: err.status || 500,
    code: err.code || 'VOIX_PROXY_ERROR',
    message: err.message
  });

  return res.status(err.status || 500).json({
    status: 'error',
    message: err.message,
    code: err.code || 'VOIX_PROXY_ERROR'
  });
}

router.get('/health', async (req, res) => {
  try {
    return respondOk(res, await voixClient.health({ query: req.query }));
  } catch (err) {
    return handleVoixError(res, err, 'health');
  }
});

router.get('/contract', (req, res) => {
  try {
    return respondOk(res, buildAgentXVoiceContract());
  } catch (err) {
    logger.error('Failed to build AgentX Voice contract', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// Runtime-configurable settings (voice mode, baseUrl, timeouts) with source labels.
router.get('/settings', (req, res) => {
  try {
    return respondOk(res, voixSettings.getSettings());
  } catch (err) {
    logger.error('Failed to read voice settings', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.patch('/settings', express.json(), (req, res) => {
  try {
    return respondOk(res, voixSettings.setSettings(req.body || {}));
  } catch (err) {
    const status = err.code === 'INVALID' ? 400 : 500;
    logger.error('Failed to update voice settings', { error: err.message });
    return res.status(status).json({ status: 'error', message: err.message });
  }
});

router.get('/models', async (req, res) => {
  try {
    return respondOk(res, await voixClient.whisperModels());
  } catch (err) {
    return handleVoixError(res, err, 'whisperModels');
  }
});

router.get('/config', async (req, res) => {
  try {
    return respondOk(res, await voixClient.config({ query: req.query }));
  } catch (err) {
    return handleVoixError(res, err, 'config');
  }
});

router.post('/config', async (req, res) => {
  try {
    return respondOk(res, await voixClient.updateConfig(req.body || {}));
  } catch (err) {
    return handleVoixError(res, err, 'updateConfig');
  }
});

router.get('/devices', async (req, res) => {
  try {
    return respondOk(res, await voixClient.devices({ query: req.query }));
  } catch (err) {
    return handleVoixError(res, err, 'devices');
  }
});

router.get('/metrics', async (req, res) => {
  try {
    return respondOk(res, await voixClient.metrics({ query: req.query }));
  } catch (err) {
    return handleVoixError(res, err, 'metrics');
  }
});

router.get('/voice-profile', async (req, res) => {
  try {
    return respondOk(res, await voixClient.voiceProfile({ query: req.query }));
  } catch (err) {
    return handleVoixError(res, err, 'voiceProfile');
  }
});

router.post('/diagnostics/tts-smoke', async (req, res) => {
  try {
    return respondOk(res, await voixClient.diagnosticsTtsSmoke(req.body || {}));
  } catch (err) {
    return handleVoixError(res, err, 'diagnosticsTtsSmoke');
  }
});

router.post('/diagnostics/smoke', async (req, res) => {
  try {
    return respondOk(res, await voixClient.diagnosticsSmoke(req.body || {}));
  } catch (err) {
    return handleVoixError(res, err, 'diagnosticsSmoke');
  }
});

router.post('/sessions', async (req, res) => {
  try {
    return respondOk(res, await voixClient.createSession(req.body || {}));
  } catch (err) {
    return handleVoixError(res, err, 'createSession');
  }
});

router.get('/sessions', async (req, res) => {
  try {
    return respondOk(res, await voixClient.listSessions(req.query || {}));
  } catch (err) {
    return handleVoixError(res, err, 'listSessions');
  }
});

router.post('/sessions/start', async (req, res) => {
  try {
    return respondOk(res, await voixClient.startSession(req.body || {}));
  } catch (err) {
    return handleVoixError(res, err, 'startSession');
  }
});

router.post('/sessions/stop', async (req, res) => {
  try {
    return respondOk(res, await voixClient.stopSession(req.body || {}));
  } catch (err) {
    return handleVoixError(res, err, 'stopSession');
  }
});

router.post('/sessions/cancel', async (req, res) => {
  try {
    return respondOk(res, await voixClient.cancelSession(req.body || {}));
  } catch (err) {
    return handleVoixError(res, err, 'cancelSession');
  }
});

router.get('/sessions/status', async (req, res) => {
  try {
    return respondOk(res, await voixClient.sessionStatus({ query: req.query }));
  } catch (err) {
    return handleVoixError(res, err, 'sessionStatus');
  }
});

router.get('/sessions/:id', async (req, res) => {
  try {
    return respondOk(res, await voixClient.getSession(req.params.id));
  } catch (err) {
    return handleVoixError(res, err, 'getSession');
  }
});

router.get('/sessions/:id/events', async (req, res) => {
  try {
    return respondOk(res, await voixClient.getSessionEvents(req.params.id, req.query || {}));
  } catch (err) {
    return handleVoixError(res, err, 'getSessionEvents');
  }
});

router.post('/sessions/text-turn', async (req, res) => {
  try {
    return respondOk(res, await voixClient.textTurn(req.body || {}));
  } catch (err) {
    return handleVoixError(res, err, 'textTurn');
  }
});

router.post('/transcribe', upload.single('audio'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ status: 'error', message: 'No audio file provided', code: 'VOIX_INVALID_REQUEST' });
    }
    const settings = voixSettings.getSettings();
    const sttDefaults = settings.features?.stt || {};
    const form = new FormData();
    form.append('file', req.file.buffer, {
      filename: req.file.originalname || 'recording.webm',
      contentType: req.file.mimetype || 'audio/webm'
    });
    const model = req.body.model || sttDefaults.model;
    const language = req.body.language || sttDefaults.language;
    if (model) form.append('model', model);
    if (language) form.append('language', language);
    if (req.body.response_format) form.append('response_format', req.body.response_format);

    return respondOk(res, await voixClient.transcribe(form));
  } catch (err) {
    return handleVoixError(res, err, 'transcribe');
  }
});

router.post('/synthesize', async (req, res) => {
  try {
    const { text, voice, model, response_format } = req.body || {};
    if (!text) {
      return res.status(400).json({ status: 'error', message: 'text is required', code: 'VOIX_INVALID_REQUEST' });
    }
    const settings = voixSettings.getSettings();
    const ttsDefaults = settings.features?.tts || {};
    const upstream = await voixClient.synthesize({
      input: text,
      voice: voice || ttsDefaults.voice || '',
      model: model || '',
      response_format: response_format || ttsDefaults.responseFormat || 'mp3'
    });
    const contentType = upstream.headers.get('content-type') || 'audio/mpeg';
    res.set('Content-Type', contentType);
    const buffer = await upstream.buffer();
    return res.send(buffer);
  } catch (err) {
    return handleVoixError(res, err, 'synthesize');
  }
});

module.exports = router;
