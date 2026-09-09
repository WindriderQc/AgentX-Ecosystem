const express = require('express');
const PipelineTask = require('../../models/PipelineTask');
const { startTestHttpHarness } = require('../helpers/testHttpServer');
const pipelineRoutes = require('../../routes/pipeline');
const mcpRoutes = require('../../routes/mcp');

let harness;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api/pipeline', pipelineRoutes);
  app.use('/api/mcp', mcpRoutes);
  harness = await startTestHttpHarness(app, { transport: process.platform === 'win32' ? 'pipe' : 'tcp' });
});
afterAll(async () => { await harness?.close(); });
afterEach(() => { jest.restoreAllMocks(); });

async function readTask(id) {
  return (await harness.request.get('/api/pipeline/tasks/' + id).expect(200)).body.data.task;
}

test('HTTP creation persists partial instructions before reporting success', async () => {
  const response = await harness.request.post('/api/pipeline/tasks').send({
    title: 'HTTP authored task', objective: 'Keep the full objective.',
    steps: ['Inspect the implementation'], constraints: ['No model campaign'],
  }).expect(201);
  const task = await readTask(response.body.data.task.pipelineId);
  expect(task.spec).toContain('Keep the full objective.');
  expect(task.spec).toContain('Inspect the implementation');
  expect(task.spec).toContain('No model campaign');
});

test('MCP creation uses the same persisted task that HTTP reads', async () => {
  const response = await harness.request.post('/api/mcp').send({
    jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name: 'create_todo', arguments: { title: 'MCP authored task', objective: 'A durable MCP objective.' },
    },
  }).expect(200);
  expect(response.body.result.isError).toBe(false);
  const task = await readTask(response.body.result.structuredContent.pipelineId);
  expect(task.spec).toContain('A durable MCP objective.');
});

test('a database write failure is an error through both creation entry points', async () => {
  jest.spyOn(PipelineTask, 'create').mockRejectedValue(new Error('Database write failed'));
  const input = { title: 'Rejected write' };
  const http = await harness.request.post('/api/pipeline/tasks').send(input).expect(400);
  expect(http.body).toMatchObject({ status: 'error', message: 'Database write failed' });
  const mcp = await harness.request.post('/api/mcp').send({
    jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'create_todo', arguments: input },
  }).expect(200);
  expect(mcp.body.result.isError).toBe(true);
  expect(mcp.body.result.structuredContent.message).toBe('Database write failed');
  expect(await PipelineTask.countDocuments({ title: input.title })).toBe(0);
});
