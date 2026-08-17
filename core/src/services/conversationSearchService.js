/**
 * Conversation Search Service
 *
 * Provides advanced search and filtering capabilities for conversations:
 * - Full-text search across titles and message content
 * - Tag management (add, remove, autocomplete)
 * - Multi-dimensional filtering (model, date, RAG, feedback)
 * - Pagination with relevance scoring
 *
 * @module services/conversationSearchService
 */

const Conversation = require('../../models/Conversation');
const logger = require('../../config/logger');

/**
 * Search conversations with advanced filtering and pagination
 *
 * @param {Object} options - Search options
 * @param {string} options.userId - User ID (required)
 * @param {string} [options.query] - Full-text search query
 * @param {Array<string>} [options.models] - Filter by model names
 * @param {string} [options.dateFrom] - Start date (ISO 8601)
 * @param {string} [options.dateTo] - End date (ISO 8601)
 * @param {boolean} [options.ragOnly] - Only conversations with RAG
 * @param {number} [options.feedbackRating] - Filter by feedback (1, -1, 0)
 * @param {Array<string>} [options.tags] - Filter by tags (AND logic)
 * @param {string} [options.sortBy='relevance'] - Sort order (relevance, date, model, feedback)
 * @param {number} [options.page=1] - Page number (1-indexed)
 * @param {number} [options.limit=20] - Results per page
 * @returns {Promise<Object>} - Search results with pagination metadata
 */
async function searchConversations(options) {
  const {
    userId,
    query,
    models = [],
    dateFrom,
    dateTo,
    ragOnly,
    feedbackRating,
    tags = [],
    sortBy = 'relevance',
    page = 1,
    limit = 20
  } = options;

  try {
    const textQuery = typeof query === 'string' ? query.trim() : '';
    const hasTextSearch = textQuery.length > 0;

    // Build aggregation pipeline
    const pipeline = [];

    // Stage 1: Match base filters and optional text search.
    // MongoDB requires $text to be inside the first $match stage in a pipeline.
    const matchStage = buildMatchStage({
      userId,
      models,
      dateFrom,
      dateTo,
      ragOnly,
      feedbackRating,
      tags
    });
    if (hasTextSearch) {
      matchStage.$text = { $search: textQuery };
    }
    pipeline.push({ $match: matchStage });

    // Stage 2: Add text score for relevance sorting (if query provided)
    if (hasTextSearch) {
      // Add text score for relevance sorting
      pipeline.push({
        $addFields: {
          textScore: { $meta: 'textScore' }
        }
      });
    }

    // Stage 3: Add computed fields for sorting/display
    pipeline.push({
      $addFields: {
        messageCount: { $size: '$messages' },
        lastMessageDate: { $arrayElemAt: ['$messages.timestamp', -1] },
        // Calculate average feedback rating
        avgFeedback: {
          $avg: {
            $filter: {
              input: '$messages.feedback.rating',
              as: 'rating',
              cond: { $ne: ['$$rating', 0] }
            }
          }
        }
      }
    });

    // Stage 4: Sort results
    const sortStage = buildSortStage(sortBy, hasTextSearch);
    pipeline.push({ $sort: sortStage });

    // Stage 5: Pagination
    const skip = (page - 1) * limit;
    pipeline.push({ $skip: skip });
    pipeline.push({ $limit: limit });

    // Stage 6: Project only needed fields (reduce payload)
    pipeline.push({
      $project: {
        title: 1,
        model: 1,
        createdAt: 1,
        updatedAt: 1,
        ragUsed: 1,
        ragRequested: 1,
        tags: 1,
        messageCount: 1,
        lastMessageDate: 1,
        avgFeedback: 1,
        textScore: 1,
        // Include preview of first user message and last assistant message
        preview: {
          $let: {
            vars: {
              userMsgs: {
                $filter: {
                  input: '$messages',
                  as: 'msg',
                  cond: { $eq: ['$$msg.role', 'user'] }
                }
              },
              assistantMsgs: {
                $filter: {
                  input: '$messages',
                  as: 'msg',
                  cond: { $eq: ['$$msg.role', 'assistant'] }
                }
              }
            },
            in: {
              firstUserMessage: {
                $substr: [
                  { $arrayElemAt: ['$$userMsgs.content', 0] },
                  0,
                  100
                ]
              },
              lastAssistantMessage: {
                $substr: [
                  { $arrayElemAt: ['$$assistantMsgs.content', -1] },
                  0,
                  150
                ]
              }
            }
          }
        }
      }
    });

    // Execute search
    const results = await Conversation.aggregate(pipeline);

    // Get total count for pagination (run count query separately)
    const countPipeline = [
      { $match: matchStage }
    ];
    countPipeline.push({ $count: 'total' });

    const countResult = await Conversation.aggregate(countPipeline);
    const totalResults = countResult.length > 0 ? countResult[0].total : 0;

    // Calculate pagination metadata
    const totalPages = Math.ceil(totalResults / limit);
    const hasNextPage = page < totalPages;
    const hasPreviousPage = page > 1;

    return {
      status: 'success',
      data: {
        results,
        pagination: {
          currentPage: page,
          totalPages,
          totalResults,
          resultsPerPage: limit,
          hasNextPage,
          hasPreviousPage
        },
        filters: {
          query: query || null,
          models,
          dateFrom: dateFrom || null,
          dateTo: dateTo || null,
          ragOnly: ragOnly || false,
          feedbackRating: feedbackRating !== undefined ? feedbackRating : null,
          tags,
          sortBy
        }
      }
    };

  } catch (error) {
    logger.error('Conversation search failed', {
      error: error.message,
      userId,
      query
    });
    throw error;
  }
}

