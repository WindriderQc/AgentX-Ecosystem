const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

const mockBuildOpenClawAgentInventory = jest.fn();
jest.mock('../../src/services/openclawAgentInventoryService', () => ({
  buildOpenClawAgentInventory: (...args) => mockBuildOpenClawAgentInventory(...args),
}));

describe('personalityAdapters', () => {
  let tmpdir;
  let originalOpenclaw;
  let originalHermesPublicUrl;
  let originalHermesDashboardUrl;
  let originalHermesProfile;
  let originalFetch;

  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: jest.fn().mockResolvedValue(body),
      text: jest.fn().mockResolvedValue(JSON.stringify(body)),
    };
  }

  function textResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      json: jest.fn().mockResolvedValue({}),
      text: jest.fn().mockResolvedValue(body),
    };
  }

  function mockHermesDashboard({ soul = 'hermes soul body', profiles } = {}) {
    global.fetch = jest.fn(async (url, opts = {}) => {
      const headers = opts.headers || {};
      if (url === 'http://hermes.test/') {
        return textResponse('<script>window.__HERMES_SESSION_TOKEN__="token-123";</script>');
      }
      if (url === 'http://hermes.test/api/profiles') {
        expect(headers['X-Hermes-Session-Token']).toBe('token-123');
        return jsonResponse({ profiles: profiles || [{ name: 'default', is_default: true }] });
      }
      if (url === 'http://hermes.test/api/profiles/default/soul') {
        expect(headers['X-Hermes-Session-Token']).toBe('token-123');
        return jsonResponse({ content: soul, exists: true });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  }

  function restoreEnv(key, value) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  beforeEach(async () => {
    tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pa-test-'));
    originalOpenclaw = process.env.OPENCLAW_HOME;
    originalHermesPublicUrl = process.env.HERMES_PUBLIC_URL;
    originalHermesDashboardUrl = process.env.HERMES_DASHBOARD_URL;
    originalHermesProfile = process.env.HERMES_PROFILE;
    originalFetch = global.fetch;
    process.env.HERMES_PUBLIC_URL = 'http://hermes.test';
    delete process.env.HERMES_DASHBOARD_URL;
    delete process.env.HERMES_PROFILE;
    process.env.OPENCLAW_HOME = path.join(tmpdir, 'openclaw');
    await fsp.mkdir(process.env.OPENCLAW_HOME, { recursive: true });
    mockBuildOpenClawAgentInventory.mockReset();
    mockBuildOpenClawAgentInventory.mockResolvedValue({ agents: [] });
    jest.resetModules();
  });

  afterEach(async () => {
    restoreEnv('OPENCLAW_HOME', originalOpenclaw);
    restoreEnv('HERMES_PUBLIC_URL', originalHermesPublicUrl);
    restoreEnv('HERMES_DASHBOARD_URL', originalHermesDashboardUrl);
    restoreEnv('HERMES_PROFILE', originalHermesProfile);
    global.fetch = originalFetch;
    try { await fsp.rm(tmpdir, { recursive: true, force: true }); } catch (_) {}
  });

  it('standalone returns soulFallback when set', async () => {
    const { getPersonality } = require('../../src/services/personalityAdapters');
    const r = await getPersonality({ source: 'standalone', soulFallback: 'my soul' });
    expect(r).toEqual({ soul: 'my soul', ref: null });
  });

  it('standalone returns null when no fallback', async () => {
    const { getPersonality } = require('../../src/services/personalityAdapters');
    const r = await getPersonality({ source: 'standalone', soulFallback: '' });
    expect(r).toBeNull();
  });

  it('agentx returns local soulFallback when set', async () => {
    const { getPersonality } = require('../../src/services/personalityAdapters');
    const r = await getPersonality({ source: 'agentx', soulFallback: 'local soul' });
    expect(r).toEqual({ soul: 'local soul', ref: 'agentx:buddy.soul' });
  });

  it('hermes reads profile SOUL from dashboard API', async () => {
    mockHermesDashboard();
    const { getPersonality } = require('../../src/services/personalityAdapters');
    const r = await getPersonality({ source: 'hermes' });
    expect(r.soul).toBe('hermes soul body');
    expect(r.ref).toBe('http://hermes.test/api/profiles/default/soul');
    expect(r.profile).toBe('default');
  });

  it('hermes reports dashboard source status', async () => {
    mockHermesDashboard();
    const { getHermesPersonalitySourceStatus } = require('../../src/services/personalityAdapters');
    const r = await getHermesPersonalitySourceStatus();
    expect(r).toEqual({
      available: true,
      source: 'dashboard',
      dashboardUrl: 'http://hermes.test',
      profile: 'default',
      ref: 'http://hermes.test/api/profiles/default/soul',
    });
  });

  it('hermes throws when dashboard URL is missing', async () => {
    delete process.env.HERMES_PUBLIC_URL;
    const { getPersonality } = require('../../src/services/personalityAdapters');
    await expect(getPersonality({ source: 'hermes' })).rejects.toThrow();
  });

  it('openclaw concatenates SOUL/IDENTITY/USER', async () => {
    const ws = path.join(process.env.OPENCLAW_HOME, 'workspace-foo');
    await fsp.mkdir(ws);
    await fsp.writeFile(path.join(ws, 'SOUL.md'), 'soul');
    await fsp.writeFile(path.join(ws, 'IDENTITY.md'), 'identity');
    await fsp.writeFile(path.join(ws, 'USER.md'), 'user');
    const { getPersonality } = require('../../src/services/personalityAdapters');
    const r = await getPersonality({ source: 'openclaw', agentId: 'foo' });
    expect(r.soul).toContain('soul');
    expect(r.soul).toContain('identity');
    expect(r.soul).toContain('user');
    expect(r.soul).toContain('---');
  });

  it('openclaw throws without agentId', async () => {
    const { getPersonality } = require('../../src/services/personalityAdapters');
    await expect(getPersonality({ source: 'openclaw' })).rejects.toThrow();
  });

  it('openclaw throws when workspace missing', async () => {
    const { getPersonality } = require('../../src/services/personalityAdapters');
    await expect(getPersonality({ source: 'openclaw', agentId: 'nope' })).rejects.toThrow();
  });

  it('openclaw rejects agent ids that could escape OPENCLAW_HOME', async () => {
    const { getPersonality, resolveOpenclawWorkspace } = require('../../src/services/personalityAdapters');
    expect(() => resolveOpenclawWorkspace('../../outside')).toThrow(/safe path segment/);
    await expect(getPersonality({ source: 'openclaw', agentId: '..\\..\\outside' }))
      .rejects.toThrow(/safe path segment/);
  });

  it('openclaw rejects a workspace junction or symlink that escapes OPENCLAW_HOME', async () => {
    const outside = path.join(tmpdir, 'outside-workspace');
    await fsp.mkdir(outside);
    await fsp.writeFile(path.join(outside, 'SOUL.md'), 'outside soul');
    await fsp.symlink(
      outside,
      path.join(process.env.OPENCLAW_HOME, 'workspace-escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );

    const { getPersonality } = require('../../src/services/personalityAdapters');
    await expect(getPersonality({ source: 'openclaw', agentId: 'escape' }))
      .rejects.toThrow(/resolves outside OPENCLAW_HOME/);
  });

  it('openclaw can resolve from official inventory metadata when local workspace is missing', async () => {
    mockBuildOpenClawAgentInventory.mockResolvedValue({
      agents: [{ id: 'leadx', name: 'LeadX', model: { primary: 'qwen' }, workspace: '/ws/leadx' }],
    });

    const { getPersonality } = require('../../src/services/personalityAdapters');
    const r = await getPersonality({ source: 'openclaw', agentId: 'leadx' });
    expect(r.soul).toContain('OpenClaw agent: LeadX');
    expect(r.soul).toContain('Model: qwen');
    expect(r.ref).toBe('openclaw-inventory:leadx');
    expect(r.sourceDetail).toBe('official-openclaw-metadata');
  });

  it('openclaw prefers official inventory prompt content when available', async () => {
    mockBuildOpenClawAgentInventory.mockResolvedValue({
      agents: [{
        id: 'leadx',
        name: 'LeadX',
        promptFiles: { 'SOUL.md': { content: '# SOUL.md\n\nreal openclaw soul' } },
      }],
    });

    const { getPersonality } = require('../../src/services/personalityAdapters');
    const r = await getPersonality({ source: 'openclaw', agentId: 'leadx' });
    expect(r.soul).toContain('real openclaw soul');
    expect(r.ref).toBe('openclaw-inventory:leadx');
    expect(r.agentName).toBe('LeadX');
    expect(r.sourceDetail).toBe('official-openclaw-prompt-inventory');
    expect(mockBuildOpenClawAgentInventory).toHaveBeenCalledWith(expect.objectContaining({
      includeContent: true,
      includePromptFiles: true,
    }));
  });

  it('listOpenclawAgents enumerates workspace-* dirs', async () => {
    await fsp.mkdir(path.join(process.env.OPENCLAW_HOME, 'workspace-alpha'));
    await fsp.mkdir(path.join(process.env.OPENCLAW_HOME, 'workspace-beta'));
    await fsp.mkdir(path.join(process.env.OPENCLAW_HOME, 'not-a-workspace'));
    const { listOpenclawAgents } = require('../../src/services/personalityAdapters');
    const r = await listOpenclawAgents();
    expect(r.map(a => a.id).sort()).toEqual(['alpha', 'beta']);
  });

  it('listOpenclawAgents includes official runtime inventory agents', async () => {
    mockBuildOpenClawAgentInventory.mockResolvedValue({
      agents: [{ id: 'leadx', name: 'LeadX', workspace: '/ws/leadx' }],
    });

    const { listOpenclawAgents } = require('../../src/services/personalityAdapters');
    const r = await listOpenclawAgents();
    expect(r).toEqual([
      expect.objectContaining({ id: 'leadx', name: 'LeadX', workspace: '/ws/leadx', source: 'openclaw' }),
    ]);
  });

  it('bootstrapSoul includes platform line and respects size cap', async () => {
    mockHermesDashboard({ soul: 'X'.repeat(10_000) });
    const { bootstrapSoul } = require('../../src/services/personalityAdapters');
    const s = await bootstrapSoul();
    expect(s.length).toBeLessThanOrEqual(4000);
    expect(s).toMatch(/AgentX/);
  });

  it('bootstrapSoul works without Hermes dashboard', async () => {
    delete process.env.HERMES_PUBLIC_URL;
    const { bootstrapSoul } = require('../../src/services/personalityAdapters');
    const s = await bootstrapSoul();
    expect(s).toMatch(/AgentX/);
  });
});
