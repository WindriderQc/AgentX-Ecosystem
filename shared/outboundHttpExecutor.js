'use strict';

/**
 * Shared, policy-driven outbound HTTP execution primitives.
 *
 * Fetch does not expose the connected socket peer in a portable way.  This
 * module therefore requires a transport adapter for dispatch.  The adapter is
 * responsible for DNS policy and connect-time peer enforcement (for example,
 * through a pinned node-fetch Agent or an Undici Dispatcher) and must return
 * the explicit CONNECT_TIME_PEER_VERIFICATION attestation.  A DNS lookup made
 * before an ordinary fetch is not sufficient because it introduces a TOCTOU
 * window.
 */

const CONNECT_TIME_PEER_VERIFICATION = 'connect-time';

const OUTBOUND_ERROR_CODES = Object.freeze({
  POLICY_INVALID: 'OUTBOUND_POLICY_INVALID',
  OPERATION_UNKNOWN: 'OUTBOUND_OPERATION_UNKNOWN',
  TARGET_REJECTED: 'OUTBOUND_TARGET_REJECTED',
  AUTHORITY_ADAPTER_REQUIRED: 'OUTBOUND_AUTHORITY_ADAPTER_REQUIRED',
  ADMISSION_INVALID: 'OUTBOUND_ADMISSION_INVALID',
  TRANSPORT_ADAPTER_REQUIRED: 'OUTBOUND_TRANSPORT_ADAPTER_REQUIRED',
  PEER_UNVERIFIED: 'OUTBOUND_PEER_UNVERIFIED',
  CALLER_ABORTED: 'OUTBOUND_CALLER_ABORTED',
  DEADLINE_EXCEEDED: 'OUTBOUND_DEADLINE_EXCEEDED',
  REQUEST_FAILED: 'OUTBOUND_REQUEST_FAILED',
  INVALID_RESPONSE: 'OUTBOUND_INVALID_RESPONSE',
  REDIRECT_REJECTED: 'OUTBOUND_REDIRECT_REJECTED',
  REQUEST_TOO_LARGE: 'OUTBOUND_REQUEST_TOO_LARGE',
  REQUEST_BODY_UNBOUNDED: 'OUTBOUND_REQUEST_BODY_UNBOUNDED',
  REQUEST_LENGTH_MISMATCH: 'OUTBOUND_REQUEST_LENGTH_MISMATCH',
  RESPONSE_TOO_LARGE: 'OUTBOUND_RESPONSE_TOO_LARGE',
  RESPONSE_UNREADABLE: 'OUTBOUND_RESPONSE_UNREADABLE',
  INVALID_JSON: 'OUTBOUND_INVALID_JSON',
  BODY_ALREADY_USED: 'OUTBOUND_BODY_ALREADY_USED',
  RESPONSE_CANCELLED: 'OUTBOUND_RESPONSE_CANCELLED',
});

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  [OUTBOUND_ERROR_CODES.POLICY_INVALID]: 'The outbound request policy is invalid.',
  [OUTBOUND_ERROR_CODES.OPERATION_UNKNOWN]: 'The outbound operation is not registered.',
  [OUTBOUND_ERROR_CODES.TARGET_REJECTED]: 'The outbound request target was rejected.',
  [OUTBOUND_ERROR_CODES.AUTHORITY_ADAPTER_REQUIRED]: 'An outbound authority admission adapter is required.',
  [OUTBOUND_ERROR_CODES.ADMISSION_INVALID]: 'The outbound target admission is invalid or already used.',
  [OUTBOUND_ERROR_CODES.TRANSPORT_ADAPTER_REQUIRED]: 'A peer-verifying outbound transport is required.',
  [OUTBOUND_ERROR_CODES.PEER_UNVERIFIED]: 'The outbound transport could not verify the connected peer.',
  [OUTBOUND_ERROR_CODES.CALLER_ABORTED]: 'The outbound request was cancelled.',
  [OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED]: 'The outbound request exceeded its deadline.',
  [OUTBOUND_ERROR_CODES.REQUEST_FAILED]: 'The outbound request failed.',
  [OUTBOUND_ERROR_CODES.INVALID_RESPONSE]: 'The outbound service returned an invalid response.',
  [OUTBOUND_ERROR_CODES.REDIRECT_REJECTED]: 'The outbound service returned a redirect.',
  [OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE]: 'The outbound request exceeded its byte limit.',
  [OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED]: 'The outbound request body must be pre-sized.',
  [OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH]: 'The outbound request body length is inconsistent.',
  [OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE]: 'The outbound response exceeded its byte limit.',
  [OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE]: 'The outbound response could not be read.',
  [OUTBOUND_ERROR_CODES.INVALID_JSON]: 'The outbound service returned invalid JSON.',
  [OUTBOUND_ERROR_CODES.BODY_ALREADY_USED]: 'The outbound response body was already consumed.',
  [OUTBOUND_ERROR_CODES.RESPONSE_CANCELLED]: 'The outbound response was cancelled.',
});

