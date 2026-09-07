const express = require('express');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

jest.mock('../../src/services/chatService', () => ({
  handleChatRequest: jest.fn(), handleChatRequestStream: jest.fn()
}));
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/ragServiceClient', () => ({ getRagServiceClient: () => ({}) }));
const service = require('../../src/services/chatService');

describe('chat input across ordinary and streamed responses', () => {
  let http;
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    app.use('/api', require('../../routes/chat'));
    http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
  });
  afterAll(async () => { await http?.close(); });
  beforeEach(() => {
    jest.clearAllMocks();
    service.handleChatRequest.mockResolvedValue({ response: 'Hello', model: 'test-model' });
    service.handleChatRequestStream.mockImplementation(async ({ onComplete }) => {
      onComplete({ response: 'Hello', model: 'test-model' });
    });
  });

  test.each(['/chat', '/chat/stream'])('%s preserves routing, history and option aliases', async (endpoint) => {
    const messages = [{ role: 'user', content: 'Earlier question' }, { role: 'assistant', content: 'Earlier answer' }];
    const response = await http.request.post(`/api${endpoint}`).send({
      message: 'Next question', autoRoute: true, messages,
      options: { temperature: 0, ragCompress: false }, ragCompress: true,
      thinking_mode: 'off'
    });
    expect(response.status).toBe(200);
    const handler = endpoint.endsWith('stream') ? service.handleChatRequestStream : service.handleChatRequest;
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Next question', autoRoute: true, messages, target: undefined,
      thinkingMode: 'off', options: { temperature: 0, ragCompress: true }
    }));
  });

  describe.each(['/chat', '/chat/stream'])('%s', (endpoint) => {
    test.each([
      { message: '   ' }, { message: 42 }, { messages: null },
      { messages: [null] }, { messages: [{ role: 'user', content: 42 }] },
      { options: null }, { options: [] }
    ])('rejects malformed input before dispatch: %j', async (input) => {
      const response = await http.request.post(`/api${endpoint}`).send({
        model: 'test-model', message: 'Hello', ...input
      });
      expect(response.status).toBe(400);
      expect(response.body.code).toBe('CHAT_REQUEST_INVALID');
      expect(response.headers['content-type']).toMatch(/application\/json/);
      expect(service.handleChatRequest).not.toHaveBeenCalled();
      expect(service.handleChatRequestStream).not.toHaveBeenCalled();
    });
  });
});
