/**
 * Buddy event client — fire-and-forget emit to core's bus.
 *
 * Posts to Core's generic `/api/platform-events` ingress. Standalone Nestor
 * consumes the supported v1 stream; RAG no longer hosts a Buddy widget or
 * proxy.
 *
 * Failures are swallowed: companion observability is non-critical. A RAG
 * ingest must not fail because the event bus is down.
 */

const { createCoreOutboundClient } = require('./coreOutboundClient');

function createBuddyEventClient(options = {}) {
  const coreOutboundClient = options.coreOutboundClient || createCoreOutboundClient(options);

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

    // Task 0277: cross-container emits (rag -> core over the Docker bridge)
    // are non-loopback, so core rejects them unless a shared secret is
    // presented. Send it only when configured; otherwise stay loopback-only.
    void coreOutboundClient.deliverPlatformEvent({
      body,
      token: process.env.AGENTX_PLATFORM_EVENT_TOKEN,
    }).catch(() => {
      // Silent — companion events are best-effort observability.
    });
  }

  return Object.freeze({ emitBuddyEvent });
}

const { emitBuddyEvent } = createBuddyEventClient();

module.exports = { createBuddyEventClient, emitBuddyEvent };
