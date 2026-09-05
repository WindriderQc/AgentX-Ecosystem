const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { explainModelUnavailability } = require('../src/services/chat/modelUnavailability');
const Conversation = require('../models/Conversation');
const { getUserId } = require('../src/helpers/userHelpers');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const { getRagServiceClient } = require('../src/services/ragServiceClient');
const { validateHostUrl } = require('../src/helpers/ollamaHostConfig');
const {
  TurnActionProvenanceError,
  validateTurnActionProvenance
} = require('../src/helpers/turnActionProvenance');
const ragStore = getRagServiceClient();

function resolveAllowlistedTarget(target) {
  const validation = validateHostUrl(target);
  if (!validation.valid) {
    return { ok: false, message: validation.message, target: null };
  }

  const raw = typeof target === 'string' ? target.trim() : target;
  return {
    ok: true,
    message: null,
    target: validation.host || (raw ? raw : undefined)
  };
}

function sendTurnActionError(res, error) {
  const isContractError = error instanceof TurnActionProvenanceError;
  const statusCode = isContractError ? error.statusCode : 500;
  if (!isContractError) {
    logger.error('Turn action provenance validation failed', {
      error: error?.message,
      stack: error?.stack
    });
  }
  return res.status(statusCode).json({
    status: 'error',
    code: isContractError ? error.code : 'TURN_ACTION_VALIDATION_FAILED',
    message: isContractError ? error.message : 'Unable to validate turn action provenance.'
  });
}

async function projectChatError(error, options = {}) {
  const body = {
    status: 'error',
    message: error.message
  };
  if (error.code) body.code = error.code;
  if (error.notImplemented) body.notImplemented = true;
  if (options.includeStatusCode && Number.isInteger(error.statusCode)) {
    body.statusCode = error.statusCode;
  }
  if (error.code === 'MODEL_UNAVAILABLE') {
    // The bounded projection contains logical host identity and readiness only:
    // no internal URLs, credentials, or unverified "absent everywhere" claim.
    try {
      const detail = await explainModelUnavailability(error);
      body.detail = detail;
      body.message = detail.message;
    } catch { /* keep the upstream message */ }
  }
  return body;
}

// CHAT: Delegated to chatService
router.post('/chat', async (req, res) => {
  const {
    // target is intentionally NOT defaulted to OLLAMA_HOST — that default was
    // silently pinning every bare-model chat call to the primary host and
    // bypassing pin-aware routing. When target is omitted, the router picks
    // the right host via advisory scheduling (scheduler → pin cache → fallback).
    target,
    model,
    message,
    messages = [],
    system,
    persona,
    promptVersion,
    options = {},
    conversationId,
    useRag,
    ragEnabled,
    ragTopK,
    ragFilters,
    ragCompress,
    autoRoute = false,  // Enable smart model routing
    taskType = null,    // Override task classification (code_generation, deep_reasoning, etc.)
    enableWebSearch = false,
    think,
    thinkingMode,
    thinking_mode,
    turnAction: rawTurnAction
  } = req.body;

  const userId = getUserId(res);

  let turnAction = null;
  try {
    turnAction = await validateTurnActionProvenance({
      rawTurnAction,
      conversationId,
      userId
    });
  } catch (error) {
    return sendTurnActionError(res, error);
  }

  // Model is optional if autoRoute or taskType is enabled
  if (!model && !autoRoute && !taskType) return res.status(400).json({ status: 'error', message: 'Model is required (or enable autoRoute/taskType)' });
  if (!message) return res.status(400).json({ status: 'error', message: 'Message is required' });

  const allowlistedTarget = resolveAllowlistedTarget(target);
  if (!allowlistedTarget.ok) {
    return res.status(400).json({ status: 'error', message: allowlistedTarget.message });
  }

  // Merge ragCompress into options
  if (ragCompress !== undefined) {
      options.ragCompress = ragCompress === true;
  }

  const abortController = new AbortController();
  const handleRequestAborted = () => abortController.abort(new Error('Client disconnected'));
  const handleResponseClose = () => {
    if (!res.writableEnded) abortController.abort(new Error('Client disconnected'));
  };
  req.once('aborted', handleRequestAborted);
  res.once('close', handleResponseClose);

  try {
    const { handleChatRequest } = require('../src/services/chatService');
    const result = await handleChatRequest({
        userId,
        model,
        message,
        messages,
        system,
        persona,
        promptVersion,
        options,
        conversationId,
        useRag,
        ragEnabled,
        ragTopK,
        ragFilters,
        target: allowlistedTarget.target,
        ragStore,
        autoRoute,
        taskType,
        enableWebSearch,
        think,
        thinkingMode: thinkingMode ?? thinking_mode,
        turnAction,
        abortSignal: abortController.signal
    });

    const responseData = turnAction ? { ...result, turnAction } : result;

    res.json({
        status: 'success',
        data: responseData,
        // Top-level fields for backward compatibility or cleaner API response
        model: result.model,
        target: result.target,
        routing: result.routing,
        taskType: result.routing?.taskType || null,
        routedModel: result.routing?.routedModel || result.model || null,
        routedHost: result.routing?.routedHost || null,
        autoRouted: result.routing?.autoRouted || false,
        ragUsed: result.ragUsed,
        ragSources: result.ragSources,
        warning: result.warning,
        ...(turnAction ? { turnAction } : {})
    });

    const modelName = result.model || req.body.model || 'unknown';
    emitBuddyEvent('message_received', 'chat', 'Chat response from ' + modelName, 'normal');

  } catch (err) {
    const statusCode = Number.isInteger(err.statusCode) ? err.statusCode : 500;
    if (statusCode === 501) {
      logger.info('Chat not-implemented branch hit', { code: err.code, message: err.message });
    } else {
      logger.error('Chat error', { error: err.message, stack: err.stack });
    }
    const body = await projectChatError(err);
    res.status(statusCode).json(body);
  } finally {
    req.removeListener('aborted', handleRequestAborted);
    res.removeListener('close', handleResponseClose);
  }
});

