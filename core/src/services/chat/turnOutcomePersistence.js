'use strict';

const mongoose = require('mongoose');
const Conversation = require('../../../models/Conversation');

const OUTCOMES = new Set(['stopped', 'failed']);

class TurnOutcomeError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_TURN_OUTCOME') {
    super(message);
    this.name = 'TurnOutcomeError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function boundedString(value, { field, required = false, maxLength }) {
  const normalized = value === null || value === undefined ? '' : String(value).trim();
  if (required && !normalized) {
    throw new TurnOutcomeError(`${field} is required`);
  }
  if (normalized.length > maxLength) {
    throw new TurnOutcomeError(`${field} must be ${maxLength} characters or fewer`);
  }
  return normalized;
}

function sanitizeErrorDetail(value) {
  const normalized = boundedString(value, { field: 'errorMessage', maxLength: 2000 });
  if (!normalized) return null;
  return normalized
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, '[redacted credential]')
    .replace(/\b(?:api[_-]?key|token|secret)\s*[:=]\s*[^\s,;]+/gi, '[redacted credential]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[service endpoint]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d+)?\b/g, '[service host]');
}

function normalizeTurnOutcome(input = {}) {
  const outcome = boundedString(input.outcome, { field: 'outcome', required: true, maxLength: 20 }).toLowerCase();
  if (!OUTCOMES.has(outcome)) {
    throw new TurnOutcomeError('outcome must be stopped or failed');
  }

  const conversationId = boundedString(input.conversationId, { field: 'conversationId', maxLength: 80 });
  if (conversationId && !mongoose.Types.ObjectId.isValid(conversationId)) {
    throw new TurnOutcomeError('conversationId is invalid');
  }
  const sourceUserMessageId = boundedString(input.sourceUserMessageId, { field: 'sourceUserMessageId', maxLength: 80 });
  if (sourceUserMessageId && !mongoose.Types.ObjectId.isValid(sourceUserMessageId)) {
    throw new TurnOutcomeError('sourceUserMessageId is invalid');
  }
  if (sourceUserMessageId && !conversationId) {
    throw new TurnOutcomeError('conversationId is required with sourceUserMessageId');
  }

  return {
    conversationId: conversationId || null,
    sourceUserMessageId: sourceUserMessageId || null,
    clientTurnId: boundedString(input.clientTurnId, { field: 'clientTurnId', required: true, maxLength: 160 }),
    model: boundedString(input.model || 'unknown', { field: 'model', maxLength: 240 }) || 'unknown',
    userMessage: boundedString(input.userMessage, { field: 'userMessage', required: true, maxLength: 120000 }),
    assistantContent: boundedString(input.assistantContent, { field: 'assistantContent', required: true, maxLength: 120000 }),
    outcome,
    errorCode: boundedString(input.errorCode, { field: 'errorCode', maxLength: 120 }) || null,
    errorMessage: sanitizeErrorDetail(input.errorMessage)
  };
}

function idOf(value) {
  if (value === null || value === undefined) return null;
  if (typeof value.toHexString === 'function') return value.toHexString();
  return String(value);
}

function findOutcomeMessage(conversation, clientTurnId) {
  return Array.from(conversation?.messages || []).find(message => (
    message?.role === 'assistant'
    && message?.metadata?.clientTurnId === clientTurnId
    && OUTCOMES.has(message?.metadata?.outcome)
  )) || null;
}

async function persistTurnOutcome({ userId, ...rawInput }) {
  const input = normalizeTurnOutcome(rawInput);
  let conversation = null;

  if (input.conversationId) {
    conversation = await Conversation.findOne({
      _id: input.conversationId,
      userId,
      'lifecycle.status': { $ne: 'archived' }
    });
    if (!conversation) {
      throw new TurnOutcomeError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND');
    }
  } else {
    conversation = await Conversation.findOne({
      userId,
      'lifecycle.status': { $ne: 'archived' },
      'messages.metadata.clientTurnId': input.clientTurnId
    });
  }

  const existing = findOutcomeMessage(conversation, input.clientTurnId);
  if (existing) {
    const sourceUserMessageId = existing.metadata?.sourceUserMessageId || null;
    return {
      conversationId: idOf(conversation._id),
      userMessageId: idOf(sourceUserMessageId),
      assistantMessageId: idOf(existing._id),
      outcome: existing.metadata.outcome,
      idempotent: true
    };
  }

  if (!conversation) {
    conversation = new Conversation({
      userId,
      model: input.model,
      source: 'agentx',
      title: input.userMessage.slice(0, 50) || 'Agent X Chat',
      messages: []
    });
  }

  let userMessage = null;
  if (input.sourceUserMessageId) {
    userMessage = Array.from(conversation.messages || []).find(message => (
      message?.role === 'user' && idOf(message?._id) === input.sourceUserMessageId
    )) || null;
    if (!userMessage) {
      throw new TurnOutcomeError('Source user message not found', 400, 'SOURCE_USER_MESSAGE_NOT_FOUND');
    }
  } else {
    userMessage = conversation.messages.create({
      role: 'user',
      content: input.userMessage,
      metadata: {
        clientTurnId: input.clientTurnId,
        outcomeRecord: true
      }
    });
  }
  const assistantMessage = conversation.messages.create({
    role: 'assistant',
    content: input.assistantContent,
    metadata: {
      clientTurnId: input.clientTurnId,
      sourceUserMessageId: idOf(userMessage._id),
      outcome: input.outcome,
      retryable: true,
      model: input.model,
      error: input.errorCode || input.errorMessage
        ? { code: input.errorCode, message: input.errorMessage }
        : null
    }
  });

  if (!input.sourceUserMessageId) conversation.messages.push(userMessage);
  conversation.messages.push(assistantMessage);
  conversation.updatedAt = new Date();
  await conversation.save();

  return {
    conversationId: idOf(conversation._id),
    userMessageId: idOf(userMessage._id),
    assistantMessageId: idOf(assistantMessage._id),
    outcome: input.outcome,
    idempotent: false
  };
}

module.exports = {
  TurnOutcomeError,
  findOutcomeMessage,
  normalizeTurnOutcome,
  persistTurnOutcome,
  sanitizeErrorDetail
};
