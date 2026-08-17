'use strict';

/**
 * Service-edge relay primitives — task 0520.
 *
 * Shared relay primitives for Core's service proxies. They keep correlation
 * headers, cancellation, and response streaming consistent at service edges.
 *
 *   - A relay must not forward unrelated caller credentials.
 *   - It must abort the upstream request when the client disconnects, so a
 *     cancelled SSE stream leaves a generation running on a GPU.
 *
 * This module is the one shared answer. It is pure except for stream plumbing,
 * so it is testable without a live upstream.
 */

const { Readable } = require('stream');

/**
 * Headers that may cross the service edge — an ALLOWLIST, deliberately.
 *
 * A blocklist of credential headers is the obvious design and the wrong one: it
 * is only correct until someone invents a new header name, and the failure mode
 * is silent credential forwarding. With an allowlist, a new header is simply not
 * relayed, and anything privileged must be injected explicitly and server-side.
 * The guarantee "secrets are never forwarded" then holds structurally rather
 * than by keeping an enumeration up to date.
 *
 * Hop-by-hop headers (RFC 7230 s6.1) are excluded for free by the same rule:
 * they describe a single connection and must never be relayed onto the next one.
 */
const FORWARDABLE_HEADERS = Object.freeze(['content-type', 'accept', 'user-agent', 'accept-language']);

/** Correlation headers, propagated so one request is traceable across services. */
const CORRELATION_HEADER = 'x-correlation-id';
const CALLER_HEADER = 'x-agentx-caller';

/** Never relayed. Kept only so tests and reviewers can assert intent explicitly. */
const NEVER_FORWARD = Object.freeze([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'x-agentx-mcp-token', 'x-auth-token', 'api-key',
  // hop-by-hop (RFC 7230 s6.1)
  'connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade',
  'proxy-connection',
]);

const DEFAULT_RELAY_TIMEOUT_MS = Number(process.env.SERVICE_RELAY_TIMEOUT_MS || 120_000);

function headerValue(req, name) {
  if (typeof req?.get === 'function') return req.get(name);
  return req?.headers?.[name.toLowerCase()];
}

/**
 * Build the header set for an upstream call.
 *
 * @param {object} req            Express request being relayed.
 * @param {object} [options]
 * @param {object} [options.inject] Server-side headers to add (credentials go
 *   here and nowhere else — they are applied after filtering, so they cannot be
 *   spoofed by an inbound header of the same name).
 * @param {string} [options.contentType] Override Content-Type.
 */
function buildRelayHeaders(req, options = {}) {
  const headers = {};

  for (const name of FORWARDABLE_HEADERS) {
    const value = headerValue(req, name);
    if (value) headers[name] = String(value);
  }
  headers['content-type'] = options.contentType || headers['content-type'] || 'application/json';

  // Correlation survives the hop; without this a trace ends at the edge.
  const correlationId = options.correlationId || req?.correlationId || headerValue(req, CORRELATION_HEADER);
  if (correlationId) headers[CORRELATION_HEADER] = String(correlationId);

  const caller = headerValue(req, CALLER_HEADER);
  if (caller) headers[CALLER_HEADER] = String(caller);

  // Injection last: a server-side credential must win over any inbound header
  // that happens to share its name.
  for (const [name, value] of Object.entries(options.inject || {})) {
    if (value == null) continue;
    headers[String(name).toLowerCase()] = String(value);
  }

  return headers;
}

/**
 * An abort signal that fires on client disconnect or after a bounded timeout.
 *
 * Both halves matter for the same reason. An upstream request nobody is waiting
 * for still occupies a model runner; on a GPU host that is capacity taken from
 * work that *is* wanted. Unbounded relays also stack up until the socket pool
 * starves, which presents as unrelated services timing out.
 *
 * Returns `dispose()` — always call it in a `finally`, or the timer keeps the
 * event loop alive past the request.
 */
function relayAbortSignal(req, options = {}) {
  const controller = new AbortController();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_RELAY_TIMEOUT_MS;

  let reason = null;
  const abort = (why) => {
    if (controller.signal.aborted) return;
    reason = why;
    controller.abort();
  };

  const timer = setTimeout(() => abort('timeout'), timeoutMs);
  if (typeof timer.unref === 'function') timer.unref();

  const onClose = () => abort('client_disconnect');
  req?.on?.('close', onClose);

  return {
    signal: controller.signal,
    get reason() { return reason; },
    abort,
    dispose() {
      clearTimeout(timer);
      req?.off?.('close', onClose);
    },
  };
}

/**
 * Pipe an upstream SSE body to the client, aborting upstream on disconnect.
 *
 * The subtle part: destroying the local `Readable` wrapper does NOT stop the
 * upstream HTTP request. Without an explicit abort the generation runs to
 * completion with nobody reading it — the exact leak this primitive exists to
 * close. `relay.abort` is therefore the operative line, not `upstream.destroy`.
 */
function pipeEventStream(response, req, res, relay) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // proxies must not buffer SSE

  const upstream = Readable.fromWeb(response.body);
  upstream.pipe(res);

  const stop = () => {
    upstream.destroy();
    relay?.abort?.('client_disconnect');
    relay?.dispose?.();
  };
  req.on('close', stop);
  upstream.on('end', () => relay?.dispose?.());
  upstream.on('error', stop);

  return upstream;
}

module.exports = {
  FORWARDABLE_HEADERS,
  NEVER_FORWARD,
  CORRELATION_HEADER,
  CALLER_HEADER,
  DEFAULT_RELAY_TIMEOUT_MS,
  buildRelayHeaders,
  relayAbortSignal,
  pipeEventStream,
};
