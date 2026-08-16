'use strict';

const mongoose = require('mongoose');
const Conversation = require('../../models/Conversation');

const CONTRACT_VERSION = 1;
const STATUS = Object.freeze({
  ACTIVE: 'active',
  ARCHIVED: 'archived',
  ALL: 'all'
});

class ConversationLifecycleError extends Error {
  constructor(message, { code = 'CONVERSATION_LIFECYCLE_INVALID_REQUEST', statusCode = 400 } = {}) {
    super(message);
    this.name = 'ConversationLifecycleError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

function boundedRequiredString(value, field, maxLength = 200) {
  const normalized = String(value || '').trim();
  if (!normalized) throw new ConversationLifecycleError(`${field} is required`);
  if (normalized.length > maxLength) {
    throw new ConversationLifecycleError(`${field} must be at most ${maxLength} characters`);
  }
  return normalized;
}

function normalizeConversationId(value) {
  const normalized = String(value || '').trim();
  if (!mongoose.Types.ObjectId.isValid(normalized)) {
    throw new ConversationLifecycleError('conversationId is invalid', {
      code: 'CONVERSATION_ID_INVALID'
    });
  }
  return new mongoose.Types.ObjectId(normalized);
}

function normalizeStatus(value = STATUS.ACTIVE) {
  const normalized = String(value || STATUS.ACTIVE).toLowerCase();
  if (!Object.values(STATUS).includes(normalized)) {
    throw new ConversationLifecycleError('status must be active, archived, or all');
  }
  return normalized;
}

function boundedInteger(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(parsed)));
}

function scopeFilter({ userId, promptName, conversationId, status = STATUS.ALL } = {}) {
  const filter = {
    userId: boundedRequiredString(userId, 'userId'),
    promptName: boundedRequiredString(promptName, 'promptName', 120)
  };
  if (conversationId !== undefined) filter._id = normalizeConversationId(conversationId);

  const lifecycleStatus = normalizeStatus(status);
  if (lifecycleStatus === STATUS.ACTIVE) filter['lifecycle.status'] = { $ne: STATUS.ARCHIVED };
  if (lifecycleStatus === STATUS.ARCHIVED) filter['lifecycle.status'] = STATUS.ARCHIVED;
  return filter;
}

function lifecycleOf(document) {
  const raw = document?.lifecycle || {};
  const archived = raw.status === STATUS.ARCHIVED;
  return {
    status: archived ? STATUS.ARCHIVED : STATUS.ACTIVE,
    archivedAt: archived && raw.archivedAt ? raw.archivedAt : null
  };
}

function messageDto(message) {
  if (!message) return null;
  return {
    id: message._id ? String(message._id) : null,
    role: message.role,
    content: message.content,
    timestamp: message.timestamp || null,
    metadata: message.metadata || null,
    stats: message.stats || null,
    feedback: message.feedback || null,
    ragSources: message.ragSources || []
  };
}

function conversationDto(document, { includeMessages = false } = {}) {
  if (!document) return null;
  const raw = typeof document.toObject === 'function' ? document.toObject() : document;
  const lastMessage = raw.lastMessage || raw.messages?.[raw.messages.length - 1] || null;
  const dto = {
    id: String(raw._id),
    userId: raw.userId,
    promptName: raw.promptName,
    promptVersion: Number.isFinite(Number(raw.promptVersion)) ? Number(raw.promptVersion) : null,
    title: String(raw.title || 'New Conversation').slice(0, 120),
    model: raw.model || null,
    createdAt: raw.createdAt || null,
    updatedAt: raw.updatedAt || null,
    lifecycle: lifecycleOf(raw),
    messageCount: Number.isFinite(Number(raw.messageCount))
      ? Number(raw.messageCount)
      : Array.isArray(raw.messages) ? raw.messages.length : 0,
    preview: lastMessage?.content ? String(lastMessage.content).slice(0, 160) : ''
  };
  if (includeMessages) dto.messages = (raw.messages || []).map(messageDto);
  return dto;
}