/**
 * Build MongoDB match stage with all filters
 *
 * @private
 * @param {Object} filters - Filter options
 * @returns {Object} - MongoDB match object
 */
function buildMatchStage(filters) {
  const {
    userId,
    models,
    dateFrom,
    dateTo,
    ragOnly,
    feedbackRating,
    tags
  } = filters;

  const match = {
    userId,
    'lifecycle.status': { $ne: 'archived' }
  };

  // Model filter (multiple models - OR logic)
  if (models && models.length > 0) {
    match.model = { $in: models };
  }

  // Date range filter
  if (dateFrom || dateTo) {
    match.createdAt = {};
    if (dateFrom) {
      match.createdAt.$gte = new Date(dateFrom);
    }
    if (dateTo) {
      match.createdAt.$lte = new Date(dateTo);
    }
  }

  // RAG filter
  if (ragOnly === true) {
    match.ragUsed = true;
  }

  // Feedback rating filter
  if (feedbackRating !== undefined && feedbackRating !== null) {
    match['messages.feedback.rating'] = feedbackRating;
  }

  // Tags filter (AND logic - conversation must have ALL specified tags)
  if (tags && tags.length > 0) {
    match.tags = { $all: tags };
  }

  return match;
}

/**
 * Build MongoDB sort stage based on sort option
 *
 * @private
 * @param {string} sortBy - Sort option
 * @param {boolean} hasTextSearch - Whether text search is active
 * @returns {Object} - MongoDB sort object
 */
function buildSortStage(sortBy, hasTextSearch) {
  switch (sortBy) {
    case 'relevance':
      // If text search active, sort by text score first
      if (hasTextSearch) {
        return { textScore: -1, updatedAt: -1 };
      }
      // Otherwise, most recently updated first
      return { updatedAt: -1 };

    case 'date_desc':
      return { createdAt: -1 };

    case 'date_asc':
      return { createdAt: 1 };

    case 'model':
      return { model: 1, updatedAt: -1 };

    case 'feedback':
      return { avgFeedback: -1, updatedAt: -1 };

    case 'messages':
      return { messageCount: -1, updatedAt: -1 };

    default:
      return { updatedAt: -1 };
  }
}

/**
 * Add tags to a conversation
 *
 * @param {Object} options - Tag options
 * @param {string} options.conversationId - Conversation ID
 * @param {string} options.userId - User ID (for security)
 * @param {Array<string>} options.tags - Tags to add
 * @returns {Promise<Object>} - Updated conversation
 */
