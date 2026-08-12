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

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/mcp', require('../../routes/mcp'));
  return app;
}

describe('mcp route', () => {
  const originalToken = process.env.AGENTX_MCP_TOKEN;

  afterEach(() => {
    jest.clearAllMocks();
    if (originalToken === undefined) delete process.env.AGENTX_MCP_TOKEN;
    else process.env.AGENTX_MCP_TOKEN = originalToken;
  });

  test('posts JSON-RPC requests to the handler', async () => {
    delete process.env.AGENTX_MCP_TOKEN;
    const res = await request(makeApp())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(200);
    expect(res.body.result.ok).toBe(true);
    expect(handleMcpMessage).toHaveBeenCalledWith({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  });

  test('passes ecosystem snapshot tool calls through the MCP route', async () => {
    delete process.env.AGENTX_MCP_TOKEN;
    handleMcpMessage.mockImplementationOnce(async (body) => ({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        content: [{ type: 'text', text: '{"mode":"driftOnly"}' }],
        structuredContent: {
          mode: body.params.arguments.mode,
          drift: { count: 1, records: [{ id: 'hermes-live-config-protected', owner: '0330' }] },
        },
        isError: false,
      },
    }));

    const body = {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'ecosystem_snapshot', arguments: { mode: 'driftOnly' } },
    };
    const res = await request(makeApp())
      .post('/mcp')
      .send(body)
      .expect(200);

    expect(handleMcpMessage).toHaveBeenCalledWith(body);
    expect(res.body.result.structuredContent).toEqual(expect.objectContaining({
      mode: 'driftOnly',
      drift: expect.objectContaining({ count: 1 }),
    }));
  });

  test('requires token when AGENTX_MCP_TOKEN is set', async () => {
    process.env.AGENTX_MCP_TOKEN = 'secret';
    await request(makeApp())
      .post('/mcp')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(401);

    await request(makeApp())
      .post('/mcp')
      .set('Authorization', 'Bearer secret')
      .send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
      .expect(200);
  });
});
