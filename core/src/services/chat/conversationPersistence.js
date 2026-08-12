/**
 * Conversation Persistence
 * Save/update conversation history with messages, metadata, and costs
 */

const Conversation = require('../../../models/Conversation');
const { calculateMessageCost, calculateConversationCost } = require('../costCalculator');
const logger = require('../../../config/logger');

async function findConversationForUpdate({ conversationId, userId }) {
    if (!conversationId || !userId) return null;

    return Conversation.findOne({
        _id: conversationId,
        userId
    });
}

/**
 * Build RAG source entries for assistant message tracking
 */
function buildRagSourceEntries(ragSources) {
    return ragSources.map(source => ({
        chunkId: source.documentId,
        score: source.score,
        excerpt: source.text,
        metadata: {
            filename: source.title,
            source: source.source,
            timestamp: new Date()
        },
        wasCompressed: source.wasCompressed === true,
        compressionRatio: Number.isFinite(source.compressionRatio) ? source.compressionRatio : 0
    }));
}

/**
 * Persist a chat conversation (both streaming and non-streaming)
 *
 * @param {Object} params - Conversation data
 * @param {string} params.userId - User ID
 * @param {string} params.conversationId - Existing conversation ID (or null)
 * @param {string} params.model - Model used
 * @param {string} params.effectiveSystemPrompt - Full system prompt
 * @param {string} params.message - User message
 * @param {string} params.assistantContent - Assistant response content
 * @param {Object} params.activePrompt - Active prompt config
 * @param {Object} params.metadata - Additional metadata (thinking, toolExecution, agent)
 * @param {Object} params.stats - Response stats
 * @param {boolean} params.ragUsed - Whether RAG was used
 * @param {boolean} params.useRag - Whether RAG was requested
 * @param {Array} params.ragSources - RAG source entries
 * @returns {Promise<Object>} { conversation, assistantMessageId }
 */
async function persistConversation(params) {
    const {
        userId, conversationId, model,
        effectiveSystemPrompt, message, assistantContent,
        activePrompt, metadata = {}, stats,
        ragUsed, useRag, ragSources
    } = params;

    let conversation;
    let assistantMessageId = null;

    try {
        if (conversationId) {
            conversation = await findConversationForUpdate({ conversationId, userId });
        }
        if (!conversation) {
            conversation = new Conversation({
                userId,
                model,
                systemPrompt: effectiveSystemPrompt,
                messages: []
            });
        }

        if (message && message.trim()) {
            conversation.messages.push({ role: 'user', content: message.trim() });
        }

        if (assistantContent && assistantContent.trim()) {
            const assistantMsg = conversation.messages.create({
                role: 'assistant',
                content: assistantContent.trim()
            });

            assistantMsg.metadata = {
                ...(metadata || {}),
                model,
                routingInfo: metadata.routingInfo || null
            };

            if (metadata.thinking) {
                assistantMsg.metadata.thinking = metadata.thinking;
            }

            if (metadata.toolExecution) {
                assistantMsg.metadata.toolExecution = metadata.toolExecution;
            }

            if (metadata.webSearchResults && Array.isArray(metadata.webSearchResults) && metadata.webSearchResults.length > 0) {
                assistantMsg.metadata.webSearchResults = metadata.webSearchResults;
            }

            if (ragUsed === true && Array.isArray(ragSources) && ragSources.length > 0) {
                assistantMsg.ragSources = buildRagSourceEntries(ragSources);
            }

            if (stats) {
                assistantMsg.stats = stats;
                assistantMsg.stats.parameters = metadata.options || {};
                assistantMsg.stats.meta = {
                    ...(assistantMsg.stats.meta || {}),
                    model,
                    routingInfo: metadata.routingInfo || null
                };

                try {
                    const cost = await calculateMessageCost(model, stats);
                    assistantMsg.cost = cost;
                    logger.debug('Message cost calculated', {
                        model, totalCost: cost.totalCost, source: cost.pricingSource?.source
                    });
                } catch (err) {
                    logger.error('Cost calculation failed', { model, error: err.message });
                }
            }

            conversation.messages.push(assistantMsg);
            assistantMessageId = assistantMsg._id;
        }

        if (conversation.messages.length <= 2) {
            conversation.title = (message || 'New Conversation').substring(0, 50);
        }

        conversation.ragRequested = conversation.ragRequested === true || useRag === true;
        conversation.ragUsed = conversation.ragUsed === true || ragUsed === true;

        if (ragUsed === true && Array.isArray(ragSources) && ragSources.length > 0) {
            conversation.ragSources = ragSources;
        }

        conversation.promptConfigId = activePrompt._id;
        conversation.promptName = activePrompt.name;
        conversation.promptVersion = (activePrompt.version == null || Number.isNaN(Number(activePrompt.version)))
            ? 1
            : Number(activePrompt.version);

        // Cost tracking
        try {
            const totalCost = calculateConversationCost(conversation.messages);
            conversation.totalCost = totalCost;
        } catch (err) {
            logger.error('Conversation cost calculation failed', { conversationId: conversation._id, error: err.message });
        }

        // Token usage tracking
        try {
            conversation.updateUsage();
            logger.info('Token usage updated', {
                conversationId: conversation._id,
                totalTokens: conversation.usage.totalTokens,
                estimatedCost: conversation.usage.estimatedCost
            });
        } catch (err) {
            logger.error('Token usage update failed', { error: err.message });
        }

        await conversation.save();
    } catch (err) {
        logger.error('Failed to save conversation', { error: err.message });
    }

    return { conversation, assistantMessageId };
}

module.exports = { persistConversation, buildRagSourceEntries, findConversationForUpdate };
