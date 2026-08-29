'use strict';

const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({ error: jest.fn(), warn: jest.fn(), info: jest.fn() }));

const createRoutes = require('../../routes/external-consumer-v1');
const { createDisconnectSignal } = require('../../routes/external-consumer-v1');

function runtimeResult(overrides = {}) {
  return {
    ok: true,
    status: 200,
    body: {
      message: { role: 'assistant', content: 'hello' },
      prompt_eval_count: 4,
      eval_count: 2,
      done: true,
    },
    metadata: {
      requestedModel: null,
      taskType: 'general_chat',
      model: 'exact:model',
      hostKey: 'primary',
      hostUrl: 'http://private-host:11434',
      routingSource: 'task_router',
      inferenceContract: {
        version: 1,
        contextBudget: { windowTokens: 32768, source: 'profile' },
        qualification: { state: 'qualified', qualified: true },
      },
    },
    ...overrides,
  };
}

function buildApp(runtimeServices) {
  const app = express();
  app.use(express.json());
  app.use('/api/consumers/v1', createRoutes({
    runtimeServices,
    systemHealth: { status: 'ok' },
  }));
  return app;
}

describe('external consumer v1 routes', () => {
  let runtimeServices;

  beforeEach(() => {
    runtimeServices = {
      inference: { execute: jest.fn(async () => runtimeResult()) },
      routing: {
        getEffectiveSnapshot: jest.fn(async () => ({
          generatedAt: '2026-08-19T00:00:00.000Z',
          hosts: { primary: 'http://private-host:11434' },
          tasks: {
            general_chat: {
              model: 'exact:model',
              hostKey: 'primary',
              hostUrl: 'http://private-host:11434',
            },
          },
          warnings: [],
        })),
      },
    };
  });

  test('advertises a stateless routed contract and stable health discovery', async () => {
    const response = await request(buildApp(runtimeServices))
      .get('/api/consumers/v1/capabilities')
      .expect(200);

    expect(response.body.data).toMatchObject({
      contract: { name: 'agentx.external-consumer', version: '1.0.0' },
      agentx: { healthEndpoint: '/health' },
      inference: { stateless: true, persistence: false, routed: true },
    });
    expect(response.headers['x-agentx-consumer-contract']).toBe('1.0.0');
  });

  test('executes non-streaming inference with stable output and no private host URL', async () => {
    const response = await request(buildApp(runtimeServices))
      .post('/api/consumers/v1/inference')
      .send({
        consumer: 'example-app',
        mode: 'chat',
        taskType: 'general_chat',
        messages: [{ role: 'user', content: 'Hi' }],
        callerDetail: 'benchmark/profiler',
        persist: false,
      })
      .expect(200);

    expect(runtimeServices.inference.execute).toHaveBeenCalledWith(
      expect.objectContaining({ callerDetail: 'external/example-app' }),
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(runtimeServices.inference.execute.mock.calls[0][0]).not.toHaveProperty('persist');
    expect(response.body.data).toMatchObject({
      text: 'hello',
      route: { model: 'exact:model', hostKey: 'primary', routingSource: 'task_router' },
      persistence: { persisted: false },
    });
    expect(JSON.stringify(response.body)).not.toContain('http://private-host');
    expect(response.headers['x-resolved-model']).toBe('exact:model');
    expect(response.headers['x-routed-host-key']).toBe('primary');
  });

  test('returns a sanitized effective routing snapshot', async () => {
    const response = await request(buildApp(runtimeServices))
      .get('/api/consumers/v1/routing')
      .expect(200);

    expect(response.body.data).toMatchObject({
      readOnly: true,
      topology: 'opaque',
      tasks: { general_chat: { model: 'exact:model', hostKey: 'primary' } },
    });
    expect(JSON.stringify(response.body)).not.toContain('http://private-host');
    expect(response.headers['x-agentx-consumer-contract']).toBe('1.0.0');
    expect(runtimeServices.routing.getEffectiveSnapshot).toHaveBeenCalledWith({ includeCatalog: false });
  });

  test('redacts deployment locations from degraded error projections', async () => {
    runtimeServices.routing.getEffectiveSnapshot.mockRejectedValueOnce(
      new Error('ECONNREFUSED 10.0.0.99:11434 at C:\\Users\\operator\\agentx and /var/run/agentx.sock via http://private-host:11434')
    );

    const response = await request(buildApp(runtimeServices))
      .get('/api/consumers/v1/routing')
      .expect(500);

    expect(response.body.error).toBe('External consumer request failed.');
    expect(JSON.stringify(response.body)).not.toContain('http://private-host');
    expect(JSON.stringify(response.body)).not.toContain('10.0.0.99');
    expect(JSON.stringify(response.body)).not.toContain('Users');
    expect(JSON.stringify(response.body)).not.toContain('/var/run');
    expect(response.headers['x-agentx-consumer-contract']).toBe('1.0.0');
  });

  test('converts the upstream NDJSON stream into stable SSE events', async () => {
    const upstream = new PassThrough();
    runtimeServices.inference.execute.mockImplementation(async () => {
      setImmediate(() => {
        upstream.write(`${JSON.stringify({ message: { role: 'assistant', content: 'hel' }, done: false })}\n`);
        upstream.end(`${JSON.stringify({ message: { role: 'assistant', content: 'lo' }, done: true, prompt_eval_count: 4, eval_count: 2 })}\n`);
      });
      return runtimeResult({ stream: upstream, body: undefined });
    });

    const response = await request(buildApp(runtimeServices))
      .post('/api/consumers/v1/inference')
      .send({
        consumer: 'example-app',
        mode: 'chat',
        taskType: 'general_chat',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    expect(response.text).toContain('event: route');
    expect(response.text).toContain('event: delta');
    expect(response.text).toContain('"text":"hel"');
    expect(response.text).toContain('"text":"lo"');
    expect(response.text).toContain('event: done');
    expect(response.text).toContain('"completionTokens":2');
    expect(response.text).not.toContain('http://private-host');
  });

  test('fails honestly when an upstream stream ends without terminal evidence', async () => {
    const upstream = new PassThrough();
    runtimeServices.inference.execute.mockImplementation(async () => {
      setImmediate(() => {
        upstream.end(`${JSON.stringify({ message: { role: 'assistant', content: 'partial' }, done: false })}\n`);
      });
      return runtimeResult({ stream: upstream, body: undefined });
    });

    const response = await request(buildApp(runtimeServices))
      .post('/api/consumers/v1/inference')
      .send({
        consumer: 'example-app',
        mode: 'chat',
        taskType: 'general_chat',
        messages: [{ role: 'user', content: 'Hi' }],
        stream: true,
      })
      .expect('Content-Type', /text\/event-stream/)
      .expect(200);

    expect(response.text).toContain('event: delta');
    expect(response.text).toContain('"text":"partial"');
    expect(response.text).toContain('event: error');
    expect(response.text).toContain('"code":"INFERENCE_STREAM_INCOMPLETE"');
    expect(response.text).not.toContain('event: done');
  });

  test('turns a client disconnect into an AbortSignal for upstream cancellation', () => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    const disconnect = createDisconnectSignal(req, res);

    expect(disconnect.signal.aborted).toBe(false);
    req.emit('aborted');
    expect(disconnect.signal.aborted).toBe(true);
    expect(disconnect.signal.reason.message).toBe('external consumer disconnected');
    disconnect.complete();
  });
});
