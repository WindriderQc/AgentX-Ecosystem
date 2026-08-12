/**
 * Re-ranker — LLM judge scores relevance of search results.
 *
 * Ported from legacy AgentX ragStore.rerankResults().
 * Routed via Core task type `rag_reranking`, so RAG does not own model
 * selection or host placement.
 * Normalizes LLM scores to 0-1, falls back to original vector score on error.
 */

'use strict';

const fetchWithTimeout = require('../utils/fetchWithTimeout');
const { boundedConcurrency } = require('../utils/boundedConcurrency');
const logger = require('../../config/logger');

const CORE_PROXY_URL = (process.env.CORE_PROXY_URL || 'http://localhost:3080').replace(/\/+$/, '');
const RERANK_TIMEOUT = Number(process.env.RERANK_TIMEOUT_MS) || 15000;
const RERANK_CONCURRENCY = Number(process.env.RERANK_CONCURRENCY) || 2;

/**
 * Build the LLM relevance-scoring prompt.
 *
 * @param {string} query - User query
 * @param {string} text - Chunk text (truncated to 500 chars)
 * @returns {string} Prompt string
 */
function buildScoringPrompt(query, text) {
  const truncated = text.substring(0, 500);
  return `You are a relevance judge. Rate how relevant this text is to the query on a scale of 0-10.

Query: "${query}"

Text: "${truncated}"

Return ONLY a number from 0 to 10, where:
- 0 = completely irrelevant
- 5 = somewhat relevant
- 10 = perfectly relevant

Score:`;
}

/**
 * Parse the LLM response text to extract a numeric score.
 *
 * @param {string} responseText - Raw LLM output
 * @param {number} fallbackScore - Score to use if parsing fails
 * @returns {number} Normalized score (0-1)
 */
function parseScore(responseText, fallbackScore) {
  const text = (responseText || '').trim();
  const match = text.match(/(\d+\.?\d*)/);
  if (!match) return fallbackScore;
  const raw = Math.min(parseFloat(match[1]), 10);
  return raw / 10; // Normalize to 0-1
}

/**
 * Re-rank search results using an LLM judge.
 *
 * Each result is scored for relevance by the judge model in parallel.
 * Results are sorted by LLM score (descending) and the top K are returned.
 * On complete failure, returns original results sliced to topK.
 *
 * @param {string} query - Search query
 * @param {Array<{text: string, score: number, metadata?: object}>} results - Search results to re-rank
 * @param {number} topK - Number of results to return (default: 5)
 * @returns {Promise<Array>} Re-ranked results with llmScore and vectorScore fields
 */
async function rerankResults(query, results, topK = 5) {
  if (!results || results.length === 0) {
    return results || [];
  }

  try {
    // Score each result with a bounded concurrency cap. Unbounded Promise.all
    // fan-out (one call per candidate, up to 50) was evicting the target
    // host's KV cache mid-batch — tune via RERANK_CONCURRENCY env var.
    const scoredResults = await boundedConcurrency(results, async (result, idx) => {
      const prompt = buildScoringPrompt(query, result.text || '');

      try {
        const response = await fetchWithTimeout(`${CORE_PROXY_URL}/api/inference/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            taskType: 'rag_reranking',
            prompt,
            stream: false,
            responseMode: 'normalized',
            think: false,
            callerDetail: 'rag-reranker',
            options: {
              temperature: 0.1,
              num_predict: 10
            }
          })
        }, RERANK_TIMEOUT);

        if (!response.ok) {
          logger.warn(`Re-ranking failed for result ${idx}`, { status: response.status });
          return { ...result, llmScore: result.score, vectorScore: result.score };
        }

        const data = await response.json();
        const llmScore = parseScore(data.response, result.score);

        return {
          ...result,
          llmScore,
          vectorScore: result.score // Preserve original vector score
        };
      } catch (error) {
        logger.warn(`Re-ranking error for result ${idx}`, { error: error.message });
        return { ...result, llmScore: result.score, vectorScore: result.score };
      }
    }, RERANK_CONCURRENCY);

    // Sort by LLM score (descending) and return top K
    const reranked = scoredResults
      .sort((a, b) => b.llmScore - a.llmScore)
      .slice(0, topK);

    logger.info('Results re-ranked', {
      originalCount: results.length,
      rerankedCount: reranked.length,
      avgLlmScore: (reranked.reduce((sum, r) => sum + r.llmScore, 0) / reranked.length).toFixed(3)
    });

    return reranked;
  } catch (error) {
    logger.error('Re-ranking error', { error: error.message });
    return results.slice(0, topK); // Fallback to original results
  }
}

module.exports = { rerankResults, buildScoringPrompt, parseScore };
