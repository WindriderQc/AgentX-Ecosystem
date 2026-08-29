'use strict';

describe('RAG platform event client', () => {
  const savedToken = process.env.AGENTX_PLATFORM_EVENT_TOKEN;

  beforeEach(() => {
    process.env.AGENTX_PLATFORM_EVENT_TOKEN = 'shared-token';
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.AGENTX_PLATFORM_EVENT_TOKEN;
    else process.env.AGENTX_PLATFORM_EVENT_TOKEN = savedToken;
  });

  it('posts to the generic ingress with the rolling-compatible shared token', async () => {
    const deliverPlatformEvent = jest.fn().mockResolvedValue({ ok: true, status: 202 });
    const { createBuddyEventClient } = require('../../src/clients/buddyEventClient');
    const { emitBuddyEvent } = createBuddyEventClient({
      coreOutboundClient: { deliverPlatformEvent },
    });
    emitBuddyEvent('ingest_done', 'data', 'Ingest completed', 'normal', {
      intent: 'suggesting',
      surfaceScope: 'rag',
    });
    await Promise.resolve();

    expect(deliverPlatformEvent).toHaveBeenCalledWith({
      body: JSON.stringify({
        type: 'ingest_done',
        class: 'data',
        summary: 'Ingest completed',
        significance: 'normal',
        intent: 'suggesting',
        surfaceScope: 'rag',
      }),
      token: 'shared-token',
    });
  });

  it('keeps delivery failures best-effort and unobserved by the caller', async () => {
    const deliverPlatformEvent = jest.fn().mockRejectedValue(new Error('Core unavailable'));
    const { createBuddyEventClient } = require('../../src/clients/buddyEventClient');
    const { emitBuddyEvent } = createBuddyEventClient({
      coreOutboundClient: { deliverPlatformEvent },
    });

    expect(() => emitBuddyEvent('ingest_failed', 'system', 'Ingest failed')).not.toThrow();
    await Promise.resolve();
  });
});
