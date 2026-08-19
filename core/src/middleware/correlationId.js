'use strict';

const crypto = require('crypto');

/**
 * Correlation-ID middleware.
 *
 * Propagates an incoming `x-correlation-id` header (from any
 * upstream caller) or generates a new one.  The ID is attached to both the
 * request object (`req.correlationId`) and the response header so downstream
 * services (Benchmark and RAG) can be traced back to the originating request.
 */
function correlationId(req, res, next) {
  const id = req.headers['x-correlation-id'] || crypto.randomUUID();
  req.correlationId = id;
  res.setHeader('x-correlation-id', id);
  next();
}

module.exports = correlationId;