const ERROR_CODE_SET = new Set(Object.values(OUTBOUND_ERROR_CODES));
const OPERATION_POLICY_FIELDS = Object.freeze([
  'authoritySource',
  'deadlineMs',
  'maxRequestBytes',
  'maxResponseBytes',
]);
const SINK_ID_PATTERN = /^[a-z0-9]+(?:[._:-][a-z0-9]+)*$/;
const HTTP_PROTOCOLS = new Set(['http:', 'https:']);
const AUTHORITY_SOURCES = new Set(['canonical', 'configured', 'request-admitted']);
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const FORBIDDEN_REQUEST_HEADERS = new Set([
  ':authority',
  'connection',
  'forwarded',
  'host',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'via',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-port',
  'x-forwarded-proto',
  'x-real-ip',
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function captureBlobIntrinsics() {
  try {
    const BlobConstructor = globalThis.Blob;
    const prototype = BlobConstructor?.prototype;
    const sizeGetter = Object.getOwnPropertyDescriptor(prototype, 'size')?.get;
    const typeGetter = Object.getOwnPropertyDescriptor(prototype, 'type')?.get;
    const arrayBuffer = prototype?.arrayBuffer;
    if (typeof BlobConstructor !== 'function'
      || typeof sizeGetter !== 'function'
      || typeof typeGetter !== 'function'
      || typeof arrayBuffer !== 'function') {
      return null;
    }
    return Object.freeze({ BlobConstructor, arrayBuffer, sizeGetter, typeGetter });
  } catch {
    return null;
  }
}

// Capture the platform intrinsics once. Calling these functions directly
// avoids trusting shadowable instance properties such as blob.size,
// blob.arrayBuffer(), or blob.stream().
const BLOB_INTRINSICS = captureBlobIntrinsics();

class OutboundHttpError extends Error {
  constructor(code, { sinkId, status } = {}) {
    const safeCode = ERROR_CODE_SET.has(code) ? code : OUTBOUND_ERROR_CODES.REQUEST_FAILED;
    super(PUBLIC_ERROR_MESSAGES[safeCode]);
    this.name = 'OutboundHttpError';
    this.code = safeCode;
    if (isSafeSinkId(sinkId)) this.sinkId = sinkId;
    if (Number.isInteger(status) && status >= 100 && status <= 599) this.status = status;
    Error.captureStackTrace?.(this, OutboundHttpError);
  }

  toJSON() {
    return toPublicOutboundError(this);
  }
}

function isSafeSinkId(value) {
  return typeof value === 'string'
    && value.length <= 160
    && SINK_ID_PATTERN.test(value);
}

function outboundError(code, sinkId, status) {
  return new OutboundHttpError(code, { sinkId, status });
}

function toPublicOutboundError(error) {
  const code = error instanceof OutboundHttpError && ERROR_CODE_SET.has(error.code)
    ? error.code
    : OUTBOUND_ERROR_CODES.REQUEST_FAILED;
  return Object.freeze({
    code,
    message: PUBLIC_ERROR_MESSAGES[code],
  });
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function sameKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function parseExpectedOrigin(value, sinkId) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.origin === 'null') {
    throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
  }
  return parsed.origin;
}

function normalizeOperationPolicy(sinkId, policy) {
  if (!isSafeSinkId(sinkId) || !sameKeys(policy, OPERATION_POLICY_FIELDS)) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  const { authoritySource, deadlineMs, maxRequestBytes, maxResponseBytes } = policy;
  if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > MAX_TIMER_DELAY_MS
    || !Number.isSafeInteger(maxRequestBytes) || maxRequestBytes < 0
    || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes < 0
    || !AUTHORITY_SOURCES.has(authoritySource)) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  return Object.freeze({
    sinkId,
    authoritySource,
    deadlineMs,
    maxRequestBytes,
    maxResponseBytes,
  });
}

