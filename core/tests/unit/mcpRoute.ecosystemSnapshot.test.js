const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const mockBuildEcosystemSnapshot = jest.fn();

jest.mock('../../src/services/ecosystemSnapshotService', () => {
  const actual = jest.requireActual('../../src/services/ecosystemSnapshotService');
  return {
    ...actual,
    buildEcosystemSnapshot: (...args) => mockBuildEcosystemSnapshot(...args),
  };
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/mcp', require('../../routes/mcp'));
  return app;
}

function makeSnapshot() {
  return {
    schemaVersion: 1,
    status: 'ok',
    generatedAt: '2026-07-04T04:00:00.000Z',
    sources: {
      runtime: { status: 'ok', durationMs: 4, issues: [] },
      openclaw: { status: 'ok', durationMs: 8, issues: [] },
    },
    runtimes: {
      core: { baseUrl: 'http://192.0.2.99:3080' },
      hermes: {
        expected: {
          model: 'openrouter/z-ai/glm-5.2',
          contextLength: 131072,
          authority: { policy: 'cloud_first_via_agentx_proxy' },
          apiKey: 'do-not-leak-hermes-key',
        },
      },
      openclaw: {
        expected: {
          providerId: 'ollama',
          apiBase: 'http://192.0.2.99:3080/api/openclaw-ollama?token=do-not-leak-url-token',
        },
      },
      lanes: {
        coding: { model: 'ax/qwen3-coder:30b', hostKey: 'primary', contextSize: 65536 },
      },
    },
    hosts: {
      summary: { configured: 3, online: 3, degraded: 0 },
      preferences: [{ displayName: 'Host Alpha', hostKey: 'primary', status: 'ready', hostUrl: 'http://192.0.2.105:11434' }],
      capacity: [{ configId: 'primary', hostId: 'host-alpha', hostname: 'Host Alpha', status: 'online', verdict: 'balanced' }],
    },
    agents: {
      openclaw: [{
        id: 'deepcoding',
        name: 'DeepCoding Reflection',
        active: true,
        default: false,
        workspace: '/home/agentx/.openclaw/workspace-deepcoding',
        model: {
          primary: 'host-alpha-ollama/ax/qwen3-coder:30b',
          fallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'],
        },
        memory: {
          classification: 'healthy',
          indexStatus: 'valid',
          dirty: false,
          files: 4,
          chunks: 44,
        },
      }],
      specialists: [],
    },
    models: {
      lanes: { coding: { model: 'ax/qwen3-coder:30b' } },
      openclawDefaults: { primary: 'host-alpha-ollama/ax/qwen3-coder:30b' },
      liveModels: {},
      openclawProviders: Array.from({ length: 55 }, (_, idx) => `provider-${idx}`),
    },
    rag: { healthy: true, status: 'success' },
    prompts: { count: 1, activeCount: 1, configs: [{ name: 'default_chat', version: 1 }] },
    memory: {
      classifications: { healthy: 1 },
      byAgent: {
        deepcoding: { classification: 'healthy', indexStatus: 'valid', dirty: false, files: 4, chunks: 44 },
      },
    },
    schedules: {
      cluster: { count: 1, entries: [{ sourceId: 'deepcoding-nightly', name: 'deepcoding nightly', enabled: true }] },
      openclawCron: { count: 1, jobs: [{ id: 'deepcoding-weekly', name: 'deepcoding weekly', enabled: true, lastRunStatus: 'ok' }] },
    },
    pipeline: { sourceOfTruth: 'mongodb:pipelinetasks', counts: { in_progress: 1 }, active: [{ pipelineId: '0010', title: 'Expose ecosystem snapshot through MCP' }] },
    alerts: { activeCount: 0, countsBySeverity: {}, active: [] },
    drift: [{
      id: 'openclaw-deepcoding-provider-drift',
      severity: 'medium',
      owner: '0331',
      title: 'DeepCoding provider differs.',
      current: 'provider drift',
      expected: 'classified',
      details: { agentId: 'deepcoding', token: 'do-not-leak-details-token' },
    }],
    recommendations: [{ owner: '0331', action: 'Resolve or classify OpenClaw provider drift.', driftCount: 1 }],
  };
}

function rpc(body) {
  return request(makeApp()).post('/mcp').send(body);
}

describe('mcp route ecosystem_snapshot integration', () => {
  const originalToken = process.env.AGENTX_MCP_TOKEN;

  beforeEach(() => {
    delete process.env.AGENTX_MCP_TOKEN;
    mockBuildEcosystemSnapshot.mockResolvedValue(makeSnapshot());
  });

  afterEach(() => {
    jest.clearAllMocks();
    if (originalToken === undefined) delete process.env.AGENTX_MCP_TOKEN;
    else process.env.AGENTX_MCP_TOKEN = originalToken;
  });

  test('tools/list advertises the ecosystem snapshot modes through the route', async () => {
    const res = await rpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }).expect(200);
    const tool = res.body.result.tools.find((entry) => entry.name === 'ecosystem_snapshot');

    expect(tool).toEqual(expect.objectContaining({
      title: 'AgentX Ecosystem Snapshot',
      annotations: expect.objectContaining({ readOnlyHint: true }),
    }));
    expect(tool.description).toContain('agentx__ecosystem_snapshot');
    expect(tool.inputSchema.properties.mode.enum).toEqual(['compact', 'driftOnly', 'full', 'agent']);
  });

  test('compact and driftOnly modes return sanitized routing and drift context', async () => {
    const compact = await rpc({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'ecosystem_snapshot', arguments: { mode: 'compact' } },
    }).expect(200);
    const driftOnly = await rpc({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ecosystem_snapshot', arguments: { mode: 'driftOnly' } },
    }).expect(200);

    expect(compact.body.result.structuredContent).toEqual(expect.objectContaining({
      mode: 'compact',
      pipeline: expect.objectContaining({ sourceOfTruth: 'mongodb:pipelinetasks' }),
      hosts: expect.objectContaining({ summary: expect.objectContaining({ online: 3 }) }),
      agents: expect.objectContaining({ counts: expect.objectContaining({ openclaw: 1 }) }),
    }));
    expect(driftOnly.body.result.structuredContent.drift.records).toEqual([
      expect.objectContaining({ id: 'openclaw-deepcoding-provider-drift', owner: '0331' }),
    ]);
    expect(driftOnly.body.result.structuredContent.recommendations).toEqual([
      expect.objectContaining({ owner: '0331' }),
    ]);
    expect(JSON.stringify([compact.body, driftOnly.body])).not.toContain('do-not-leak');
  });

  test('agent and full modes return role context, capped payloads, and no secrets', async () => {
    const agent = await rpc({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'ecosystem_snapshot', arguments: { mode: 'agent', agentId: 'deepcoding' } },
    }).expect(200);
    const full = await rpc({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'ecosystem_snapshot', arguments: { mode: 'full', maxChars: 60000 } },
    }).expect(200);

    expect(agent.body.result.structuredContent).toEqual(expect.objectContaining({
      mode: 'agent',
      agent: expect.objectContaining({
        id: 'deepcoding',
        role: expect.objectContaining({
          id: 'deepcoding',
          name: 'DeepCoding Reflection',
          kind: 'openclaw_agent',
        }),
      }),
      modelChain: expect.objectContaining({
        primary: 'host-alpha-ollama/ax/qwen3-coder:30b',
        fallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'],
      }),
      memory: expect.objectContaining({ classification: 'healthy', indexStatus: 'valid' }),
      schedules: expect.objectContaining({
        cluster: [expect.objectContaining({ sourceId: 'deepcoding-nightly' })],
        openclawCron: [expect.objectContaining({ id: 'deepcoding-weekly' })],
      }),
      drift: expect.objectContaining({ count: 1 }),
    }));
    expect(full.body.result.structuredContent.snapshot.models.openclawProviders).toHaveLength(50);
    expect(full.body.result.structuredContent._mcp.caps.providerModels).toBe(50);
    expect(JSON.stringify([agent.body, full.body])).not.toContain('do-not-leak');
  });
});
