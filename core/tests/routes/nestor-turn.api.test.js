'use strict';

const express = require('express');
const request = require('supertest');

const mockRunTurn = jest.fn();
const mockRunTurnStream = jest.fn();

jest.mock('../../src/services/nestorTurnService', () => {
  class NestorTurnError extends Error {
    constructor(message, { status = 500, code = 'NESTOR_TURN_ERROR' } = {}) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return {
    NestorTurnError,
    NESTOR_AGENT_ID: 'main',
    NESTOR_TURN_LANES: { AUTO: 'auto', FRONT_DOOR: 'front_door', ANSWER_LIGHT: 'answer_light' },
    NESTOR_ANSWER_LIGHT_TASK: 'nestor_answer_light',
    runTurn: (...args) => mockRunTurn(...args),
    runTurnStream: (...args) => mockRunTurnStream(...args)
  };
});

jest.mock('../../src/services/openclawClient', () => ({
  getOpenClawClient: () => ({ healthCheck: jest.fn() }),
  isOpenClawIntegrationEnabled: () => true
}));

jest.mock('../../config/logger', () => ({
  error: jest.fn(),
  warn: jest.fn(),
  info: jest.fn()
}));

const nestorTurnRoutes = require('../../routes/nestor-turn');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/nestor/turn', nestorTurnRoutes);
  return app;
}

describe('Nestor streaming turn route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRunTurnStream.mockImplementation(async (_input, handlers) => {
      handlers.onStart({
        agent: 'main',
        lane: 'answer_light',
        conversationId: 'conv-1',
        traceId: 'trace-1',
        surface: 'voice-console'
      });
      handlers.onDelta({ delta: 'Bonjour.', elapsedMs: 20 });
      handlers.onSentence({ text: 'Bonjour.', index: 0, elapsedMs: 21 });
      return {
        reply: 'Bonjour.',
        brain: 'nestor-openclaw',
        conversationId: 'conv-1',
        traceId: 'trace-1',
        timings: { firstTokenMs: 20, firstSentenceMs: 21, totalMs: 25 }
      };
    });
  });

  test('emits stable meta, delta, sentence, and done SSE events', async () => {
    const response = await request(buildApp())
      .post('/api/nestor/turn/stream')
      .send({ text: 'Allô?', surface: 'voice-console', lane: 'answer_light' })
      .expect(200)
      .expect('Content-Type', /text\/event-stream/);

    expect(response.text).toContain('event: meta');
    expect(response.text).toContain('event: delta');
    expect(response.text).toContain('"delta":"Bonjour."');
    expect(response.text).toContain('event: sentence');
    expect(response.text).toContain('event: done');
    expect(mockRunTurnStream).toHaveBeenCalledWith(
      expect.objectContaining({
        text: 'Allô?',
        surface: 'voice-console',
        lane: 'answer_light'
      }),
      expect.objectContaining({
        signal: expect.any(Object),
        onStart: expect.any(Function),
        onDelta: expect.any(Function),
        onSentence: expect.any(Function)
      })
    );
  });

  test('passes the selected lane through the JSON turn endpoint', async () => {
    mockRunTurn.mockResolvedValue({
      reply: 'Rapide.',
      brain: 'nestor-local',
      lane: 'answer_light'
    });

    await request(buildApp())
      .post('/api/nestor/turn')
      .send({ text: 'Allô?', lane: 'answer_light' })
      .expect(200);

    expect(mockRunTurn).toHaveBeenCalledWith(expect.objectContaining({
      text: 'Allô?',
      lane: 'answer_light'
    }));
  });

  test('advertises Auto without changing the historical API default', async () => {
    const response = await request(buildApp())
      .get('/api/nestor/turn/health')
      .expect(200);

    expect(response.body.data.lanes).toEqual({
      default: 'front_door',
      supported: ['auto', 'front_door', 'answer_light'],
      answerLightTask: 'nestor_answer_light'
    });
  });
});