function normalizeOperations(operations) {
  let entries;
  try {
    if (operations instanceof Map) entries = [...operations.entries()];
    else if (isPlainObject(operations)) entries = Object.entries(operations);
    else throw new TypeError('invalid operations');
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID);
  }
  if (entries.length === 0) throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID);

  const normalized = new Map();
  for (const [sinkId, policy] of entries) {
    if (normalized.has(sinkId)) throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
    normalized.set(sinkId, normalizeOperationPolicy(sinkId, policy));
  }
  return normalized;
}

function parseCandidateTarget(target, sinkId) {
  let parsed;
  try {
    parsed = target instanceof URL ? new URL(target.href) : new URL(target);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
  }

  if (!HTTP_PROTOCOLS.has(parsed.protocol)
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
  }
  return parsed;
}

function isAbortSignal(value) {
  try {
    return value === undefined
      || value === null
      || (typeof value === 'object'
        && typeof value.aborted === 'boolean'
        && typeof value.addEventListener === 'function'
        && typeof value.removeEventListener === 'function');
  } catch {
    return false;
  }
}

function normalizeRequestHeaders(headers, sinkId) {
  if (headers === undefined || headers === null) return undefined;

  let entries;
  try {
    if (Array.isArray(headers)) {
      entries = headers;
    } else if (typeof headers?.[Symbol.iterator] === 'function') {
      entries = [...headers];
    } else if (isPlainObject(headers)) {
      entries = Object.entries(headers);
    } else {
      throw new TypeError('invalid headers');
    }
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  const normalized = Object.create(null);
  try {
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2) throw new TypeError('invalid header');
      const name = String(entry[0]).trim().toLowerCase();
      const value = Array.isArray(entry[1])
        ? entry[1].map((item) => String(item)).join(', ')
        : String(entry[1]);
      if (!HEADER_NAME_PATTERN.test(name)
        || FORBIDDEN_REQUEST_HEADERS.has(name)
        || /[\0\r\n]/.test(value)) {
        throw new TypeError('unsafe header');
      }
      normalized[name] = Object.hasOwn(normalized, name)
        ? `${normalized[name]}, ${value}`
        : value;
    }
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }
  return Object.freeze(normalized);
}

function sanitizeFetchInit(options, sinkId) {
  let plain;
  try {
    plain = isPlainObject(options);
  } catch {
    plain = false;
  }
  if (!plain) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  let callerSignal;
  let fetchInit;
  try {
    const {
      signal,
      redirect: _redirect,
      agent: _agent,
      dispatcher: _dispatcher,
      headers,
      ...rest
    } = options;
    callerSignal = signal;
    const normalizedHeaders = normalizeRequestHeaders(headers, sinkId);
    fetchInit = normalizedHeaders === undefined
      ? rest
      : { ...rest, headers: normalizedHeaders };
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }

  if (!isAbortSignal(callerSignal)) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }
  if (Object.hasOwn(options, 'policy')
    || Object.hasOwn(options, 'expectedOrigin')
    || Object.hasOwn(options, 'admittedTarget')) {
    throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
  }
  return { callerSignal, fetchInit };
}

