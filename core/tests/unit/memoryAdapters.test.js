const fsp = require('fs').promises;
const os = require('os');
const path = require('path');

describe('memoryAdapters', () => {
  let tmpdir;
  let originalOpenclaw;
  let originalHermes;
  let originalHermesPublicUrl;
  let originalHermesDashboardUrl;
  let originalOpenclawInventorySshTarget;
  let originalOpenclawMemoryStatusSource;
  let originalEmbeddingModel;
  let originalEmbeddingDimension;
  let originalVectorStoreType;
  let originalFetch;

  function jsonResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: jest.fn().mockResolvedValue(JSON.stringify(body)),
      json: jest.fn().mockResolvedValue(body),
    };
  }

  function textResponse(body, status = 200) {
    return {
      ok: status >= 200 && status < 300,
      status,
      text: jest.fn().mockResolvedValue(body),
      json: jest.fn().mockResolvedValue({}),
    };
  }

  beforeEach(async () => {
    tmpdir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ma-test-'));
    originalOpenclaw = process.env.OPENCLAW_HOME;
    originalHermes = process.env.HERMES_HOME;
    originalHermesPublicUrl = process.env.HERMES_PUBLIC_URL;
    originalHermesDashboardUrl = process.env.HERMES_DASHBOARD_URL;
    originalOpenclawInventorySshTarget = process.env.OPENCLAW_INVENTORY_SSH_TARGET;
    originalOpenclawMemoryStatusSource = process.env.OPENCLAW_MEMORY_STATUS_SOURCE;
    originalEmbeddingModel = process.env.EMBEDDING_MODEL;
    originalEmbeddingDimension = process.env.EMBEDDING_DIMENSION;
    originalVectorStoreType = process.env.VECTOR_STORE_TYPE;
    originalFetch = global.fetch;
    process.env.OPENCLAW_HOME = path.join(tmpdir, 'openclaw');
    process.env.HERMES_HOME = path.join(tmpdir, 'hermes-empty');
    delete process.env.HERMES_PUBLIC_URL;
    delete process.env.HERMES_DASHBOARD_URL;
    delete process.env.OPENCLAW_INVENTORY_SSH_TARGET;
    delete process.env.OPENCLAW_MEMORY_STATUS_SOURCE;
    await fsp.mkdir(process.env.OPENCLAW_HOME, { recursive: true });
    await fsp.mkdir(process.env.HERMES_HOME, { recursive: true });
    jest.resetModules();
    jest.dontMock('../../src/services/openclawAgentInventoryService');
    jest.dontMock('../../src/services/ragServiceClient');
    const ma = require('../../src/services/memoryAdapters');
    if (ma._resetCacheForTests) ma._resetCacheForTests();
  });

  afterEach(async () => {
    process.env.OPENCLAW_HOME = originalOpenclaw;
    process.env.HERMES_HOME = originalHermes;
    if (originalHermesPublicUrl === undefined) delete process.env.HERMES_PUBLIC_URL;
    else process.env.HERMES_PUBLIC_URL = originalHermesPublicUrl;
    if (originalHermesDashboardUrl === undefined) delete process.env.HERMES_DASHBOARD_URL;
    else process.env.HERMES_DASHBOARD_URL = originalHermesDashboardUrl;
    if (originalOpenclawInventorySshTarget === undefined) delete process.env.OPENCLAW_INVENTORY_SSH_TARGET;
    else process.env.OPENCLAW_INVENTORY_SSH_TARGET = originalOpenclawInventorySshTarget;
    if (originalOpenclawMemoryStatusSource === undefined) delete process.env.OPENCLAW_MEMORY_STATUS_SOURCE;
    else process.env.OPENCLAW_MEMORY_STATUS_SOURCE = originalOpenclawMemoryStatusSource;
    if (originalEmbeddingModel === undefined) delete process.env.EMBEDDING_MODEL;
    else process.env.EMBEDDING_MODEL = originalEmbeddingModel;
    if (originalEmbeddingDimension === undefined) delete process.env.EMBEDDING_DIMENSION;
    else process.env.EMBEDDING_DIMENSION = originalEmbeddingDimension;
    if (originalVectorStoreType === undefined) delete process.env.VECTOR_STORE_TYPE;
    else process.env.VECTOR_STORE_TYPE = originalVectorStoreType;
    global.fetch = originalFetch;
    jest.dontMock('../../src/services/openclawAgentInventoryService');
    jest.dontMock('../../src/services/ragServiceClient');
    try { await fsp.rm(tmpdir, { recursive: true, force: true }); } catch (_) {}
  });

  it('returns empty when sources empty', async () => {
    const { searchMemory } = require('../../src/services/memoryAdapters');
    const r = await searchMemory({ sources: [], query: 'foo', k: 5 });
    expect(r).toEqual([]);
  });

  it('returns empty when query empty', async () => {
    const { searchMemory } = require('../../src/services/memoryAdapters');
    const r = await searchMemory({ sources: ['openclaw'], query: '   ', k: 5 });
    expect(r).toEqual([]);
  });

  it('finds matches in openclaw markdown by case-insensitive substring', async () => {
    const ws = path.join(process.env.OPENCLAW_HOME, 'workspace-test');
    await fsp.mkdir(ws);
    await fsp.writeFile(
      path.join(ws, 'notes.md'),
      'The Host Beta host runs the qwen2.5:14b judge model. Host Beta sometimes wedges under heavy load.'
    );
    await fsp.writeFile(
      path.join(ws, 'other.md'),
      'unrelated content about cats.'
    );

    const { searchMemory } = require('../../src/services/memoryAdapters');
    const r = await searchMemory({ sources: ['openclaw'], query: 'host-beta wedge', k: 5 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].source).toBe('openclaw');
    expect(r[0].text.toLowerCase()).toContain('host beta');
    expect(r[0].ref).toMatch(/^openclaw:/);
  });

  it('finds matches in the default openclaw workspace directory', async () => {
    const ws = path.join(process.env.OPENCLAW_HOME, 'workspace');
    await fsp.mkdir(ws);
    await fsp.writeFile(
      path.join(ws, 'SOUL.md'),
      'Hermes and OpenClaw coordination notes mention durable memory.'
    );

    const { searchMemory, statusForSource } = require('../../src/services/memoryAdapters');
    const r = await searchMemory({ sources: ['openclaw'], query: 'durable memory', k: 5 });
    expect(r.length).toBeGreaterThan(0);
    expect(r[0].ref).toMatch(/^openclaw:workspace/);

    const status = await statusForSource('openclaw');
    expect(status).toEqual(expect.objectContaining({
      source: 'openclaw',
      available: true,
      home: process.env.OPENCLAW_HOME,
      fileCount: 1,
      workspaceCount: 1,
      workspaceRoots: ['workspace'],
    }));
  });

  it('reports OpenClaw live inventory status when SSH inventory is configured', async () => {
    process.env.OPENCLAW_INVENTORY_SSH_TARGET = 'operator@openclaw.test';
    const buildOpenClawAgentInventory = jest.fn().mockResolvedValue({
      generated_at: '2026-07-02T12:00:00.000Z',
      source: {
        openclawHome: '/home/agentx/.openclaw',
        memoryStatusSource: 'ssh openclaw memory status --json',
        degraded: false,
        issues: [],
      },
      memory_strategy: {
        provider: 'ollama',
        model: 'qllama/bge-m3:f16',
      },
      agents: [
        {
          id: 'main',
          name: 'main',
          workspace: '/home/agentx/.openclaw/workspace-main',
          memory: {
            provider: 'ollama',
            model: 'qllama/bge-m3:f16',
            vectorDims: 1024,
            files: 1,
            chunks: 2,
            dirty: false,
            indexStatus: 'valid',
            issues: [],
          },
        },
        {
          id: 'deepsearch',
          name: 'deepsearch',
          workspace: '/home/agentx/.openclaw/workspace-deepsearch',
          memory: {
            provider: 'ollama',
            model: 'qllama/bge-m3:f16',
            vectorDims: 1024,
            files: 1,
            chunks: 1,
            dirty: true,
            indexStatus: 'missing',
            issues: ['index missing'],
          },
        },
      ],
    });
    jest.resetModules();
    jest.doMock('../../src/services/openclawAgentInventoryService', () => ({
      buildOpenClawAgentInventory,
    }));

    const { statusForSource } = require('../../src/services/memoryAdapters');
    const status = await statusForSource('openclaw');

    expect(buildOpenClawAgentInventory).toHaveBeenCalledWith(expect.objectContaining({
      includeContent: false,
      includeRuntimeStatus: false,
    }));
    expect(status).toEqual(expect.objectContaining({
      source: 'openclaw',
      available: true,
      sourceDetail: 'inventory',
      lane: 'private-runtime',
      shared: false,
      agentCount: 2,
      validIndexCount: 1,
      dirtyIndexCount: 1,
      missingIndexCount: 1,
    }));
    expect(status.memory).toEqual(expect.objectContaining({
      provider: 'ollama',
      model: 'qllama/bge-m3:f16',
      vectorDims: 1024,
      vectorDimOptions: [1024],
    }));
    expect(status.agents).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'main', indexStatus: 'valid', vectorDims: 1024 }),
      expect.objectContaining({ id: 'deepsearch', indexStatus: 'missing', issueCount: 1 }),
    ]));
  });

  it('falls back to local OpenClaw status when live inventory fails', async () => {
    process.env.OPENCLAW_INVENTORY_SSH_TARGET = 'operator@openclaw.test';
    const ws = path.join(process.env.OPENCLAW_HOME, 'workspace');
    await fsp.mkdir(ws);
    await fsp.writeFile(path.join(ws, 'MEMORY.md'), 'Local fallback memory notes.');
    jest.resetModules();
    jest.doMock('../../src/services/openclawAgentInventoryService', () => ({
      buildOpenClawAgentInventory: jest.fn().mockRejectedValue(new Error('ssh inventory failed')),
    }));

    const { statusForSource } = require('../../src/services/memoryAdapters');
    const status = await statusForSource('openclaw');

    expect(status).toEqual(expect.objectContaining({
      source: 'openclaw',
      available: true,
      sourceDetail: 'local-markdown',
      lane: 'private-runtime',
      shared: false,
      fileCount: 1,
      workspaceCount: 1,
      liveInventoryError: 'ssh inventory failed',
    }));
  });

  it('returns empty when no openclaw matches', async () => {
    const ws = path.join(process.env.OPENCLAW_HOME, 'workspace-test');
    await fsp.mkdir(ws);
    await fsp.writeFile(path.join(ws, 'notes.md'), 'something completely different here');

    const { searchMemory } = require('../../src/services/memoryAdapters');
    const r = await searchMemory({ sources: ['openclaw'], query: 'xyzzy_unmatched', k: 5 });
    expect(r).toEqual([]);
  });

  it('caps combined results at 2*k', async () => {
    const ws = path.join(process.env.OPENCLAW_HOME, 'workspace-test');
    await fsp.mkdir(ws);
    for (let i = 0; i < 30; i++) {
      await fsp.writeFile(path.join(ws, `f${i}.md`), `keyword content number ${i}`);
    }
    const { searchMemory } = require('../../src/services/memoryAdapters');
    const r = await searchMemory({ sources: ['openclaw'], query: 'keyword', k: 3 });
    expect(r.length).toBeLessThanOrEqual(6);
  });

  it('does not crash when hermes db is missing', async () => {
    const { searchMemory } = require('../../src/services/memoryAdapters');
    const r = await searchMemory({ sources: ['hermes'], query: 'anything', k: 3 });
    expect(r).toEqual([]);
  });

  it('finds Hermes matches through dashboard sessions', async () => {
    process.env.HERMES_PUBLIC_URL = 'http://hermes.test';
    global.fetch = jest.fn(async (url) => {
      if (url === 'http://hermes.test/') {
        return textResponse('<script>window.__HERMES_SESSION_TOKEN__="token-123";</script>');
      }
      if (url === 'http://hermes.test/api/sessions') {
        return jsonResponse({ sessions: [{ id: 'session-1', created_at: new Date().toISOString() }] });
      }
      if (url === 'http://hermes.test/api/sessions/session-1/messages') {
        return jsonResponse({
          messages: [
            { id: 1, role: 'user', content: 'Host Gamma routing notes mention Hermes memory.', created_at: new Date().toISOString() },
            { id: 2, role: 'assistant', content: 'unrelated', created_at: new Date().toISOString() },
          ],
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    jest.resetModules();
    const { searchMemory } = require('../../src/services/memoryAdapters');
    const r = await searchMemory({ sources: ['hermes'], query: 'Host Gamma memory', k: 3 });
    expect(r).toEqual([
      expect.objectContaining({
        source: 'hermes',
        ref: 'hermes:session-1#1',
      }),
    ]);
  });

  it('reports Hermes dashboard status when dashboard is configured', async () => {
    process.env.HERMES_PUBLIC_URL = 'http://hermes.test';
    global.fetch = jest.fn(async (url) => {
      if (url === 'http://hermes.test/') {
        return textResponse('<script>window.__HERMES_SESSION_TOKEN__="token-123";</script>');
      }
      if (url === 'http://hermes.test/api/sessions') {
        return jsonResponse({ sessions: [{ id: 'one' }, { id: 'two' }] });
      }
      throw new Error(`unexpected fetch ${url}`);
    });

    jest.resetModules();
    const { statusForSource } = require('../../src/services/memoryAdapters');
    const r = await statusForSource('hermes');
    expect(r).toEqual(expect.objectContaining({
      source: 'hermes',
      available: true,
      sourceDetail: 'dashboard',
      dashboardUrl: 'http://hermes.test',
      home: process.env.HERMES_HOME,
      sessionCount: 2,
    }));
  });

  it('reports actionable Hermes paths when unavailable', async () => {
    const { statusForSource } = require('../../src/services/memoryAdapters');
    const r = await statusForSource('hermes');
    expect(r).toEqual(expect.objectContaining({
      source: 'hermes',
      available: false,
      home: process.env.HERMES_HOME,
      dbPath: path.join(process.env.HERMES_HOME, 'state.db'),
      notesPath: path.join(process.env.HERMES_HOME, 'buddy.md'),
    }));
  });

  it('builds ecosystem memory alignment status across AgentX RAG, Hermes, and OpenClaw', async () => {
    process.env.OPENCLAW_INVENTORY_SSH_TARGET = 'operator@openclaw.test';
    jest.resetModules();
    jest.doMock('../../src/services/ragServiceClient', () => ({
      getRagServiceClient: () => ({
        getStatus: jest.fn().mockResolvedValue({
          documentCount: 74,
          chunkCount: 1769,
          vectorDimension: 768,
          status: 'green',
          embeddingModel: 'nomic-embed-text:v1.5',
          vectorStore: {
            healthy: true,
            type: 'qdrant',
            url: 'http://qdrant:6333',
          },
          dependencies: {
            embedding: {
              healthy: true,
              provider: 'core-proxy',
              model: 'nomic-embed-text:v1.5',
              dimension: 768,
            },
          },
          healthy: true,
        }),
      }),
    }));
    jest.doMock('../../src/services/openclawAgentInventoryService', () => ({
      buildOpenClawAgentInventory: jest.fn().mockResolvedValue({
        generated_at: '2026-07-02T12:00:00.000Z',
        source: {
          openclawHome: '/home/agentx/.openclaw',
          memoryStatusSource: 'ssh openclaw memory status --json',
          degraded: false,
          issues: [],
        },
        memory_strategy: {
          provider: 'ollama',
          model: 'qllama/bge-m3:f16',
        },
        agents: [
          {
            id: 'main',
            memory: {
              provider: 'ollama',
              model: 'qllama/bge-m3:f16',
              vectorDims: 1024,
              files: 1,
              chunks: 2,
              dirty: false,
              indexStatus: 'valid',
              issues: [],
            },
          },
        ],
      }),
    }));

    const { getEcosystemMemoryAlignmentStatus } = require('../../src/services/memoryAdapters');
    const status = await getEcosystemMemoryAlignmentStatus();

    expect(status.policy).toEqual(expect.objectContaining({
      sharedMemoryLane: 'agentx-rag',
      privateRuntimeLanes: ['hermes', 'openclaw'],
    }));
    expect(status.shared.rag).toEqual(expect.objectContaining({
      source: 'agentx-rag',
      lane: 'shared-rag',
      shared: true,
      embeddingModel: 'nomic-embed-text:v1.5',
      vectorDimension: 768,
      vectorStoreType: 'qdrant',
    }));
    expect(status.private.openclaw.memory).toEqual(expect.objectContaining({
      model: 'qllama/bge-m3:f16',
      vectorDims: 1024,
    }));
    expect(status.compatibility).toEqual(expect.objectContaining({
      sharedRagToOpenclawVectors: false,
      sharedDimension: 768,
      openclawVectorDimensions: [1024],
    }));
    expect(status.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'private_openclaw_dimension_differs', severity: 'info' }),
    ]));
  });

  it('builds an FTS5-safe MATCH from free-form query', async () => {
    const { buildFtsMatch } = require('../../src/services/memoryAdapters');
    const m = buildFtsMatch('Tell me about Host Beta & qwen2.5');
    expect(m).toMatch(/"Host"\*/);
    expect(m).toMatch(/"Beta"\*/);
    expect(m).not.toMatch(/&/);
    expect(m).toMatch(/OR/);
  });
});
