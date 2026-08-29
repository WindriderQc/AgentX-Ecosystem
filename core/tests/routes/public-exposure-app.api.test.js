const request = require('supertest');

jest.mock('../../src/services/pipelineTaskService', () => ({
  ...jest.requireActual('../../src/services/pipelineTaskService'),
  findNextEligibleTask: jest.fn(),
}));

const pipelineTaskService = require('../../src/services/pipelineTaskService');
const { app } = require('../../src/app');

describe('public exposure guard app mount', () => {
  const savedOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
  const savedAdminToken = process.env.AGENTX_ADMIN_TOKEN;
  const savedConsumerToken = process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
  const savedPipelineToken = process.env.AGENTX_PIPELINE_TOKEN;
  const savedScheduleToken = process.env.AGENTX_SCHEDULE_TOKEN;
  const savedPublicHosts = process.env.AGENTX_PUBLIC_HOSTS;

  beforeEach(() => {
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = 'consumer-token';
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-token';
    process.env.AGENTX_SCHEDULE_TOKEN = 'schedule-token';
    delete process.env.AGENTX_ADMIN_TOKEN;
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    pipelineTaskService.findNextEligibleTask.mockReset();
    pipelineTaskService.findNextEligibleTask.mockResolvedValue({
      pipelineId: '0706', status: 'queued', assignee: null
    });
  });

  afterAll(() => {
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;

    if (savedAdminToken === undefined) delete process.env.AGENTX_ADMIN_TOKEN;
    else process.env.AGENTX_ADMIN_TOKEN = savedAdminToken;

    if (savedConsumerToken === undefined) delete process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
    else process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = savedConsumerToken;

    if (savedPipelineToken === undefined) delete process.env.AGENTX_PIPELINE_TOKEN;
    else process.env.AGENTX_PIPELINE_TOKEN = savedPipelineToken;

    if (savedScheduleToken === undefined) delete process.env.AGENTX_SCHEDULE_TOKEN;
    else process.env.AGENTX_SCHEDULE_TOKEN = savedScheduleToken;

    if (savedPublicHosts === undefined) delete process.env.AGENTX_PUBLIC_HOSTS;
    else process.env.AGENTX_PUBLIC_HOSTS = savedPublicHosts;
  });

  it('blocks public-host API traffic before app routes handle it', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Host', 'agentx.example.test')
      .expect(403);

    expect(res.body).toEqual(expect.objectContaining({
      ok: false,
      code: 'PUBLIC_EXPOSURE_GUARD'
    }));
  });

  it('allows public-host API traffic with a valid operator token', async () => {
    const res = await request(app)
      .get('/api/config')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer operator-token')
      .expect(200);

    expect(res.body).toHaveProperty('ollama');
  });

  it('blocks unconfigured hostnames even when the connection itself is loopback', async () => {
    await request(app)
      .get('/api/config')
      .set('Host', '192.0.2.99:3080')
      .expect(403);

    const res = await request(app)
      .get('/api/config')
      .set('Host', '127.0.0.1:3080')
      .expect(200);
    expect(res.body).toHaveProperty('ollama');
  });

  it('leaves public-host health checks available', async () => {
    const res = await request(app)
      .get('/health')
      .set('Host', 'agentx.example.test');

    expect([200, 503]).toContain(res.statusCode);
    expect(res.statusCode).not.toBe(403);
  });

  it('requires the exact scoped consumer token for public-host Nestor mutations', async () => {
    for (const path of [
      '/api/consumers/nestor/v1/inference',
      '/api/consumers/nestor/v1/memory/search',
    ]) {
      const rejected = await request(app)
        .post(path)
        .set('Host', 'agentx.example.test')
        .set('X-AgentX-Consumer-Token', 'wrong-token')
        .send({});
      expect(rejected.statusCode).toBe(403);
      expect(rejected.body.code).toBe('PUBLIC_EXPOSURE_GUARD');

      const admitted = await request(app)
        .post(path)
        .set('Host', 'agentx.example.test')
        .set('X-AgentX-Consumer-Token', 'consumer-token')
        .send({});
      expect(admitted.statusCode).toBe(400);
      expect(admitted.statusCode).not.toBe(403);
    }
  });

  it('admits the exact pipeline worker token through the public boundary and route-local validator', async () => {
    const rejected = await request(app)
      .post('/api/pipeline/tasks/0705/status')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'wrong-token')
      .send({ status: 'not-a-real-status' })
      .expect(403);
    expect(rejected.body.code).toBe('PUBLIC_EXPOSURE_GUARD');

    const admitted = await request(app)
      .post('/api/pipeline/tasks/0705/status')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .send({ status: 'not-a-real-status' })
      .expect(400);
    expect(admitted.body.code).toBe('INVALID_STATUS');

    const workerFinalize = await request(app)
      .post('/api/pipeline/tasks/0705/status')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .send({ status: 'done', by: 'invented-overseer' })
      .expect(403);
    expect(workerFinalize.body.code).toBe('PIPELINE_FINALIZE_REQUIRES_CONTROL_AUTHORITY');

    const next = await request(app)
      .get('/api/pipeline/tasks/next?agent=remote-worker')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .expect(200);
    expect(next.body.data.nextTaskId).toBe('0706');
    expect(pipelineTaskService.findNextEligibleTask).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'remote-worker' })
    );

    const fullList = await request(app)
      .get('/api/pipeline/tasks')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .expect(403);
    expect(fullList.body.code).toBe('PUBLIC_EXPOSURE_GUARD');
  });

  it('admits the exact schedule token through the public boundary and route-local validator', async () => {
    const rejected = await request(app)
      .post('/api/cluster/schedule/sync')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Schedule-Token', 'wrong-token')
      .send({ entries: [] })
      .expect(403);
    expect(rejected.body.code).toBe('PUBLIC_EXPOSURE_GUARD');

    const admitted = await request(app)
      .post('/api/cluster/schedule/sync')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Schedule-Token', 'schedule-token')
      .send({ entries: [] })
      .expect(400);
    expect(admitted.body.error).toBe('entries array required');
  });
});