function createLifecycle(policy, initialCallerSignal) {
  const controller = new AbortController();
  let abortCode = null;
  let abortCleanup = null;
  let closed = false;
  const callerListeners = [];
  let resolveAbort;
  const abortPromise = new Promise((resolve) => {
    resolveAbort = resolve;
  });

  const abort = (code) => {
    if (closed || abortCode) return false;
    abortCode = code;
    // Never propagate a caller-controlled AbortSignal reason into the request
    // or into an error: reasons may contain addresses or credentials.
    controller.abort();
    resolveAbort(code);
    if (abortCleanup) {
      Promise.resolve().then(abortCleanup).catch(() => {});
    }
    return true;
  };

  const addCallerSignal = (callerSignal) => {
    if (!isAbortSignal(callerSignal)) {
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, policy.sinkId);
    }
    if (!callerSignal || closed || abortCode
      || callerListeners.some(([registered]) => registered === callerSignal)) return;
    if (callerSignal.aborted) {
      abort(OUTBOUND_ERROR_CODES.CALLER_ABORTED);
      return;
    }
    const onCallerAbort = () => abort(OUTBOUND_ERROR_CODES.CALLER_ABORTED);
    try {
      callerSignal.addEventListener('abort', onCallerAbort, { once: true });
      callerListeners.push([callerSignal, onCallerAbort]);
    } catch {
      try {
        callerSignal.removeEventListener('abort', onCallerAbort);
      } catch {
        // The signal-like object is invalid; no further cleanup is possible.
      }
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, policy.sinkId);
    }
  };

  addCallerSignal(initialCallerSignal);

  const timer = abortCode
    ? null
    : setTimeout(() => abort(OUTBOUND_ERROR_CODES.DEADLINE_EXCEEDED), policy.deadlineMs);
  // A stalled authority, transport, or response body may own no event-loop
  // handles of its own. Keep this timer referenced so the promised deadline
  // remains enforceable even when it is the operation's only live handle.

  const close = () => {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    for (const [callerSignal, onCallerAbort] of callerListeners.splice(0)) {
      try {
        callerSignal.removeEventListener('abort', onCallerAbort);
      } catch {
        // A caller-provided signal-like object cannot prevent timer cleanup.
      }
    }
    abortCleanup = null;
  };

  const throwIfAborted = () => {
    if (abortCode) throw outboundError(abortCode, policy.sinkId);
  };

  const race = async (work) => {
    throwIfAborted();
    const settledWork = Promise.resolve(work).then(
      (value) => ({ type: 'value', value }),
      (error) => ({ type: 'error', error })
    );
    const result = await Promise.race([
      settledWork,
      abortPromise.then((code) => ({ type: 'abort', code })),
    ]);
    if (result.type === 'abort') throw outboundError(result.code, policy.sinkId);
    if (result.type === 'error') throw result.error;
    return result.value;
  };

  const setAbortCleanup = (cleanup) => {
    abortCleanup = typeof cleanup === 'function' ? cleanup : null;
    if (abortCode && abortCleanup) {
      Promise.resolve().then(abortCleanup).catch(() => {});
    }
  };

  return Object.freeze({
    abort,
    addCallerSignal,
    close,
    race,
    setAbortCleanup,
    signal: controller.signal,
    throwIfAborted,
    get aborted() { return Boolean(abortCode); },
    get closed() { return closed; },
  });
}

function responseBody(response) {
  try {
    return response?.body ?? null;
  } catch {
    return null;
  }
}

async function cancelRawBody(body) {
  if (!body) return;
  try {
    if (typeof body.cancel === 'function') {
      await body.cancel();
    } else if (typeof body.destroy === 'function') {
      body.destroy();
    } else if (typeof body.return === 'function') {
      await body.return();
    }
  } catch {
    // Cancellation is best-effort.  The composed AbortSignal remains the
    // authoritative way to terminate a conforming transport.
  }
}

async function cancelRawResponse(response) {
  await cancelRawBody(responseBody(response));
}

function headerValue(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  if (typeof headers !== 'object') return null;
  if (Array.isArray(headers)) {
    const entry = headers.find((candidate) => Array.isArray(candidate)
      && String(candidate[0]).toLowerCase() === name);
    return entry ? entry[1] : null;
  }
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  const value = key === undefined ? null : headers[key];
  return Array.isArray(value) ? value.join(',') : value;
}

function knownRequestBodyLength(body) {
  if (body === undefined || body === null) return 0;
  if (typeof body === 'string') return Buffer.byteLength(body);
  if (Buffer.isBuffer(body)) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  return null;
}

function addIntrinsicBlobContentType(fetchInit, type) {
  if (!type || headerValue(fetchInit.headers, 'content-type') !== null) return fetchInit;
  const normalized = Object.assign(Object.create(null), fetchInit.headers || {});
  normalized['content-type'] = type;
  return { ...fetchInit, headers: Object.freeze(normalized) };
}

