'use strict';

const {
  MAX_TURN_ID_LENGTH,
  normalizeTurnAction,
  validateTurnActionProvenance
} = require('../../src/helpers/turnActionProvenance');

function message(_id, role, content) {
  return { _id, role, content };
}

describe('turn action provenance contract', () => {
  test('validates an exact older user/assistant pair even when a newer prompt has duplicate text', async () => {
    const conversation = {
      messages: [
        message('u-older', 'user', 'Same prompt'),
        message('a-older', 'assistant', 'Older answer'),
        message('u-newer', 'user', 'Same prompt'),
        message('a-newer', 'assistant', 'Newer answer')
      ]
    };
    const ConversationModel = { findOne: jest.fn().mockResolvedValue(conversation) };

    await expect(validateTurnActionProvenance({
      rawTurnAction: {
        kind: 'ask-again',
        sourceUserMessageId: 'u-older',
        sourceAssistantMessageId: 'a-older'
      },
      conversationId: 'conversation-1',
      userId: 'owner-1',
      ConversationModel
    })).resolves.toEqual({
      kind: 'ask-again',
      sourceUserMessageId: 'u-older',
      sourceAssistantMessageId: 'a-older'
    });
    expect(ConversationModel.findOne).toHaveBeenCalledWith({
      _id: 'conversation-1',
      userId: 'owner-1',
      'lifecycle.status': { $ne: 'archived' }
    });
  });

  test('rejects a mismatched newer assistant before inference can use the action', async () => {
    const ConversationModel = {
      findOne: jest.fn().mockResolvedValue({
        messages: [
          message('u-older', 'user', 'Same prompt'),
          message('a-older', 'assistant', 'Older answer'),
          message('u-newer', 'user', 'Same prompt'),
          message('a-newer', 'assistant', 'Newer answer')
        ]
      })
    };

    await expect(validateTurnActionProvenance({
      rawTurnAction: {
        kind: 'ask-again',
        sourceUserMessageId: 'u-older',
        sourceAssistantMessageId: 'a-newer'
      },
      conversationId: 'conversation-1',
      userId: 'owner-1',
      ConversationModel
    })).rejects.toMatchObject({
      statusCode: 409,
      code: 'TURN_ACTION_PAIR_MISMATCH'
    });
  });

  test('uses ownership-scoped lookup and returns a stable 404 for unavailable evidence', async () => {
    const ConversationModel = { findOne: jest.fn().mockResolvedValue(null) };

    await expect(validateTurnActionProvenance({
      rawTurnAction: {
        kind: 'ask-again',
        sourceUserMessageId: 'u-1',
        sourceAssistantMessageId: 'a-1'
      },
      conversationId: 'foreign-or-missing',
      userId: 'owner-1',
      ConversationModel
    })).rejects.toMatchObject({
      statusCode: 404,
      code: 'TURN_ACTION_CONVERSATION_NOT_FOUND'
    });
  });

  test('returns a stable 422 when exact ids resolve to the wrong roles', async () => {
    const ConversationModel = {
      findOne: jest.fn().mockResolvedValue({
        messages: [
          message('u-1', 'assistant', 'Not a user'),
          message('a-1', 'user', 'Not an assistant')
        ]
      })
    };

    await expect(validateTurnActionProvenance({
      rawTurnAction: {
        kind: 'ask-again',
        sourceUserMessageId: 'u-1',
        sourceAssistantMessageId: 'a-1'
      },
      conversationId: 'conversation-1',
      userId: 'owner-1',
      ConversationModel
    })).rejects.toMatchObject({
      statusCode: 422,
      code: 'TURN_ACTION_SOURCE_ROLE_INVALID'
    });
  });

  test('accepts a bounded client-ephemeral retry id without a database lookup', async () => {
    const ConversationModel = { findOne: jest.fn() };

    await expect(validateTurnActionProvenance({
      rawTurnAction: {
        kind: 'retry',
        sourceUserMessageId: 'u-1720000000000',
        sourceAssistantMessageId: null
      },
      conversationId: null,
      userId: 'owner-1',
      ConversationModel
    })).resolves.toEqual({
      kind: 'retry',
      sourceUserMessageId: 'u-1720000000000',
      sourceAssistantMessageId: null
    });
    expect(ConversationModel.findOne).not.toHaveBeenCalled();
  });

  test.each([
    [null, 'object'],
    [{ kind: 'retry', sourceUserMessageId: 'u-1', extra: true }, 'unsupported field'],
    [{ kind: 'retry', sourceUserMessageId: 'x'.repeat(MAX_TURN_ID_LENGTH + 1) }, 'bounded identifier'],
    [{ kind: 'retry', sourceUserMessageId: 'u-1', sourceAssistantMessageId: 'a-1' }, 'null'],
    [{ kind: 'ask-again', sourceUserMessageId: 'u-1' }, 'requires']
  ])('strictly rejects malformed action %# with TURN_ACTION_INVALID', (rawTurnAction, messagePattern) => {
    expect(() => normalizeTurnAction(rawTurnAction)).toThrow(expect.objectContaining({
      code: 'TURN_ACTION_INVALID',
      statusCode: 400,
      message: expect.stringMatching(new RegExp(messagePattern, 'i'))
    }));
  });
});
