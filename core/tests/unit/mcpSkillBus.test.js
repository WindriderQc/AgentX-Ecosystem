jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { handleMcpMessage, TOOLS, PROTOCOL_VERSION } = require('../../src/services/mcpSkillBus');

describe('mcpSkillBus product tools', () => {
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
