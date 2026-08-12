const previousOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
process.env.AGENTX_OPERATOR_TOKEN = 'inventory-test-token';

jest.mock('../../src/services/openclawAgentInventoryService', () => ({
  buildOpenClawAgentInventory: jest.fn(),
}));
jest.mock('../../src/services/openclawRuntimeEvidenceService', () => ({
  getOpenClawRuntimeEvidence: jest.fn(),
}));
jest.mock('../../src/services/openclawClient', () => {
  const actual = jest.requireActual('../../src/services/openclawClient');
  return {
    ...actual,
    getOpenClawControlLaunchUrl: jest.fn(),
  };
});
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const express = require('express');
const request = require('supertest');
const { buildOpenClawAgentInventory } = require('../../src/services/openclawAgentInventoryService');
const { getOpenClawRuntimeEvidence } = require('../../src/services/openclawRuntimeEvidenceService');
const { getOpenClawControlLaunchUrl } = require('../../src/services/openclawClient');

const evidence = {
  authority: 'official-openclaw-cli',
  generatedAt: '2026-07-29T00:00:00.000Z',
  source: { degraded: false, issues: [] },
  status: {
    online: true,
    runtimeVersion: '2026.7.1-2',
    gateway: { url: 'http://192.0.2.66:18789', reachable: true, latencyMs: 9, error: null },
    gatewayService: { running: true, state: 'active' },
    agents: 2,
    sessions: { count: 3, recent: [{ agentId: 'main', model: 'openrouter/test', totalTokens: 10 }] },
  },
  defaults: { model: { primary: 'ollama/default', fallbacks: [] } },
  memoryStrategy: { provider: 'qdrant' },
  agents: [
    { id: 'main', name: 'Main', default: true, model: { primary: 'openrouter/test', fallbacks: [] }, memory: { indexStatus: 'valid' } },
    { id: 'leadx', name: 'LeadX', default: false, model: { primary: 'ollama/local', fallbacks: [] }, memory: { indexStatus: 'valid' } },
  ],
  cron: { count: 1, jobs: [{ id: 'job-1', name: 'Daily', enabled: true }] },
  models: {
    default: 'ollama/default',
    fallbacks: [],
    providers: ['ollama', 'openrouter'],
    agents: [{ id: 'main', name: 'Main', primary: 'openrouter/test', fallbacks: [] }],
    liveModels: { main: { provider: 'openrouter', model: 'openrouter/test', fullModel: 'openrouter/test' } },
  },
};

function buildApp() {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json());
  app.use('/api/openclaw', require('../../routes/openclaw'));
  return app;
}

describe('OpenClaw official evidence API', () => {
  const app = buildApp();

  beforeEach(() => {
    jest.clearAllMocks();
    getOpenClawRuntimeEvidence.mockResolvedValue(evidence);
    getOpenClawControlLaunchUrl.mockReturnValue(
      'https://192.0.2.99:18790/chat?agent=main#token=test-secret'
    );
  });

  afterAll(() => {
    if (previousOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = previousOperatorToken;
  });

  it('returns metadata inventory by default and guards prompt content', async () => {
    buildOpenClawAgentInventory.mockResolvedValueOnce({ schema_version: 2, content_mode: 'metadata_only', agents: [{ id: 'main' }] });
    const metadata = await request(app).get('/api/openclaw/agent-inventory').expect(200);
    expect(metadata.body.content_mode).toBe('metadata_only');
    expect(buildOpenClawAgentInventory).toHaveBeenCalledWith({ includeContent: false, includeRuntimeStatus: false });

    await request(app)
      .get('/api/openclaw/agent-inventory?includeContent=true')
      .set('X-Forwarded-For', '192.0.2.50')
      .expect(403);
  });

  it('projects status, agents, sessions, models, memory, and cron from one native evidence contract', async () => {
    const status = await request(app).get('/api/openclaw/status').expect(200);
    const agents = await request(app).get('/api/openclaw/agents').expect(200);
    const agent = await request(app).get('/api/openclaw/agents/main').expect(200);
    const sessions = await request(app).get('/api/openclaw/sessions').expect(200);
    const models = await request(app).get('/api/openclaw/models').expect(200);
    const memory = await request(app).get('/api/openclaw/memory/main').expect(200);
    const cron = await request(app).get('/api/openclaw/cron').expect(200);

    expect(status.body).toEqual(expect.objectContaining({ status: 'online', runtimeVersion: '2026.7.1-2', agents: 2, sessions: 3 }));
    expect(agents.body.data).toHaveLength(2);
    expect(agent.body.data.id).toBe('main');
    expect(sessions.body).toEqual(expect.objectContaining({ count: 3, authority: 'official-openclaw-cli' }));
    expect(models.body.data.providers).toEqual(['ollama', 'openrouter']);
    expect(memory.body.data.indexStatus).toBe('valid');
    expect(cron.body.data[0].id).toBe('job-1');
  });

  it('returns a stable 404 for an unknown agent', async () => {
    await request(app).get('/api/openclaw/agents/missing').expect(404);
  });

  it('redirects to the official chat with a no-cache browser token handoff', async () => {
    const response = await request(app)
      .get('/api/openclaw/control-launch/chat?agent=main')
      .set('X-Forwarded-Proto', 'https')
      .set('X-Forwarded-For', '192.0.2.50')
      .expect(302);

    expect(response.headers.location).toBe(
      'https://192.0.2.99:18790/chat?agent=main#token=test-secret'
    );
    expect(response.headers['cache-control']).toContain('no-store');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(getOpenClawControlLaunchUrl).toHaveBeenCalledWith('chat', { agent: 'main' });
  });

  it('rejects invalid launch targets and agent ids without leaking a token', async () => {
    await request(app)
      .get('/api/openclaw/control-launch/chat?agent=../main')
      .set('X-Forwarded-Proto', 'https')
      .expect(400);

    const error = new (require('../../src/services/openclawClient').OpenClawClientError)(
      'Unknown OpenClaw Control UI target',
      { status: 400, code: 'OPENCLAW_CONTROL_TARGET_INVALID' }
    );
    getOpenClawControlLaunchUrl.mockImplementationOnce(() => { throw error; });

    const response = await request(app)
      .get('/api/openclaw/control-launch/not-real')
      .set('X-Forwarded-Proto', 'https')
      .expect(400);
    expect(response.body.code).toBe('OPENCLAW_CONTROL_TARGET_INVALID');
    expect(response.text).not.toContain('test-secret');
  });

  it('refuses to put the gateway token in a plain-HTTP LAN response', async () => {
    const response = await request(app)
      .get('/api/openclaw/control-launch/chat')
      .set('X-Forwarded-For', '192.0.2.50')
      .expect(400);

    expect(response.body.code).toBe('OPENCLAW_CONTROL_HTTPS_REQUIRED');
    expect(response.text).not.toContain('test-secret');
    expect(getOpenClawControlLaunchUrl).not.toHaveBeenCalled();
  });
});
