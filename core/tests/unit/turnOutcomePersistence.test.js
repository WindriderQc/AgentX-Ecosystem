'use strict';

let idCounter = 1;
function nextId() {
  const suffix = String(idCounter++).padStart(24, '0');
  return suffix.slice(-24);
}

function messageArray(items = []) {
  const messages = Array.from(items);
  Object.defineProperty(messages, 'create', {
    enumerable: false,
    value: data => ({ ...data, _id: nextId() })
  });
  return messages;
}

const findOne = jest.fn();
const save = jest.fn().mockResolvedValue(undefined);
const mockConversation = jest.fn(function FakeConversation(data) {
  Object.assign(this, data);
  this._id = data._id || nextId();
  this.messages = messageArray(data.messages);
  this.save = save;
});
mockConversation.findOne = findOne;

jest.mock('../../models/Conversation', () => mockConversation);

const {
  normalizeTurnOutcome,
  persistTurnOutcome,
  sanitizeErrorDetail
} = require('../../src/services/chat/turnOutcomePersistence');

describe('durable terminal chat outcomes', () => {
  beforeEach(() => {
    idCounter = 1;
    findOne.mockReset();
    save.mockClear();
    mockConversation.mockClear();
  });

  test('accepts only bounded stopped or failed outcomes', () => {
    expect(normalizeTurnOutcome({
      clientTurnId: 'u-1',
      userMessage: 'Hello',
      assistantContent: 'Stopped',
      outcome: 'stopped'
    })).toEqual(expect.objectContaining({ outcome: 'stopped', clientTurnId: 'u-1' }));
    expect(() => normalizeTurnOutcome({
      clientTurnId: 'u-1',
      userMessage: 'Hello',
      assistantContent: 'Unknown',
      outcome: 'success'
    })).toThrow('outcome must be stopped or failed');
  });

  test('redacts service endpoints and credentials before persisting an error', () => {
    const projected = sanitizeErrorDetail('POST http://192.168.2.99:11434 token=super-secret failed');
    expect(projected).toContain('[service endpoint]');
    expect(projected).toContain('[redacted credential]');
    expect(projected).not.toContain('192.168.2.99');
    expect(projected).not.toContain('super-secret');
  });

  test('creates a new conversation with paired user and failed assistant evidence', async () => {
    findOne.mockResolvedValue(null);

    const result = await persistTurnOutcome({
      userId: 'user-1',
      clientTurnId: 'u-client-1',
      model: 'model-a',
      userMessage: 'Explain this',
      assistantContent: 'Timed out. Retry with Quick mode.',
      outcome: 'failed',
      errorCode: 'UPSTREAM_TIMEOUT',
      errorMessage: 'Timed out'
    });

    const conversation = mockConversation.mock.instances[0];
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[0]).toEqual(expect.objectContaining({
      role: 'user',
      content: 'Explain this',
      metadata: expect.objectContaining({ clientTurnId: 'u-client-1' })
    }));
    expect(conversation.messages[1]).toEqual(expect.objectContaining({
      role: 'assistant',
      metadata: expect.objectContaining({
        outcome: 'failed',
        retryable: true,
        sourceUserMessageId: conversation.messages[0]._id
      })
    }));
    expect(save).toHaveBeenCalledTimes(1);
    expect(result).toEqual(expect.objectContaining({ outcome: 'failed', idempotent: false }));
  });

  test('returns the prior receipt idempotently for the same client turn', async () => {
    const existing = {
      _id: '000000000000000000000010',
      messages: messageArray([{
        _id: '000000000000000000000012',
        role: 'assistant',
        metadata: {
          clientTurnId: 'u-client-1',
          sourceUserMessageId: '000000000000000000000011',
          outcome: 'stopped'
        }
      }])
    };
    findOne.mockResolvedValue(existing);

    const result = await persistTurnOutcome({
      userId: 'user-1',
      clientTurnId: 'u-client-1',
      userMessage: 'Hello',
      assistantContent: 'Stopped',
      outcome: 'stopped'
    });

    expect(result).toEqual({
      conversationId: existing._id,
      userMessageId: '000000000000000000000011',
      assistantMessageId: '000000000000000000000012',
      outcome: 'stopped',
      idempotent: true
    });
    expect(save).not.toHaveBeenCalled();
  });

  test('reuses a durable source user message for retry failures', async () => {
    const sourceUserMessageId = '000000000000000000000021';
    const existing = {
      _id: '000000000000000000000020',
      messages: messageArray([{ _id: sourceUserMessageId, role: 'user', content: 'Retry me' }]),
      save
    };
    findOne.mockResolvedValue(existing);

    await persistTurnOutcome({
      userId: 'user-1',
      conversationId: existing._id,
      sourceUserMessageId,
      clientTurnId: 'retry-1',
      userMessage: 'Retry me',
      assistantContent: 'Retry failed',
      outcome: 'failed'
    });

    expect(existing.messages).toHaveLength(2);
    expect(existing.messages[1].metadata.sourceUserMessageId).toBe(sourceUserMessageId);
    expect(save).toHaveBeenCalledTimes(1);
  });
});
