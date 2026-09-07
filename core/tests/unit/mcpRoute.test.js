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
  beforeEach(() => {
    jest.clearAllMocks();
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

  test('serves remote LAN callers without any token', async () => {
    const res = await request(makeApp({ ip: '198.51.100.20' }))
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .send({ jsonrpc: '2.0', id: 7, method: 'tools/list' })
      .expect(200);

    expect(res.body.result.ok).toBe(true);
    expect(handleMcpMessage).toHaveBeenCalledTimes(1);
  });

  test('rejects batch JSON-RPC requests', async () => {
    const res = await request(makeApp())
      .post('/mcp')
      .send([{ jsonrpc: '2.0', id: 1, method: 'tools/list' }])
      .expect(400);

    expect(res.body.error.code).toBe(-32600);
    expect(handleMcpMessage).not.toHaveBeenCalled();
  });
});
