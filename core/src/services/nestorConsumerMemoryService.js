'use strict';

const memoryAdapters = require('./memoryAdapters');
const { getRagServiceClient } = require('./ragServiceClient');
const {
  MEMORY_SOURCES,
  LIMITS,
  NestorConsumerError,
} = require('./nestorConsumerContract');

const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;
const PRIVATE_LOCATION_KEYS = new Set(['address', 'endpoint']);

function isPrivateLocationKey(key) {
  const normalized = String(key).toLowerCase();
  return normalized.endsWith('url') || PRIVATE_LOCATION_KEYS.has(normalized);
}

function publicMessage(value) {
  return String(value || 'unavailable')
    .replace(ABSOLUTE_URL_PATTERN, '[redacted-endpoint]')
    .slice(0, 500);
}

function sanitizePublicStatus(value) {
  if (value == null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return publicMessage(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sanitizePublicStatus);
  if (typeof value !== 'object') return null;

  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !isPrivateLocationKey(key))
    .map(([key, entry]) => [key, sanitizePublicStatus(entry)]));
}

function observationTimestamp(options = {}) {
  const observedAt = typeof options.now === 'function' ? options.now() : new Date();
  return (observedAt instanceof Date ? observedAt : new Date(observedAt)).toISOString();
}

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
  const resolvedSource = String(result?.source || metadata.source || source || '').trim();
  const rawReference = result?.ref || metadata.ref || metadata.documentId || result?.documentId || null;
  return {
    source: /^[a-z][a-z0-9+.-]*:\/\//i.test(resolvedSource) ? source : resolvedSource,
    text,
    snippet: text,
    score: Number.isFinite(Number(result?.score)) ? Number(result.score) : null,
    ref: rawReference && !/^[a-z][a-z0-9+.-]*:\/\//i.test(String(rawReference))
      ? String(rawReference).slice(0, 500)
      : null,
  };
}

async function statusForSource(source) {
  if (source === 'rag') {
    const status = await getRagServiceClient().getStatus();
    const sanitized = sanitizePublicStatus(status || {});
    const publicStatus = sanitized && typeof sanitized === 'object' && !Array.isArray(sanitized)
      ? sanitized
      : {};
    return { ...publicStatus, source: 'rag', available: publicStatus?.healthy !== false };
  }
  return sanitizePublicStatus(await memoryAdapters.statusForSource(source));
}

async function searchSource(source, query, k) {
  if (source === 'rag') {
    return getRagServiceClient().searchSimilarChunks(query, { topK: k });
  }
  return memoryAdapters.searchSingle(source, query, k);
}

async function getMemoryStatus(inputSources, options = {}) {
  const sources = normalizeSources(inputSources);
  const entries = await Promise.all(sources.map(async (source) => {
    try {
      return [source, await statusForSource(source)];
    } catch (error) {
      return [source, { source, available: false, error: publicMessage(error.message) }];
    }
  }));
  const statuses = Object.fromEntries(entries);
  return {
    generatedAt: observationTimestamp(options),
    readOnly: true,
    sources: statuses,
    available: sources.filter((source) => statuses[source]?.available !== false),
    warnings: sources
      .filter((source) => statuses[source]?.available === false)
      .map((source) => ({
        source,
        code: 'MEMORY_SOURCE_UNAVAILABLE',
        message: publicMessage(statuses[source].error),
      })),
  };
}

async function searchMemory(input = {}, options = {}) {
  const { source, sources, query, k } = input;
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
        message: publicMessage(error.message),
      });
    }
  }));

  return {
    generatedAt: observationTimestamp(options),
    readOnly: true,
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
  normalizeResult,
  getMemoryStatus,
  observationTimestamp,
  publicMessage,
  sanitizePublicStatus,
  searchMemory,
};
