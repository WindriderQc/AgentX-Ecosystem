/**
 * Web Search Service (SearXNG)
 * Local-first web search via self-hosted SearXNG instance.
 * Graceful degradation: returns empty results on failure, never throws.
 */

const fetch = require('node-fetch');
const { getFetchOptions } = require('../helpers/httpAgent');
const logger = require('../../config/logger');

const SEARXNG_URL = String(process.env.SEARXNG_URL || '').trim().replace(/\/$/, '');
const SEARCH_TIMEOUT_MS = 10000;
const MAX_RESULTS = 5;

/**
 * Search the web via SearXNG JSON API
 * @param {string} query - Search query
 * @param {Object} [options]
 * @param {number} [options.maxResults=5] - Max results to return
 * @param {string} [options.language='en'] - Search language
 * @returns {Promise<{ results: Array<{title, url, snippet}>, formatted: string, error: string|null }>}
 */
async function searchWeb(query, options = {}) {
  const { maxResults = MAX_RESULTS, language = 'en' } = options;

  if (!SEARXNG_URL) {
    return { results: [], formatted: '', error: 'SearXNG is not configured' };
  }

  try {
    const params = new URLSearchParams({
      q: query,
      format: 'json',
      language,
      safesearch: '0'
    });

    const url = `${SEARXNG_URL}/search?${params}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEARCH_TIMEOUT_MS);

    const fetchOpts = getFetchOptions(url, {
      method: 'GET',
      signal: controller.signal
    });

    const res = await fetch(url, fetchOpts);
    clearTimeout(timer);

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`SearXNG ${res.status}: ${body.substring(0, 200)}`);
    }

    const data = await res.json();
    const raw = (data.results || []).slice(0, maxResults);

    const results = raw.map(r => ({
      title: r.title || '',
      url: r.url || '',
      snippet: r.content || ''
    }));

    return {
      results,
      formatted: formatSearchContext(results),
      error: null
    };
  } catch (err) {
    const isTimeout = err.name === 'AbortError';
    const errorMsg = isTimeout ? `SearXNG timeout after ${SEARCH_TIMEOUT_MS}ms` : err.message;

    logger.warn('Web search failed (graceful degradation)', { query, error: errorMsg });

    return { results: [], formatted: '', error: errorMsg };
  }
}

/**
 * Format search results as markdown context for prompt injection
 * @param {Array<{title, url, snippet}>} results
 * @returns {string}
 */
function formatSearchContext(results) {
  if (!results || results.length === 0) return '';

  const lines = ['## Web Search Results\n'];
  for (const r of results) {
    lines.push(`- **${r.title}** (${r.url})`);
    if (r.snippet) lines.push(`  ${r.snippet}`);
  }
  lines.push('');
  return lines.join('\n');
}

module.exports = { searchWeb, formatSearchContext };
