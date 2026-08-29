'use strict';

/**
 * Closed outbound client for the Operations Center health probes.
 *
 * Operations health is a public diagnostic surface, so every target is built
 * from one configured origin and one immutable request specification.  The
 * shared executor owns deadlines, redirect rejection and byte accounting;
 * Core's transport pins DNS results and verifies the connected socket peer.
 */

const nodeFetch = require('node-fetch');
const {
  OutboundHttpError,
  createOutboundHttpExecutor,
  discardBoundedResponse,
  readBoundedJson,
  readBoundedText,
  toPublicOutboundError,
} = require('../../../shared/outboundHttpExecutor');
const {
  peerVerifiedNodeFetchTransport,
} = require('../helpers/peerVerifiedNodeFetchTransport');

const OPERATIONS_HEALTH_OPERATION_IDS = Object.freeze({
  OPTIONAL_RUNTIME_PROBE: 'core.operations.optional-runtime-probe',
  OLLAMA_HEALTH: 'core.operations.ollama-health',
  QDRANT_HEALTH: 'core.operations.qdrant-health',
});

const MODEL_INVENTORY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HEALTH_MAX_RESPONSE_BYTES = 64 * 1024;
const OPERATIONS_HEALTH_DEADLINE_MS = 5_000;

function operation(pathPattern, responseMode, maxResponseBytes) {
  return Object.freeze({
    allowSearch: false,
    method: 'GET',
    pathPattern,
    responseMode,
    policy: Object.freeze({
      authoritySource: 'configured',
      deadlineMs: OPERATIONS_HEALTH_DEADLINE_MS,
      maxRequestBytes: 0,
      maxResponseBytes,
    }),
  });
}

const OPERATIONS_HEALTH_REQUEST_SPECS = Object.freeze({
  [OPERATIONS_HEALTH_OPERATION_IDS.OPTIONAL_RUNTIME_PROBE]: operation(
    '^/api/(?:tags|ps)$',
    'text',
    MODEL_INVENTORY_MAX_RESPONSE_BYTES
  ),
  [OPERATIONS_HEALTH_OPERATION_IDS.OLLAMA_HEALTH]: operation(
    '^/api/tags$',
    'json',
    MODEL_INVENTORY_MAX_RESPONSE_BYTES
  ),
  [OPERATIONS_HEALTH_OPERATION_IDS.QDRANT_HEALTH]: operation(
    '^/healthz$',
    'discard',
    HEALTH_MAX_RESPONSE_BYTES
  ),
});

const OPERATIONS_HEALTH_OPERATIONS = Object.freeze(Object.fromEntries(
  Object.entries(OPERATIONS_HEALTH_REQUEST_SPECS)
    .map(([operationId, spec]) => [operationId, spec.policy])
));

const CONFIG_KEYS = Object.freeze({
  [OPERATIONS_HEALTH_OPERATION_IDS.OPTIONAL_RUNTIME_PROBE]: 'optionalRuntimeUrl',
  [OPERATIONS_HEALTH_OPERATION_IDS.OLLAMA_HEALTH]: 'ollamaUrl',
  [OPERATIONS_HEALTH_OPERATION_IDS.QDRANT_HEALTH]: 'qdrantUrl',
});

class OperationsHealthConfigurationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OperationsHealthConfigurationError';
  }
}

function configuredOrigin(value, { optional = false } = {}) {
  if (value === undefined || value === null || String(value).trim() === '') {
    if (optional) return null;
    throw new OperationsHealthConfigurationError('The service health authority is not configured.');
  }

  let parsed;
  try {
    parsed = new URL(String(value).trim());
  } catch {
    throw new OperationsHealthConfigurationError('The service health authority is invalid.');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin === 'null') {
    throw new OperationsHealthConfigurationError('The service health authority is invalid.');
  }
  return parsed.origin;
}

function resolveOperationOrigin(operationId, configuredUrls) {
  const key = CONFIG_KEYS[operationId];
  if (!key) {
    throw new OperationsHealthConfigurationError('The service health operation is not registered.');
  }
  const optional = operationId === OPERATIONS_HEALTH_OPERATION_IDS.OPTIONAL_RUNTIME_PROBE;
  const origin = configuredOrigin(configuredUrls[key], { optional });
  if (!origin) {
    throw new OperationsHealthConfigurationError('The optional runtime is not configured.');
  }
  return origin;
}

function requestMatches(spec, requested) {
  return new RegExp(spec.pathPattern).test(requested.pathname)
    && (spec.allowSearch || !requested.search)
    && !requested.hash;
}

