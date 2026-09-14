const http = require('node:http');

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const {
  BUDGET_GATE_MAX_RESPONSE_BYTES,
  BUDGET_GATE_REQUEST_SPEC,
  handleMcpMessage,
  TOOLS,
  PROTOCOL_VERSION,
} = require('../../src/services/mcpSkillBus');

function listen(handler) {
  const server = http.createServer(handler);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function callDefaultEscalation(hours = 24) {
  return handleMcpMessage({
    jsonrpc: '2.0', id: 20, method: 'tools/call',
    params: { name: 'get_escalation_recommendation', arguments: { hours } },
  });
}

describe('mcpSkillBus product tools', () => {
  test('publishes the canonical path contract as an immutable primitive', () => {
    expect(typeof BUDGET_GATE_REQUEST_SPEC.pathPattern).toBe('string');
    expect(BUDGET_GATE_REQUEST_SPEC.pathPattern.compile).toBeUndefined();
    expect(Object.isFrozen(BUDGET_GATE_REQUEST_SPEC)).toBe(true);
  });

  test('initialize advertises the current MCP protocol and tools capability', async () => {
    const response = await handleMcpMessage({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'test' } },
    });
    expect(response.result.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(response.result.capabilities.tools).toEqual({ listChanged: false });
    expect(response.result.serverInfo.name).toBe('agentx-core-skill-bus');
  });

  test('tools/list exposes only the bounded product tool set', async () => {
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(response.result.tools.map((tool) => tool.name)).toEqual([
      'rag_search',
      'check_health',
      'get_escalation_recommendation',
      'create_todo',
    ]);
    expect(TOOLS).toHaveLength(4);
  });

  test('rag_search uses an injected RAG client and returns structured content', async () => {
    const ragClient = {
      searchSimilarChunks: jest.fn(async () => [{ text: 'AgentX fact', score: 0.9 }]),
    };
    const response = await handleMcpMessage({
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
    expect(response.result.isError).toBe(false);
    expect(response.result.structuredContent.count).toBe(1);
  });

  test('check_health uses the injected health provider', async () => {
    const healthProvider = jest.fn(async () => ({ ok: true, core: { mongodb: 'connected' } }));
    const response = await handleMcpMessage({
      jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'check_health', arguments: { includeDetails: true } },
    }, { healthProvider });
    expect(response.result.isError).toBe(false);
    expect(response.result.structuredContent.ok).toBe(true);
  });

  test('default health is compact while retaining stale and failed dependency evidence', async () => {
    const status = { status: 'degraded', healthy: false, serviceReady: true, queryReady: false,
      observedAt: '2026-01-02T03:04:05Z', documentCount: 138, chunkCount: 3281,
      embeddingModel: 'example-embedding', vectorDimension: 768,
      cache: { hits: 49, misses: 59, size: 36 }, vectorStore: { type: 'qdrant', healthy: false },
      freshness: { state: 'stale', lastIngestAt: '2025-12-01T00:00:00Z', ageMs: 8000, ttlMs: 7000,
        reason: 'past-ttl', signal: { contributors: ['diagnostic-only'], schema: 'verbose-evidence' } },
      dependencies: { embedding: { healthy: true, stale: true, checkedAt: 123, model: 'example-embedding' },
        qdrant: { healthy: false, error: 'unreachable', reason: 'connection-refused' } } };
    const ragClient = { getStatus: jest.fn(async () => status) };
    const request = args => handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'check_health', arguments: args } }, { ragClient });
    const brief = (await request({})).result.structuredContent;
    expect(brief.ok).toBe(false);
    expect(brief.rag.ok).toBe(false);
    expect(brief.rag.status).toMatchObject({ status: 'degraded', healthy: false, queryReady: false, vectorStore: { healthy: false },
      freshness: { state: 'stale', reason: 'past-ttl' },
      dependencies: { embedding: { healthy: true, stale: true, checkedAt: 123 },
        qdrant: { healthy: false, error: 'unreachable', reason: 'connection-refused' } } });
    expect(brief.rag.status.cache).toBeUndefined();
    expect(brief.rag.status.chunkCount).toBeUndefined();
    expect(brief.rag.status.freshness.signal).toBeUndefined();
    const detailed = (await request({ includeDetails: true })).result.structuredContent;
    expect(detailed.rag.status).toEqual(status);
    expect(JSON.stringify(brief).length).toBeLessThan(JSON.stringify(detailed).length);
    expect(ragClient.getStatus).toHaveBeenCalledTimes(2);
  });

  test('compact health keeps unavailable RAG errors explicit', async () => {
    const response = await handleMcpMessage({ jsonrpc: '2.0', id: 4, method: 'tools/call',
      params: { name: 'check_health', arguments: {} } }, {
      ragClient: { getStatus: jest.fn(async () => { throw new Error('RAG unavailable'); }) },
    });
    expect(response.result.structuredContent.rag).toEqual({ ok: false, error: 'RAG unavailable' });
    expect(response.result.structuredContent.ok).toBe(false);
  });

  test('reads the default budget gate through the bounded canonical loopback operation', async () => {
    const previousPort = process.env.PORT;
    const payload = {
      period: { hours: 12 },
      cloud_health: 'healthy',
      cloud_requests: 3,
      cloud_tokens: 1200,
      cloud_daily_limit: 100000,
      cloud_usage_ratio: 0.012,
      cloud_spend_observability: 'available',
      escalation: {
        recommendation: 'allow',
        gate_basis: 'cloud_spend',
        cloud_allowed: true,
      },
    };
    const { server, port } = await listen((req, res) => {
      expect(req.url).toBe('/api/budget/escalation-recommendation?hours=12');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(payload));
    });
    process.env.PORT = String(port);

    try {
      const response = await callDefaultEscalation(12);
      expect(response.result.isError).toBe(false);
      expect(response.result.structuredContent).toEqual(payload);
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      await close(server);
    }
  });

  test('rejects a hostile Core port before constructing the canonical loopback target', async () => {
    const previousPort = process.env.PORT;
    process.env.PORT = '80@169.254.169.254';

    try {
      const response = await callDefaultEscalation();
      expect(response.result.isError).toBe(true);
      expect(response.result.structuredContent).toMatchObject({
        error: 'BUDGET_GATE_UNAVAILABLE',
      });
      expect(response.result.structuredContent.message).toContain('port configuration is invalid');
      expect(response.result.structuredContent.message).not.toContain('169.254.169.254');
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
    }
  });

  test('fails closed when the canonical budget gate attempts a redirect', async () => {
    const previousPort = process.env.PORT;
    const { server, port } = await listen((_req, res) => {
      res.writeHead(302, { location: '/elsewhere' });
      res.end();
    });
    process.env.PORT = String(port);

    try {
      const response = await callDefaultEscalation();
      expect(response.result.isError).toBe(true);
      expect(response.result.structuredContent).toMatchObject({
        error: 'BUDGET_GATE_UNAVAILABLE',
      });
      expect(response.result.structuredContent.message).toContain('redirect');
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      await close(server);
    }
  });

  test('fails closed before reading a budget response declared above its byte cap', async () => {
    const previousPort = process.env.PORT;
    const { server, port } = await listen((_req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-length': String(BUDGET_GATE_MAX_RESPONSE_BYTES + 1),
      });
      res.end('{}');
    });
    process.env.PORT = String(port);

    try {
      const response = await callDefaultEscalation();
      expect(response.result.isError).toBe(true);
      expect(response.result.structuredContent).toMatchObject({
        error: 'BUDGET_GATE_UNAVAILABLE',
      });
      expect(response.result.structuredContent.message).toContain('byte limit');
    } finally {
      if (previousPort === undefined) delete process.env.PORT;
      else process.env.PORT = previousPort;
      await close(server);
    }
  });

  test('tool validation failures are returned as MCP tool errors', async () => {
    const response = await handleMcpMessage({
      jsonrpc: '2.0', id: 5, method: 'tools/call',
      params: { name: 'rag_search', arguments: {} },
    }, { ragClient: { searchSimilarChunks: jest.fn() } });
    expect(response.result.isError).toBe(true);
    expect(response.result.structuredContent.error).toBe('INVALID_ARGUMENTS');
  });

  test('unknown tools fail without invoking product services', async () => {
    await expect(handleMcpMessage({
      jsonrpc: '2.0', id: 6, method: 'tools/call',
      params: { name: 'missing_tool', arguments: {} },
    })).rejects.toMatchObject({ code: 'UNKNOWN_TOOL' });
  });
});
