/**
 * Buddy event client — fire-and-forget emit to core's bus.
 *
 * Posts to Core's generic `/api/platform-events` ingress. Standalone Nestor
 * consumes the supported v1 stream; Benchmark no longer hosts a Buddy widget
 * or proxy.
 *
 * Failures are swallowed: companion observability is non-critical. A bench
 * batch must not fail because the event bus is down.
 */

const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';

function emitBuddyEvent(type, eventClass, summary, significance, opts) {
  opts = opts || {};
  const body = JSON.stringify({
    type,
    class: eventClass,
    summary,
    significance: significance || 'normal',
    intent: opts.intent,
    surfaceScope: opts.surfaceScope,
  });

  const headers = { 'Content-Type': 'application/json' };

  fetch(`${CORE_URL}/api/platform-events`, {
    method: 'POST',
    headers,
    body,
  }).catch(() => {
    // Silent — companion events are best-effort observability.
  });
}

module.exports = { emitBuddyEvent };
