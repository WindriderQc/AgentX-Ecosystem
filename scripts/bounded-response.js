'use strict';

const { TextDecoder } = require('node:util');

class BoundedResponseError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BoundedResponseError';
    this.code = code;
  }
}

function requiredPositiveLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError('Response byte limit must be a positive safe integer.');
  }
  return value;
}

function declaredLength(response) {
  const raw = response?.headers?.get?.('content-length');
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const normalized = String(raw).trim();
  if (!/^(?:0|[1-9]\d*)$/.test(normalized)) {
    throw new BoundedResponseError('INVALID_CONTENT_LENGTH', 'Response Content-Length is invalid.');
  }
  const value = Number(normalized);
  if (!Number.isSafeInteger(value)) {
    throw new BoundedResponseError('INVALID_CONTENT_LENGTH', 'Response Content-Length is invalid.');
  }
  return value;
}

function abortError() {
  return new BoundedResponseError('RESPONSE_ABORTED', 'Response body deadline or cancellation was reached.');
}

async function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  let onAbort;
  const aborted = new Promise((_, reject) => {
    onAbort = () => reject(abortError());
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener('abort', onAbort);
  }
}

async function cancelBody(body, iterator) {
  try {
    if (iterator?.cancel) await iterator.cancel();
    else if (iterator?.return) await iterator.return();
    else if (body?.cancel) await body.cancel();
    else body?.destroy?.();
  } catch {
    // Cancellation is best-effort after the bounded reader has already failed.
  }
}

async function cancelResponseBody(response) {
  await cancelBody(response?.body);
}

async function readBoundedBytes(response, { maxBytes, signal } = {}) {
  const limit = requiredPositiveLimit(maxBytes);
  if (!response || typeof response !== 'object') {
    throw new BoundedResponseError('INVALID_RESPONSE', 'HTTP response is invalid.');
  }

  let length;
  try {
    length = declaredLength(response);
  } catch (error) {
    await cancelBody(response.body);
    throw error;
  }
  if (length !== null && length > limit) {
    await cancelBody(response.body);
    throw new BoundedResponseError('RESPONSE_TOO_LARGE', 'Response body exceeded its byte limit.');
  }

  const body = response.body;
  if (!body) {
    if (length === 0) return Buffer.alloc(0);
    throw new BoundedResponseError('RESPONSE_UNREADABLE', 'Response body is not stream-readable.');
  }

  const chunks = [];
  let total = 0;
  const append = (value) => {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > limit) {
      throw new BoundedResponseError('RESPONSE_TOO_LARGE', 'Response body exceeded its byte limit.');
    }
    chunks.push(chunk);
  };

  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    try {
      while (true) {
        const next = await waitWithSignal(reader.read(), signal);
        if (next.done) break;
        append(next.value);
      }
    } catch (error) {
      await cancelBody(body, reader);
      throw error;
    } finally {
      reader.releaseLock?.();
    }
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    const iterator = body[Symbol.asyncIterator]();
    try {
      while (true) {
        const next = await waitWithSignal(iterator.next(), signal);
        if (next.done) break;
        append(next.value);
      }
    } catch (error) {
      await cancelBody(body, iterator);
      throw error;
    }
  } else {
    await cancelBody(body);
    throw new BoundedResponseError('RESPONSE_UNREADABLE', 'Response body is not stream-readable.');
  }

  return Buffer.concat(chunks, total);
}

async function readBoundedText(response, options) {
  const bytes = await readBoundedBytes(response, options);
  return new TextDecoder('utf-8').decode(bytes);
}

async function readBoundedJson(response, options) {
  const text = await readBoundedText(response, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new BoundedResponseError('INVALID_JSON', 'Response body is not valid JSON.');
  }
}

module.exports = {
  BoundedResponseError,
  cancelResponseBody,
  declaredLength,
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
};
