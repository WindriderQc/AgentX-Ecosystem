jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { handleMcpMessage, TOOLS, PROTOCOL_VERSION } = require('../../src/services/mcpSkillBus');

function makeSnapshot() {
  return {
    schemaVersion: 1,
    status: 'ok',
    generatedAt: '2026-07-03T00:00:00.000Z',
    sources: {
      runtime: { status: 'ok', durationMs: 12, issues: [] },
      openclaw: { status: 'ok', durationMs: 20, issues: [] },
    },
    runtimes: {
      core: { baseUrl: 'http://192.0.2.99:3080' },
      hermes: {
        expected: {
          model: 'openrouter/z-ai/glm-5.2',
          contextLength: 131072,
          apiKey: 'super-secret-key',
          authority: { policy: 'cloud_first_via_agentx_proxy' },
        },
        registryPolicy: {
          primaryModel: 'openrouter/z-ai/glm-5.2',
          context: 131072,
          authorityPolicy: { policy: 'cloud_first_via_agentx_proxy' },
        },
        authority: { status: 'aligned', live: { configValidation: 'protected' } },
      },
      openclaw: {
        expected: {
          providerId: 'ollama',
          apiBase: 'http://192.0.2.99:3080/api/openclaw-ollama?token=url-secret',
          providerAliases: [{ id: 'host-alpha-ollama', aliasOf: 'ollama' }],
          contextOverrides: [{ provider: 'host-alpha-ollama', model: 'ax/qwen3-coder:30b', contextWindow: 74854 }],
        },
        registryPolicy: {
          provider: 'agentx_openclaw_ollama_proxy',
          context: 65536,
          memoryPolicies: [{ agentId: 'deepcoding', status: 'missing_bootstrap_source' }],
        },
      },
      lanes: {
        daily: { model: 'ax/qwen3-coder:30b', hostKey: 'primary', contextSize: 40038 },
      },
    },
    hosts: {
      summary: { configured: 3, online: 3, degraded: 0 },
      preferences: [{ displayName: 'Host Alpha', hostKey: 'primary', status: 'ready', hostUrl: 'http://192.0.2.105:11434' }],
      capacity: [{ configId: 'primary', hostId: 'host-alpha', hostname: 'Host Alpha', status: 'online', ollamaReachable: true, verdict: 'BALANCED' }],
    },
    agents: {
      frontDoor: {
        id: 'main',
        persona: 'Nestor',
        runtime: 'openclaw',
        type: 'openclaw_front_door',
        model: { primary: 'openrouter/z-ai/glm-5.2', fallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'] },
        roleDocs: ['./roles/Nestor.md'],
      },
      specialists: [
        {
          id: 'cloudx',
          name: 'CloudX',
          runtime: 'openclaw',
          model: { primary: 'openrouter/z-ai/glm-5.2' },
          boundary: 'cloud specialist',
        },
      ],
      openclaw: [
        {
          id: 'deepcoding',
          name: 'DeepCoding',
          active: true,
          default: false,
          workspace: '/home/agentx/.openclaw/workspace-deepcoding',
          model: { primary: 'ollama/ax/qwen3-coder:30b', fallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'] },
          memory: {
            classification: 'missing',
            indexStatus: 'missing',
            dirty: true,
            files: 0,
            chunks: 0,
            policy: { status: 'missing_bootstrap_source' },
          },
        },
        {
          id: 'main',
          name: 'Nestor',
          active: true,
          default: true,
          model: { primary: 'openrouter/z-ai/glm-5.2' },
          memory: { classification: 'healthy', indexStatus: 'valid', dirty: false, files: 2, chunks: 10 },
        },
      ],
    },
    models: {
      lanes: { daily: { model: 'ax/qwen3-coder:30b' } },
      openclawDefaults: { primary: 'ollama/ax/qwen3-coder:30b' },
      liveModels: { deepcoding: { fullModel: 'ollama/ax/qwen3-coder:30b' } },
      openclawExpected: Array.from({ length: 60 }, (_, idx) => ({ id: `model-${idx}` })),
      openclawProviders: Array.from({ length: 60 }, (_, idx) => `provider-${idx}`),
    },
    rag: { healthy: true, status: 'success' },
    prompts: { count: 1, activeCount: 1, configs: [{ name: 'default_chat', version: 3 }] },
    memory: {
      classifications: { missing: 1, healthy: 1 },
      byAgent: {
        deepcoding: {
          classification: 'missing',
          indexStatus: 'missing',
          dirty: true,
          files: 0,
          chunks: 0,
          policy: { status: 'missing_bootstrap_source' },
        },
        main: { classification: 'healthy', indexStatus: 'valid', dirty: false, files: 2, chunks: 10 },
      },
      knownGaps: [{ id: 'deepcoding-memory-index-missing', detail: 'DeepCoding memory index missing.' }],
    },
    schedules: {
      cluster: { count: 1, entries: [{ source: 'openclaw', sourceId: 'deepcoding-nightly', name: 'deepcoding nightly', taskType: 'index', enabled: true }] },
      openclawCron: { available: true, count: 1, jobs: [{ id: 'deepcoding-weekly', name: 'deepcoding weekly', enabled: true, lastRunStatus: 'ok', consecutiveErrors: 0 }] },
    },
    pipeline: { sourceOfTruth: 'mongodb:pipelinetasks', counts: { in_progress: 1, review: 1 }, active: [{ pipelineId: '0335', title: 'Expose ecosystem snapshot through MCP' }] },
    alerts: { activeCount: 0, countsBySeverity: {}, active: [] },
    drift: [
      {
        id: 'openclaw-deepcoding-memory-index-missing',
        severity: 'medium',
        owner: '0332',
        title: 'DeepCoding memory/index gap detected.',
        current: 'gap',
        expected: 'classified',
        details: { agentId: 'deepcoding', token: 'inline-secret-token' },
      },
      {
        id: 'hermes-live-config-protected',
        severity: 'medium',
        owner: '0330',
        title: 'Hermes live runtime config is protected.',
        current: '401',
        expected: 'validated_or_documented_override',
      },
    ],
    recommendations: [
      { owner: '0332', action: 'Resolve or intentionally classify drift owned by 0332.', driftCount: 1 },
      { owner: '0330', action: 'Resolve or intentionally classify drift owned by 0330.', driftCount: 1 },
    ],
  };
}

function callSnapshot(arguments_ = {}) {
  const ecosystemSnapshotProvider = jest.fn(async () => makeSnapshot());
  return handleMcpMessage({
    jsonrpc: '2.0',
    id: 30,
    method: 'tools/call',
    params: { name: 'ecosystem_snapshot', arguments: arguments_ },
  }, { ecosystemSnapshotProvider });
}

describe('mcpSkillBus', () => {
  test('initialize advertises the current MCP protocol and tools capability', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test' } },
    });
    expect(res.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(res.result.capabilities.tools).toEqual({ listChanged: false });
    expect(res.result.serverInfo.name).toBe('agentx-core-skill-bus');
  });

  test('tools/list exposes exactly the intended narrow tool set', async () => {
    const res = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(res.result.tools.map(t => t.name)).toEqual([
      'rag_search',
      'check_health',
      'get_escalation_recommendation',
      'lookup_french_word',
      'ecosystem_snapshot',
      'create_todo',
      'save_memory',
      'add_personal_task',
      'list_personal_tasks',
      'complete_personal_task',
      'add_email_action',
    ]);
    expect(TOOLS).toHaveLength(11);
  });

  test('rag_search calls the injected RAG client and returns structured content', async () => {
    const ragClient = {
      searchSimilarChunks: jest.fn(async () => [{ text: 'AgentX fact', score: 0.9 }]),
    };
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'rag_search',
        arguments: { query: 'agentx', topK: 3, minScore: 0.2, hybrid: true },
      },
    }, { ragClient });
    expect(ragClient.searchSimilarChunks).toHaveBeenCalledWith('agentx', expect.objectContaining({
      topK: 3,
      minScore: 0.2,
      hybrid: true,
    }));
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.count).toBe(1);
  });

  test('check_health uses the injected health provider', async () => {
    const healthProvider = jest.fn(async () => ({ ok: true, core: { mongodb: 'connected' } }));
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'check_health', arguments: { includeDetails: true } },
    }, { healthProvider });
    expect(healthProvider).toHaveBeenCalledWith({ includeDetails: true });
    expect(res.result.structuredContent.ok).toBe(true);
  });

  test('get_escalation_recommendation returns the injected billable-cloud gate', async () => {
    const escalationProvider = jest.fn(async () => ({
      period: '24h',
      cloud_health: 'green',
      cloud_tokens: 0,
      escalation: {
        recommendation: 'allow',
        cloud_allowed: true,
        gate_basis: 'cloud_spend',
      },
    }));
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 41,
      method: 'tools/call',
      params: { name: 'get_escalation_recommendation', arguments: { hours: 24 } },
    }, { escalationProvider });

    expect(escalationProvider).toHaveBeenCalledWith({ hours: 24 });
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.escalation.recommendation).toBe('allow');
    expect(res.result.structuredContent.escalation.gate_basis).toBe('cloud_spend');
  });

  test('get_escalation_recommendation fails closed on malformed provider data', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 42,
      method: 'tools/call',
      params: { name: 'get_escalation_recommendation', arguments: {} },
    }, {
      escalationProvider: jest.fn(async () => ({
        cloud_health: 'green',
        escalation: { recommendation: 'allow', cloud_allowed: true, gate_basis: 'total_tokens' },
      })),
    });

    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.error).toBe('BUDGET_GATE_UNAVAILABLE');
  });

  test('lookup_french_word delegates to the exact local lexicon', async () => {
    const lexiconLookup = jest.fn(() => ({
      status: 'ready',
      hit: true,
      target: 'gigantesque',
      entry: { glosses: ['Qui dépasse la taille ordinaire.'] }
    }));
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 40,
      method: 'tools/call',
      params: { name: 'lookup_french_word', arguments: { word: 'gigantesque' } },
    }, { lexiconLookup });

    expect(lexiconLookup).toHaveBeenCalledWith('gigantesque');
    expect(res.result.structuredContent).toEqual(expect.objectContaining({
      status: 'ready',
      hit: true
    }));
  });

  test('create_todo delegates to the injected writer', async () => {
    const todoWriter = jest.fn(async () => ({ id: '0299', filename: '0299-test.md' }));
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'create_todo',
        arguments: {
          objective: 'Do the thing',
          service: 'core',
          short_name: 'test',
          source_files: ['core/src/app.js'],
          steps: ['Implement'],
          constraints: ['Keep scoped'],
          acceptance_criteria: ['Tests pass'],
        },
      },
    }, { todoWriter });
    expect(todoWriter).toHaveBeenCalled();
    expect(res.result.structuredContent.id).toBe('0299');
  });

  test('save_memory delegates to the injected memory writer', async () => {
    const memoryWriter = jest.fn(async () => ({ saved: true, documentId: 'nestor-memory:abc' }));
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'save_memory', arguments: { text: 'Remember this useful fact.' } },
    }, { memoryWriter });
    expect(memoryWriter).toHaveBeenCalledWith({ text: 'Remember this useful fact.' });
    expect(res.result.structuredContent.saved).toBe(true);
  });

  test('add_email_action delegates one idempotent Gmail-thread receipt', async () => {
    const emailActionWriter = jest.fn(async () => ({
      created: true,
      gmailThreadId: '10f6012a48bd8cb7',
      leantimeProjectId: 4,
      leantimeTicketId: 88,
      state: 'active',
    }));
    const args = {
      gmailThreadId: '10f6012a48bd8cb7',
      gmailMessageId: '10f6012a48bd8cb7',
      category: 'Needs Reply',
      action: 'Reply to Vincent',
      sender: 'hotmail.com',
      messageDate: '2006-12-07 22:19',
    };
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 63,
      method: 'tools/call',
      params: { name: 'add_email_action', arguments: args },
    }, { emailActionWriter });

    expect(emailActionWriter).toHaveBeenCalledWith(args);
    expect(res.result.isError).toBe(false);
    expect(res.result.structuredContent.leantimeTicketId).toBe(88);
  });

  test('list_personal_tasks omits notes by default and bounds its reader input', async () => {
    const secretaryList = jest.fn(async () => ({
      count: 1,
      overdueCount: 0,
      dueTodayCount: 0,
      tasks: [{ id: '0464', title: 'buy winter tires', status: 'queued', note: 'x'.repeat(1800) }],
    }));
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 61,
      method: 'tools/call',
      params: {
        name: 'list_personal_tasks',
        arguments: { includeDone: false, limit: 500 },
      },
    }, { secretaryList });

    expect(secretaryList).toHaveBeenCalledWith({ includeDone: false, limit: 100 });
    expect(res.result.structuredContent.tasks).toEqual([
      { id: '0464', title: 'buy winter tires', status: 'queued' },
    ]);
    expect(res.result.content[0].text).not.toContain('x'.repeat(20));
  });

  test('list_personal_tasks includes only bounded note summaries on request', async () => {
    const secretaryList = jest.fn(async () => ({
      count: 2,
      overdueCount: 0,
      dueTodayCount: 0,
      tasks: [
        { id: '0464', title: 'long', note: 'n'.repeat(300) },
        { id: '0319', title: 'short', note: 'call support' },
      ],
    }));
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 62,
      method: 'tools/call',
      params: {
        name: 'list_personal_tasks',
        arguments: { includeNotes: true, limit: 10 },
      },
    }, { secretaryList });

    expect(res.result.structuredContent.tasks[0]).toEqual(expect.objectContaining({
      note: 'n'.repeat(240),
      noteTruncated: true,
    }));
    expect(res.result.structuredContent.tasks[1]).toEqual(expect.objectContaining({
      note: 'call support',
      noteTruncated: false,
    }));
  });

  test('ecosystem_snapshot compact mode returns routing context and redacts sensitive values', async () => {
    const res = await callSnapshot();
    const snapshot = res.result.structuredContent;

    expect(res.result.isError).toBe(false);
    expect(snapshot.mode).toBe('compact');
    expect(snapshot.sources.degraded).toBe(0);
    expect(snapshot.runtimes.openclaw.expectedProvider).toBe('ollama');
    expect(snapshot.agents.openclaw).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'deepcoding', primaryModel: 'ollama/ax/qwen3-coder:30b' }),
    ]));
    expect(snapshot.memory.classifications).toEqual({ missing: 1, healthy: 1 });
    expect(snapshot.drift.byOwner).toEqual(expect.objectContaining({ '0332': 1, '0330': 1 }));

    const rendered = JSON.stringify(snapshot);
    expect(rendered).not.toContain('super-secret-key');
    expect(rendered).not.toContain('inline-secret-token');
    expect(rendered).not.toContain('url-secret');
  });

  test('ecosystem_snapshot driftOnly mode returns mismatches and recommended owners', async () => {
    const res = await callSnapshot({ mode: 'driftOnly' });
    const snapshot = res.result.structuredContent;

    expect(snapshot.mode).toBe('driftOnly');
    expect(snapshot.drift.count).toBe(2);
    expect(snapshot.drift.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'openclaw-deepcoding-memory-index-missing', owner: '0332' }),
      expect.objectContaining({ id: 'hermes-live-config-protected', owner: '0330' }),
    ]));
    expect(snapshot.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: '0332' }),
      expect.objectContaining({ owner: '0330' }),
    ]));
    expect(JSON.stringify(snapshot)).not.toContain('inline-secret-token');
  });

  test('ecosystem_snapshot agent mode returns role, model chain, memory, schedules, and relevant drift', async () => {
    const res = await callSnapshot({ mode: 'agent', agentId: 'deepcoding' });
    const snapshot = res.result.structuredContent;

    expect(snapshot.mode).toBe('agent');
    expect(snapshot.agent).toEqual(expect.objectContaining({
      id: 'deepcoding',
      workspace: '/home/agentx/.openclaw/workspace-deepcoding',
    }));
    expect(snapshot.modelChain).toEqual(expect.objectContaining({
      primary: 'ollama/ax/qwen3-coder:30b',
      fallbacks: ['ollama/ax/gemma4:26b-a4b-it-qat'],
      liveModel: 'ollama/ax/qwen3-coder:30b',
    }));
    expect(snapshot.memory).toHaveProperty('classification', 'missing');
    expect(snapshot.schedules.cluster).toHaveLength(1);
    expect(snapshot.schedules.openclawCron).toHaveLength(1);
    expect(snapshot.drift.records).toEqual([
      expect.objectContaining({ id: 'openclaw-deepcoding-memory-index-missing', owner: '0332' }),
    ]);
    expect(snapshot.recommendations).toEqual([
      expect.objectContaining({ owner: '0332' }),
    ]);
  });

  test('ecosystem_snapshot full mode caps large arrays and keeps payload sanitized', async () => {
    const res = await callSnapshot({ mode: 'full', maxChars: 60000 });
    const snapshot = res.result.structuredContent;

    expect(snapshot.mode).toBe('full');
    expect(snapshot._mcp.caps).toEqual(expect.objectContaining({
      providerModels: 50,
      prompts: 25,
    }));
    expect(snapshot.snapshot.models.openclawExpected).toHaveLength(50);
    expect(snapshot.snapshot.models.openclawProviders).toHaveLength(50);
    const rendered = JSON.stringify(snapshot);
    expect(rendered).not.toContain('super-secret-key');
    expect(rendered).not.toContain('inline-secret-token');
    expect(rendered).not.toContain('url-secret');
  });

  test('ecosystem_snapshot returns tool error for unknown agent focus', async () => {
    const res = await callSnapshot({ mode: 'agent', agentId: 'missing-agent' });
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.error).toBe('NOT_FOUND');
  });

  test('tool validation failures are returned as MCP tool errors', async () => {
    const res = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'rag_search', arguments: {} },
    }, { ragClient: { searchSimilarChunks: jest.fn() } });
    expect(res.result.isError).toBe(true);
    expect(res.result.structuredContent.error).toBe('INVALID_ARGUMENTS');
  });
});
