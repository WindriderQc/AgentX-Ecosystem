'use strict';

const nodeFetch = require('node-fetch');

const {
  createOutboundHttpExecutor,
  readBoundedBytes,
} = require('../../../shared/outboundHttpExecutor');
const { createPinnedNodeFetchTransport } = require('./coreOutboundClient');

const MIB = 1024 * 1024;
const ALLOWED_REQUEST_OPTION_KEYS = new Set(['body', 'headers', 'method', 'signal']);

function configuredDeadline(envName, fallbackMs, hardMaximumMs) {
  const raw = process.env[envName];
  if (raw === undefined || String(raw).trim() === '') return fallbackMs;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0 || value > hardMaximumMs) {
    throw new TypeError(`${envName} must be a positive integer no greater than ${hardMaximumMs}.`);
  }
  return value;
}

const COMPRESSION_DEADLINE_MS = configuredDeadline('COMPRESSION_TIMEOUT_MS', 15_000, 300_000);
const EMBEDDING_DEADLINE_MS = configuredDeadline('EMBEDDING_TIMEOUT_MS', 60_000, 300_000);
const QDRANT_DEADLINE_MS = configuredDeadline('QDRANT_TIMEOUT_MS', 30_000, 120_000);
const QUERY_EXPANSION_DEADLINE_MS = configuredDeadline('QUERY_EXPANSION_TIMEOUT_MS', 15_000, 300_000);
const RERANK_DEADLINE_MS = configuredDeadline('RERANK_TIMEOUT_MS', 15_000, 300_000);
const INGEST_DEADLINE_MS = 120_000;

const SERVICE_OUTBOUND_OPERATION_IDS = Object.freeze({
  COMPRESSION_GENERATE: 'rag.compression.generate',
  CORE_EMBED: 'rag.core-proxy.embed',
  INGEST_SUBMIT: 'rag.ingest-worker.submit',
  OLLAMA_EMBED_BATCH: 'rag.ollama.embed-batch',
  OLLAMA_EMBED_SINGLE: 'rag.ollama.embed-single',
  QDRANT_COLLECTION_CREATE: 'rag.qdrant.collection-create',
  QDRANT_COLLECTION_READ: 'rag.qdrant.collection-read',
  QDRANT_COLLECTIONS_HEALTH: 'rag.qdrant.collections-health',
  QDRANT_POINTS_DELETE: 'rag.qdrant.points-delete',
  QDRANT_POINTS_PAYLOAD: 'rag.qdrant.points-payload',
  QDRANT_POINTS_SCROLL: 'rag.qdrant.points-scroll',
  QDRANT_POINTS_SEARCH: 'rag.qdrant.points-search',
  QDRANT_POINTS_UPSERT: 'rag.qdrant.points-upsert',
  QUERY_EXPANSION_GENERATE: 'rag.query-expansion.generate',
  RERANKER_GENERATE: 'rag.reranker.generate',
});

// These policies state the unconditional executor ceiling recorded by the
// static registry. SERVICE_OUTBOUND_TIMEOUTS below preserves each workflow's
// shorter configured timeout across dispatch and response-body consumption.
const SERVICE_OUTBOUND_OPERATIONS = Object.freeze({
  [SERVICE_OUTBOUND_OPERATION_IDS.COMPRESSION_GENERATE]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 300_000, maxRequestBytes: 512 * 1024, maxResponseBytes: 2 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.CORE_EMBED]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 300_000, maxRequestBytes: 256 * 1024, maxResponseBytes: 4 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.INGEST_SUBMIT]: Object.freeze({
    authoritySource: 'configured', deadlineMs: INGEST_DEADLINE_MS, maxRequestBytes: 8 * MIB, maxResponseBytes: 2 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.OLLAMA_EMBED_BATCH]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 300_000, maxRequestBytes: MIB, maxResponseBytes: 16 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.OLLAMA_EMBED_SINGLE]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 300_000, maxRequestBytes: 128 * 1024, maxResponseBytes: 4 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_CREATE]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 120_000, maxRequestBytes: 64 * 1024, maxResponseBytes: 2 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_READ]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 120_000, maxRequestBytes: 0, maxResponseBytes: 4 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTIONS_HEALTH]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 120_000, maxRequestBytes: 0, maxResponseBytes: MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_DELETE]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 120_000, maxRequestBytes: 8 * MIB, maxResponseBytes: 2 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_PAYLOAD]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 120_000, maxRequestBytes: 2 * MIB, maxResponseBytes: 2 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SCROLL]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 120_000, maxRequestBytes: 2 * MIB, maxResponseBytes: 32 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SEARCH]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 120_000, maxRequestBytes: 2 * MIB, maxResponseBytes: 32 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_UPSERT]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 120_000, maxRequestBytes: 32 * MIB, maxResponseBytes: 2 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QUERY_EXPANSION_GENERATE]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 300_000, maxRequestBytes: 256 * 1024, maxResponseBytes: 2 * MIB,
  }),
  [SERVICE_OUTBOUND_OPERATION_IDS.RERANKER_GENERATE]: Object.freeze({
    authoritySource: 'configured', deadlineMs: 300_000, maxRequestBytes: 256 * 1024, maxResponseBytes: 2 * MIB,
  }),
});

