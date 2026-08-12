'use strict';

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function addCanonicalEnvelope(body) {
  if (!isPlainObject(body) || Object.prototype.hasOwnProperty.call(body, 'ok')) {
    return body;
  }

  if (body.status === 'success') {
    return { ok: true, ...body };
  }

  if (body.status === 'error') {
    const next = { ok: false, ...body };
    if (!Object.prototype.hasOwnProperty.call(next, 'error') && typeof body.message === 'string') {
      next.error = body.message;
    }
    return next;
  }

  return body;
}

function responseEnvelopeCompatibility(_req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (body) => originalJson(addCanonicalEnvelope(body));
  next();
}

module.exports = {
  addCanonicalEnvelope,
  responseEnvelopeCompatibility
};
