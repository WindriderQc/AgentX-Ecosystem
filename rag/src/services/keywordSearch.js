/**
 * Keyword Search — BM25-like scoring for full-text search across document chunks.
 *
 * Ported from legacy AgentX ragStore.keywordSearch().
 * Scores: termFrequency * positionBonus (earlier terms weighted higher).
 * Returns normalized 0-1 scores.
 */

'use strict';

const logger = require('../../config/logger');

/**
 * Calculate BM25-like relevance score for a chunk against query terms.
 *
 * @param {string} text - Chunk text (lowercased)
 * @param {string[]} queryTerms - Lowercased query terms (length > 2)
 * @returns {number} Raw score (0 = no match)
 */
function scoreChunk(text, queryTerms) {
  let score = 0;

  for (const term of queryTerms) {
    const regex = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    const matches = text.match(regex);
    const termCount = matches ? matches.length : 0;

    if (termCount > 0) {
      const firstPos = text.indexOf(term);
      // Position bonus: earlier occurrence = higher bonus
      const positionBonus = firstPos >= 0 ? (1.0 - (firstPos / text.length) * 0.5) : 1.0;
      score += termCount * positionBonus;
    }
  }

  return score;
}

/**
 * Run keyword search across all documents in the vector store.
 *
 * @param {object} vectorStore - VectorStoreAdapter instance
 * @param {string} query - Search query
 * @param {object} options - { topK, filters }
 * @returns {Promise<Array<{text: string, score: number, metadata: object}>>}
 */
async function keywordSearch(vectorStore, query, options = {}) {
  const topK = options.topK || 10;
  const filters = options.filters || {};

  try {
    if (typeof vectorStore.getDocumentChunks !== 'function') {
      logger.warn('Keyword search not supported by current vector store adapter');
      return [];
    }

    const { documents: allDocuments } = await vectorStore.listDocuments(filters);

    if (!allDocuments || allDocuments.length === 0) {
      return [];
    }

    // Tokenize query — only terms with length > 2
    const queryTerms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
    if (queryTerms.length === 0) {
      return [];
    }

    const results = [];

    for (const doc of allDocuments) {
      const docId = doc.documentId || doc.id;
      if (!docId) continue;

      const chunks = await vectorStore.getDocumentChunks(docId);
      if (!chunks) continue;

      for (const chunk of chunks) {
        if (!chunk || typeof chunk.text !== 'string') continue;

        const text = chunk.text.toLowerCase();
        const rawScore = scoreChunk(text, queryTerms);

        if (rawScore > 0) {
          results.push({
            text: chunk.text,
            score: Math.min(rawScore / 10, 1.0), // Normalize to 0-1
            metadata: {
              documentId: docId,
              chunkIndex: chunk.chunkIndex || 0,
              source: doc.source,
              title: doc.title,
              searchType: 'keyword'
            }
          });
        }
      }
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

  } catch (error) {
    logger.error('Keyword search error', { error: error.message });
    return [];
  }
}

module.exports = { keywordSearch, scoreChunk };
