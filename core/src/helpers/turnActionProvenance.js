'use strict';

const Conversation = require('../../models/Conversation');

const MAX_TURN_ID_LENGTH = 160;
const TURN_ACTION_FIELDS = new Set([
  'kind',
  'sourceUserMessageId',
  'sourceAssistantMessageId'
]);

class TurnActionProvenanceError extends Error {
  constructor(message, { code = 'TURN_ACTION_INVALID', statusCode = 400 } = {}) {
    super(message);
    this.name = 'TurnActionProvenanceError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function invalid(message, code = 'TURN_ACTION_INVALID') {
  throw new TurnActionProvenanceError(message, { code, statusCode: 400 });
}

function normalizeBoundedId(value, fieldName, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined)) return null;
  if (typeof value !== 'string') {
    invalid(`${fieldName} must be a string.`);
  }

  const normalized = value.trim();
  if (!normalized || normalized !== value || normalized.length > MAX_TURN_ID_LENGTH || /[\u0000-\u001f\u007f]/.test(normalized)) {
    invalid(`${fieldName} must be a non-empty bounded identifier without surrounding whitespace.`);
  }
  return normalized;
}

function normalizeTurnAction(rawTurnAction) {
  if (rawTurnAction === undefined) return null;
  if (!rawTurnAction || typeof rawTurnAction !== 'object' || Array.isArray(rawTurnAction)) {
    invalid('turnAction must be an object.');
  }

  const extraFields = Object.keys(rawTurnAction).filter((field) => !TURN_ACTION_FIELDS.has(field));
  if (extraFields.length > 0) {
    invalid(`turnAction contains unsupported field: ${extraFields[0]}.`);
  }

  const kind = rawTurnAction.kind;
  if (kind !== 'ask-again' && kind !== 'retry') {
    invalid('turnAction.kind must be ask-again or retry.');
  }

  const sourceUserMessageId = normalizeBoundedId(
    rawTurnAction.sourceUserMessageId,
    'turnAction.sourceUserMessageId'
  );
  const sourceAssistantMessageId = normalizeBoundedId(
    rawTurnAction.sourceAssistantMessageId,
    'turnAction.sourceAssistantMessageId',
    { nullable: true }
  );

  if (kind === 'ask-again' && !sourceAssistantMessageId) {
    invalid('ask-again requires turnAction.sourceAssistantMessageId.');
  }
  if (kind === 'retry' && sourceAssistantMessageId !== null) {
    invalid('retry requires turnAction.sourceAssistantMessageId to be null or omitted.');
  }

  return {
    kind,
    sourceUserMessageId,
    sourceAssistantMessageId
  };
}

function messageIdOf(message) {
  const value = message?._id ?? message?.id ?? null;
  return value === null || value === undefined ? null : String(value);
}

async function validateTurnActionProvenance({
  rawTurnAction,
  conversationId,
  userId,
  ConversationModel = Conversation
}) {
  const turnAction = normalizeTurnAction(rawTurnAction);
  if (!turnAction || turnAction.kind === 'retry') return turnAction;

  const normalizedConversationId = normalizeBoundedId(
    conversationId,
    'conversationId'
  );

  let conversation;
  try {
    conversation = await ConversationModel.findOne({
      _id: normalizedConversationId,
      userId,
      'lifecycle.status': { $ne: 'archived' }
    });
  } catch (error) {
    if (error?.name === 'CastError') {
      invalid('conversationId is not a valid identifier.', 'TURN_ACTION_CONVERSATION_ID_INVALID');
    }
    throw error;
  }

  if (!conversation) {
    throw new TurnActionProvenanceError('Conversation not found for this turn action.', {
      code: 'TURN_ACTION_CONVERSATION_NOT_FOUND',
      statusCode: 404
    });
  }

  const messages = Array.isArray(conversation.messages)
    ? conversation.messages
    : Array.from(conversation.messages || []);
  const userIndex = messages.findIndex((entry) => (
    messageIdOf(entry) === turnAction.sourceUserMessageId
  ));
  const assistantIndex = messages.findIndex((entry) => (
    messageIdOf(entry) === turnAction.sourceAssistantMessageId
  ));

  if (userIndex < 0 || assistantIndex < 0) {
    throw new TurnActionProvenanceError('The referenced persisted turn was not found.', {
      code: 'TURN_ACTION_SOURCE_NOT_FOUND',
      statusCode: 404
    });
  }
  if (messages[userIndex]?.role !== 'user' || messages[assistantIndex]?.role !== 'assistant') {
    throw new TurnActionProvenanceError('The referenced messages do not have the required turn roles.', {
      code: 'TURN_ACTION_SOURCE_ROLE_INVALID',
      statusCode: 422
    });
  }

  let pairedUserIndex = -1;
  for (let index = assistantIndex - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === 'user') {
      pairedUserIndex = index;
      break;
    }
  }
  if (pairedUserIndex !== userIndex) {
    throw new TurnActionProvenanceError('The assistant message is not paired with the referenced user message.', {
      code: 'TURN_ACTION_PAIR_MISMATCH',
      statusCode: 409
    });
  }

  return turnAction;
}

module.exports = {
  MAX_TURN_ID_LENGTH,
  TurnActionProvenanceError,
  normalizeTurnAction,
  validateTurnActionProvenance
};