async function snapshotRequestBody(fetchInit, policy, lifecycle) {
  let body;
  try {
    body = fetchInit.body;
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (body === undefined || body === null || typeof body === 'string') return fetchInit;
  try {
    if (Buffer.isBuffer(body)) return { ...fetchInit, body: Buffer.from(body) };
    if (ArrayBuffer.isView(body)) {
      return {
        ...fetchInit,
        body: Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
      };
    }
    if (body instanceof ArrayBuffer) {
      return { ...fetchInit, body: Buffer.from(new Uint8Array(body)) };
    }
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }

  let isPlatformBlob = false;
  try {
    isPlatformBlob = BLOB_INTRINSICS !== null
      && body instanceof BLOB_INTRINSICS.BlobConstructor;
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (!isPlatformBlob) return fetchInit;

  let intrinsicSize;
  let intrinsicType;
  try {
    intrinsicSize = Reflect.apply(BLOB_INTRINSICS.sizeGetter, body, []);
    intrinsicType = Reflect.apply(BLOB_INTRINSICS.typeGetter, body, []);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (!Number.isSafeInteger(intrinsicSize) || intrinsicSize < 0
    || typeof intrinsicType !== 'string') {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (intrinsicSize > policy.maxRequestBytes) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE, policy.sinkId);
  }
  const declaredLength = declaredRequestLength(fetchInit, policy.sinkId);
  if (declaredLength !== null && declaredLength !== BigInt(intrinsicSize)) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, policy.sinkId);
  }

  let arrayBuffer;
  try {
    const snapshotPromise = Promise.resolve().then(
      () => Reflect.apply(BLOB_INTRINSICS.arrayBuffer, body, [])
    );
    arrayBuffer = await lifecycle.race(snapshotPromise);
  } catch (error) {
    if (error instanceof OutboundHttpError) throw error;
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (!(arrayBuffer instanceof ArrayBuffer) || arrayBuffer.byteLength !== intrinsicSize) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  const ownedBody = Buffer.from(new Uint8Array(arrayBuffer));
  return addIntrinsicBlobContentType({ ...fetchInit, body: ownedBody }, intrinsicType);
}

function declaredRequestLength(fetchInit, sinkId) {
  let value;
  try {
    value = headerValue(fetchInit.headers, 'content-length');
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, sinkId);
  }
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, sinkId);
  }
  try {
    return BigInt(normalized);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, sinkId);
  }
}

function validateRequestBody(fetchInit, policy) {
  let body;
  try {
    body = fetchInit.body;
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  let measuredLength;
  try {
    measuredLength = knownRequestBodyLength(body);
  } catch {
    measuredLength = null;
  }
  if (measuredLength === null) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_BODY_UNBOUNDED, policy.sinkId);
  }
  if (measuredLength > policy.maxRequestBytes) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_TOO_LARGE, policy.sinkId);
  }

  const declaredLength = declaredRequestLength(fetchInit, policy.sinkId);
  if (declaredLength !== null && declaredLength !== BigInt(measuredLength)) {
    throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_LENGTH_MISMATCH, policy.sinkId);
  }
  return measuredLength;
}

function ownRequestContentLength(fetchInit, measuredLength) {
  const normalized = Object.assign(Object.create(null), fetchInit.headers || {});
  delete normalized['content-length'];
  if (fetchInit.body !== undefined && fetchInit.body !== null) {
    normalized['content-length'] = String(measuredLength);
  }
  if (Object.keys(normalized).length === 0) {
    const { headers: _headers, ...withoutHeaders } = fetchInit;
    return withoutHeaders;
  }
  return { ...fetchInit, headers: Object.freeze(normalized) };
}

function declaredContentLength(response, sinkId) {
  let value;
  try {
    value = headerValue(response.headers, 'content-length');
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, sinkId);
  }
  if (value === null || value === undefined || value === '') return null;
  const normalized = String(value).trim();
  if (!/^\d+$/.test(normalized)) {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, sinkId);
  }
  try {
    return BigInt(normalized);
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, sinkId);
  }
}

function validateResponse(response, policy, requestedUrl, expectedOrigin) {
  let status;
  let redirected;
  let responseUrl;
  try {
    status = response?.status;
    redirected = response?.redirected;
    responseUrl = response?.url;
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, policy.sinkId);
  }

  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, policy.sinkId);
  }
  if (redirected === true || (status >= 300 && status <= 399)) {
    throw outboundError(OUTBOUND_ERROR_CODES.REDIRECT_REJECTED, policy.sinkId, status);
  }

  if (responseUrl) {
    let parsed;
    try {
      parsed = new URL(responseUrl);
    } catch {
      throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, policy.sinkId, status);
    }
    if (parsed.origin !== expectedOrigin || parsed.href !== requestedUrl.href) {
      throw outboundError(OUTBOUND_ERROR_CODES.REDIRECT_REJECTED, policy.sinkId, status);
    }
  }

  const length = declaredContentLength(response, policy.sinkId);
  if (length !== null && length > BigInt(policy.maxResponseBytes)) {
    throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE, policy.sinkId, status);
  }
  return status;
}

