/**
 * crossServiceClient — shared HTTP primitive for core's cross-service clients.
 *
 * Consolidates the fetch + URL building + timeout + error wrapping plumbing that
 * used to live separately in ragServiceClient, reportsServiceClient,
 * benchmarkServiceClient, and voixClientService.
 *
 * Design:
 *   - One `requestJson({ baseUrl, path, method, body, query, timeoutMs, ...})`
 *     primitive returns parsed JSON (or text fallback, or null) and throws a
 *     `CrossServiceClientError` on failure unless `onFailure` is supplied.
 *   - Per-client specifics (api-key header, envelope unwrap, error-class identity)
 *     are handled via hooks, so each client stays a thin facade.
 *   - Uses native AbortController for cancellation and passes the legacy
 *     `timeout` option to `node-fetch` for backward compatibility with clients
 *     that relied on it (e.g. reportsServiceClient).
 *   - Graceful-degradation clients (reports) pass an `onFailure` callback instead
 *     of letting the primitive throw.
 */

const fetch = require('node-fetch');

const DEFAULT_TIMEOUT_MS = 30000;

class CrossServiceClientError extends Error {
  constructor(message, { service, status = 500, code = 'CROSS_SERVICE_ERROR', body = null, cause = null } = {}) {
    super(message);
    this.name = 'CrossServiceClientError';
    this.service = service || null;
    this.status = status;
    this.code = code;
    this.body = body;
    if (cause) this.cause = cause;
  }
}

function stripTrailingSlash(url) {
  return typeof url === 'string' ? url.replace(/\/+$/, '') : url;
}

function buildUrl(baseUrl, pathname, query) {
  if (!baseUrl) {
    throw new CrossServiceClientError('baseUrl is required', {
      status: 500,
      code: 'CROSS_SERVICE_INVALID_CONFIG'
    });
  }
  const url = new URL(stripTrailingSlash(baseUrl) + pathname);
  if (query && typeof query === 'object') {
    Object.entries(query).forEach(([key, value]) => {
      if (value === undefined || value === null || value === '') return;
      if (Array.isArray(value)) {
        if (value.length > 0) url.searchParams.set(key, value.join(','));
        return;
      }
      url.searchParams.set(key, String(value));
    });
  }
  return url.toString();
}

async function parseResponseBody(response) {
  // Prefer text() so we can distinguish empty-body from null and recover from
  // non-JSON responses. Fallback to json() for callers/mocks that only expose
  // json() (notably the legacy reports tests).
  if (typeof response.text === 'function') {
    const text = await response.text();
    if (!text) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  if (typeof response.json === 'function') {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }
  return null;
}

function extractErrorMessage(body, fallback) {
  if (typeof body === 'string' && body.trim()) return body.trim();
  if (body && typeof body === 'object') {
    return body.message || body.detail || body.error || fallback;
  }
  return fallback;
}

/**
 * Perform one JSON request against a cross-service endpoint.
 *
 * @param {Object}   opts
 * @param {string}   opts.baseUrl       Base URL (host, optional path prefix).
 * @param {string}   opts.path          Path to append (must start with '/').
 * @param {string}   [opts.method]      HTTP method (default 'GET').
 * @param {*}        [opts.body]        JSON-serialisable body.
 * @param {Object}   [opts.query]       Query-string kv map (string/number/array).
 * @param {Object}   [opts.headers]     Extra headers (merged after defaults).
 * @param {number}   [opts.timeoutMs]   Abort after this many ms (default 30_000).
 * @param {string}   [opts.serviceName] Name attached to thrown errors.
 * @param {string}   [opts.errorCode]   Code attached to thrown errors.
 * @param {Function} [opts.ErrorClass]  Optional error ctor to throw instead
 *                                      of `CrossServiceClientError`. Must accept
 *                                      (message, { status, code, body, cause }).
 * @param {Function} [opts.onFailure]   If provided, invoked with
 *                                      `{ reason, url, error, status, body }`
 *                                      instead of throwing. Its return value is
 *                                      returned to the caller (null for graceful
 *                                      degradation).
 * @param {boolean}  [opts.unwrapEnvelope] Unwrap `{status:'success', data}` (default false).
 * @param {Function} [opts.unwrap]      Custom unwrap fn(body) -> returnValue.
 * @returns {Promise<*>} parsed JSON body (or unwrapped value / onFailure return).
 */
async function requestJson({
  baseUrl,
  path,
  method = 'GET',
  body,
  query,
  headers = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
  serviceName,
  errorCode = 'CROSS_SERVICE_ERROR',
  ErrorClass = CrossServiceClientError,
  onFailure,
  unwrapEnvelope = false,
  unwrap
} = {}) {
  let url;
  try {
    url = buildUrl(baseUrl, path, query);
  } catch (error) {
    if (typeof onFailure === 'function') {
      return onFailure({ reason: 'invalid-url', url: `${baseUrl || ''}${path || ''}`, error, message: error.message });
    }
    throw error;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const bodyIsJson = body !== undefined && body !== null;
  const mergedHeaders = {
    Accept: 'application/json',
    ...(bodyIsJson ? { 'Content-Type': 'application/json' } : {}),
    ...headers
  };

  const makeError = (message, extra = {}) => {
    const payload = { status: extra.status ?? 500, code: extra.code ?? errorCode, body: extra.body ?? null };
    if (extra.cause) payload.cause = extra.cause;
    if (ErrorClass === CrossServiceClientError) payload.service = serviceName;
    return new ErrorClass(message, payload);
  };

  const failOrThrow = (message, extra = {}) => {
    if (typeof onFailure === 'function') {
      return onFailure({ reason: extra.reason || 'error', url, ...extra, message });
    }
    throw makeError(message, extra);
  };

  let response;
  try {
    response = await fetch(url, {
      method,
      headers: mergedHeaders,
      body: bodyIsJson ? JSON.stringify(body) : undefined,
      signal: controller.signal,
      // node-fetch legacy timeout option — ignored by undici/native fetch but
      // kept so existing tests that assert `options.timeout` still pass.
      timeout: timeoutMs
    });
  } catch (error) {
    clearTimeout(timer);
    if (error && error.name === 'AbortError') {
      return failOrThrow(`${serviceName || 'Service'} request timed out after ${timeoutMs}ms`, {
        status: 504,
        code: `${errorCode}_TIMEOUT`,
        reason: 'timeout',
        error,
        cause: error
      });
    }
    return failOrThrow(`${serviceName || 'Service'} unavailable at ${url}`, {
      status: 503,
      code: `${errorCode}_UNAVAILABLE`,
      reason: 'network',
      error,
      cause: error,
      body: { cause: error.message }
    });
  }

  const parsed = await parseResponseBody(response).catch((err) => {
    // should not normally happen — response.text() rarely rejects
    return { __parseError: err.message };
  });

  clearTimeout(timer);

  if (!response.ok) {
    const message = extractErrorMessage(parsed, `${serviceName || 'Service'} request failed (${response.status})`);
    return failOrThrow(message, {
      status: response.status,
      code: (parsed && typeof parsed === 'object' && parsed.error) || errorCode,
      body: parsed,
      reason: 'non-ok'
    });
  }

  if (typeof unwrap === 'function') {
    return unwrap(parsed);
  }
  if (unwrapEnvelope && parsed && typeof parsed === 'object' && parsed.status === 'success' && 'data' in parsed) {
    return parsed.data;
  }
  return parsed;
}

module.exports = {
  CrossServiceClientError,
  DEFAULT_TIMEOUT_MS,
  buildUrl,
  parseResponseBody,
  extractErrorMessage,
  requestJson
};