async function addTagsToConversation(options) {
  const { conversationId, userId, tags } = options;

  try {
    // Validate input
    if (!conversationId || !userId || !tags || tags.length === 0) {
      throw new Error('Missing required fields: conversationId, userId, tags');
    }

    // Build security query
    const query = { _id: conversationId, userId };

    // Normalize tags (lowercase, trim, deduplicate)
    const normalizedTags = [...new Set(
      tags.map(tag => tag.toLowerCase().trim()).filter(tag => tag.length > 0)
    )];

    // Add tags using $addToSet (prevents duplicates)
    const conversation = await Conversation.findOneAndUpdate(
      query,
      {
        $addToSet: { tags: { $each: normalizedTags } },
        $set: { updatedAt: Date.now() }
      },
      { new: true, select: 'tags title updatedAt' }
    );

    if (!conversation) {
      throw new Error('Conversation not found or access denied');
    }

    logger.info('Tags added to conversation', {
      conversationId,
      userId,
      tagsAdded: normalizedTags,
      totalTags: conversation.tags.length
    });

    return {
      status: 'success',
      data: {
        conversationId: conversation._id,
        tags: conversation.tags,
        updatedAt: conversation.updatedAt
      }
    };

  } catch (error) {
    logger.error('Failed to add tags', {
      error: error.message,
      conversationId,
      userId
    });
    throw error;
  }
}

/**
 * Remove tags from a conversation
 *
 * @param {Object} options - Tag options
 * @param {string} options.conversationId - Conversation ID
 * @param {string} options.userId - User ID (for security)
 * @param {Array<string>} options.tags - Tags to remove
 * @returns {Promise<Object>} - Updated conversation
 */
async function removeTagsFromConversation(options) {
  const { conversationId, userId, tags } = options;

  try {
    // Validate input
    if (!conversationId || !userId || !tags || tags.length === 0) {
      throw new Error('Missing required fields: conversationId, userId, tags');
    }

    // Build security query
    const query = { _id: conversationId, userId };

    // Normalize tags
    const normalizedTags = tags.map(tag => tag.toLowerCase().trim()).filter(tag => tag.length > 0);

    // Remove tags using $pull
    const conversation = await Conversation.findOneAndUpdate(
      query,
      {
        $pull: { tags: { $in: normalizedTags } },
        $set: { updatedAt: Date.now() }
      },
      { new: true, select: 'tags title updatedAt' }
    );

    if (!conversation) {
      throw new Error('Conversation not found or access denied');
    }

    logger.info('Tags removed from conversation', {
      conversationId,
      userId,
      tagsRemoved: normalizedTags,
      remainingTags: conversation.tags.length
    });

    return {
      status: 'success',
      data: {
        conversationId: conversation._id,
        tags: conversation.tags,
        updatedAt: conversation.updatedAt
      }
    };

  } catch (error) {
    logger.error('Failed to remove tags', {
      error: error.message,
      conversationId,
      userId
    });
    throw error;
  }
}

/**
 * Get all unique tags for a user (for autocomplete)
 *
 * @param {Object} options - Query options
 * @param {string} options.userId - User ID
 * @param {string} [options.prefix] - Filter tags by prefix (for autocomplete)
 * @param {number} [options.limit=50] - Max tags to return
 * @returns {Promise<Object>} - List of tags with usage counts
 */
async function getUserTags(options) {
  const { userId, prefix, limit = 50 } = options;

  try {
    // Build aggregation pipeline
    const pipeline = [];

    // Stage 1: Match user's conversations
    pipeline.push({ $match: { userId } });

    // Stage 2: Unwind tags array
    pipeline.push({ $unwind: '$tags' });

    // Stage 3: Filter by prefix if provided
    if (prefix && prefix.trim()) {
      pipeline.push({
        $match: {
          tags: { $regex: `^${prefix.toLowerCase().trim()}`, $options: 'i' }
        }
      });
    }

    // Stage 4: Group and count
    pipeline.push({
      $group: {
        _id: '$tags',
        count: { $sum: 1 },
        lastUsed: { $max: '$updatedAt' }
      }
    });

    // Stage 5: Sort by usage count (most used first)
    pipeline.push({ $sort: { count: -1, lastUsed: -1 } });

    // Stage 6: Limit results
    pipeline.push({ $limit: limit });

    // Stage 7: Reshape output
    pipeline.push({
      $project: {
        _id: 0,
        tag: '$_id',
        count: 1,
        lastUsed: 1
      }
    });

    const tags = await Conversation.aggregate(pipeline);

    return {
      status: 'success',
      data: {
        tags,
        total: tags.length
      }
    };

  } catch (error) {
    logger.error('Failed to get user tags', {
      error: error.message,
      userId
    });
    throw error;
  }
}

module.exports = {
  searchConversations,
  addTagsToConversation,
  removeTagsFromConversation,
  getUserTags
};
