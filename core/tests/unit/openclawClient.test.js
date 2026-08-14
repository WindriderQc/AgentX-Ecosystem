jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const path = require('path');

describe('openclawClient capability helpers', () => {
  const modulePath = '../../src/services/openclawClient';
  const originalEnv = { ...process.env };

  function loadModule() {
    jest.resetModules();
    return require(modulePath);
  }

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.AGENTX_OPENCLAW_ENABLED;
    delete process.env.OPENCLAW_INTEGRATION_ENABLED;
    delete process.env.OPENCLAW_GATEWAY_URL;
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
    delete process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL;
    delete process.env.OPENCLAW_CONTROL_UI_LOCAL_URL;
    delete process.env.OPENCLAW_CONTROL_UI_MODE;
    delete process.env.OPENCLAW_CONTROL_UI_SSH_TARGET;
    delete process.env.OPENCLAW_CONTROL_UI_SSH_USER;
    delete process.env.OPENCLAW_INVENTORY_SSH_TARGET;
    delete process.env.OPENCLAW_HOME;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('honors explicit disable even when gateway URL is present', () => {
    process.env.AGENTX_OPENCLAW_ENABLED = '0';
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789';

    const { isOpenClawIntegrationEnabled } = loadModule();
    expect(isOpenClawIntegrationEnabled()).toBe(false);
  });

  it('enables integration when gateway URL is provided', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789';

    const { isOpenClawIntegrationEnabled } = loadModule();
    expect(isOpenClawIntegrationEnabled()).toBe(true);
  });

  it('enables integration when an official inventory SSH target is provided', () => {
    process.env.OPENCLAW_INVENTORY_SSH_TARGET = 'operator@192.0.2.66';

    const { isOpenClawIntegrationEnabled } = loadModule();
    expect(isOpenClawIntegrationEnabled()).toBe(true);
  });

  it('reports runtime config with the official Control UI handoff', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789';
    process.env.OPENCLAW_HOME = '/tmp/openclaw-home';

    const { getOpenClawRuntimeConfig } = loadModule();
    expect(getOpenClawRuntimeConfig()).toMatchObject({
      enabled: true,
      home: '/tmp/openclaw-home',
      configPath: path.join('/tmp/openclaw-home', 'openclaw.json'),
      gatewayUrl: 'http://127.0.0.1:18789',
      controlUi: {
        authority: 'official-openclaw-control-ui',
        launchBaseUrl: 'http://127.0.0.1:18789',
        mode: 'direct',
        requiresTunnel: false
      }
    });
  });

  it('uses the browser-facing plain-HTTP LAN Control UI URL when provided', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://192.0.2.66:18789';
    process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL = 'http://192.0.2.66:18789';

    const { getOpenClawRuntimeConfig } = loadModule();
    expect(getOpenClawRuntimeConfig().controlUi).toMatchObject({
      directBaseUrl: 'http://192.0.2.66:18789',
      launchBaseUrl: 'http://192.0.2.66:18789',
      mode: 'direct',
      requiresTunnel: false,
    });
  });

  it('builds a browser-only token handoff without exposing it in runtime config', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://192.0.2.66:18789';
    process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL = 'https://192.0.2.99:18790';
    process.env.OPENCLAW_GATEWAY_TOKEN = 'mobile-secret';

    const { getOpenClawControlLaunchUrl, getOpenClawRuntimeConfig } = loadModule();
    const launchUrl = getOpenClawControlLaunchUrl('chat', { agent: 'main' });

    expect(launchUrl).toBe('https://192.0.2.99:18790/chat?agent=main#token=mobile-secret');
    expect(JSON.stringify(getOpenClawRuntimeConfig())).not.toContain('mobile-secret');
  });

  it('fails closed when a one-click Control UI launch has no token', () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://192.0.2.66:18789';
    process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL = 'https://192.0.2.99:18790';
    process.env.OPENCLAW_HOME = path.join(process.cwd(), 'not-real-openclaw-home');

    const { getOpenClawControlLaunchUrl } = loadModule();
    expect(() => getOpenClawControlLaunchUrl('chat')).toThrow(
      'OpenClaw gateway token is not configured in AgentX'
    );
  });

  it('routes supported OpenResponses turns by agent and session headers', async () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789';
    process.env.OPENCLAW_GATEWAY_TOKEN = 'test-token';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ output: [{ content: [{ type: 'output_text', text: 'hello' }] }] })
    });

    const { getOpenClawClient } = loadModule();
    const result = await getOpenClawClient().respond('hi', {
      agentId: 'main',
      sessionKey: 'agent:main:nestor-test',
      instructions: 'Use live AgentX context.',
      timeout: 1000
    });

    expect(result.output[0].content[0].text).toBe('hello');
    expect(global.fetch).toHaveBeenCalledWith(
      'http://127.0.0.1:18789/v1/responses',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test-token',
          'x-openclaw-agent-id': 'main',
          'x-openclaw-session-key': 'agent:main:nestor-test'
        })
      })
    );
    const requestBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(requestBody.instructions).toBe('Use live AgentX context.');
  });

  it('streams OpenResponses text deltas without exposing non-text events', async () => {
    process.env.OPENCLAW_GATEWAY_URL = 'http://127.0.0.1:18789';
    const encoder = new TextEncoder();
    const chunks = [
      'event: response.created\r\ndata: {"type":"response.created"}\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":"Bon',
      'jour"}\r\n\r\nevent: response.output_text.delta\r\ndata: {"delta":" Example User."}\r\n\r\n',
      'event: response.completed\r\ndata: {"response":{"output":[]}}\r\n\r\ndata: [DONE]\r\n\r\n'
    ].map((chunk) => encoder.encode(chunk));
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      body: {
        getReader: () => ({
          read: jest.fn(async () => chunks.length
            ? { value: chunks.shift(), done: false }
            : { value: undefined, done: true }),
          cancel: jest.fn(async () => {})
        })
      }
    });
    const deltas = [];
    const events = [];

    const { getOpenClawClient } = loadModule();
    const result = await getOpenClawClient().respondStream('bonjour', {
      agentId: 'main',
      sessionKey: 'agent:main:nestor-stream',
      onDelta: (delta) => deltas.push(delta),
      onEvent: ({ event }) => events.push(event)
    });

    expect(result.text).toBe('Bonjour Example User.');
    expect(deltas).toEqual(['Bonjour', ' Example User.']);
    expect(events).toContain('response.created');
    expect(events).toContain('response.completed');
    const request = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(request.stream).toBe(true);
    expect(global.fetch.mock.calls[0][1].headers.Accept).toBe('text/event-stream');
  });
});
