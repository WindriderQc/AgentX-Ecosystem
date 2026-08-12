const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const Conversation = require('../models/Conversation');
const { getUserId } = require('../src/helpers/userHelpers');
const { emit: emitBuddyEvent } = require('../src/services/buddyEvents');
const { getRagServiceClient } = require('../src/services/ragServiceClient');
const { validateHostUrl } = require('../src/helpers/ollamaHostConfig');
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
    thinking_mode
  } = req.body;

  const userId = getUserId(res);

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

  try {
        const { handleChatRequest } = require('../src/services/chatService');
    const result = await handleChatRequest({
        userId,
        model,
        message,
        messages,
        system,
        persona,
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
        thinkingMode: thinkingMode ?? thinking_mode
    });

    res.json({
        status: 'success',
        data: result,
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
        warning: result.warning
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
    const body = {
      status: 'error',
      message: err.message
    };
    if (err.code) body.code = err.code;
    if (err.notImplemented) body.notImplemented = true;
    res.status(statusCode).json(body);
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
    thinking_mode
  } = payload || {};

  const userId = getUserId(res);

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

  // Helper to send SSE event
  const sendEvent = (event, data) => {
    if (res.writableEnded) return;
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const abortController = new AbortController();
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) {
      res.write(': ping\n\n');
    }
  }, 15000);

  const handleClose = () => {
    clearInterval(heartbeat);
    abortController.abort();
    logger.info('Client disconnected from streaming');
  };

  req.on('close', handleClose);

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
        if (abortController.signal.aborted) return;
        sendEvent('done', result);
        emitBuddyEvent('message_received', 'chat', 'Streamed response completed', 'normal');
        clearInterval(heartbeat);
        res.end();
      },
      onError: (error) => {
        if (abortController.signal.aborted) return;
        const errorPayload = { message: error.message };
        if (error.code) errorPayload.code = error.code;
        if (Number.isInteger(error.statusCode)) errorPayload.statusCode = error.statusCode;
        sendEvent('error', errorPayload);
        emitBuddyEvent('error', 'chat', 'Chat stream error', 'normal');
        clearInterval(heartbeat);
        res.end();
      }
    });

  } catch (err) {
    logger.error('Chat streaming error', { error: err.message, stack: err.stack });
    const errorPayload = { message: err.message };
    if (err.code) errorPayload.code = err.code;
    if (Number.isInteger(err.statusCode)) errorPayload.statusCode = err.statusCode;
    sendEvent('error', errorPayload);
    clearInterval(heartbeat);
    res.end();
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
    options: safeJsonParse(req.query.options, {}),
    conversationId: req.query.conversationId,
    useRag: req.query.useRag === 'true',
    ragTopK: req.query.ragTopK ? parseInt(req.query.ragTopK, 10) : undefined,
    ragFilters: safeJsonParse(req.query.ragFilters, undefined),
    ragCompress: req.query.ragCompress === 'true',
    autoRoute: req.query.autoRoute === 'true',
    taskType: req.query.taskType
  };

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
