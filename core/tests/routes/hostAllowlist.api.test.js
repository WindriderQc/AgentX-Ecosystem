/**
 * Task 0182 — Host allowlist enforcement at the route level.
 *
 * Smoke tests proving the validateHostUrl helper is wired into every
 * mutating host-accepting route:
 *   - POST /api/models/ollama/pull   (body.host)
 *   - POST /api/models/ollama/stop   (body.host)
 *   - DELETE /api/models/ollama/:n   (query.host)
 *   - POST /api/inference/embed      (body.ollamaHost)
 *   - POST /api/inference/generate   (body.host)
 *   - POST /api/custom-models/:id/deploy (body.ollamaHost)
 *   - POST /api/chat                 (body.target)
 *   - POST/GET /api/chat/stream      (body/query target)
 *   - GET /api/models/health         (query.host)
 *   - /api/nerve-center/host-preferences/:hostUrl(*)
 */

const express = require('express');
const request = require('supertest');

// ── Pin a known allowlist for the entire suite ────────────────────────────
process.env.OLLAMA_HOST = 'http://192.0.2.66:11434';
process.env.OLLAMA_HOST_2 = 'http://192.0.2.12:11434';
process.env.OLLAMA_HOST_3 = 'http://localhost:11434';

// Mock node-fetch so allowed hosts return 200 instead of trying to dial real
// Ollama. The disallowed-host assertions return BEFORE fetch is called, so
// they don't depend on this mock.
jest.mock('node-fetch', () => jest.fn(async () => ({
  ok: true,
  status: 200,
  statusText: 'OK',
  text: async () => '{"embedding":[0.1,0.2,0.3]}',
  json: async () => ({ status: 'ok', embedding: [0.1, 0.2, 0.3] })
})));
const fetch = require('node-fetch');

jest.mock('../../src/services/chatService', () => ({
  handleChatRequest: jest.fn(),
  handleChatRequestStream: jest.fn()
}));

jest.mock('../../src/services/customModelService', () => ({
  deployToOllama: jest.fn()
}));

jest.mock('../../src/services/modelAggregator', () => ({
  getAllModels: jest.fn(),
  getModelSources: jest.fn(),
  clearCache: jest.fn()
}));

jest.mock('../../src/services/modelReadinessService', () => ({
  getModelReadiness: jest.fn(async () => ({ readiness: { stage: 'available' } })),
  isReadyStage: jest.fn(() => true)
}));

jest.mock('../../src/services/modelRouter', () => ({
  getRoutingStatus: jest.fn(),
  classifyQuery: jest.fn(),
  getModelHealth: jest.fn(),
  getAllModelsHealth: jest.fn(),
  getTargetForModel: jest.fn(() => 'http://192.0.2.66:11434'),
  recordInference: jest.fn(),
  resolveHostKey: jest.fn(() => 'primary')
}));

jest.mock('../../src/services/modelRouterConfig', () => ({
  HOSTS: { primary: 'http://192.0.2.66:11434' },
  TASK_MODELS: {},
  buildRouterConfigPayload: jest.fn(),
  ensureTaskModelOverridesLoaded: jest.fn(),
  getAdvisoryModelForTask: jest.fn(),
  getDefaultTaskModels: jest.fn(() => ({})),
  getModelForTask: jest.fn(),
  resolvePreferredTaskEntry: jest.fn(),
  resetAllTaskModelOverrides: jest.fn(),
  resetTaskModelOverride: jest.fn(),
  saveTaskModelOverride: jest.fn()
}));

jest.mock('../../src/services/hostPreferenceService', () => ({
  ...jest.requireActual('../../src/services/hostPreferenceIdentity'),
  getAll: jest.fn(async () => []),
  getHealthCheckIntervalMs: jest.fn(() => 30000),
  getByHost: jest.fn(async () => null),
  get: jest.fn(async () => null),
  getPinnedEntries: jest.fn((pref) => pref.pinnedModels || []),
  getPinStatus: jest.fn(async () => ({})),
  setPinnedModel: jest.fn(async () => ({})),
  clearPinnedModel: jest.fn(async () => ({})),
  restorePin: jest.fn(async () => ({})),
  swapModel: jest.fn(async () => ({})),
  claimBenchmark: jest.fn(async () => ({ claimed: true })),
  heartbeatBenchmarkClaim: jest.fn(async () => ({ heartbeat: true })),
  releaseBenchmarkClaim: jest.fn(async () => ({ released: true })),
  listBenchmarkClaims: jest.fn(async () => []),
  reapStaleBenchmarkClaims: jest.fn(async () => ({})),
  updatePreference: jest.fn(async () => ({})),
  warmHost: jest.fn(async () => []),
  upsert: jest.fn(async () => ({})),
  reload: jest.fn(async () => {}),
  start: jest.fn(),
  stop: jest.fn()
}));

jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));
jest.mock('../../src/services/alertService', () => ({ getAlertService: jest.fn(() => null) }));

const modelsUnifiedRoutes = require('../../routes/models-unified');
const apiRoutes = require('../../routes/api');
const customModelsRoutes = require('../../routes/custom-models');
const nerveHostPreferenceRoutes = require('../../routes/nerve-center-host-preferences');
const chatService = require('../../src/services/chatService');
const customModelService = require('../../src/services/customModelService');
const hostPrefService = require('../../src/services/hostPreferenceService');
const { getModelHealth } = require('../../src/services/modelRouter');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/models', modelsUnifiedRoutes);
  app.use('/api/custom-models', customModelsRoutes);
  app.use('/api/nerve-center', nerveHostPreferenceRoutes);
  app.use('/api', apiRoutes);
  return app;
}

describe('Host allowlist gate (task 0182) — route-level', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    app = buildApp();
  });

  // ── /api/models/ollama/pull ──────────────────────────────────────────────
  describe('POST /api/models/ollama/pull', () => {
    it('400 — requires an explicit target host', async () => {
      const res = await request(app)
        .post('/api/models/ollama/pull')
        .send({ name: 'gemma4:26b' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/target.*host|required/i);
    });

    it('200 — accepts a configured host', async () => {
      const res = await request(app)
        .post('/api/models/ollama/pull')
        .send({ name: 'gemma4:26b', host: 'http://192.0.2.66:11434' });
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('success');
    });

    it('400 — rejects an arbitrary unknown host', async () => {
      const res = await request(app)
        .post('/api/models/ollama/pull')
        .send({ name: 'gemma4:26b', host: 'http://10.0.0.99:11434' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
    });

    it('200 — accepts loopback equivalent of a configured host', async () => {
      // OLLAMA_HOST_3 = http://localhost:11434 → 127.0.0.1:11434 should pass.
      const res = await request(app)
        .post('/api/models/ollama/pull')
        .send({ name: 'gemma4:26b', host: 'http://127.0.0.1:11434' });
      expect(res.status).toBe(200);
    });
  });

  // ── /api/models/ollama/stop ──────────────────────────────────────────────
  describe('POST /api/models/ollama/stop', () => {
    it('400 — rejects unknown host before reaching Ollama', async () => {
      fetch.mockClear();
      const res = await request(app)
        .post('/api/models/ollama/stop')
        .send({ name: 'gemma4:26b', host: 'http://evil.example/api' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  // ── DELETE /api/models/ollama/:name ──────────────────────────────────────
  describe('DELETE /api/models/ollama/:name', () => {
    it('400 — rejects unknown host (query string)', async () => {
      fetch.mockClear();
      const res = await request(app)
        .delete('/api/models/ollama/gemma4:26b')
        .query({ host: 'http://10.0.0.99:11434' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
      expect(fetch).not.toHaveBeenCalled();
    });

    it('200 — accepts configured host', async () => {
      const res = await request(app)
        .delete('/api/models/ollama/gemma4:26b')
        .query({ host: 'http://192.0.2.12:11434' });
      expect(res.status).toBe(200);
    });
  });

  // ── /api/inference/embed (host override) ─────────────────────────────────
  describe('POST /api/inference/embed', () => {
    it('400 — rejects unknown ollamaHost override', async () => {
      const res = await request(app)
        .post('/api/inference/embed')
        .send({ model: 'nomic-embed-text', prompt: 'hello', ollamaHost: 'http://10.0.0.99:11434' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
    });
  });

  // ── /api/inference/generate (host override) ──────────────────────────────
  describe('POST /api/inference/generate', () => {
    it('400 — rejects unknown host override', async () => {
      const res = await request(app)
        .post('/api/inference/generate')
        .send({ model: 'gemma4:26b', prompt: 'hi', host: 'http://10.0.0.99:11434' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
    });
  });

  describe('POST /api/models/ollama/start', () => {
    it('200 — loads a model on the configured target host', async () => {
      const res = await request(app)
        .post('/api/models/ollama/start')
        .send({ name: 'gemma4:26b', host: 'http://192.0.2.12:11434' });
      expect(res.status).toBe(200);
      expect(res.body.data).toMatchObject({
        action: 'start',
        host: 'http://192.0.2.12:11434',
        name: 'gemma4:26b'
      });
    });
  });

  // ── /api/custom-models/:id/deploy ───────────────────────────────────────
  describe('POST /api/custom-models/:id/deploy', () => {
    it('400 — rejects unknown deployment host before service call', async () => {
      const res = await request(app)
        .post('/api/custom-models/demo-model/deploy')
        .send({ ollamaHost: 'http://10.0.0.99:11434' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/allowlist/i);
      expect(customModelService.deployToOllama).not.toHaveBeenCalled();
    });
  });

  // ── /api/chat target override ───────────────────────────────────────────
  describe('POST /api/chat', () => {
    it('400 — rejects unknown chat target before chat service call', async () => {
      const res = await request(app)
        .post('/api/chat')
        .send({ model: 'gemma4:26b', message: 'hello', target: 'http://10.0.0.99:11434' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
      expect(chatService.handleChatRequest).not.toHaveBeenCalled();
    });
  });

  describe('POST /api/chat/stream', () => {
    it('400 — rejects unknown stream target before SSE setup', async () => {
      const res = await request(app)
        .post('/api/chat/stream')
        .send({ model: 'gemma4:26b', message: 'hello', target: 'http://10.0.0.99:11434' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
      expect(chatService.handleChatRequestStream).not.toHaveBeenCalled();
    });
  });

  describe('GET /api/chat/stream', () => {
    it('400 — rejects unknown query target before stream service call', async () => {
      const res = await request(app)
        .get('/api/chat/stream')
        .query({ model: 'gemma4:26b', message: 'hello', target: 'http://10.0.0.99:11434' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
      expect(chatService.handleChatRequestStream).not.toHaveBeenCalled();
    });
  });

  // ── /api/models/health ──────────────────────────────────────────────────
  describe('GET /api/models/health', () => {
    it('400 — rejects unknown health-check host before model router call', async () => {
      const res = await request(app)
        .get('/api/models/health')
        .query({ host: 'http://10.0.0.99:11434', model: 'gemma4:26b' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
      expect(getModelHealth).not.toHaveBeenCalled();
    });
  });

  // ── /api/nerve-center/host-preferences ──────────────────────────────────
  describe('Nerve Center host preference allowlist', () => {
    it('400 — rejects unknown host path before updating preferences', async () => {
      const hostUrl = encodeURIComponent('http://10.0.0.99:11434');
      const res = await request(app)
        .put(`/api/nerve-center/host-preferences/${hostUrl}`)
        .send({ displayName: 'Poisoned host' });
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
      expect(hostPrefService.updatePreference).not.toHaveBeenCalled();
    });

    it('400 — rejects unknown restore host before warmup', async () => {
      const hostUrl = encodeURIComponent('http://10.0.0.99:11434');
      const res = await request(app)
        .post(`/api/nerve-center/host-preferences/${hostUrl}/restore`)
        .send({});
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(/allowlist/i);
      expect(hostPrefService.restorePin).not.toHaveBeenCalled();
    });

    it('does not fetch live status for a stored non-allowlisted host', async () => {
      fetch.mockClear();
      hostPrefService.getAll.mockResolvedValueOnce([
        {
          hostUrl: 'http://10.0.0.99:11434',
          displayName: 'Poisoned host',
          pinnedModels: [{ model: 'gemma4:26b' }]
        }
      ]);

      const res = await request(app)
        .get('/api/nerve-center/host-preferences');

      expect(res.status).toBe(200);
      expect(res.body.data[0].live.blockedByAllowlist).toBe(true);
      expect(fetch).not.toHaveBeenCalled();
    });
  });
});
