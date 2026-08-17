const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');
const {
  ConversationLifecycleError,
  createConversationLifecycleService
} = require('../../src/services/conversationLifecycleService');

describe('conversationLifecycleService', () => {
  const userId = 'conversation-lifecycle-test';
  const otherUserId = 'conversation-lifecycle-other';
  const promptName = 'psyx';
  const service = createConversationLifecycleService({
    now: () => new Date('2026-08-16T02:30:00.000Z')
  });

  beforeEach(async () => {
    await Conversation.deleteMany({ userId: { $in: [userId, otherUserId] } });
  });

  afterAll(async () => {
    await Conversation.deleteMany({ userId: { $in: [userId, otherUserId] } });
  });

  async function createConversation(overrides = {}) {
    return Conversation.create({
      userId,
      promptName,
      promptVersion: 2,
      title: 'Private session',
      model: 'test-model',
      messages: [
        { role: 'user', content: 'Sensitive user statement' },
        { role: 'assistant', content: 'Bounded response', metadata: { provenance: 'psyx_response' } }
      ],
      ...overrides
    });
  }

  test('lists and retrieves only the requested owner and prompt with transcript provenance intact', async () => {
    const target = await createConversation();
    await createConversation({ promptName: 'default_chat', title: 'Ordinary chat' });
    await createConversation({ userId: otherUserId, title: 'Other owner' });

    const list = await service.listConversations({ userId, promptName });
    expect(list.total).toBe(1);
    expect(list.items).toEqual([
      expect.objectContaining({
        id: String(target._id),
        promptName,
        lifecycle: { status: 'active', archivedAt: null },
        messageCount: 2,
        preview: 'Bounded response'
      })
    ]);

    const conversation = await service.getConversation({
      userId,
      promptName,
      conversationId: target._id
    });
    expect(conversation.messages).toHaveLength(2);
    expect(conversation.messages[1].metadata).toEqual(expect.objectContaining({
      provenance: 'psyx_response'
    }));
    expect(await service.isConversationOwnedByPrompt({
      userId,
      promptName,
      conversationId: target._id
    })).toBe(true);
    expect(await service.isConversationOwnedByPrompt({
      userId: otherUserId,
      promptName,
      conversationId: target._id
    })).toBe(false);
  });

  test('archives, restores, renames, and permanently deletes within the same scope', async () => {
    const target = await createConversation();

    const renamed = await service.renameConversation({
      userId,
      promptName,
      conversationId: target._id,
      title: 'Renamed PsyX session'
    });
    expect(renamed.title).toBe('Renamed PsyX session');

    const archived = await service.archiveConversation({ userId, promptName, conversationId: target._id });
    expect(archived.lifecycle).toEqual({
      status: 'archived',
      archivedAt: new Date('2026-08-16T02:30:00.000Z')
    });
    expect((await service.listConversations({ userId, promptName })).items).toHaveLength(0);
    expect((await service.listConversations({ userId, promptName, status: 'archived' })).items).toHaveLength(1);

    const restored = await service.restoreConversation({ userId, promptName, conversationId: target._id });
    expect(restored.lifecycle).toEqual({ status: 'active', archivedAt: null });

    const deleted = await service.permanentlyDeleteConversation({ userId, promptName, conversationId: target._id });
    expect(deleted.deleted).toBe(true);
    expect(await Conversation.exists({ _id: target._id })).toBeNull();
  });

  test('treats legacy rows without lifecycle metadata as active', async () => {
    const result = await mongoose.connection.collection('conversations').insertOne({
      userId,
      promptName,
      title: 'Legacy session',
      messages: [],
      createdAt: new Date(),
      updatedAt: new Date()
    });

    const list = await service.listConversations({ userId, promptName });
    expect(list.items).toEqual([
      expect.objectContaining({
        id: String(result.insertedId),
        lifecycle: { status: 'active', archivedAt: null }
      })
    ]);
  });

  test('wrong prompt cannot mutate or delete a conversation', async () => {
    const target = await createConversation();
    expect(await service.renameConversation({
      userId,
      promptName: 'default_chat',
      conversationId: target._id,
      title: 'Leaked'
    })).toBeNull();
    expect((await service.permanentlyDeleteConversation({
      userId,
      promptName: 'default_chat',
      conversationId: target._id
    })).deleted).toBe(false);
    expect(await Conversation.exists({ _id: target._id })).not.toBeNull();
  });

  test('rejects malformed scope and identifiers before querying', async () => {
    await expect(service.listConversations({ userId: '', promptName }))
      .rejects.toBeInstanceOf(ConversationLifecycleError);
    await expect(service.getConversation({ userId, promptName, conversationId: 'not-an-id' }))
      .rejects.toMatchObject({ code: 'CONVERSATION_ID_INVALID', statusCode: 400 });
  });
});
