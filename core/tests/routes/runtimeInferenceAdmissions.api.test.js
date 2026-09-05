'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/runtimeCoordinationService', () => ({
  acquireInference: jest.fn(),
  heartbeatInference: jest.fn(),
  releaseInference: jest.fn(),
  markInferenceUnknown: jest.fn(),
  recoverInferenceAfterRuntimeRestart: jest.fn()
}));

const runtime = require('../../src/services/runtimeCoordinationService');
const router = require('../../routes/runtime-inference-admissions');

describe('runtime inference admission bridge API', () => {
  const savedToken = process.env.AGENTX_RUNTIME_BRIDGE_TOKEN;
  const savedHost = process.env.OLLAMA_HOST;
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.AGENTX_RUNTIME_BRIDGE_TOKEN = 'runtime-bridge-token';
    process.env.OLLAMA_HOST = 'http://ollama.test:11434';
    app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '192.0.2.10', configurable: true });
      next();
    });
    app.use('/api/runtime/inference-admissions', router);
  });

  afterAll(() => {
    if (savedToken === undefined) delete process.env.AGENTX_RUNTIME_BRIDGE_TOKEN;
    else process.env.AGENTX_RUNTIME_BRIDGE_TOKEN = savedToken;
    if (savedHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = savedHost;
  });

  test('acquires only shared admission under the server-owned runtime-bridge principal', async () => {
    runtime.acquireInference.mockResolvedValue({
      acquired: true,
      admissionId: 'inference-a',
      generation: 'generation-a',
      principal: 'runtime-bridge',
      requestId: 'dsh-request-a',
      host: 'http://ollama.test:11434',
      model: 'model-a',
      kind: 'runtime-bridge',
      mode: 'shared',
      residencyKey: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      residencySpec: { version: 1, model: 'model-a', runner: { num_ctx: 8192 }, keepAliveClass: 'finite' }
    });
    const response = await request(app)
      .post('/api/runtime/inference-admissions')
      .set('Authorization', 'Bearer runtime-bridge-token')
      .send({
        requestId: 'dsh-request-a',
        host: 'http://ollama.test:11434',
        model: 'model-a',
        runtimeOptions: { num_ctx: 8192, temperature: 0.4 },
        keepAlive: '5m',
        residencyKey: 'forged',
        principal: 'forged',
        callerDetail: 'benchmark-forged'
      })
      .expect(200);

    expect(response.body.data).toMatchObject({
      contract: 'agentx.runtime-inference-admission/v1',
      coordinationKind: 'inference',
      acquired: true,
      principal: 'runtime-bridge',
      residencyKey: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    });
    expect(runtime.acquireInference).toHaveBeenCalledWith(expect.objectContaining({
      principal: 'runtime-bridge',
      requestId: 'dsh-request-a',
      host: 'http://ollama.test:11434',
      model: 'model-a',
      kind: 'runtime-bridge',
      mode: 'shared',
      runtimeOptions: { num_ctx: 8192, temperature: 0.4 },
      keepAlive: '5m'
    }));
  });

  test('rejects wrong token, unconfigured host, and exclusive mode', async () => {
    await request(app)
      .post('/api/runtime/inference-admissions')
      .set('Authorization', 'Bearer wrong')
      .send({ requestId: 'a', host: 'http://ollama.test:11434', model: 'model-a' })
      .expect(403);
    await request(app)
      .post('/api/runtime/inference-admissions')
      .set('Authorization', 'Bearer runtime-bridge-token')
      .send({ requestId: 'a', host: 'http://other.test:11434', model: 'model-a' })
      .expect(400);
    await request(app)
      .post('/api/runtime/inference-admissions')
      .set('Authorization', 'Bearer runtime-bridge-token')
      .send({ requestId: 'a', host: 'http://ollama.test:11434', model: 'model-a', mode: 'exclusive' })
      .expect(400);
    expect(runtime.acquireInference).not.toHaveBeenCalled();
  });

  test('heartbeats, completes, and quarantines only the exact server principal proof', async () => {
    const proof = {
      admissionId: 'inference-a', generation: 'generation-a', principal: 'runtime-bridge',
      requestId: 'dsh-request-a', host: 'http://ollama.test:11434', model: 'model-a',
      kind: 'runtime-bridge', mode: 'shared', residencyKey: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      residencySpec: { version: 1, model: 'model-a', runner: {}, keepAliveClass: 'default' }
    };
    runtime.heartbeatInference.mockResolvedValue({ heartbeat: true, ...proof, heartbeatAt: new Date(), expiresAt: new Date() });
    runtime.releaseInference.mockResolvedValue({ released: true, ...proof, releasedAt: new Date() });
    runtime.markInferenceUnknown.mockResolvedValue({
      quarantined: true, ...proof, unknownAt: new Date(), reason: 'socket disconnected'
    });
    const auth = { Authorization: 'Bearer runtime-bridge-token' };

    const heartbeat = await request(app).post('/api/runtime/inference-admissions/inference-a/heartbeat')
      .set(auth).send({ generation: 'generation-a', principal: 'forged' }).expect(200);
    const complete = await request(app).post('/api/runtime/inference-admissions/inference-a/complete')
      .set(auth).send({ generation: 'generation-a', principal: 'forged' }).expect(200);
    const unknown = await request(app).post('/api/runtime/inference-admissions/inference-a/mark-unknown')
      .set(auth).send({ generation: 'generation-a', principal: 'forged', reason: 'socket disconnected' }).expect(200);

    expect(heartbeat.body.data).toMatchObject({
      contract: 'agentx.runtime-inference-heartbeat/v1', coordinationKind: 'inference', heartbeat: true, ...proof
    });
    expect(complete.body.data).toMatchObject({
      contract: 'agentx.runtime-inference-completion/v1', coordinationKind: 'inference', released: true, ...proof
    });
    expect(unknown.body.data).toMatchObject({
      contract: 'agentx.runtime-inference-quarantine/v1', coordinationKind: 'inference', quarantined: true,
      state: 'UNKNOWN', reason: 'socket disconnected', ...proof
    });

    for (const mock of [runtime.heartbeatInference, runtime.releaseInference, runtime.markInferenceUnknown]) {
      expect(mock).toHaveBeenCalledWith(expect.objectContaining({
        id: 'inference-a', generation: 'generation-a', principal: 'runtime-bridge'
      }));
    }
  });

  test('runtime token cannot recover UNKNOWN; operator recovery keeps principal fixed', async () => {
    await request(app)
      .post('/api/runtime/inference-admissions/inference-a/recover-runtime-restart')
      .set('Authorization', 'Bearer runtime-bridge-token')
      .send({ generation: 'generation-a' })
      .expect(403);
    expect(runtime.recoverInferenceAfterRuntimeRestart).not.toHaveBeenCalled();
  });
});