function createBodySource(body) {
  let webReader = null;
  let nodeIterator = null;
  let ended = false;
  let cancellation = null;

  const next = async () => {
    if (ended || !body) return { done: true, value: undefined };
    if (typeof body.getReader === 'function') {
      webReader ||= body.getReader();
      const result = await webReader.read();
      if (result.done) ended = true;
      return result;
    }
    if (typeof body[Symbol.asyncIterator] === 'function') {
      nodeIterator ||= body[Symbol.asyncIterator]();
      const result = await nodeIterator.next();
      if (result.done) ended = true;
      return result;
    }
    throw new TypeError('unreadable response body');
  };

  const release = () => {
    try {
      webReader?.releaseLock?.();
    } catch {
      // The stream may already have released its lock while being cancelled.
    }
  };

  const cancel = () => {
    if (cancellation) return cancellation;
    ended = true;
    cancellation = (async () => {
      try {
        if (webReader?.cancel) await webReader.cancel();
        else if (webReader === null && typeof body?.cancel === 'function') await body.cancel();
        else if (nodeIterator?.return) await nodeIterator.return();
        else if (typeof body?.destroy === 'function') body.destroy();
      } catch {
        // Best-effort cancellation; request abort remains authoritative.
      } finally {
        release();
      }
    })();
    return cancellation;
  };

  const finish = () => {
    ended = true;
    release();
  };

  return Object.freeze({ cancel, finish, next });
}

function chunkBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  }
  if (typeof value === 'string') return Buffer.from(value);
  throw new TypeError('unsupported response chunk');
}

const managedResponseState = new WeakMap();
const MANAGED_RESPONSE_CONSTRUCTOR_TOKEN = Object.freeze(Object.create(null));

function getManagedResponseState(response) {
  const state = response && typeof response === 'object'
    ? managedResponseState.get(response)
    : null;
  if (!state) throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE);
  return state;
}

function claimManagedBody(response) {
  const state = getManagedResponseState(response);
  if (state.bodyUsed) {
    throw outboundError(
      OUTBOUND_ERROR_CODES.BODY_ALREADY_USED,
      state.policy.sinkId,
      state.status
    );
  }
  state.lifecycle.throwIfAborted();
  state.bodyUsed = true;
  return state;
}

async function* iterateManagedBody(response) {
  let completed = false;
  const state = getManagedResponseState(response);
  const {
    lifecycle, policy, source, status,
  } = state;
  try {
    while (true) {
      let result;
      try {
        result = await lifecycle.race(source.next());
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE, policy.sinkId, status);
      }
      if (!result || typeof result.done !== 'boolean') {
        throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE, policy.sinkId, status);
      }
      if (result.done) {
        completed = true;
        source.finish();
        return;
      }

      let chunk;
      try {
        chunk = chunkBuffer(result.value);
      } catch {
        throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE, policy.sinkId, status);
      }
      state.bytesConsumed += chunk.byteLength;
      if (state.bytesConsumed > policy.maxResponseBytes) {
        throw outboundError(OUTBOUND_ERROR_CODES.RESPONSE_TOO_LARGE, policy.sinkId, status);
      }
      yield chunk;
    }
  } finally {
    if (!completed) await source.cancel();
    lifecycle.close();
  }
}

async function consumeManagedBytes(response) {
  const state = claimManagedBody(response);
  const chunks = [];
  let total = 0;
  for await (const chunk of iterateManagedBody(response)) {
    chunks.push(chunk);
    total += chunk.byteLength;
  }
  try {
    return Buffer.concat(chunks, total);
  } catch {
    throw outboundError(
      OUTBOUND_ERROR_CODES.RESPONSE_UNREADABLE,
      state.policy.sinkId,
      state.status
    );
  }
}

async function discardBoundedResponse(response) {
  claimManagedBody(response);
  for await (const _chunk of iterateManagedBody(response)) {
    // Drain incrementally. iterateManagedBody owns byte accounting, deadline
    // enforcement, and cancellation, so no aggregate response is retained.
  }
}

class ManagedOutboundResponse {
  constructor(constructorToken, { response, policy, lifecycle, status } = {}) {
    if (constructorToken !== MANAGED_RESPONSE_CONSTRUCTOR_TOKEN) {
      throw outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE);
    }
    const source = createBodySource(responseBody(response));
    this.ok = status >= 200 && status <= 299;
    this.status = status;
    this.headers = response.headers;
    managedResponseState.set(this, {
      bodyUsed: false,
      bytesConsumed: 0,
      lifecycle,
      policy,
      source,
      status,
    });