const SERVICE_OUTBOUND_TIMEOUTS = Object.freeze({
  [SERVICE_OUTBOUND_OPERATION_IDS.COMPRESSION_GENERATE]: COMPRESSION_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.CORE_EMBED]: EMBEDDING_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.INGEST_SUBMIT]: INGEST_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.OLLAMA_EMBED_BATCH]: EMBEDDING_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.OLLAMA_EMBED_SINGLE]: EMBEDDING_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_CREATE]: QDRANT_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_READ]: QDRANT_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTIONS_HEALTH]: Math.min(QDRANT_DEADLINE_MS, 2_000),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_DELETE]: QDRANT_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_PAYLOAD]: QDRANT_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SCROLL]: QDRANT_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SEARCH]: QDRANT_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_UPSERT]: QDRANT_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.QUERY_EXPANSION_GENERATE]: QUERY_EXPANSION_DEADLINE_MS,
  [SERVICE_OUTBOUND_OPERATION_IDS.RERANKER_GENERATE]: RERANK_DEADLINE_MS,
});

const COLLECTION_SEGMENT = '[A-Za-z0-9][A-Za-z0-9._-]{0,254}';

const SERVICE_OUTBOUND_REQUEST_SPECS = Object.freeze({
  [SERVICE_OUTBOUND_OPERATION_IDS.COMPRESSION_GENERATE]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: '^/api/inference/generate$' }),
  [SERVICE_OUTBOUND_OPERATION_IDS.CORE_EMBED]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: '^/api/inference/embed$' }),
  [SERVICE_OUTBOUND_OPERATION_IDS.INGEST_SUBMIT]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: '^/api/rag/ingest$' }),
  [SERVICE_OUTBOUND_OPERATION_IDS.OLLAMA_EMBED_BATCH]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: '^/api/embed$' }),
  [SERVICE_OUTBOUND_OPERATION_IDS.OLLAMA_EMBED_SINGLE]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: '^/api/embeddings$' }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_CREATE]: Object.freeze({ allowSearch: false, method: 'PUT', pathPattern: `^/collections/${COLLECTION_SEGMENT}$` }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTION_READ]: Object.freeze({ allowSearch: false, method: 'GET', pathPattern: `^/collections/${COLLECTION_SEGMENT}$` }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_COLLECTIONS_HEALTH]: Object.freeze({ allowSearch: false, method: 'GET', pathPattern: '^/collections$' }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_DELETE]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: `^/collections/${COLLECTION_SEGMENT}/points/delete$` }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_PAYLOAD]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: `^/collections/${COLLECTION_SEGMENT}/points/payload$` }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SCROLL]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: `^/collections/${COLLECTION_SEGMENT}/points/scroll$` }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_SEARCH]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: `^/collections/${COLLECTION_SEGMENT}/points/search$` }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QDRANT_POINTS_UPSERT]: Object.freeze({ allowSearch: false, method: 'PUT', pathPattern: `^/collections/${COLLECTION_SEGMENT}/points$` }),
  [SERVICE_OUTBOUND_OPERATION_IDS.QUERY_EXPANSION_GENERATE]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: '^/api/inference/generate$' }),
  [SERVICE_OUTBOUND_OPERATION_IDS.RERANKER_GENERATE]: Object.freeze({ allowSearch: false, method: 'POST', pathPattern: '^/api/inference/generate$' }),
});