const decodeStreamPayload = (payload) => {
  if (!payload) return null;
  try {
    const raw = Buffer.from(payload, 'base64').toString('utf8');
    return JSON.parse(raw);
  } catch (err) {
    logger.warn('Failed to decode stream payload', { error: err.message });
    return null;
  }
};

const safeJsonParse = (value, fallback) => {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    logger.warn('Failed to parse stream query JSON', { error: err.message });
    return fallback;
  }
};

const handleChatStreamRequest = async (req, res, payload) => {
  const {
    // target intentionally not defaulted — see POST /chat for rationale
    target,
    model,
    message,
    messages = [],
    system,
    persona,
    promptVersion,
    options = {},
    conversationId,
    useRag,
    ragEnabled,
    ragTopK,
    ragFilters,
    ragCompress,
    autoRoute = false,
    taskType = null,
    enableWebSearch = false,
    think,
    thinkingMode,
    thinking_mode,
    turnAction: rawTurnAction
  } = payload || {};

  const userId = getUserId(res);

  let turnAction = null;
  try {
    turnAction = await validateTurnActionProvenance({
      rawTurnAction,
      conversationId,
      userId
    });
  } catch (error) {
    return sendTurnActionError(res, error);
  }

  logger.info('DEBUG_STREAM: handleChatStreamRequest', {
    userId,
    model
  });

  if (!model && !autoRoute && !taskType) {
    return res.status(400).json({ status: 'error', message: 'Model is required (or enable autoRoute/taskType)' });
  }
  if (!message) {
    return res.status(400).json({ status: 'error', message: 'Message is required' });
  }

  const allowlistedTarget = resolveAllowlistedTarget(target);
  if (!allowlistedTarget.ok) {
    return res.status(400).json({ status: 'error', message: allowlistedTarget.message });
  }

  // Merge ragCompress into options
  if (ragCompress !== undefined) {
    options.ragCompress = ragCompress === true;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

  const abortController = new AbortController();
  let streamTerminal = false;
  let clientDisconnected = false;
  let heartbeat = null;
  let terminalWork = null;

  // Helper to send SSE event
  const sendEvent = (event, data) => {
    if (clientDisconnected || res.writableEnded || res.destroyed) return false;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    return true;
  };

  const clearStreamResources = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
    req.off('aborted', handleRequestAborted);
    res.off('close', handleResponseClose);
  };

  const handleClientDisconnect = (source) => {
    if (streamTerminal || res.writableEnded) {
      clearStreamResources();
      return;
    }
    clientDisconnected = true;
    clearStreamResources();
    if (!abortController.signal.aborted) abortController.abort();
    logger.info('Client disconnected from streaming', { source });
  };

  // IncomingMessage `close` means the POST body has finished on supported
  // Node releases; it is not evidence that the browser stopped reading SSE.
  // Response `close` is the downstream disconnect signal we actually need.
  const handleRequestAborted = () => handleClientDisconnect('request-aborted');
  const handleResponseClose = () => handleClientDisconnect('response-closed');
  req.once('aborted', handleRequestAborted);
  res.once('close', handleResponseClose);

  const finishStream = (event, data) => {
    if (streamTerminal || clientDisconnected || res.writableEnded || res.destroyed) return false;
    streamTerminal = true;
    sendEvent(event, data);
    clearStreamResources();
    res.end();
    return true;
  };

  const finishStreamError = async (error) => {
    if (abortController.signal.aborted) return false;
    const errorPayload = await projectChatError(error, { includeStatusCode: true });
    const finished = finishStream('error', errorPayload);
    if (finished) emitBuddyEvent('error', 'chat', 'Chat stream error', 'normal');
    return finished;
  };

  heartbeat = setInterval(() => {
    if (!clientDisconnected && !res.writableEnded && !res.destroyed) {
      res.write(': ping\n\n');
    }
  }, 15000);
  if (typeof res.flushHeaders === 'function') res.flushHeaders();

  try {
    const { handleChatRequestStream } = require('../src/services/chatService');

    // Stream handler receives tokens progressively
    await handleChatRequestStream({
      userId,
      model,
      message,
      messages,
      system,
      persona,
      promptVersion,
      options,
      conversationId,
      useRag,
      ragEnabled,
      ragTopK,
      ragFilters,
      target: allowlistedTarget.target,
      ragStore,
      autoRoute,
      taskType,
      enableWebSearch,
      think,
      thinkingMode: thinkingMode ?? thinking_mode,
      turnAction,
      abortSignal: abortController.signal,
      onWebSearchStart: () => {
        sendEvent('web-search-start', {});
      },
      onWebSearchDone: (resultCount) => {
        sendEvent('web-search-done', { resultCount });
      },
      onToken: (token) => {
        sendEvent('token', { content: token });
      },
      onThinking: (thinking) => {
        sendEvent('thinking', { content: thinking });
      },
      onComplete: (result) => {
        const completionReceipt = turnAction ? { ...result, turnAction } : result;
        if (finishStream('done', completionReceipt)) {
          emitBuddyEvent('message_received', 'chat', 'Streamed response completed', 'normal');
        }
      },
      onError: (error) => {
        if (abortController.signal.aborted) return;
        terminalWork = finishStreamError(error);
      }
    });

    if (terminalWork) await terminalWork;
    if (!streamTerminal && !clientDisconnected && !abortController.signal.aborted) {
      const err = new Error('Chat stream ended without a terminal event');
      logger.error('Chat streaming lifecycle error', { error: err.message });
      finishStream('error', { message: err.message, code: 'STREAM_TERMINAL_EVENT_MISSING' });
    }

  } catch (err) {
    if (clientDisconnected || abortController.signal.aborted || streamTerminal) return;
    if (terminalWork) {
      await terminalWork;
      return;
    }
    logger.error('Chat streaming error', { error: err.message, stack: err.stack });
    await finishStreamError(err);
  } finally {
    if (streamTerminal || clientDisconnected || res.writableEnded || res.destroyed) {
      clearStreamResources();
    }
  }
};

