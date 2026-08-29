'use strict';

const express = require('express');
const request = require('supertest');
const { PassThrough } = require('stream');

const mockGetCapabilities = jest.fn();
const mockExecuteInference = jest.fn();
const mockGetRouterSnapshot = jest.fn();
const mockGetMemoryStatus = jest.fn();
const mockSearchMemory = jest.fn();
const mockGetNestorMetrics = jest.fn();

jest.mock('../../src/services/nestorConsumerCapabilitiesService', () => ({
  getCapabilities: (...args) => mockGetCapabilities(...args),
}));
jest.mock('../../src/services/nestorConsumerRuntimeService', () => ({
  executeInference: (...args) => mockExecuteInference(...args),
  getRouterSnapshot: (...args) => mockGetRouterSnapshot(...args),
}));
jest.mock('../../src/services/nestorConsumerMemoryService', () => ({
  getMemoryStatus: (...args) => mockGetMemoryStatus(...args),
  searchMemory: (...args) => mockSearchMemory(...args),
}));
jest.mock('../../src/services/nestorConsumerMetricsService', () => ({
  getNestorMetrics: (...args) => mockGetNestorMetrics(...args),
}));
jest.mock('../../config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const createRoutes = require('../../routes/nestor-consumer-v1');

function buildApp() {
  const app = express();
  const runtimeServices = { inference: { execute: jest.fn() } };
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', {
      value: app.locals.forcedIp || '127.0.0.1',
      configurable: true,
    });
    next();
  });
  app.use('/api/consumers/nestor/v1', createRoutes({ runtimeServices, systemHealth: { status: 'ok' } }));
  return app;
}

describe('Nestor v1 consumer contract routes', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
    mockGetCapabilities.mockResolvedValue({ contract: { name: 'agentx.nestor.consumer', version: '1.2.0' } });
    mockGetRouterSnapshot.mockResolvedValue({ readOnly: true, routes: {} });
    mockExecuteInference.mockResolvedValue({ reply: 'hello', callerDetail: 'nestor/desktop/chat' });
    mockGetMemoryStatus.mockResolvedValue({ sources: {} });
    mockSearchMemory.mockResolvedValue({ results: [], warnings: [] });
    mockGetNestorMetrics.mockResolvedValue({ calls: 0 });
  });

  it('discovers the versioned contract', async () => {
    const capabilities = await request(app)
      .get('/api/consumers/nestor/v1/capabilities')
      .expect(200);

    expect(capabilities.body.data.contract.version).toBe('1.2.0');
    expect(capabilities.headers['x-agentx-consumer-contract']).toBe('1.2.0');
  });

  it('delegates inference, memory, metrics, and router reads', async () => {
    const inference = await request(app)
      .post('/api/consumers/nestor/v1/inference')
      .send({ operation: 'chat', messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);
    await request(app).get('/api/consumers/nestor/v1/router').expect(200);
    await request(app).get('/api/consumers/nestor/v1/memory/status?source=agentx').expect(200);
    await request(app).post('/api/consumers/nestor/v1/memory/search').send({ source: 'agentx', query: 'x' }).expect(200);
    const personality = await request(app).get('/api/consumers/nestor/v1/personality/sources').expect(410);
    await request(app).get('/api/consumers/nestor/v1/metrics?hours=12&taskType=buddy_chat').expect(200);
    const panel = await request(app).get('/api/consumers/nestor/v1/panel-summary').expect(410);

    expect(inference.body.data.callerDetail).toBe('nestor/desktop/chat');
    expect(mockGetMemoryStatus).toHaveBeenCalledWith('agentx');
    expect(mockGetNestorMetrics).toHaveBeenCalledWith({ hours: '12', taskType: 'buddy_chat' });
    expect(personality.body.code).toBe('ADAPTER_REQUIRED');
    expect(panel.body.code).toBe('ADAPTER_REQUIRED');
  });

  it('returns a stable error envelope from bounded contract validation', async () => {
    const error = new Error('Unknown memory source: mars');
    error.statusCode = 400;
    error.code = 'UNKNOWN_MEMORY_SOURCE';
    mockSearchMemory.mockRejectedValue(error);

    const response = await request(app)
      .post('/api/consumers/nestor/v1/memory/search')
      .send({ source: 'mars', query: 'x' })
      .expect(400);

    expect(response.body).toEqual({
      ok: false,
      status: 'error',
      error: 'Unknown memory source: mars',
      message: 'Unknown memory source: mars',
      code: 'UNKNOWN_MEMORY_SOURCE',
    });
    expect(response.headers['x-agentx-consumer-contract']).toBe('1.2.0');
  });

  it('redacts deployment locations from degraded error projections', async () => {
    const error = new Error('Could not reach http://private-memory:3082');
    error.statusCode = 503;
    mockGetMemoryStatus.mockRejectedValueOnce(error);

    const response = await request(app)
      .get('/api/consumers/nestor/v1/memory/status?source=agentx')
      .expect(503);

    expect(response.body.error).toBe('Nestor consumer request failed.');
    expect(JSON.stringify(response.body)).not.toContain('http://private-memory');
    expect(response.headers['x-agentx-consumer-contract']).toBe('1.2.0');
  });

  it('relays bounded inference as route, delta, and terminal done SSE events', async () => {
    const stream = new PassThrough();
    stream.end([
      JSON.stringify({ message: { role: 'assistant', content: 'Bon' }, done: false }),
      JSON.stringify({ message: { role: 'assistant', content: 'jour' }, done: true, prompt_eval_count: 8, eval_count: 2 }),
      '',
    ].join('\n'));
    mockExecuteInference.mockResolvedValueOnce({
      operation: 'chat',
      taskType: 'buddy_chat',
      callerDetail: 'nestor/voix-native/chat',
      sessionId: 'session-1',
      provenance: {
        resolved: { model: 'model-a', hostKey: 'primary' },
        routingSource: 'task_router',
        taskType: 'buddy_chat',
      },
      stream,
    });

    const response = await request(app)
      .post('/api/consumers/nestor/v1/inference')
      .send({ operation: 'chat', stream: true, messages: [{ role: 'user', content: 'Salut' }] })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    expect(response.text).toContain('event: route');
    expect(response.text).toContain('data: {"text":"Bon","role":"assistant"}');
    expect(response.text).toContain('data: {"text":"jour","role":"assistant"}');
    expect(response.text).toContain('event: done');
    expect(response.text).toContain('"reply":"Bonjour"');
    expect(response.text).toContain('"completionTokens":2');
    expect(response.headers['x-agentx-consumer-contract']).toBe('1.2.0');
  });

  it('fails honestly when an upstream stream ends without a terminal record', async () => {
    const stream = new PassThrough();
    stream.end(`${JSON.stringify({ message: { content: 'partial' }, done: false })}\n`);
    mockExecuteInference.mockResolvedValueOnce({
      operation: 'chat',
      taskType: 'buddy_chat',
      callerDetail: 'nestor/desktop/chat',
      sessionId: null,
      provenance: {
        resolved: { model: 'model-a', hostKey: 'primary' },
        routingSource: 'task_router',
        taskType: 'buddy_chat',
      },
      stream,
    });

    const response = await request(app)
      .post('/api/consumers/nestor/v1/inference')
      .send({ operation: 'chat', stream: true, messages: [{ role: 'user', content: 'Hi' }] })
      .expect(200);

    expect(response.text).toContain('event: delta');
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('INFERENCE_STREAM_INCOMPLETE');
    expect(response.text).not.toContain('event: done');
  });
});
