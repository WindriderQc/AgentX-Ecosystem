'use strict';

const DEFAULT_MAX_JSON_BYTES = 1024 * 1024;

class ResponseBodyLimitError extends Error {
  constructor(maxBytes) {
    super(`Ollama response exceeded the ${maxBytes}-byte limit`);
    this.name = 'ResponseBodyLimitError';
    this.code = 'OLLAMA_RESPONSE_TOO_LARGE';
  }
}

function contentLength(response) {
  const raw = response?.headers?.get
    ? response.headers.get('content-length')
    : response?.headers?.['content-length'];
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function cancelBody(body, reader) {
  try {
    if (reader?.cancel) await reader.cancel();
    else if (body?.cancel) await body.cancel();
    else if (body?.destroy) body.destroy();
  } catch {
    // Best-effort cancellation; the caller's timeout/abort signal remains live.
  }
}

async function readBoundedJson(response, { maxBytes = DEFAULT_MAX_JSON_BYTES } = {}) {
  if (contentLength(response) > maxBytes) {
    await cancelBody(response?.body);
    throw new ResponseBodyLimitError(maxBytes);
  }

  const body = response?.body;
  if (!body) throw new Error('Ollama response body stream is unavailable');

  const chunks = [];
  let total = 0;
  const append = async (chunk, reader) => {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      await cancelBody(body, reader);
      throw new ResponseBodyLimitError(maxBytes);
    }
    chunks.push(buffer);
  };

  if (typeof body.getReader === 'function') {
    const reader = body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      await append(value, reader);
    }
  } else if (typeof body[Symbol.asyncIterator] === 'function') {
    for await (const chunk of body) await append(chunk);
  } else {
    throw new Error('Ollama response body is not a readable stream');
  }

  return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
}

module.exports = {
  DEFAULT_MAX_JSON_BYTES,
  ResponseBodyLimitError,
  readBoundedJson
};
