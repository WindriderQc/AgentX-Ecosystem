const request = require('supertest');

jest.mock('../../src/helpers/promptAnalysis', () => ({
  analyzeFailurePatterns: jest.fn(() => ({
    patterns: [],
    themes: [],
    stats: {
      totalConversations: 1,
      avgMessagesPerConversation: 2,
      mostCommonFailurePoints: []
    }
  })),
  callOllamaForAnalysis: jest.fn(async () => ({
    success: true,
    analysis: {
      suggested_prompt: 'You are a concise assistant.',
      root_causes: ['test']
    },
    raw_response: '{"suggested_prompt":"You are a concise assistant."}'
  }))
}));

const { app } = require('../../src/app');
const { connectTestDb, disconnectTestDb, clearTestDb } = require('../helpers/testDb');
const Conversation = require('../../models/Conversation');
const PromptConfig = require('../../models/PromptConfig');

beforeAll(async () => {
  await connectTestDb();
});

afterAll(async () => {
  await disconnectTestDb();
});

afterEach(async () => {
  await Conversation.deleteMany({});
  await PromptConfig.deleteMany({});
});

describe('POST /api/prompts/:name/analyze-failures', () => {
  it('returns failure analysis with suggested prompt', async () => {
    const prompt = new PromptConfig({
      name: 'default_chat',
      version: 1,
      systemPrompt: 'You are a helpful assistant.',
      isActive: true
    });
    await prompt.save();

    const conversation = new Conversation({
      promptName: 'default_chat',
      promptVersion: 1,
      messages: [
        { role: 'user', content: 'Help me' },
        { role: 'assistant', content: 'Sorry', feedback: { rating: -1, comment: 'bad' } }
      ]
    });
    await conversation.save();

    const res = await request(app)
      .post('/api/prompts/default_chat/analyze-failures')
      .send({ version: 1, limit: 20 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.prompt.name).toBe('default_chat');
    expect(res.body.data.conversations).toBe(1);
    expect(res.body.data.llmAnalysis).toBeTruthy();
    expect(res.body.data.llmAnalysis.suggested_prompt).toBe('You are a concise assistant.');
  });

  it('handles prompts with no failures gracefully', async () => {
    const prompt = new PromptConfig({
      name: 'default_chat',
      version: 1,
      systemPrompt: 'You are a helpful assistant.',
      isActive: true
    });
    await prompt.save();

    const conversation = new Conversation({
      promptName: 'default_chat',
      promptVersion: 1,
      messages: [
        { role: 'user', content: 'Hello' },
        { role: 'assistant', content: 'Hi there', feedback: { rating: 1 } }
      ]
    });
    await conversation.save();

    const res = await request(app)
      .post('/api/prompts/default_chat/analyze-failures')
      .send({ version: 1, limit: 20 });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.conversations).toBe(0);
    expect(res.body.data.patternAnalysis).toBeDefined();
    expect(res.body.data.llmAnalysis).toBeNull();
  });

  it('returns 404 for invalid prompt name', async () => {
    const res = await request(app)
      .post('/api/prompts/nonexistent/analyze-failures')
      .send({ version: 1 });

    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });
});
