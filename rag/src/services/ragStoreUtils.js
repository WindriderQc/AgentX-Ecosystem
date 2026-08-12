'use strict';
/**
 * RAG Store Utilities — pure helper functions.
 */

const crypto = require('crypto');
const logger = require('../../config/logger');

function generateDocumentId(source, filePath) {
  const combined = `${source}:${filePath}`;
  return crypto.createHash('md5').update(combined).digest('hex');
}

function hashText(text) {
  return crypto.createHash('md5').update(text).digest('hex');
}

function splitIntoChunks(text, chunkSize, chunkOverlap) {
  if (typeof text !== 'string') {
    throw new Error('splitIntoChunks: text must be a string');
  }
  if (chunkSize <= 0 || !Number.isFinite(chunkSize)) {
    throw new Error(`splitIntoChunks: chunkSize must be a positive number, got ${chunkSize}`);
  }
  if (chunkOverlap < 0 || !Number.isFinite(chunkOverlap)) {
    throw new Error(`splitIntoChunks: chunkOverlap must be a non-negative number, got ${chunkOverlap}`);
  }
  if (chunkOverlap >= chunkSize) {
    throw new Error(`splitIntoChunks: chunkOverlap (${chunkOverlap}) must be less than chunkSize (${chunkSize})`);
  }

  const chunks = [];
  let start = 0;
  const MAX_CHUNKS = 10000;

  while (start < text.length) {
    if (chunks.length >= MAX_CHUNKS) {
      logger.error('Chunking safety limit reached', {
        chunkCount: chunks.length, chunkSize, chunkOverlap, textLength: text.length
      });
      break;
    }

    let end = Math.min(start + chunkSize, text.length);

    if (end < text.length) {
      const breakPoint = text.lastIndexOf('. ', end);
      if (breakPoint > start && breakPoint > start + chunkSize * 0.5) {
        end = breakPoint + 1;
      }
    }

    const chunk = text.substring(start, end).trim();
    if (chunk.length > 0) {
      chunks.push(chunk);
    }

    if (end >= text.length) {
      break;
    }

    const minAdvance = Math.max(50, Math.floor(chunkSize * 0.1));
    const overlap = Math.min(chunkOverlap, chunkSize - minAdvance);
    const nextStart = end - overlap;

    if (nextStart <= start) {
      const oldStart = start;
      start = oldStart + minAdvance;
      logger.warn('Chunking forced advance', {
        oldStart, newStart: start, chunkSize, chunkOverlap, minAdvance
      });
    } else {
      start = nextStart;
    }

    if (start >= text.length) break;
  }

  return chunks;
}

/**
 * Reciprocal Rank Fusion (RRF) — merges two ranked result lists.
 *
 * Items appearing in both lists receive boosted scores (sum of reciprocal ranks).
 * Formula per list: 1 / (k + rank + 1)
 *
 * Ported from legacy AgentX ragStore._reciprocalRankFusion().
 *
 * @param {Array} list1 - First ranked list (e.g. vector search results)
 * @param {Array} list2 - Second ranked list (e.g. keyword search results)
 * @param {number} k - RRF constant (default: 60)
 * @returns {Array} Merged list sorted by fused score, each item gets an `rrfScore` field
 */
function reciprocalRankFusion(list1, list2, k = 60) {
  const scoreMap = new Map();

  // Score list1
  list1.forEach((item, rank) => {
    const meta = item.metadata || {};
    const key = `${meta.documentId || ''}:${meta.chunkIndex ?? ''}`;
    const rrfScore = 1 / (k + rank + 1);
    scoreMap.set(key, { item, score: rrfScore });
  });

  // Add/update with list2
  list2.forEach((item, rank) => {
    const meta = item.metadata || {};
    const key = `${meta.documentId || ''}:${meta.chunkIndex ?? ''}`;
    const rrfScore = 1 / (k + rank + 1);

    if (scoreMap.has(key)) {
      // Item in both lists — add scores (boost)
      const existing = scoreMap.get(key);
      existing.score += rrfScore;
    } else {
      scoreMap.set(key, { item, score: rrfScore });
    }
  });

  return Array.from(scoreMap.values())
    .sort((a, b) => b.score - a.score)
    .map(entry => ({
      ...entry.item,
      rrfScore: entry.score
    }));
}

module.exports = { generateDocumentId, hashText, splitIntoChunks, reciprocalRankFusion };
