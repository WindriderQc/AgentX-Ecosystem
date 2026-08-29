'use strict';

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

jest.mock('../../models/Conversation', () => ({
  findOne: jest.fn()
}));
jest.mock('../../src/services/chatService', () => ({
  handleChatRequest: jest.fn(),
  handleChatRequestStream: jest.fn()
}));
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/ragServiceClient', () => ({
  getRagServiceClient: jest.fn(() => ({}))
}));

const Conversation = require('../../models/Conversation');
const chatService = require('../../src/services/chatService');
const chatRoutes = require('../../routes/chat');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api', chatRoutes);
  return app;
}

function exactConversation() {
  return {
    messages: [
      { _id: 'u-older', role: 'user', content: 'Duplicate prompt' },
      { _id: 'a-older', role: 'assistant', content: 'Older answer' },
      { _id: 'u-newer', role: 'user', content: 'Duplicate prompt' },
      { _id: 'a-newer', role: 'assistant', content: 'Newer answer' }
    ]
  };
}

describe('chat route turn-action provenance', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  test('POST /chat validates and echoes the exact persisted older pair', async () => {
    Conversation.findOne.mockResolvedValue(exactConversation());
    chatService.handleChatRequest.mockResolvedValue({
      response: 'Another answer',
      conversationId: 'conversation-1',
      messageId: 'a-created',
      model: 'test-model',
      routing: null,
      ragSources: []
    });
    const turnAction = {
      kind: 'ask-again',
      sourceUserMessageId: 'u-older',
      sourceAssistantMessageId: 'a-older'
    };

    const response = await request(app)
      .post('/api/chat')
      .send({
        model: 'test-model',
        message: 'Duplicate prompt',
        conversationId: 'conversation-1',
        turnAction
      });

    expect(response.status).toBe(200);
    expect(response.body.data.turnAction).toEqual(turnAction);
    expect(response.body.turnAction).toEqual(turnAction);
    expect(chatService.handleChatRequest).toHaveBeenCalledWith(
      expect.objectContaining({ turnAction })
    );
  });

  test('POST /chat rejects a mismatched newer pair before the chat handler', async () => {
    Conversation.findOne.mockResolvedValue(exactConversation());

    const response = await request(app)
      .post('/api/chat')
      .send({
        model: 'test-model',
        message: 'Duplicate prompt',
        conversationId: 'conversation-1',
        turnAction: {
          kind: 'ask-again',
          sourceUserMessageId: 'u-older',
          sourceAssistantMessageId: 'a-newer'
        }
      });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('TURN_ACTION_PAIR_MISMATCH');
    expect(chatService.handleChatRequest).not.toHaveBeenCalled();
  });

  test('POST /chat strictly rejects extra fields before lookup or inference', async () => {
    const response = await request(app)
      .post('/api/chat')
      .send({
        model: 'test-model',
        message: 'Try again',
        turnAction: {
          kind: 'retry',
          sourceUserMessageId: 'u-ephemeral',
          sourceAssistantMessageId: null,
          promptText: 'must not identify a turn'
        }
      });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('TURN_ACTION_INVALID');
    expect(Conversation.findOne).not.toHaveBeenCalled();
    expect(chatService.handleChatRequest).not.toHaveBeenCalled();
  });

  test('POST /chat/stream accepts an ephemeral retry and includes it in the done receipt', async () => {
    const turnAction = {
      kind: 'retry',
      sourceUserMessageId: 'u-ephemeral-1',
      sourceAssistantMessageId: null
    };
    chatService.handleChatRequestStream.mockImplementation(async ({ onComplete }) => {
      onComplete({ response: 'Retried', conversationId: 'conversation-1', messageId: 'a-new' });
    });

    const response = await request(app)
      .post('/api/chat/stream')
      .send({ model: 'test-model', message: 'Try again', turnAction });

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.text).toContain('event: done');
    expect(response.text).toContain(`\"turnAction\":${JSON.stringify(turnAction)}`);
    expect(Conversation.findOne).not.toHaveBeenCalled();
    expect(chatService.handleChatRequestStream).toHaveBeenCalledWith(
      expect.objectContaining({ turnAction })
    );
  });

  test('POST /chat/stream rejects malformed provenance before SSE or handler setup', async () => {
    const response = await request(app)
      .post('/api/chat/stream')
      .send({
        model: 'test-model',
        message: 'Try again',
        turnAction: { kind: 'retry', sourceUserMessageId: '' }
      });

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.body.code).toBe('TURN_ACTION_INVALID');
    expect(chatService.handleChatRequestStream).not.toHaveBeenCalled();
  });

  test('GET /chat/stream explicitly rejects turn actions in compatibility payloads', async () => {
    const payload = Buffer.from(JSON.stringify({
      model: 'test-model',
      message: 'Try again',
      turnAction: {
        kind: 'retry',
        sourceUserMessageId: 'u-ephemeral-1',
        sourceAssistantMessageId: null
      }
    })).toString('base64');

    const response = await request(app)
      .get('/api/chat/stream')
      .query({ payload });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('TURN_ACTION_GET_UNSUPPORTED');
    expect(chatService.handleChatRequestStream).not.toHaveBeenCalled();
  });
});