function configuredServiceOrigin(value) {
  let parsed;
  try {
    parsed = new URL(String(value || '').trim());
  } catch {
    throw new TypeError('Configured outbound service URL must be an HTTP(S) origin.');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin === 'null') {
    throw new TypeError('Configured outbound service URL must be an HTTP(S) origin.');
  }
  return parsed.origin;
}

function normalizeExpectedOrigins(values) {
  const candidates = Array.isArray(values) ? values : [values];
  if (candidates.length === 0) {
    throw new TypeError('At least one configured outbound service origin is required.');
  }
  return new Set(candidates.map(configuredServiceOrigin));
}

function matchesRequestSpec(spec, parsed, method) {
  return Boolean(spec)
    && method === spec.method
    && new RegExp(spec.pathPattern).test(parsed.pathname)
    && !parsed.hash
    && (spec.allowSearch || !parsed.search);
}

function snapshotRequestOptions(requestOptions) {
  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(requestOptions);
    keys = Object.keys(requestOptions);
  } catch {
    throw new TypeError('Outbound service request options are invalid.');
  }
  if (!requestOptions
    || typeof requestOptions !== 'object'
    || Array.isArray(requestOptions)
    || (prototype !== Object.prototype && prototype !== null)
    || keys.some((key) => !ALLOWED_REQUEST_OPTION_KEYS.has(key))) {
    throw new TypeError('Outbound service request options are invalid.');
  }
  try {
    const owned = {};
    for (const key of keys) owned[key] = requestOptions[key];
    return Object.freeze(owned);
  } catch {
    throw new TypeError('Outbound service request options are invalid.');
  }
}

function createConfiguredServiceAuthorityAdapter(expectedOrigins) {
  const origins = normalizeExpectedOrigins(expectedOrigins);
  return ({ sinkId, target }) => {
    const spec = SERVICE_OUTBOUND_REQUEST_SPECS[sinkId];
    const parsed = new URL(target);
    if (!spec
      || !origins.has(parsed.origin)
      || !new RegExp(spec.pathPattern).test(parsed.pathname)
      || parsed.hash
      || (!spec.allowSearch && parsed.search)) {
      throw new Error('Outbound target does not match a configured service authority.');
    }
    return Object.freeze({ expectedOrigin: parsed.origin });
  };
}

function createServiceOutboundClient(options = {}) {
  const expectedOrigins = options.expectedOrigins ?? options.expectedOrigin;
  const executor = createOutboundHttpExecutor({
    authorityAdapter: options.authorityAdapter || createConfiguredServiceAuthorityAdapter(expectedOrigins),
    fetchImpl: options.fetchImpl || nodeFetch,
    operations: options.operations || SERVICE_OUTBOUND_OPERATIONS,
    transportAdapter: options.transportAdapter || createPinnedNodeFetchTransport({ lookup: options.lookup }),
  });

  return Object.freeze({
    async requestBytes(operationId, target, requestOptions = {}) {
      const spec = SERVICE_OUTBOUND_REQUEST_SPECS[operationId];
      const ownedRequestOptions = snapshotRequestOptions(requestOptions);
      let parsed;
      try {
        parsed = target instanceof URL ? new URL(target.href) : new URL(target);
      } catch {
        throw new TypeError('Outbound service target is invalid.');
      }
      const method = String(ownedRequestOptions.method || 'GET').toUpperCase();
      if (!matchesRequestSpec(spec, parsed, method)) {
        throw new TypeError('Outbound service operation does not match its closed request specification.');
      }
      const governedRequestOptions = Object.freeze({
        ...ownedRequestOptions,
        method,
      });

      const admission = await executor.admitTarget(operationId, parsed, {
        signal: governedRequestOptions.signal,
      });
      const response = await executor.request(admission, governedRequestOptions);
      const bytes = await readBoundedBytes(response);
      return Object.freeze({
        bytes,
        headers: response.headers,
        ok: response.ok,
        status: response.status,
        url: parsed.href,
      });
    },
  });
}

module.exports = {
  SERVICE_OUTBOUND_OPERATIONS,
  SERVICE_OUTBOUND_OPERATION_IDS,
  SERVICE_OUTBOUND_REQUEST_SPECS,
  SERVICE_OUTBOUND_TIMEOUTS,
  configuredDeadline,
  configuredServiceOrigin,
  createConfiguredServiceAuthorityAdapter,
  createServiceOutboundClient,
  matchesRequestSpec,
  snapshotRequestOptions,
};
