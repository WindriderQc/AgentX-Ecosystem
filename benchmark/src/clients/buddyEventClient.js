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
  // Task 0277: cross-container emits (benchmark -> core over the Docker
  // bridge) are non-loopback, so core rejects them unless a shared secret
  // is presented. Send it only when configured; otherwise stay loopback-only.
  if (process.env.BUDDY_EMIT_TOKEN) {
    headers['X-Platform-Event-Token'] = process.env.BUDDY_EMIT_TOKEN;
  }

  fetch(`${CORE_URL}/api/platform-events`, {
    method: 'POST',
    headers,
    body,
  }).catch(() => {
    // Silent — companion events are best-effort observability.
  });
}

module.exports = { emitBuddyEvent };
