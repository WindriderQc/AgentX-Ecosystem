'use strict';

describe('Benchmark platform event client', () => {
  const savedFetch = global.fetch;
  const savedToken = process.env.AGENTX_PLATFORM_EVENT_TOKEN;
  const savedCoreUrl = process.env.CORE_URL;

  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn(() => Promise.resolve({ ok: true }));
    process.env.CORE_URL = 'http://core.test:3080';
    process.env.AGENTX_PLATFORM_EVENT_TOKEN = 'shared-token';
  });

  afterEach(() => {
    global.fetch = savedFetch;
    if (savedToken === undefined) delete process.env.AGENTX_PLATFORM_EVENT_TOKEN;
    else process.env.AGENTX_PLATFORM_EVENT_TOKEN = savedToken;
    if (savedCoreUrl === undefined) delete process.env.CORE_URL;
    else process.env.CORE_URL = savedCoreUrl;
  });

  it('posts to the generic ingress with the rolling-compatible shared token', () => {
    const { emitBuddyEvent } = require('../../src/clients/buddyEventClient');
    emitBuddyEvent('judge_start', 'benchmark', 'Judge started', 'normal', {
      intent: 'watching',
      surfaceScope: 'benchmark',
    });

    expect(global.fetch).toHaveBeenCalledWith(
      'http://core.test:3080/api/platform-events',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Platform-Event-Token': 'shared-token' }),
      })
    );
  });
});
