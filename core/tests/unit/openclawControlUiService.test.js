const {
  getOpenClawControlUiConfig,
  hasSecureBrowserContext
} = require('../../src/services/openclawControlUiService');

describe('openclawControlUiService', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL;
    delete process.env.OPENCLAW_CONTROL_UI_LOCAL_URL;
    delete process.env.OPENCLAW_CONTROL_UI_MODE;
    delete process.env.OPENCLAW_CONTROL_UI_SSH_TARGET;
    delete process.env.OPENCLAW_CONTROL_UI_SSH_USER;
    delete process.env.OPENCLAW_INVENTORY_SSH_TARGET;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('recognizes HTTPS and loopback HTTP as secure browser contexts', () => {
    expect(hasSecureBrowserContext('https://claw.example.test')).toBe(true);
    expect(hasSecureBrowserContext('http://127.0.0.1:18790')).toBe(true);
    expect(hasSecureBrowserContext('http://localhost:18790')).toBe(true);
    expect(hasSecureBrowserContext('http://192.0.2.66:18789')).toBe(false);
  });

  test('uses a configured plain-HTTP LAN Control UI directly', () => {
    const config = getOpenClawControlUiConfig({
      gatewayUrl: 'http://192.0.2.66:18789',
      localBaseUrl: 'http://127.0.0.1:18790',
      tunnelTarget: 'operator@192.0.2.66'
    });

    expect(config).toMatchObject({
      authority: 'official-openclaw-control-ui',
      directBaseUrl: 'http://192.0.2.66:18789',
      launchBaseUrl: 'http://192.0.2.66:18789',
      mode: 'direct',
      secureContextAvailable: false,
      requiresSecureContext: false,
      requiresTunnel: false,
      tunnelCommand: ''
    });
    expect(config.nativeCapabilities).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'agents', owner: 'openclaw', href: 'http://192.0.2.66:18789/agents' }),
      expect.objectContaining({ id: 'cron', owner: 'openclaw', href: 'http://192.0.2.66:18789/cron' }),
      expect.objectContaining({ id: 'tasks', owner: 'openclaw', href: 'http://192.0.2.66:18789/tasks' })
    ]));
    expect(config.agentx).toMatchObject({
      authority: 'cross-platform-complements',
      complements: expect.arrayContaining([
        expect.objectContaining({ id: 'integration-events', owner: 'agentx' }),
        expect.objectContaining({ id: 'provider-usage', owner: 'agentx' })
      ])
    });
  });

  test('builds a localhost handoff only when SSH tunnel mode is explicit', () => {
    const config = getOpenClawControlUiConfig({
      gatewayUrl: 'http://192.0.2.66:18789',
      localBaseUrl: 'http://127.0.0.1:18790',
      tunnelTarget: 'operator@192.0.2.66',
      mode: 'ssh-tunnel'
    });

    expect(config).toMatchObject({
      directBaseUrl: 'http://192.0.2.66:18789',
      launchBaseUrl: 'http://127.0.0.1:18790',
      mode: 'ssh-tunnel',
      requiresTunnel: true,
      tunnelCommand: 'ssh -N -L 18790:127.0.0.1:18789 operator@192.0.2.66'
    });
  });

  test('uses a configured HTTPS Control UI directly without a tunnel command', () => {
    const config = getOpenClawControlUiConfig({
      gatewayUrl: 'http://192.0.2.66:18789',
      directBaseUrl: 'https://openclaw.example.test'
    });

    expect(config).toMatchObject({
      launchBaseUrl: 'https://openclaw.example.test',
      mode: 'direct',
      secureContextAvailable: true,
      requiresTunnel: false,
      tunnelCommand: ''
    });
  });
});
