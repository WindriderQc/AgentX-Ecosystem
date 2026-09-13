'use strict';

const express = require('express');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const Conversation = require('../../models/Conversation');
const ChatImage = require('../../models/ChatImage');
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/ragServiceClient', () => ({ getRagServiceClient: () => ({}) }));
const { persistConversation } = require('../../src/services/chat/conversationPersistence');
const { persistTurnOutcome } = require('../../src/services/chat/turnOutcomePersistence');

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jkWQAAAAASUVORK5CYII=';

describe('screenshot storage and conversation history', () => {
  let http;
  beforeAll(async () => {
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use('/api', require('../../routes/chat'));
    app.use('/api/history', require('../../routes/history'));
    http = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
  });
  afterAll(async () => { await http?.close(); });

  async function upload() {
    const response = await http.request.post('/api/chat/images').send({ dataUrl: `data:image/png;base64,${png}` });
    expect(response.status).toBe(201);
    return response.body.data.id;
  }

  test('uploads and retrieves the exact bytes without placing bytes in the conversation document', async () => {
    const id = await upload();
    const response = await http.request.get(`/api/chat/images/${id}`);
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe('image/png');
    expect(response.body).toEqual(Buffer.from(png, 'base64'));
    const saved = await persistConversation({
      userId: 'default', model: 'vision-model', effectiveSystemPrompt: 'Help',
      message: 'Explain this image', imageIds: [id], assistantContent: 'A test image',
      activePrompt: { name: 'default_chat', version: 1 }
    });
    const history = await http.request.get(`/api/history/${saved.conversation._id}`);
    expect(history.status).toBe(200);
    expect(history.body.data.messages[0].imageIds).toEqual([id]);
    expect(JSON.stringify(history.body)).not.toContain(png);
  });

  test('keeps the image on stopped or failed turns after a reload', async () => {
    const id = await upload();
    const saved = await persistTurnOutcome({
      userId: 'default', userMessage: 'Explain this', imageIds: [id],
      assistantContent: 'Choose a model with vision', clientTurnId: 'image-failed-1', outcome: 'failed'
    });
    const response = await http.request.get(`/api/history/${saved.conversationId}`);
    expect(response.body.data.messages[0].imageIds).toEqual([id]);
    expect(response.body.data.messages[1].metadata.retryable).toBe(true);
  });

  test('removes image bytes only when the last referencing conversation is deleted', async () => {
    const id = await upload();
    const first = await Conversation.create({ userId: 'default', messages: [{ role: 'user', content: 'First', imageIds: [id] }] });
    const second = await Conversation.create({ userId: 'default', messages: [{ role: 'user', content: 'Second', imageIds: [id] }] });
    expect((await http.request.delete(`/api/history/${first._id}`)).status).toBe(200);
    expect(await ChatImage.findById(id)).not.toBeNull();
    expect((await http.request.delete(`/api/history/${second._id}`)).status).toBe(200);
    expect(await ChatImage.findById(id)).toBeNull();
  });

  test('rejects invalid images without storing an attachment', async () => {
    const before = await ChatImage.countDocuments();
    const response = await http.request.post('/api/chat/images').send({ dataUrl: 'data:image/png;base64,dGV4dA==' });
    expect(response.status).toBe(400);
    expect(await ChatImage.countDocuments()).toBe(before);
  });
});
