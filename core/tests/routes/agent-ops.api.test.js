const express = require('express');
const request = require('supertest');

const mockBuildAgentOpsProjection = jest.fn();
const mockLoadAgentOpsHistoryInputs = jest.fn();
const mockExecuteAgentOpsAction = jest.fn();

class MockActionError extends Error {
  constructor(message, status = 400, code = 'ACTION_ERROR') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

jest.mock('../../config/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

jest.mock('../../src/services/agentOpsProjectionService', () => ({
  buildAgentOpsProjection: (...args) => mockBuildAgentOpsProjection(...args)
}));

jest.mock('../../src/services/agentOpsHistoryService', () => ({
  loadAgentOpsHistoryInputs: (...args) => mockLoadAgentOpsHistoryInputs(...args)
}));

jest.mock('../../src/services/agentOpsActionService', () => ({
  AgentOpsActionError: MockActionError,
  confirmationKey: (action, target) => `${action}:${target}`,
  executeAgentOpsAction: (...args) => mockExecuteAgentOpsAction(...args)
}));

const router = require('../../routes/agent-ops');
const OPENCLAW_CONTROL = {
  authority: 'official-openclaw-control-ui',
  launchBaseUrl: 'http://127.0.0.1:18790',
  mode: 'ssh-tunnel'
};

function buildApp() {
  const app = express();
  app.locals.openclawControl = OPENCLAW_CONTROL;
  app.use('/api/agent-ops', router);
  return app;
}

describe('GET /api/agent-ops', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBuildAgentOpsProjection.mockResolvedValue({
      status: 'ok',
      summary: { registeredAgents: 4 },
      automations: [],
      agents: [],
      work: { active: [] }
    });
    mockLoadAgentOpsHistoryInputs.mockResolvedValue({ auditEntries: [], recentTasks: [] });
    mockExecuteAgentOpsAction.mockResolvedValue({ message: 'Action complete' });
  });

  test('returns the evidence-first Agent Ops projection', async () => {
    const response = await request(buildApp())
      .get('/api/agent-ops')
      .expect(200);

    expect(response.body.status).toBe('success');
    expect(response.body.data.summary.registeredAgents).toBe(4);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(mockBuildAgentOpsProjection).toHaveBeenCalledWith({
      snapshotOptions: { coreBaseUrl: expect.stringMatching(/^http:\/\//) },
      openclawControl: OPENCLAW_CONTROL,
      auditEntries: [],
      recentTasks: []
    });
  });

  test('fails closed without leaking the internal error', async () => {
    mockBuildAgentOpsProjection.mockRejectedValueOnce(new Error('secret path detail'));

    const response = await request(buildApp())
      .get('/api/agent-ops')
      .expect(500);

    expect(response.body).toMatchObject({
      status: 'error',
      message: 'Failed to build Agent Ops projection'
    });
    expect(JSON.stringify(response.body)).not.toContain('secret path detail');
  });

  test('rejects operator actions without the exact confirmation header', async () => {
    const response = await request(buildApp())
      .post('/api/agent-ops/actions')
      .send({ action: 'automation-run', target: 'job-1' })
      .expect(400);

    expect(response.body.message).toMatch(/confirmation/i);
    expect(mockExecuteAgentOpsAction).not.toHaveBeenCalled();
  });

  test('executes a confirmed allowlisted action against a fresh projection', async () => {
    const response = await request(buildApp())
      .post('/api/agent-ops/actions')
      .set('X-Agent-Ops-Confirmation', 'automation-run:job-1')
      .send({ action: 'automation-run', target: 'job-1' })
      .expect(200);

    expect(response.body).toMatchObject({ status: 'success', data: { message: 'Action complete' } });
    expect(mockExecuteAgentOpsAction).toHaveBeenCalledWith(expect.objectContaining({
      action: 'automation-run',
      target: 'job-1',
      projection: expect.any(Object)
    }));
  });

  test('preserves safe action error status and code', async () => {
    mockExecuteAgentOpsAction.mockRejectedValueOnce(new MockActionError('Already paused', 409, 'NO_CHANGE'));

    const response = await request(buildApp())
      .post('/api/agent-ops/actions')
      .set('X-Agent-Ops-Confirmation', 'automation-disable:job-1')
      .send({ action: 'automation-disable', target: 'job-1' })
      .expect(409);

    expect(response.body).toMatchObject({ status: 'error', code: 'NO_CHANGE', message: 'Already paused' });
  });
});