function createConversationLifecycleService({ ConversationModel = Conversation, now = () => new Date() } = {}) {
  const capabilities = Object.freeze({
    provider: 'agentx-core',
    contractVersion: CONTRACT_VERSION,
    list: true,
    get: true,
    rename: true,
    archive: true,
    restore: true,
    permanentDelete: true,
    transcriptExport: true,
    sessionDigest: false
  });

  async function listConversations({ userId, promptName, status = STATUS.ACTIVE, page = 1, limit = 30 } = {}) {
    const filter = scopeFilter({ userId, promptName, status });
    const boundedPage = boundedInteger(page, 1, 1, 1000000);
    const boundedLimit = boundedInteger(limit, 30, 1, 100);
    const skip = (boundedPage - 1) * boundedLimit;

    const [items, total] = await Promise.all([
      ConversationModel.aggregate([
        { $match: filter },
        { $sort: { updatedAt: -1, _id: -1 } },
        { $skip: skip },
        { $limit: boundedLimit },
        {
          $project: {
            userId: 1,
            promptName: 1,
            promptVersion: 1,
            title: 1,
            model: 1,
            createdAt: 1,
            updatedAt: 1,
            lifecycle: 1,
            messageCount: { $size: { $ifNull: ['$messages', []] } },
            lastMessage: { $arrayElemAt: [{ $ifNull: ['$messages', []] }, -1] }
          }
        }
      ]),
      ConversationModel.countDocuments(filter)
    ]);

    return Object.freeze({
      items: items.map((item) => conversationDto(item)),
      page: boundedPage,
      limit: boundedLimit,
      total,
      hasMore: skip + items.length < total
    });
  }

  async function getConversation({ userId, promptName, conversationId, status = STATUS.ALL, includeMessages = true } = {}) {
    const filter = scopeFilter({ userId, promptName, conversationId, status });
    const projection = {
      userId: 1,
      promptName: 1,
      promptVersion: 1,
      title: 1,
      model: 1,
      createdAt: 1,
      updatedAt: 1,
      lifecycle: 1,
      ...(includeMessages ? { messages: 1 } : {})
    };
    const conversation = await ConversationModel.findOne(filter).select(projection).lean();
    return conversationDto(conversation, { includeMessages });
  }

  async function isConversationOwnedByPrompt({ userId, promptName, conversationId, status = STATUS.ALL } = {}) {
    const filter = scopeFilter({ userId, promptName, conversationId, status });
    return Boolean(await ConversationModel.exists(filter));
  }

  async function latestConversationMatchesPrompt({ userId, promptName } = {}) {
    const owner = boundedRequiredString(userId, 'userId');
    const expectedPrompt = boundedRequiredString(promptName, 'promptName', 120);
    const latest = await ConversationModel.findOne({ userId: owner })
      .sort({ updatedAt: -1, _id: -1 })
      .select({ promptName: 1 })
      .lean();
    return latest?.promptName === expectedPrompt;
  }

  async function listConversationIds({ userId, promptName, status = STATUS.ALL } = {}) {
    const filter = scopeFilter({ userId, promptName, status });
    const rows = await ConversationModel.find(filter).select({ _id: 1 }).lean();
    return rows.map((row) => String(row._id));
  }

  async function renameConversation({ userId, promptName, conversationId, title } = {}) {
    const filter = scopeFilter({ userId, promptName, conversationId });
    const normalizedTitle = boundedRequiredString(title, 'title', 120);
    const conversation = await ConversationModel.findOneAndUpdate(
      filter,
      { $set: { title: normalizedTitle, updatedAt: now() } },
      { new: true, runValidators: true }
    ).select({ userId: 1, promptName: 1, promptVersion: 1, title: 1, model: 1, createdAt: 1, updatedAt: 1, lifecycle: 1 });
    return conversationDto(conversation);
  }

  async function archiveConversation({ userId, promptName, conversationId } = {}) {
    const filter = scopeFilter({ userId, promptName, conversationId, status: STATUS.ACTIVE });
    const at = now();
    const conversation = await ConversationModel.findOneAndUpdate(
      filter,
      { $set: { 'lifecycle.status': STATUS.ARCHIVED, 'lifecycle.archivedAt': at, updatedAt: at } },
      { new: true, runValidators: true }
    ).select({ userId: 1, promptName: 1, promptVersion: 1, title: 1, model: 1, createdAt: 1, updatedAt: 1, lifecycle: 1 });
    return conversationDto(conversation);
  }

  async function restoreConversation({ userId, promptName, conversationId } = {}) {
    const filter = scopeFilter({ userId, promptName, conversationId, status: STATUS.ARCHIVED });
    const conversation = await ConversationModel.findOneAndUpdate(
      filter,
      { $set: { 'lifecycle.status': STATUS.ACTIVE, 'lifecycle.archivedAt': null, updatedAt: now() } },
      { new: true, runValidators: true }
    ).select({ userId: 1, promptName: 1, promptVersion: 1, title: 1, model: 1, createdAt: 1, updatedAt: 1, lifecycle: 1 });
    return conversationDto(conversation);
  }

  async function permanentlyDeleteConversation({ userId, promptName, conversationId } = {}) {
    const filter = scopeFilter({ userId, promptName, conversationId });
    const result = await ConversationModel.deleteOne(filter);
    return { deleted: result.deletedCount === 1 };
  }

  return Object.freeze({
    capabilities,
    listConversations,
    getConversation,
    isConversationOwnedByPrompt,
    latestConversationMatchesPrompt,
    listConversationIds,
    renameConversation,
    archiveConversation,
    restoreConversation,
    permanentlyDeleteConversation
  });
}

const conversationLifecycle = createConversationLifecycleService();

module.exports = {
  CONTRACT_VERSION,
  STATUS,
  ConversationLifecycleError,
  createConversationLifecycleService,
  conversationLifecycle,
  _testing: {
    scopeFilter,
    conversationDto,
    normalizeStatus
  }
};
