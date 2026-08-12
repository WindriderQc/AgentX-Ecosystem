const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const {
  DEFAULT_PACK_ID,
  VoicePersonaPackError,
  getPack,
  listPacks,
  packSummary,
  resolveMode,
  resolvePrompt
} = require('../src/services/voicePersonaPacks');
const {
  VoicePersonaRuntimeError,
  createSession,
  runTextTurn
} = require('../src/services/voicePersonaRuntimeService');
const {
  VoicePersonaMemoryError,
  saveScopedMemory,
  searchScopedMemory
} = require('../src/services/voicePersonaMemoryService');
const { getRecentAudit } = require('../src/services/voicePersonaAuditService');
const { analyzeAlerts } = require('../src/services/voicePersonaAlerts');
const {
  buildVoicePersonaMessages
} = require('../src/services/voicePersonaPrompt');
const {
  assessTurn,
  buildEscalationReply
} = require('../src/services/voicePersonaSafety');

const router = express.Router();

function routeError(res, err) {
  if (err instanceof VoicePersonaPackError
    || err instanceof VoicePersonaRuntimeError
    || err instanceof VoicePersonaMemoryError) {
    return envelope.error(res, err.status || 400, err.message, err.code);
  }
  return envelope.error(res, 500, err.message || 'Voice persona request failed', 'VOICE_PERSONA_ERROR');
}

router.get('/packs', async (_req, res) => {
  try {
    return envelope.success(res, {
      defaultPackId: DEFAULT_PACK_ID,
      packs: listPacks()
    });
  } catch (err) {
    return routeError(res, err);
  }
});

router.get('/packs/:packId', async (req, res) => {
  try {
    const pack = getPack(req.params.packId);
    const mode = resolveMode(pack, req.query.mode);
    const auditConfig = pack.audit || pack.memory || {};
    const promptInfo = await resolvePrompt(pack);
    return envelope.success(res, {
      pack: {
        ...packSummary(pack),
        inference: {
          taskType: pack.inference?.taskType || 'voice_persona_chat',
          callerDetail: pack.inference?.callerDetail || 'chat-voice-personas',
          maxReplyTokens: pack.inference?.maxReplyTokens || null,
          temperature: pack.inference?.temperature || null
        },
        memory: pack.memory || {},
        audit: {
          rawTranscriptRetention: auditConfig.rawTranscriptRetention || 'disabled',
          previewChars: auditConfig.previewChars || 160
        },
        prompt: {
          source: promptInfo.source,
          config: promptInfo.promptConfig
        }
      },
      mode: {
        id: mode.id,
        label: mode.label,
        description: mode.description || ''
      }
    });
  } catch (err) {
    return routeError(res, err);
  }
});

router.post('/preview', async (req, res) => {
  try {
    const body = req.body || {};
    const pack = getPack(body.packId || DEFAULT_PACK_ID);
    const mode = resolveMode(pack, body.modeId || pack.defaultMode);
    const safety = assessTurn(body.userText, pack);
    const promptInfo = await resolvePrompt(pack);
    const messages = await buildVoicePersonaMessages({
      pack,
      mode,
      prompt: promptInfo.prompt,
      promptSource: promptInfo.source,
      promptConfig: promptInfo.promptConfig,
      scopeId: body.scopeId || pack.defaultScopeId || 'default',
      memoryResults: body.memoryResults,
      safety,
      history: body.history,
      userText: body.userText
    });

    return envelope.success(res, {
      pack: packSummary(pack),
      mode: {
        id: mode.id,
        label: mode.label,
        description: mode.description || ''
      },
      prompt: {
        source: promptInfo.source,
        config: promptInfo.promptConfig
      },
      safety,
      escalationReply: safety.deterministicEscalation ? buildEscalationReply(pack) : '',
      messages
    });
  } catch (err) {
    return routeError(res, err);
  }
});

router.post('/sessions', async (req, res) => {
  try {
    const result = await createSession(req.body || {});
    return envelope.success(res, result, null, 201);
  } catch (err) {
    return routeError(res, err);
  }
});

router.post('/sessions/:sessionId/turns/text', async (req, res) => {
  try {
    const result = await runTextTurn({
      sessionId: req.params.sessionId,
      text: req.body?.text,
      history: req.body?.history,
      channel: req.body?.channel || 'text'
    });
    return envelope.success(res, result);
  } catch (err) {
    return routeError(res, err);
  }
});

router.post('/memory', async (req, res) => {
  try {
    const memory = await saveScopedMemory({
      ...(req.body || {}),
      type: req.body?.type === 'summary' ? 'summary' : 'fact'
    });
    return envelope.success(res, { memory }, null, 201);
  } catch (err) {
    return routeError(res, err);
  }
});

router.post('/memory/summary', async (req, res) => {
  try {
    const memory = await saveScopedMemory({
      ...(req.body || {}),
      text: req.body?.summary || req.body?.text,
      type: 'summary'
    });
    return envelope.success(res, { memory }, null, 201);
  } catch (err) {
    return routeError(res, err);
  }
});

router.post('/memory/search', async (req, res) => {
  try {
    const memory = await searchScopedMemory(req.body || {});
    return envelope.success(res, { memory });
  } catch (err) {
    return routeError(res, err);
  }
});

router.get('/audit/recent', async (req, res) => {
  try {
    const audit = await getRecentAudit({
      packId: req.query.packId,
      scopeId: req.query.scopeId,
      sessionId: req.query.sessionId,
      limit: req.query.limit
    });
    return envelope.success(res, { audit });
  } catch (err) {
    return routeError(res, err);
  }
});

router.get('/alerts', async (req, res) => {
  try {
    const pack = getPack(req.query.packId || DEFAULT_PACK_ID);
    const mode = resolveMode(pack, req.query.modeId);
    const limit = req.query.limit || pack.safety?.alertAnalysis?.auditLimit || 50;
    const audit = await getRecentAudit({
      packId: pack.id,
      scopeId: req.query.scopeId,
      limit
    });
    const alerts = analyzeAlerts(pack, audit, {
      limit,
      packId: pack.id,
      modeId: mode.id,
      scopeId: req.query.scopeId || ''
    });
    return envelope.success(res, { alerts });
  } catch (err) {
    return routeError(res, err);
  }
});

module.exports = router;