function createConfiguredOperationsAuthorityAdapter(configuredUrls) {
  const ownedConfig = Object.freeze({
    optionalRuntimeUrl: configuredUrls?.optionalRuntimeUrl,
    ollamaUrl: configuredUrls?.ollamaUrl,
    qdrantUrl: configuredUrls?.qdrantUrl,
  });

  return ({ authoritySource, sinkId, target }) => {
    const spec = OPERATIONS_HEALTH_REQUEST_SPECS[sinkId];
    const requested = new URL(target);
    const expectedOrigin = resolveOperationOrigin(sinkId, ownedConfig);
    if (authoritySource !== 'configured'
      || !spec
      || requested.origin !== expectedOrigin
      || !requestMatches(spec, requested)) {
      throw new OperationsHealthConfigurationError(
        'The service health target is not registered.'
      );
    }
    return Object.freeze({ expectedOrigin });
  };
}

function publicOperationsHealthError(error) {
  if (error instanceof OutboundHttpError) return toPublicOutboundError(error).message;
  if (error instanceof OperationsHealthConfigurationError) return error.message;
  return toPublicOutboundError(error).message;
}

function createOperationsHealthClient(options = {}) {
  const configuredUrls = Object.freeze({
    optionalRuntimeUrl: options.optionalRuntimeUrl,
    ollamaUrl: options.ollamaUrl,
    qdrantUrl: options.qdrantUrl,
  });
  const operationPolicies = options.operations || OPERATIONS_HEALTH_OPERATIONS;
  const executor = createOutboundHttpExecutor({
    authorityAdapter: options.authorityAdapter
      || createConfiguredOperationsAuthorityAdapter(configuredUrls),
    fetchImpl: options.fetchImpl || nodeFetch,
    operations: operationPolicies,
    transportAdapter: options.transportAdapter || peerVerifiedNodeFetchTransport,
  });

  async function execute(operationId, pathname, { signal } = {}) {
    const spec = OPERATIONS_HEALTH_REQUEST_SPECS[operationId];
    if (!spec || typeof pathname !== 'string') {
      throw new OperationsHealthConfigurationError(
        'The service health operation is not registered.'
      );
    }
    const expectedOrigin = resolveOperationOrigin(operationId, configuredUrls);
    const target = new URL(pathname, `${expectedOrigin}/`);
    if (target.origin !== expectedOrigin || !requestMatches(spec, target)) {
      throw new OperationsHealthConfigurationError(
        'The service health target is not registered.'
      );
    }
    const admission = await executor.admitTarget(operationId, target.href, { signal });
    const response = await executor.request(admission, {
      headers: { accept: spec.responseMode === 'json' ? 'application/json' : '*/*' },
      method: spec.method,
      signal,
    });
    return Object.freeze({ response, target: target.href });
  }

  return Object.freeze({
    async probeOptionalRuntime(pathname, { signal } = {}) {
      const { response, target } = await execute(
        OPERATIONS_HEALTH_OPERATION_IDS.OPTIONAL_RUNTIME_PROBE,
        pathname,
        { signal }
      );
      const bodyText = await readBoundedText(response);
      let data = null;
      let json = false;
      if (bodyText) {
        try {
          data = JSON.parse(bodyText);
          json = true;
        } catch {
          data = bodyText;
        }
      }
      return Object.freeze({
        data,
        json,
        ok: response.ok,
        status: response.status,
        url: target,
      });
    },

    async getOllamaTags({ signal } = {}) {
      const { response } = await execute(
        OPERATIONS_HEALTH_OPERATION_IDS.OLLAMA_HEALTH,
        '/api/tags',
        { signal }
      );
      if (!response.ok) {
        const status = response.status;
        await response.cancel();
        return Object.freeze({ ok: false, status });
      }
      const data = await readBoundedJson(response);
      return Object.freeze({ data, ok: true, status: response.status });
    },

    async getQdrantHealth({ signal } = {}) {
      const { response } = await execute(
        OPERATIONS_HEALTH_OPERATION_IDS.QDRANT_HEALTH,
        '/healthz',
        { signal }
      );
      const result = Object.freeze({ ok: response.ok, status: response.status });
      if (response.ok) await discardBoundedResponse(response);
      else await response.cancel();
      return result;
    },
  });
}

module.exports = {
  HEALTH_MAX_RESPONSE_BYTES,
  MODEL_INVENTORY_MAX_RESPONSE_BYTES,
  OPERATIONS_HEALTH_DEADLINE_MS,
  OPERATIONS_HEALTH_OPERATIONS,
  OPERATIONS_HEALTH_OPERATION_IDS,
  OPERATIONS_HEALTH_REQUEST_SPECS,
  OperationsHealthConfigurationError,
  configuredOrigin,
  createConfiguredOperationsAuthorityAdapter,
  createOperationsHealthClient,
  publicOperationsHealthError,
};