    Object.defineProperty(this, 'bodyUsed', {
      enumerable: true,
      get: () => getManagedResponseState(this).bodyUsed,
    });

    lifecycle.setAbortCleanup(async () => {
      await source.cancel();
      lifecycle.close();
    });
    Object.freeze(this);
  }

  stream() {
    const state = claimManagedBody(this);
    const iterator = iterateManagedBody(this);
    return Object.freeze({
      [Symbol.asyncIterator]() { return iterator; },
      cancel: async () => {
        state.lifecycle.abort(OUTBOUND_ERROR_CODES.RESPONSE_CANCELLED);
        await state.source.cancel();
        state.lifecycle.close();
      },
    });
  }

  async bytes() {
    return consumeManagedBytes(this);
  }

  async text() {
    return (await consumeManagedBytes(this)).toString('utf8');
  }

  async json() {
    const state = getManagedResponseState(this);
    const bytes = await consumeManagedBytes(this);
    try {
      return JSON.parse(bytes.toString('utf8'));
    } catch {
      throw outboundError(OUTBOUND_ERROR_CODES.INVALID_JSON, state.policy.sinkId, state.status);
    }
  }

  async cancel() {
    const state = getManagedResponseState(this);
    state.lifecycle.abort(OUTBOUND_ERROR_CODES.RESPONSE_CANCELLED);
    await state.source.cancel();
    state.lifecycle.close();
  }
}

Object.freeze(ManagedOutboundResponse.prototype);

