'use strict';

process.env.NODE_ENV = 'test';

const express = require('express');
const request = require('supertest');

class MockTurnOutcomeError extends Error {
  constructor(message, statusCode = 400, code = 'INVALID_TURN_OUTCOME') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
  }
}

const mockPersistTurnOutcome = jest.fn();
jest.mock('../../src/services/chat/turnOutcomePersistence', () => ({
  TurnOutcomeError: MockTurnOutcomeError,
  persistTurnOutcome: mockPersistTurnOutcome
}));

const historyRoutes = require('../../routes/history');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/history', historyRoutes);
  return app;
}

describe('POST /api/history/turn-outcome', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns the durable terminal-turn receipt', async () => {
    mockPersistTurnOutcome.mockResolvedValue({
      conversationId: '507f1f77bcf86cd799439011',
      userMessageId: '507f1f77bcf86cd799439012',
      assistantMessageId: '507f1f77bcf86cd799439013',
      outcome: 'failed',
      idempotent: false
    });

    const response = await request(buildApp())
      .post('/api/history/turn-outcome')
      .send({
        clientTurnId: 'terminal:attempt-1',
        userMessage: 'Hello',
        assistantContent: 'The request failed. Retry with Quick mode.',
        outcome: 'failed'
      })
      .expect(200);

    expect(response.body).toEqual(expect.objectContaining({
      status: 'success',
      data: expect.objectContaining({ outcome: 'failed', idempotent: false })
    }));
    expect(mockPersistTurnOutcome).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'default',
      clientTurnId: 'terminal:attempt-1'
    }));
  });

  test('preserves the bounded validation error contract', async () => {
    mockPersistTurnOutcome.mockRejectedValue(
      new MockTurnOutcomeError('Conversation not found', 404, 'CONVERSATION_NOT_FOUND')
    );

    const response = await request(buildApp())
      .post('/api/history/turn-outcome')
      .send({ clientTurnId: 'terminal:attempt-2' })
      .expect(404);

    expect(response.body).toEqual({
      status: 'error',
      code: 'CONVERSATION_NOT_FOUND',
      message: 'Conversation not found'
    });
  });
});
