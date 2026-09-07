'use strict';

const express = require('express');
const { emit: emitPlatformEvent } = require('../src/services/buddyEvents');

const router = express.Router();

// Generic, server-to-server platform event ingress. This route feeds the same
// in-process bus exposed to Nestor by /api/consumers/nestor/v1/events/stream.
router.post('/', (req, res) => {
  const { type, summary, significance, intent, surfaceScope } = req.body || {};
  const eventClass = req.body?.class;
  if (typeof type !== 'string' || typeof eventClass !== 'string' || typeof summary !== 'string') {
    return res.status(400).json({ error: 'invalid_payload', message: 'type, class, summary required' });
  }
  const event = emitPlatformEvent(type, eventClass, summary.slice(0, 500), significance, { intent, surfaceScope });
  return res.json({ status: 'success', eventId: event?.id || null });
});

module.exports = router;
