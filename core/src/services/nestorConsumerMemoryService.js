'use strict';

const memoryAdapters = require('./memoryAdapters');
const { getRagServiceClient } = require('./ragServiceClient');
const {
  MEMORY_SOURCES,
  LIMITS,
  NestorConsumerError,
} = require('./nestorConsumerContract');

function normalizeSources(input) {
  const requested = Array.isArray(input) ? input : (input ? [input] : MEMORY_SOURCES);
  const sources = Array.from(new Set(requested.map((source) => String(source).trim().toLowerCase())));
  const unknown = sources.filter((source) => !MEMORY_SOURCES.includes(source));
  if (unknown.length) {
    throw new NestorConsumerError(`Unknown memory source: ${unknown.join(', ')}`, 400, 'UNKNOWN_MEMORY_SOURCE');
  }
  return sources;
}

function normalizeK(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 5;
  return Math.max(1, Math.min(Math.trunc(parsed), LIMITS.memoryResultsPerSource));
}

function normalizeResult(result, source) {
  const metadata = result?.metadata || {};
  const text = String(result?.compressedText || result?.text || result?.snippet || '').slice(0, 4000);
  return {
    source: result?.source || metadata.source || source,
    text,
    snippet: text,
    score: Number.isFinite(Number(result?.score)) ? Number(result.score) : null,
    ref: result?.ref || metadata.ref || metadata.documentId || result?.documentId || null,
  };
}

async function statusForSource(source) {
  if (source === 'rag') {
    const status = await getRagServiceClient().getStatus();
    return { source: 'rag', available: status?.healthy !== false, ...status };
  }
  return memoryAdapters.statusForSource(source);
}

async function searchSource(source, query, k) {
  if (source === 'rag') {
    return getRagServiceClient().searchSimilarChunks(query, { topK: k });
  }
  return memoryAdapters.searchSingle(source, query, k);
}

async function getMemoryStatus(inputSources) {
  const sources = normalizeSources(inputSources);
  const entries = await Promise.all(sources.map(async (source) => {
    try {
      return [source, await statusForSource(source)];
    } catch (error) {
      return [source, { source, available: false, error: error.message }];
    }
  }));
  const statuses = Object.fromEntries(entries);
  return {
    sources: statuses,
    available: sources.filter((source) => statuses[source]?.available !== false),
    warnings: sources
      .filter((source) => statuses[source]?.available === false)
      .map((source) => ({ source, code: 'MEMORY_SOURCE_UNAVAILABLE', message: statuses[source].error || 'unavailable' })),
  };
}

async function searchMemory({ source, sources, query, k } = {}) {
  const normalizedQuery = String(query == null ? '' : query).trim();
  if (!normalizedQuery) {
    throw new NestorConsumerError('query is required', 400, 'MEMORY_QUERY_REQUIRED');
  }
  if (normalizedQuery.length > LIMITS.memoryQueryCharacters) {
    throw new NestorConsumerError(
      `query exceeds ${LIMITS.memoryQueryCharacters} characters`,
      413,
      'MEMORY_QUERY_TOO_LARGE'
    );
  }

  const selected = normalizeSources(sources || source);
  const boundedK = normalizeK(k);
  const warnings = [];
  const bySource = {};

  await Promise.all(selected.map(async (selectedSource) => {
    try {
      const results = await searchSource(selectedSource, normalizedQuery, boundedK);
      bySource[selectedSource] = (Array.isArray(results) ? results : [])
        .slice(0, boundedK)
        .map((result) => normalizeResult(result, selectedSource))
        .filter((result) => result.text);
    } catch (error) {
      bySource[selectedSource] = [];
      warnings.push({
        source: selectedSource,
        code: 'MEMORY_SOURCE_SEARCH_FAILED',
        message: error.message,
      });
    }
  }));

  return {
    query: normalizedQuery,
    k: boundedK,
    sources: selected,
    results: selected.flatMap((selectedSource) => bySource[selectedSource]),
    bySource,
    warnings,
  };
}

module.exports = {
  normalizeSources,
  getMemoryStatus,
  searchMemory,
};
