const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/roundtable', () => ({
  DEFAULT_PANEL: [],
  DEFAULT_SYNTHESIZER: {},
  COUNCIL_OPTIONS: [{ id: 'debate', rounds: 2 }],
  startRoundtable: jest.fn(),
  listRoundtables: jest.fn(),
  getActiveRoundtableId: jest.fn(),
  getRoundtable: jest.fn(),
  getEmitter: jest.fn(),
  formatTranscript: jest.fn(),
  analyzeQuality: jest.fn(),
  addInterjection: jest.fn(),
  findTelegramRoundtable: jest.fn(),
  parseTelegramCommand: jest.fn(),
  publishRoundtableEvent: jest.fn(),
  sendTelegramText: jest.fn(),
  setDecision: jest.fn()
}));

jest.mock('../../models/Roundtable', () => ({
  findOne: jest.fn(),
  deleteOne: jest.fn()
}));

const roundtableService = require('../../src/services/roundtable');
const router = require('../../routes/roundtable');

function buildApp() {
  const app = express();
  app.use('/api/roundtable', router);
  return app;
}

describe('Roundtable v2 API', () => {
  let app;

  beforeEach(() => {
    app = buildApp();
    jest.clearAllMocks();
    delete process.env.ROUNDTABLE_CHAIR_TOKEN;
    delete process.env.ROUNDTABLE_TELEGRAM_WEBHOOK_SECRET;
    delete process.env.ROUNDTABLE_TELEGRAM_CHAIR_IDS;
  });

  test('passes runtime, Telegram topic, and governance configuration to the service', async () => {
    process.env.ROUNDTABLE_CHAIR_TOKEN = 'chair-secret';
    roundtableService.startRoundtable.mockResolvedValue({
      _id: 'rt-1', status: 'pending', question: 'Discuss?', rounds: 2
    });
    const response = await request(app)
      .post('/api/roundtable')
      .set('x-roundtable-chair-token', 'chair-secret')
      .send({
        question: 'Discuss?',
        panel: [{ agentId: 'leadx', role: 'LeadX', runtime: 'openclaw' }],
        telegram: { chatId: '-100123', threadId: 42, publishTurns: true },
        governance: { requireApproval: true }
      });

    expect(response.status).toBe(201);
    expect(roundtableService.startRoundtable).toHaveBeenCalledWith(expect.objectContaining({
      telegram: { chatId: '-100123', threadId: 42, publishTurns: true },
      governance: { requireApproval: true }
    }));
  });

  test('defaults to advisory execution with post-run judging disabled', async () => {
    roundtableService.startRoundtable.mockResolvedValue({
      _id: 'rt-advisory', status: 'pending', question: 'Compare options?', rounds: 2
    });

    const response = await request(app)
      .post('/api/roundtable')
      .send({ question: 'Compare options?' });

    expect(response.status).toBe(201);
    expect(roundtableService.startRoundtable).toHaveBeenCalledWith(expect.objectContaining({
      governance: {},
      telegram: null,
      notify: null,
      enableScoring: false
    }));
  });

  test('advertises Council choices and its no-execution boundary', async () => {
    const response = await request(app).get('/api/roundtable/defaults');

    expect(response.status).toBe(200);
    expect(response.body.data.options).toEqual([{ id: 'debate', rounds: 2 }]);
    expect(response.body.data.policy).toEqual(expect.objectContaining({
      canonicalSurface: '/council',
      advisoryOnlyDefault: true,
      executionAuthority: 'none',
      qualityScoringDefault: false,
      runtimeParticipantsEnabled: false
    }));
  });

  test('fails closed when chair approval is not configured', async () => {
    const response = await request(app)
      .post('/api/roundtable/rt-1/decision')
      .send({ decision: 'approved' });
    expect(response.status).toBe(503);
    expect(roundtableService.setDecision).not.toHaveBeenCalled();
  });

  test('does not start real runtimes without chair authorization', async () => {
    process.env.ROUNDTABLE_CHAIR_TOKEN = 'chair-secret';
    const response = await request(app)
      .post('/api/roundtable')
      .send({
        question: 'Ask LeadX?',
        panel: [{ agentId: 'leadx', runtime: 'openclaw' }]
      });
    expect(response.status).toBe(401);
    expect(roundtableService.startRoundtable).not.toHaveBeenCalled();
  });

  test('does not start an approval-gated model table without chair authorization', async () => {
    process.env.ROUNDTABLE_CHAIR_TOKEN = 'chair-secret';
    const response = await request(app)
      .post('/api/roundtable')
      .send({
        question: 'Approve this recommendation?',
        panel: [{ agentId: 'critic', runtime: 'model', model: 'qwen3:8b' }],
        governance: { requireApproval: true }
      });
    expect(response.status).toBe(401);
    expect(roundtableService.startRoundtable).not.toHaveBeenCalled();
  });

  test('requires the server-side chair token for API approval', async () => {
    process.env.ROUNDTABLE_CHAIR_TOKEN = 'chair-secret';
    const rejected = await request(app)
      .post('/api/roundtable/rt-1/decision')
      .set('x-roundtable-chair-token', 'wrong')
      .send({ decision: 'approved' });
    expect(rejected.status).toBe(401);

    roundtableService.setDecision.mockResolvedValue({
      governance: {
        decisionStatus: 'approved', decidedBy: 'Example User', decisionNote: 'Proceed.'
      }
    });
    const accepted = await request(app)
      .post('/api/roundtable/rt-1/decision')
      .set('x-roundtable-chair-token', 'chair-secret')
      .send({ decision: 'approved', actor: 'Example User', note: 'Proceed.' });
    expect(accepted.status).toBe(200);
    expect(roundtableService.setDecision).toHaveBeenCalledWith('rt-1', expect.objectContaining({
      decision: 'approved', actor: 'Example User', source: 'web-ui'
    }));
  });

  test('requires the server-side chair token for direct interjections', async () => {
    process.env.ROUNDTABLE_CHAIR_TOKEN = 'chair-secret';
    const rejected = await request(app)
      .post('/api/roundtable/rt-1/interjections')
      .send({ text: 'Check the evidence.' });
    expect(rejected.status).toBe(401);
    expect(roundtableService.addInterjection).not.toHaveBeenCalled();

    roundtableService.addInterjection.mockResolvedValue({
      doc: { governance: { decisionStatus: 'deliberating' } },
      interjection: { interjectionId: 'i-1', text: 'Check the evidence.' }
    });
    const accepted = await request(app)
      .post('/api/roundtable/rt-1/interjections')
      .set('x-roundtable-chair-token', 'chair-secret')
      .send({ text: 'Check the evidence.', source: 'web-ui' });
    expect(accepted.status).toBe(201);
  });

  test('authenticates Telegram webhook commands and queues interjections', async () => {
    process.env.ROUNDTABLE_TELEGRAM_WEBHOOK_SECRET = 'telegram-secret';
    process.env.ROUNDTABLE_TELEGRAM_CHAIR_IDS = '95100785879';
    const unauthorized = await request(app)
      .post('/api/roundtable/telegram/webhook')
      .send({ message: { text: '/status' } });
    expect(unauthorized.status).toBe(401);

    roundtableService.parseTelegramCommand.mockReturnValue({
      command: 'interject', argument: 'Check the rollback path.'
    });
    roundtableService.findTelegramRoundtable.mockResolvedValue({
      _id: 'rt-1', telegram: { chatId: '-100123', threadId: 42 }
    });
    roundtableService.addInterjection.mockResolvedValue({
      doc: {},
      interjection: { interjectionId: 'i-1', author: '@operator' }
    });
    roundtableService.sendTelegramText.mockResolvedValue({});
    const accepted = await request(app)
      .post('/api/roundtable/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'telegram-secret')
      .send({
        message: {
          text: '/interject Check the rollback path.',
          chat: { id: -100123 },
          message_thread_id: 42,
          from: { id: 95100785879, username: 'operator', is_bot: false }
        }
      });

    expect(accepted.status).toBe(200);
    expect(accepted.body.action).toBe('interjection-queued');
    expect(roundtableService.addInterjection).toHaveBeenCalledWith('rt-1', {
      text: 'Check the rollback path.', author: '@operator', source: 'telegram'
    });
  });

  test('ignores mutating Telegram commands from group members who are not chairs', async () => {
    process.env.ROUNDTABLE_TELEGRAM_WEBHOOK_SECRET = 'telegram-secret';
    process.env.ROUNDTABLE_TELEGRAM_CHAIR_IDS = '42';
    roundtableService.parseTelegramCommand.mockReturnValue({
      command: 'approve', argument: 'Ship it.'
    });
    roundtableService.findTelegramRoundtable.mockResolvedValue({
      _id: 'rt-1', telegram: { chatId: '-100123', threadId: 42 }
    });

    const response = await request(app)
      .post('/api/roundtable/telegram/webhook')
      .set('x-telegram-bot-api-secret-token', 'telegram-secret')
      .send({
        message: {
          text: '/approve Ship it.', chat: { id: -100123 }, message_thread_id: 42,
          from: { id: 99, username: 'guest', is_bot: false }
        }
      });

    expect(response.status).toBe(200);
    expect(response.body.reason).toBe('unauthorized-chair');
    expect(roundtableService.setDecision).not.toHaveBeenCalled();
  });
});
