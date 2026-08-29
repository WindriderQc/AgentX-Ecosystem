const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const Conversation = require('../models/Conversation');
const { getUserId } = require('../src/helpers/userHelpers');
const conversationSearchService = require('../src/services/conversationSearchService');
const {
    isPlaygroundConversation,
    withPlaygroundHistoryFilter
} = require('../src/services/conversationSurfacePolicy');
const logger = require('../config/logger');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

function publicId(value) {
    if (value === null || value === undefined) return null;
    if (typeof value.toHexString === 'function') return value.toHexString();
    return String(value);
}

function publicDate(value) {
    if (value === null || value === undefined) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function publicMessage(message) {
    const raw = typeof message?.toObject === 'function' ? message.toObject() : { ...message };
    return {
        ...raw,
        _id: publicId(raw._id),
        timestamp: publicDate(raw.timestamp || raw.createdAt),
    };
}

function publicConversation(conversation) {
    const raw = typeof conversation?.toObject === 'function' ? conversation.toObject() : { ...conversation };
    return {
        ...raw,
        _id: publicId(raw._id),
        createdAt: publicDate(raw.createdAt),
        updatedAt: publicDate(raw.updatedAt),
        messages: Array.isArray(raw.messages) ? raw.messages.map(publicMessage) : [],
    };
}

// ============================================================================
// IMPORTANT: Named GET routes MUST come BEFORE /:id to avoid route shadowing.
// Express matches top-to-bottom; /:id would catch /search, /tags, etc.
// ============================================================================

/**
 * CREATE / APPEND: Save messages to an Agent X conversation.
 * POST /api/history
 * Body: { conversationId?, model, source?, clientRef?, messages: [{role, content}] }
 */
router.post('/', async (req, res) => {
    try {
        const userId = getUserId(res);
        const { conversationId, model, source, clientRef, messages } = req.body;

        if (!messages || !Array.isArray(messages) || messages.length === 0) {
            return res.status(400).json({ status: 'error', message: 'messages array is required' });
        }

        const stamped = messages.map(m => ({
            role: m.role,
            content: m.content,
            timestamp: new Date()
        }));

        let conv;
        if (conversationId && mongoose.Types.ObjectId.isValid(conversationId)) {
            conv = await Conversation.findOne({
                _id: conversationId,
                userId,
                'lifecycle.status': { $ne: 'archived' }
            });
            if (conv) {
                conv.messages.push(...stamped);
                conv.updatedAt = new Date();
                await conv.save();
            }
        }

        if (!conv) {
            const title = messages[0]?.content?.slice(0, 60) || 'Agent X Chat';
            conv = await Conversation.create({
                userId,
                model: model || 'unknown',
                source: source || 'agentx',
                clientRef: clientRef || undefined,
                messages: stamped,
                title,
            });
        }

        res.json({ status: 'success', data: { conversationId: publicId(conv._id) } });
    } catch (err) {
        logger.error('Failed to save conversation:', err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// HISTORY: Get list (workspace-aware)
router.get('/', async (req, res) => {
    try {
        const userId = getUserId(res);
        const query = withPlaygroundHistoryFilter({
            userId,
            'lifecycle.status': { $ne: 'archived' }
        });

        const conversations = await Conversation.find(query)
            .sort({ updatedAt: -1 })
            .limit(50)
            .select('title updatedAt model messages quality_assessment.overall_score quality_assessment.judged_at');

        const previews = conversations.filter(isPlaygroundConversation).map(c => {
            const lastMessage = c.messages && c.messages.length > 0
                ? c.messages[c.messages.length - 1]
                : null;
            const previewText = lastMessage?.content
                ? lastMessage.content.substring(0, 60) + '...'
                : '';

            return {
                id: publicId(c._id),
                title: c.title,
                date: publicDate(c.updatedAt),
                model: c.model,
                preview: previewText,
                qualityScore: c.quality_assessment?.overall_score ?? null
            };
        });

        res.json({ status: 'success', data: previews });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// LOGS - Get latest conversation messages (workspace-aware)
router.get('/logs', async (req, res) => {
    try {
        const userId = getUserId(res);
        const query = withPlaygroundHistoryFilter({
            userId,
            'lifecycle.status': { $ne: 'archived' }
        });

        const conversation = await Conversation.findOne(query)
            .sort({ updatedAt: -1 });

        if (!conversation) {
            return res.json({ status: 'success', data: { messages: [] } });
        }

        res.json({ status: 'success', data: { messages: conversation.messages.map(publicMessage) } });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================================================
// V7: SEARCH & TAG MANAGEMENT ENDPOINTS
// ============================================================================

/**
 * SEARCH: Advanced conversation search with filtering
 * GET /api/history/search
 */
router.get('/search', async (req, res) => {
    try {
        const userId = getUserId(res);

        const {
            q: query,
            models,
            dateFrom,
            dateTo,
            ragOnly,
            feedbackRating,
            tags,
            sortBy = 'relevance',
            page = '1',
            limit = '20'
        } = req.query;

        const modelArray = models ? models.split(',').map(m => m.trim()).filter(m => m) : [];
        const tagArray = tags ? tags.split(',').map(t => t.trim()).filter(t => t) : [];

        const pageNum = Math.max(1, parseInt(page, 10) || 1);
        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
        const feedbackNum = feedbackRating !== undefined ? parseInt(feedbackRating, 10) : undefined;

        const ragOnlyBool = ragOnly === 'true';

        const searchOptions = {
            userId,
            query,
            models: modelArray,
            dateFrom,
            dateTo,
            ragOnly: ragOnlyBool,
            feedbackRating: feedbackNum,
            tags: tagArray,
            sortBy,
            page: pageNum,
            limit: limitNum
        };

        const result = await conversationSearchService.searchConversations(searchOptions);

        logger.info('Conversation search executed', {
            userId,
            query,
            resultsCount: result.data.results.length,
            totalResults: result.data.pagination.totalResults
        });

        res.json(result);

    } catch (err) {
        logger.error('Conversation search failed', {
            error: err.message,
            userId: getUserId(res),
            query: req.query
        });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * TAGS: Get all user tags (for autocomplete)
 * GET /api/history/tags
 */
router.get('/tags', async (req, res) => {
    try {
        const userId = getUserId(res);
        const { prefix, limit = '50' } = req.query;

        const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));

        const result = await conversationSearchService.getUserTags({
            userId,
            prefix,
            limit: limitNum
        });

        res.json(result);

    } catch (err) {
        logger.error('Failed to get user tags', {
            error: err.message,
            userId: getUserId(res)
        });
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// Route aliases for backwards compatibility
router.get('/conversations', async (req, res) => {
    try {
        const userId = getUserId(res);
        const query = withPlaygroundHistoryFilter({
            userId,
            'lifecycle.status': { $ne: 'archived' }
        });

        const conversations = await Conversation.find(query)
            .sort({ updatedAt: -1 })
            .limit(50)
            .select('title updatedAt model messages');

        const previews = conversations.filter(isPlaygroundConversation).map(c => ({
            id: publicId(c._id),
            title: c.title,
            date: publicDate(c.updatedAt),
            model: c.model,
            messageCount: c.messages?.length || 0
        }));

        res.json({ status: 'success', data: previews });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

router.get('/conversations/:id', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid conversation ID format' });
        }

        const userId = getUserId(res);
        const query = { _id: new mongoose.Types.ObjectId(req.params.id), userId };

        const conversation = await Conversation.findOne(query);

        if (!conversation) {
            return res.status(404).json({ status: 'error', message: 'Conversation not found' });
        }

        res.json({ status: 'success', data: publicConversation(conversation) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ============================================================================
// Parameterized routes LAST — /:id matches any path segment
// ============================================================================

// HISTORY: Get single conversation
router.get('/:id', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid conversation ID format' });
        }

        const userId = getUserId(res);
        const query = { _id: new mongoose.Types.ObjectId(req.params.id), userId };

        const conversation = await Conversation.findOne(query);

        if (!conversation) {
            return res.status(404).json({ status: 'error', message: 'Conversation not found' });
        }

        res.json({ status: 'success', data: publicConversation(conversation) });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * TAGS: Add tags to a conversation
 * POST /api/history/:id/tags
 */
router.post('/:id/tags', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid conversation ID format' });
        }

        const userId = getUserId(res);
        const { tags } = req.body;

        if (!tags || !Array.isArray(tags) || tags.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Tags array is required and must not be empty'
            });
        }

        const result = await conversationSearchService.addTagsToConversation({
            conversationId: req.params.id,
            userId,
            tags
        });

        res.json(result);

    } catch (err) {
        logger.error('Failed to add tags', {
            error: err.message,
            conversationId: req.params.id,
            userId: getUserId(res)
        });

        if (err.message.includes('not found') || err.message.includes('access denied')) {
            return res.status(404).json({ status: 'error', message: err.message });
        }

        res.status(500).json({ status: 'error', message: err.message });
    }
});

/**
 * TAGS: Remove tags from a conversation
 * DELETE /api/history/:id/tags
 */
router.delete('/:id/tags', async (req, res) => {
    try {
        if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
            return res.status(400).json({ status: 'error', message: 'Invalid conversation ID format' });
        }

        const userId = getUserId(res);
        const { tags } = req.body;

        if (!tags || !Array.isArray(tags) || tags.length === 0) {
            return res.status(400).json({
                status: 'error',
                message: 'Tags array is required and must not be empty'
            });
        }

        if (!requireTypedConfirmation(req, res, 'REMOVE CONVERSATION TAGS', req.params.id)) return;

        const result = await conversationSearchService.removeTagsFromConversation({
            conversationId: req.params.id,
            userId,
            tags
        });

        res.json(result);

    } catch (err) {
        logger.error('Failed to remove tags', {
            error: err.message,
            conversationId: req.params.id,
            userId: getUserId(res)
        });

        if (err.message.includes('not found') || err.message.includes('access denied')) {
            return res.status(404).json({ status: 'error', message: err.message });
        }

        res.status(500).json({ status: 'error', message: err.message });
    }
});

module.exports = router;
