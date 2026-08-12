const express = require('express');
const router = express.Router();
const logger = require('../config/logger');
const { buildRelayHeaders, relayAbortSignal, pipeEventStream } = require('../src/helpers/serviceRelay');

const DATA_BASE = process.env.DATAAPI_BASE_URL || 'http://localhost:3083';

// Generic proxy — forwards /api/data/* → DATA_BASE/api/v1/*
// Preserves method, body, and query string
router.all('/*', async (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  const path = `/api/v1${req.path}`;
  const url = `${DATA_BASE}${path}${qs ? '?' + qs : ''}`;
  // Shared service-edge primitives (task 0520): correlation survives the hop,
  // credentials never do, and the upstream is bounded and cancellable.
  const relay = relayAbortSignal(req);
  try {
    const opts = {
      method: req.method,
      headers: buildRelayHeaders(req),
      signal: relay.signal,
    };
    if (req.method !== 'GET' && req.method !== 'HEAD') opts.body = JSON.stringify(req.body);
    const response = await fetch(url, opts);
    const contentType = response.headers.get('content-type') || '';

    // SSE passthrough. pipeEventStream owns relay disposal from here — it must
    // abort the upstream fetch on disconnect, not just destroy the local
    // wrapper, or the feed keeps running with nobody reading it.
    if (contentType.includes('text/event-stream')) {
      pipeEventStream(response, req, res, relay);
      return;
    }

    if (contentType.includes('json')) {
      const data = await response.json();
      res.status(response.status).json(data);
    } else {
      const text = await response.text();
      res.status(response.status).type(contentType || 'text/plain').send(text);
    }
    relay.dispose();
  } catch (err) {
    relay.dispose();
    // A client that hung up is not a service failure; writing to a closed
    // socket would also throw and mask the real reason.
    if (relay.reason === 'client_disconnect' || err.name === 'AbortError') {
      logger.debug('Data proxy relay aborted', { path, reason: relay.reason || 'abort' });
      return;
    }
    logger.warn('Data proxy error', { path, error: err.message });
    res.status(502).json({ status: 'error', message: 'Data service unreachable', detail: err.message });
  }
});

module.exports = router;