// CHAT STREAMING: SSE endpoint for real-time token streaming
router.post('/chat/stream', async (req, res) => {
  await handleChatStreamRequest(req, res, req.body);
});

router.get('/chat/stream', async (req, res) => {
  logger.info('DEBUG_STREAM: GET request');

  const payload = decodeStreamPayload(req.query.payload) || {
    target: req.query.target,
    model: req.query.model,
    message: req.query.message,
    messages: safeJsonParse(req.query.messages, []),
    system: req.query.system,
    persona: req.query.persona,
    promptVersion: req.query.promptVersion,
    options: safeJsonParse(req.query.options, {}),
    conversationId: req.query.conversationId,
    useRag: req.query.useRag === 'true',
    ragTopK: req.query.ragTopK ? parseInt(req.query.ragTopK, 10) : undefined,
    ragFilters: safeJsonParse(req.query.ragFilters, undefined),
    ragCompress: req.query.ragCompress === 'true',
    autoRoute: req.query.autoRoute === 'true',
    taskType: req.query.taskType
  };

  if (req.query.turnAction !== undefined
      || Object.prototype.hasOwnProperty.call(payload, 'turnAction')) {
    return res.status(400).json({
      status: 'error',
      code: 'TURN_ACTION_GET_UNSUPPORTED',
      message: 'Turn actions require POST /api/chat/stream.'
    });
  }

  await handleChatStreamRequest(req, res, payload);
});

// FEEDBACK
router.post('/feedback', async (req, res) => {
    const { conversationId, messageId, rating, comment } = req.body;
    try {
        if (!conversationId && !messageId) {
            return res.status(400).json({ status: 'error', message: 'conversationId or messageId is required' });
        }

        const userId = getUserId(res);
        const query = { userId };

        if (conversationId) {
            query._id = conversationId;
        } else {
            query['messages._id'] = messageId;
        }

        const conversation = await Conversation.findOne(query);
        if (!conversation) return res.status(404).json({ status: 'error', message: 'Conversation not found' });

        const msg = conversation.messages.id(messageId);
        if (!msg) return res.status(404).json({ status: 'error', message: 'Message not found' });

        msg.feedback = { rating, comment };
        await conversation.save();

        res.json({ status: 'success', message: 'Feedback saved' });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});


module.exports = router;
