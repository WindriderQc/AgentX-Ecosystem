'use strict';

const { emit: emitPlatformEvent } = require('./buddyEvents');

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

function callerAddress(req) {
  return req.ip || req.connection?.remoteAddress || '';
}

function callerAuthorized(req) {
  if (LOOPBACK_ADDRESSES.has(callerAddress(req))) return true;

  // BUDDY_EMIT_TOKEN remains the deployed secret name during compatibility.
  // New producers use the generic header; the old header remains accepted for
  // the pinned /api/buddy/emit consumer and rolling deployments.
  const expectedToken = process.env.BUDDY_EMIT_TOKEN;
  const presentedToken = req.get('x-platform-event-token') || req.get('x-buddy-emit-token');
  return Boolean(expectedToken) && presentedToken === expectedToken;
}

function platformEventIngress(req, res) {
  if (!callerAuthorized(req)) {
    return res.status(403).json({
      error: 'forbidden',
      message: 'loopback or valid X-Platform-Event-Token required',
    });
  }

  const { type, summary, significance, intent, surfaceScope } = req.body || {};
  const eventClass = req.body?.class;
  if (typeof type !== 'string' || typeof eventClass !== 'string' || typeof summary !== 'string') {
    return res.status(400).json({ error: 'invalid_payload', message: 'type, class, summary required' });
  }

  const event = emitPlatformEvent(
    type,
    eventClass,
    summary.slice(0, 500),
    significance,
    { intent, surfaceScope }
  );
  return res.json({ status: 'success', eventId: event?.id || null });
}

module.exports = {
  platformEventIngress,
  callerAuthorized,
};
