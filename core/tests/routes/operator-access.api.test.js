const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/openclawAgentInventoryService', () => ({
  buildOpenClawAgentInventory: jest.fn(),
}));
jest.mock('../../src/services/openclawRuntimeEvidenceService', () => ({
  getOpenClawRuntimeEvidence: jest.fn(),
}));

jest.mock('../../config/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', {
      value: app.locals.forcedIp || '127.0.0.1',
      configurable: true
    });
    next();
  });
  app.use('/api/openclaw', require('../../routes/openclaw'));
  return app;
}

describe('operator-access guarded routes', () => {
  const savedOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
  const savedAdminToken = process.env.AGENTX_ADMIN_TOKEN;
  let app;

  beforeEach(() => {
    jest.resetModules();
    global.fetch = jest.fn();
    app = buildApp();
    delete process.env.AGENTX_OPERATOR_TOKEN;
    delete process.env.AGENTX_ADMIN_TOKEN;
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  afterAll(() => {
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;
    if (savedAdminToken === undefined) delete process.env.AGENTX_ADMIN_TOKEN;
    else process.env.AGENTX_ADMIN_TOKEN = savedAdminToken;
  });

  it('rejects a non-loopback OpenClaw config mutation without an operator token before proxying', async () => {
    app.locals.forcedIp = '172.18.0.5';

    const res = await request(app)
      .patch('/api/openclaw/config')
      .send({ path: 'agents.defaults.model.primary', value: 'qwen3:14b' })
      .expect(403);

    expect(res.body.error).toBe('forbidden');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('authenticates a non-loopback operator but preserves official OpenClaw config authority', async () => {
    app.locals.forcedIp = '172.18.0.5';
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    const res = await request(app)
      .patch('/api/openclaw/config')
      .set('X-AgentX-Operator-Token', 'operator-token')
      .send({ path: 'agents.defaults.model.primary', value: 'qwen3:14b' })
      .expect(409);

    expect(res.body.code).toBe('OPENCLAW_NATIVE_AUTHORITY');
    expect(global.fetch).not.toHaveBeenCalled();
  });
});
