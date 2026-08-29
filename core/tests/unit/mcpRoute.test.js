const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/mcpSkillBus', () => ({
  handleMcpMessage: jest.fn(async (body) => ({
    jsonrpc: '2.0',
    id: body.id,
    result: { ok: true },
  })),
}));

const { handleMcpMessage } = require('../../src/services/mcpSkillBus');

function makeApp({ ip = '127.0.0.1' } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: ip, configurable: true });
    next();
  });
  app.use('/mcp', require('../../routes/mcp'));
  return app;
}

describe('mcp route', () => {
  const originalToken = process.env.AGENTX_MCP_TOKEN;
  const originalOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
  const originalProxyTrust = process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.AGENTX_MCP_TOKEN;
    delete process.env.AGENTX_OPERATOR_TOKEN;
    delete process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;
  });

  afterAll(() => {
    if (originalToken === undefined) delete process.env.AGENTX_MCP_TOKEN;
    else process.env.AGENTX_MCP_TOKEN = originalToken;
    if (originalOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalOperatorToken;
    if (originalProxyTrust === undefined) delete process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;
    else process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI = originalProxyTrust;
  });

  test('posts JSON-RPC requests to the handler', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
    expect(res.body.result.ok).toBe(true);
    expect(handleMcpMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });

  test('passes bounded product tool calls through the MCP route', async () => {
    handleMcpMessage.mockImplementationOnce(async (body) => ({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{ type: 'text', text: '{"count":1}' }],
        structuredContent: {
          count: 1,
          results: [{ text: 'bounded result' }],
        },
        isError: false,
      },
    }));

    const body = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'rag_search', arguments: { query: 'bounded result' } },
    };
    const res = await request(makeApp())
      .post('/mcp')
      .send(body)
      .expect(200);

    expect(handleMcpMessage).toHaveBeenCalledWith(body);
    expect(res.body.result.structuredContent).toEqual(expect.objectContaining({ count: 1 }));
  });

  test('fails closed for a remote request when AGENTX_MCP_TOKEN is unset without invoking the skill bus', async () => {
    const response = await request(makeApp({ ip: '198.51.100.20' }))
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .send({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
      .expect(401);

    expect(response.body.error).toEqual({ code: -32001, message: 'Unauthorized' });
    expect(response.body.id).toBe(7);
    expect(handleMcpMessage).not.toHaveBeenCalled();
  });

  test('rejects a wrong remote token without invoking the skill bus', async () => {
    process.env.AGENTX_MCP_TOKEN = 'secret';
    await request(makeApp({ ip: '198.51.100.20' }))
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-MCP-Token', 'wrong')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(401);
    expect(handleMcpMessage).not.toHaveBeenCalled();
  });

  test('accepts either remote MCP token transport', async () => {
    process.env.AGENTX_MCP_TOKEN = 'secret';
    const app = makeApp({ ip: '198.51.100.20' });

    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer secret')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      .expect(200);

    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-MCP-Token', 'secret')
      .send({ jsonrpc: '2.0', id: 3, method: 'tools/list' })
      .expect(200);

    expect(handleMcpMessage).toHaveBeenCalledTimes(2);
  });

  test('preserves trusted local and remote operator access independently of the MCP token', async () => {
    process.env.AGENTX_MCP_TOKEN = 'configured-mcp-token';
    await request(makeApp())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 4, method: 'tools/list' })
      .expect(200);

    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    await request(makeApp({ ip: '198.51.100.20' }))
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Operator-Token', 'operator-token')
      .send({ jsonrpc: '2.0', id: 5, method: 'tools/list' })
      .expect(200);

    expect(handleMcpMessage).toHaveBeenCalledTimes(2);
  });
});
