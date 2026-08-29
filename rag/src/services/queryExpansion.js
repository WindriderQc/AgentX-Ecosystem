/**
 * Query Expansion — uses a small LLM to generate related search queries.
 *
 * Ported from legacy AgentX ragStore.expandQuery().
 * Routed via Core task type `rag_query_expansion`, so RAG does not own model
 * selection or host placement.
 */

const fetchWithTimeout = require('../utils/fetchWithTimeout');
const {
  SERVICE_OUTBOUND_OPERATION_IDS,
  SERVICE_OUTBOUND_TIMEOUTS,
  configuredServiceOrigin,
} = require('../clients/serviceOutboundClient');
const logger = require('../../config/logger');

const CORE_PROXY_URL = configuredServiceOrigin(process.env.CORE_PROXY_URL || 'http://localhost:3080');
const EXPANSION_TIMEOUT = SERVICE_OUTBOUND_TIMEOUTS[
  SERVICE_OUTBOUND_OPERATION_IDS.QUERY_EXPANSION_GENERATE
];
const MAX_EXPANSIONS = 3;

/**
 * Expand a user query into 2-3 related search queries via LLM.
 *
 * @param {string} query - Original search query
 * @returns {Promise<string[]>} Related queries (excluding original). Empty array on failure.
 */
async function expandQuery(query) {
  try {
    const prompt = `Given this search query: "${query}"

Generate 2-3 related search queries that would help find relevant information. Focus on:
- Synonyms and alternative phrasings
- Related concepts
- More specific or general versions
- Acronyms and abbreviations

Return ONLY the queries, one per line, without numbering or explanation.`;

    const response = await fetchWithTimeout(`${CORE_PROXY_URL}/api/inference/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        taskType: 'rag_query_expansion',
        prompt,
        stream: false,
        responseMode: 'normalized',
        think: false,
        callerDetail: 'rag-query-expansion',
        options: {
          temperature: 0.7,
          num_predict: 200
        }
      })
    }, EXPANSION_TIMEOUT, {
      expectedOrigins: [CORE_PROXY_URL],
      operationId: SERVICE_OUTBOUND_OPERATION_IDS.QUERY_EXPANSION_GENERATE,
    });

    if (!response.ok) {
      logger.warn('Query expansion failed, using original query only');
      return [];
    }

    const data = await response.json();
    const expandedText = data.response || '';

    // Parse line-separated queries, strip numbering artifacts
    const relatedQueries = expandedText
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && line.length < 200)
      .filter(line => !line.match(/^\d+[\.\)]/))
      .slice(0, MAX_EXPANSIONS);

    logger.info('Query expanded', {
      original: query.substring(0, 50),
      expansionCount: relatedQueries.length
    });

    return relatedQueries;
  } catch (error) {
    logger.error('Query expansion error', { error: error.message });
    return [];
  }
}

module.exports = { expandQuery };