function createOutboundHttpExecutor({
  authorityAdapter,
  fetchImpl = globalThis.fetch,
  operations,
  transportAdapter,
} = {}) {
  if (typeof fetchImpl !== 'function') {
    throw new TypeError('Outbound HTTP execution requires a Fetch-compatible function.');
  }
  const operationPolicies = normalizeOperations(operations);
  const admissions = new WeakMap();

  const admitTarget = async (sinkId, target, options = {}) => {
    if (!isSafeSinkId(sinkId)) {
      throw outboundError(OUTBOUND_ERROR_CODES.OPERATION_UNKNOWN);
    }
    const policy = operationPolicies.get(sinkId);
    if (!policy) throw outboundError(OUTBOUND_ERROR_CODES.OPERATION_UNKNOWN, sinkId);
    if (typeof authorityAdapter !== 'function') {
      throw outboundError(OUTBOUND_ERROR_CODES.AUTHORITY_ADAPTER_REQUIRED, sinkId);
    }

    let callerSignal;
    try {
      if (!isPlainObject(options)
        || Object.keys(options).some((key) => key !== 'signal')) {
        throw new TypeError('invalid admission options');
      }
      callerSignal = options.signal;
    } catch {
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
    }
    if (!isAbortSignal(callerSignal)) {
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
    }

    const requestedUrl = parseCandidateTarget(target, sinkId);
    let lifecycle;
    try {
      lifecycle = createLifecycle(policy, callerSignal);
    } catch (error) {
      if (error instanceof OutboundHttpError) throw error;
      throw outboundError(OUTBOUND_ERROR_CODES.POLICY_INVALID, sinkId);
    }
    lifecycle.setAbortCleanup(() => lifecycle.close());

    try {
      lifecycle.throwIfAborted();
      let admission;
      try {
        admission = await lifecycle.race(Promise.resolve().then(() => authorityAdapter(Object.freeze({
          authoritySource: policy.authoritySource,
          signal: lifecycle.signal,
          sinkId,
          target: requestedUrl.href,
        }))));
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
      }

      let expectedOrigin;
      try {
        if (!sameKeys(admission, ['expectedOrigin'])) {
          throw new TypeError('invalid admission');
        }
        expectedOrigin = parseExpectedOrigin(admission.expectedOrigin, sinkId);
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
      }
      if (requestedUrl.origin !== expectedOrigin) {
        throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
      }

      lifecycle.throwIfAborted();
      const receipt = Object.freeze(Object.create(null));
      admissions.set(receipt, Object.freeze({
        expectedOrigin,
        lifecycle,
        policy,
        requestedUrl,
      }));
      return receipt;
    } catch (error) {
      lifecycle.close();
      if (error instanceof OutboundHttpError) throw error;
      throw outboundError(OUTBOUND_ERROR_CODES.TARGET_REJECTED, sinkId);
    }
  };

  const request = async (receipt, options = {}) => {
    const admission = receipt && typeof receipt === 'object' ? admissions.get(receipt) : null;
    if (!admission) throw outboundError(OUTBOUND_ERROR_CODES.ADMISSION_INVALID);
    // Receipts are capabilities for one dispatch only.  Consume before any
    // validation or await so concurrent/retry paths cannot replay them.
    admissions.delete(receipt);
    const {
      expectedOrigin,
      lifecycle,
      policy,
      requestedUrl,
    } = admission;

    try {
      const { callerSignal, fetchInit: sanitizedFetchInit } = sanitizeFetchInit(options, policy.sinkId);
      lifecycle.addCallerSignal(callerSignal);
      const snapshottedFetchInit = await snapshotRequestBody(
        sanitizedFetchInit,
        policy,
        lifecycle
      );
      const measuredLength = validateRequestBody(snapshottedFetchInit, policy);
      const fetchInit = ownRequestContentLength(snapshottedFetchInit, measuredLength);

      if (typeof transportAdapter !== 'function') {
        throw outboundError(OUTBOUND_ERROR_CODES.TRANSPORT_ADAPTER_REQUIRED, policy.sinkId);
      }

      lifecycle.throwIfAborted();
      const init = Object.freeze({
        ...fetchInit,
        redirect: 'manual',
        signal: lifecycle.signal,
      });
      const authority = Object.freeze({
        authoritySource: policy.authoritySource,
        expectedOrigin,
        hostname: requestedUrl.hostname,
        port: requestedUrl.port || (requestedUrl.protocol === 'https:' ? '443' : '80'),
        protocol: requestedUrl.protocol,
        sinkId: policy.sinkId,
      });

      const dispatchPromise = Promise.resolve().then(() => transportAdapter(Object.freeze({
        authority,
        fetchImpl,
        init,
        target: requestedUrl.href,
      })));

      // If a non-conforming adapter ignores the AbortSignal and resolves after
      // the deadline, cancel its late body rather than orphaning the socket.
      dispatchPromise.then(
        (result) => {
          try {
            if (lifecycle.aborted || lifecycle.closed) {
              void cancelRawResponse(result?.response);
            }
          } catch {
            // A malformed late adapter result must not create an unhandled
            // rejection after the request has already timed out.
          }
        },
        () => {}
      ).catch(() => {});

      let result;
      try {
        result = await lifecycle.race(dispatchPromise);
      } catch (error) {
        if (error instanceof OutboundHttpError) throw error;
        throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_FAILED, policy.sinkId);
      }

      if (!result || typeof result !== 'object'
        || result.peerVerification !== CONNECT_TIME_PEER_VERIFICATION) {
        await cancelRawResponse(result?.response);
        throw outboundError(OUTBOUND_ERROR_CODES.PEER_UNVERIFIED, policy.sinkId);
      }

      const response = result.response;
      let status;
      try {
        status = validateResponse(response, policy, requestedUrl, expectedOrigin);
      } catch (error) {
        await cancelRawResponse(response);
        throw error instanceof OutboundHttpError
          ? error
          : outboundError(OUTBOUND_ERROR_CODES.INVALID_RESPONSE, policy.sinkId);
      }

      lifecycle.throwIfAborted();
      const managed = new ManagedOutboundResponse(
        MANAGED_RESPONSE_CONSTRUCTOR_TOKEN,
        { response, policy, lifecycle, status }
      );
      lifecycle.throwIfAborted();
      return managed;
    } catch (error) {
      lifecycle.close();
      if (error instanceof OutboundHttpError) throw error;
      throw outboundError(OUTBOUND_ERROR_CODES.REQUEST_FAILED, policy.sinkId);
    }
  };

  return Object.freeze({ admitTarget, request });
}

async function readBoundedBytes(response) {
  return consumeManagedBytes(response);
}

async function readBoundedText(response) {
  return (await consumeManagedBytes(response)).toString('utf8');
}

async function readBoundedJson(response) {
  const state = getManagedResponseState(response);
  const bytes = await consumeManagedBytes(response);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw outboundError(OUTBOUND_ERROR_CODES.INVALID_JSON, state.policy.sinkId, state.status);
  }
}

module.exports = {
  CONNECT_TIME_PEER_VERIFICATION,
  OUTBOUND_ERROR_CODES,
  OutboundHttpError,
  createOutboundHttpExecutor,
  discardBoundedResponse,
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
  toPublicOutboundError,
};
