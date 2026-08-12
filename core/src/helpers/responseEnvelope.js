/**
 * Response envelope helpers for consistent API responses.
 *
 * Standard formats:
 *   Success: { ok: true, status: 'success', data, meta? }
 *   Error:   { ok: false, status: 'error', error, message, code? }
 */

/**
 * Send a success response.
 * @param {import('express').Response} res
 * @param {*} data
 * @param {object} [meta] - Optional metadata (e.g. { durationMs: 12 })
 * @param {number} [statusCode=200]
 */
function success(res, data, meta, statusCode = 200) {
  const body = { ok: true, status: 'success', data };
  if (meta && typeof meta === 'object') body.meta = meta;
  return res.status(statusCode).json(body);
}

/**
 * Send an error response.
 * @param {import('express').Response} res
 * @param {number} statusCode - HTTP status code (e.g. 400, 404, 500)
 * @param {string} message - Human-readable error message
 * @param {string} [code] - Optional machine-readable error code
 */
function error(res, statusCode, message, code) {
  const body = { ok: false, status: 'error', error: message, message };
  if (code) body.code = code;
  return res.status(statusCode).json(body);
}

module.exports = { success, error };
