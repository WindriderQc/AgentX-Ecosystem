const express = require('express');
const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');
const { startTestHttpHarness } = require('../helpers/testHttpServer');

let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    res.locals.user = { userId: 'history-owner' };
    next();
  });
  app.use('/api/history', require('../../routes/history'));
  harness = await startTestHttpHarness(app, {
    maxSockets: 4,
    transport: process.platform === 'win32' ? 'pipe' : 'tcp'
  });
});
afterAll(async () => { await harness?.close(); });
afterEach(() => jest.restoreAllMocks());

function createConversation(overrides = {}) {
  return Conversation.create({
    userId: 'history-owner', title: 'Original title', model: 'fixture-model',
    messages: [{ role: 'user', content: 'A fictional chat fixture.' }],
    ...overrides
  });
}

test('rename changes only the title, keeps messages and appears in history', async () => {
  const conversation = await createConversation();
  const response = await harness.request.patch(`/api/history/${conversation.id}`)
    .send({ title: '  New title  ', userId: 'other-user', messages: [] }).expect(200);
  expect(response.body.data).toEqual({ conversationId: conversation.id, title: 'New title' });
  const retained = await Conversation.findById(conversation.id);
  expect(retained.userId).toBe('history-owner');
  expect(retained.messages.map(message => message.content)).toEqual(['A fictional chat fixture.']);
  const history = await harness.request.get('/api/history').expect(200);
  expect(history.body.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: conversation.id, title: 'New title' })]));
});

test.each([undefined, '', '   ', 7, { $set: 'injected' }, 'x'.repeat(121)])('rename rejects an invalid title: %p', async title => {
  const conversation = await createConversation();
  await harness.request.patch(`/api/history/${conversation.id}`).send({ title }).expect(400);
  expect((await Conversation.findById(conversation.id)).title).toBe('Original title');
});

test('delete removes only the selected conversation and its history row', async () => {
  const target = await createConversation();
  const survivor = await createConversation({ title: 'Keep me' });
  const response = await harness.request.delete(`/api/history/${target.id}`).expect(200);
  expect(response.body.data).toEqual({ conversationId: target.id, deleted: true });
  expect(await Conversation.findById(target.id)).toBeNull();
  expect(await Conversation.findById(survivor.id)).not.toBeNull();
  const history = await harness.request.get('/api/history').expect(200);
  expect(history.body.data.some(item => item.id === target.id)).toBe(false);
  await harness.request.delete(`/api/history/${target.id}`).expect(404);
});

describe.each(['patch', 'delete'])('%s history scope', method => {
  function mutate(id) {
    const request = harness.request[method](`/api/history/${id}`);
    return method === 'patch' ? request.send({ title: 'Changed' }) : request;
  }

  test('invalid and unknown IDs do not report success', async () => {
    await mutate('not-an-object-id').expect(400);
    await mutate(new mongoose.Types.ObjectId().toString()).expect(404);
  });

  test.each([
    { userId: 'another-owner' },
    { lifecycle: { status: 'archived', archivedAt: new Date() } },
    { tags: ['agentx:internal-probe'] },
    { source: 'external', clientRef: 'benchmark-canary:test' },
    { title: 'Reply exactly FINAL_CORE_FIXTURE_OK' }
  ])('leaves conversations outside the visible owner scope unchanged: %p', async overrides => {
    const conversation = await createConversation(overrides);
    await mutate(conversation.id).expect(404);
    const retained = await Conversation.findById(conversation.id);
    expect(retained).not.toBeNull();
    expect(retained.title).toBe(conversation.title);
  });

  test('database failure is reported without changing the record', async () => {
    const conversation = await createConversation();
    const dbMethod = method === 'patch' ? 'findOneAndUpdate' : 'findOneAndDelete';
    jest.spyOn(Conversation, dbMethod).mockReturnValueOnce({ select: () => Promise.reject(new Error('fixture failure')) });
    await mutate(conversation.id).expect(500);
    expect((await Conversation.findById(conversation.id)).title).toBe('Original title');
  });
});
