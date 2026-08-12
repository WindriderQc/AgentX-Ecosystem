/**
 * Shared response helpers — consistent envelope for all RAG API responses.
 * Envelope shape: { ok, data?, error?, detail?, meta? }
 */

function sendOk(res, data, meta = {}) {
  const envelope = { ok: true, data };
  if (Object.keys(meta).length) envelope.meta = meta;
  return res.json(envelope);
}

function sendError(res, status, message, detail = null, meta = {}) {
  const envelope = { ok: false, error: message };
  if (detail && process.env.NODE_ENV !== 'production') {
    envelope.detail = detail;
  }
  if (Object.keys(meta).length) envelope.meta = meta;
  return res.status(status).json(envelope);
}

module.exports = { sendOk, sendError };
