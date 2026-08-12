const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/openclawRuntimeEvidenceService', () => ({
  getOpenClawRuntimeEvidence: jest.fn(),
}));
jest.mock('../../src/services/openclawAgentInventoryService', () => ({
  buildOpenClawAgentInventory: jest.fn(),
}));
jest.mock('../../src/middleware/operatorAccess', () => ({
  requireOperatorAccess: (_req, _res, next) => next(),
}));
jest.mock('../../config/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }));

const { getOpenClawRuntimeEvidence } = require('../../src/services/openclawRuntimeEvidenceService');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/openclaw', require('../../routes/openclaw'));
  return app;
}

describe('OpenClaw native-authority API behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    getOpenClawRuntimeEvidence.mockResolvedValue({
      authority: 'official-openclaw-cli',
      source: { degraded: false },
      generatedAt: new Date().toISOString(),
      status: { online: true, gateway: {}, gatewayService: {}, agents: 0, sessions: { count: 0, recent: [] } },
      defaults: {},
      memoryStrategy: null,
      agents: [],
      cron: { count: 0, jobs: [] },
      models: { default: null, fallbacks: [], providers: [], agents: [], liveModels: {} },
    });
  });

  it('keeps configuration reads bounded and read-only', async () => {
    const read = await request(buildApp()).get('/api/openclaw/config').expect(200);
    expect(read.body).toEqual(expect.objectContaining({ readOnly: true, authority: 'official-openclaw-cli' }));

    const write = await request(buildApp())
      .patch('/api/openclaw/config')
      .send({ path: 'agents.defaults.model.primary', value: 'ollama/model' })
      .expect(409);
    expect(write.body.code).toBe('OPENCLAW_NATIVE_AUTHORITY');
  });

  it('returns stable evidence failure envelopes', async () => {
    getOpenClawRuntimeEvidence.mockRejectedValueOnce(Object.assign(new Error('runtime unavailable'), { status: 503 }));
    const response = await request(buildApp()).get('/api/openclaw/agents').expect(503);
    expect(response.body).toEqual({ status: 'error', message: 'runtime unavailable' });
  });
});
