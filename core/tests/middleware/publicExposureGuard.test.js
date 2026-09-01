const express = require('express');
const request = require('supertest');
const {
  benchmarkCredentialPath,
  publicExposureGuard,
  runtimeBridgeCredentialPath,
} = require('../../src/middleware/publicExposureGuard');

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
  app.use(publicExposureGuard);
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/api/nerve-center/status', (_req, res) => res.json({ status: 'success' }));
  app.get('/api/consumers/v1/capabilities', (_req, res) => res.json({ ok: true }));
  app.post('/api/consumers/nestor/v1/inference', (_req, res) => res.json({ ok: true }));
  app.post('/api/consumers/nestor/v1/memory/search', (_req, res) => res.json({ ok: true }));
  app.post('/api/chat', (_req, res) => res.json({ status: 'success' }));
  app.post('/api/analytics/codex-usage', (_req, res) => res.json({ ok: true }));
  app.post('/api/platform-events', (_req, res) => res.json({ ok: true }));
  app.post('/api/inference/generate', (_req, res) => res.json({ ok: true }));
  app.post('/api/planning/automation/reconcile', (_req, res) => res.json({ ok: true }));
  app.post('/api/memory-review/runs', (_req, res) => res.json({ ok: true }));
  app.post('/api/memory-review/runs/run-1/observations', (_req, res) => res.json({ ok: true }));
  app.get('/api/memory-review/runs/run-1/synthesis-input', (_req, res) => res.json({ ok: true }));
  app.post('/api/cluster/schedule/sync', (_req, res) => res.json({ ok: true }));
  app.post('/api/cluster/schedule/claim', (_req, res) => res.json({ ok: true }));
  app.delete('/api/cluster/schedule/claim/claim-1', (_req, res) => res.json({ ok: true }));
  app.post('/api/pipeline/tasks/task-1/claim', (_req, res) => res.json({ ok: true }));
  app.get('/api/pipeline/tasks/next', (_req, res) => res.json({ ok: true }));
  app.get('/api/pipeline/tasks/task-1/worker', (_req, res) => res.json({ ok: true }));
  app.post('/api/pipeline/tasks/task-1/status', (_req, res) => res.json({ ok: true }));
  app.post('/api/todos', (_req, res) => res.json({ ok: true }));
  app.post('/api/alerts/alert-1/delivery-status', (_req, res) => res.json({ ok: true }));
  app.get('/api/openclaw-ollama/api/tags', (_req, res) => res.json({ models: [] }));
  app.post('/api/openclaw-ollama/api/chat', (_req, res) => res.json({ done: true }));
  app.get('/api/openclaw-ollama-evil/api/tags', (_req, res) => res.json({ unsafe: true }));
  app.post('/mcp', (_req, res) => res.json({ jsonrpc: '2.0', result: {} }));
  return app;
}

describe('publicExposureGuard', () => {
  const savedOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
  const savedAdminToken = process.env.AGENTX_ADMIN_TOKEN;
  const savedConsumerToken = process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
  const savedPublicHosts = process.env.AGENTX_PUBLIC_HOSTS;
  const savedAgentxPublicUrl = process.env.AGENTX_PUBLIC_URL;
  const savedOperatorUiHosts = process.env.AGENTX_OPERATOR_UI_HOSTS;
  const savedCorePublicUrl = process.env.CORE_PUBLIC_URL;
  const savedMcpToken = process.env.AGENTX_MCP_TOKEN;
  const savedCodexUsageToken = process.env.AGENTX_CODEX_USAGE_TOKEN;
  const savedPlatformEventToken = process.env.AGENTX_PLATFORM_EVENT_TOKEN;
  const savedBenchmarkToken = process.env.AGENTX_BENCHMARK_TOKEN;
  const savedMemoryReviewToken = process.env.AGENTX_MEMORY_REVIEW_TOKEN;
  const savedScheduleToken = process.env.AGENTX_SCHEDULE_TOKEN;
  const savedPipelineToken = process.env.AGENTX_PIPELINE_TOKEN;
  const savedAlertDeliveryToken = process.env.AGENTX_ALERT_DELIVERY_TOKEN;
  const savedRuntimeBridgeToken = process.env.AGENTX_RUNTIME_BRIDGE_TOKEN;
  const savedInternalHostTrust = process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
  const savedLoopbackProxyUiTrust = process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;

  let app;

  beforeEach(() => {
    delete process.env.AGENTX_OPERATOR_TOKEN;
    delete process.env.AGENTX_ADMIN_TOKEN;
    delete process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
    delete process.env.AGENTX_PUBLIC_HOSTS;
    delete process.env.AGENTX_PUBLIC_URL;
    delete process.env.AGENTX_OPERATOR_UI_HOSTS;
    delete process.env.CORE_PUBLIC_URL;
    delete process.env.AGENTX_MCP_TOKEN;
    delete process.env.AGENTX_CODEX_USAGE_TOKEN;
    delete process.env.AGENTX_PLATFORM_EVENT_TOKEN;
    delete process.env.AGENTX_BENCHMARK_TOKEN;
    delete process.env.AGENTX_MEMORY_REVIEW_TOKEN;
    delete process.env.AGENTX_SCHEDULE_TOKEN;
    delete process.env.AGENTX_PIPELINE_TOKEN;
    delete process.env.AGENTX_ALERT_DELIVERY_TOKEN;
    delete process.env.AGENTX_RUNTIME_BRIDGE_TOKEN;
    delete process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
    delete process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;
    app = buildApp();
  });

  afterAll(() => {
    if (savedOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = savedOperatorToken;
    if (savedAdminToken === undefined) delete process.env.AGENTX_ADMIN_TOKEN;
    else process.env.AGENTX_ADMIN_TOKEN = savedAdminToken;
    if (savedConsumerToken === undefined) delete process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN;
    else process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = savedConsumerToken;
    if (savedPublicHosts === undefined) delete process.env.AGENTX_PUBLIC_HOSTS;
    else process.env.AGENTX_PUBLIC_HOSTS = savedPublicHosts;
    if (savedAgentxPublicUrl === undefined) delete process.env.AGENTX_PUBLIC_URL;
    else process.env.AGENTX_PUBLIC_URL = savedAgentxPublicUrl;
    if (savedOperatorUiHosts === undefined) delete process.env.AGENTX_OPERATOR_UI_HOSTS;
    else process.env.AGENTX_OPERATOR_UI_HOSTS = savedOperatorUiHosts;
    if (savedCorePublicUrl === undefined) delete process.env.CORE_PUBLIC_URL;
    else process.env.CORE_PUBLIC_URL = savedCorePublicUrl;
    if (savedMcpToken === undefined) delete process.env.AGENTX_MCP_TOKEN;
    else process.env.AGENTX_MCP_TOKEN = savedMcpToken;
    if (savedCodexUsageToken === undefined) delete process.env.AGENTX_CODEX_USAGE_TOKEN;
    else process.env.AGENTX_CODEX_USAGE_TOKEN = savedCodexUsageToken;
    if (savedPlatformEventToken === undefined) delete process.env.AGENTX_PLATFORM_EVENT_TOKEN;
    else process.env.AGENTX_PLATFORM_EVENT_TOKEN = savedPlatformEventToken;
    if (savedBenchmarkToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = savedBenchmarkToken;
    if (savedMemoryReviewToken === undefined) delete process.env.AGENTX_MEMORY_REVIEW_TOKEN;
    else process.env.AGENTX_MEMORY_REVIEW_TOKEN = savedMemoryReviewToken;
    if (savedScheduleToken === undefined) delete process.env.AGENTX_SCHEDULE_TOKEN;
    else process.env.AGENTX_SCHEDULE_TOKEN = savedScheduleToken;
    if (savedPipelineToken === undefined) delete process.env.AGENTX_PIPELINE_TOKEN;
    else process.env.AGENTX_PIPELINE_TOKEN = savedPipelineToken;
    if (savedAlertDeliveryToken === undefined) delete process.env.AGENTX_ALERT_DELIVERY_TOKEN;
    else process.env.AGENTX_ALERT_DELIVERY_TOKEN = savedAlertDeliveryToken;
    if (savedRuntimeBridgeToken === undefined) delete process.env.AGENTX_RUNTIME_BRIDGE_TOKEN;
    else process.env.AGENTX_RUNTIME_BRIDGE_TOKEN = savedRuntimeBridgeToken;
    if (savedInternalHostTrust === undefined) delete process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
    else process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = savedInternalHostTrust;
    if (savedLoopbackProxyUiTrust === undefined) delete process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI;
    else process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI = savedLoopbackProxyUiTrust;
  });

  it('blocks public-host API requests without an operator token even from loopback', async () => {
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    const res = await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'agentx.example.test')
      .expect(403);

    expect(res.body).toEqual(expect.objectContaining({
      ok: false,
      code: 'PUBLIC_EXPOSURE_GUARD'
    }));
  });

  it('does not let X-Forwarded-Host hide a configured public host', async () => {
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'agentx.example.test')
      .set('X-Forwarded-Host', '127.0.0.1:3080')
      .expect(403);
  });

  it('allows public-host API requests with a valid operator token', async () => {
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';

    await request(app)
      .post('/api/chat')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer operator-token')
      .send({ message: 'hello' })
      .expect(200);
  });

  it('allows the scoped token only on the external consumer path', async () => {
    process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = 'consumer-token';
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';

    await request(app)
      .get('/api/consumers/v1/capabilities')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer consumer-token')
      .expect(200);
    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer consumer-token')
      .expect(403);
  });

  it('admits the same documented consumer token on only the Nestor v1 family', async () => {
    process.env.AGENTX_EXTERNAL_CONSUMER_TOKEN = 'consumer-token';
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    app.locals.forcedIp = '192.0.2.10';

    for (const path of [
      '/api/consumers/nestor/v1/inference',
      '/api/consumers/nestor/v1/memory/search',
    ]) {
      await request(app)
        .post(path)
        .set('Host', 'agentx.example.test')
        .set('X-AgentX-Consumer-Token', 'consumer-token')
        .send({})
        .expect(200);
      await request(app)
        .post(path)
        .set('Host', 'agentx.example.test')
        .set('X-AgentX-Consumer-Token', 'wrong-token')
        .send({})
        .expect(403);
    }

    await request(app)
      .post('/api/chat')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Consumer-Token', 'consumer-token')
      .send({})
      .expect(403);
  });

  it('admits the dedicated runtime token only on the exact OpenClaw proxy family', async () => {
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    process.env.AGENTX_RUNTIME_BRIDGE_TOKEN = 'runtime-bridge-token-1234';
    app.locals.forcedIp = '192.0.2.10';

    await request(app)
      .get('/api/openclaw-ollama/api/tags')
      .set('Host', 'agentx.example.test')
      .expect(403);
    await request(app)
      .get('/api/openclaw-ollama/api/tags')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer wrong-token')
      .expect(403);
    await request(app)
      .get('/api/openclaw-ollama/api/tags')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer runtime-bridge-token-1234')
      .expect(200);
    await request(app)
      .post('/api/openclaw-ollama/api/chat')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Runtime-Token', 'runtime-bridge-token-1234')
      .send({ model: 'qualified-model', messages: [] })
      .expect(200);

    for (const path of [
      '/api/nerve-center/status',
      '/api/openclaw-ollama-evil/api/tags',
    ]) {
      await request(app)
        .get(path)
        .set('Host', 'agentx.example.test')
        .set('Authorization', 'Bearer runtime-bridge-token-1234')
        .expect(403);
    }

    expect(runtimeBridgeCredentialPath('/api/openclaw-ollama')).toBe(true);
    expect(runtimeBridgeCredentialPath('/API/OPENCLAW-OLLAMA/api/tags?refresh=true')).toBe(true);
    expect(runtimeBridgeCredentialPath('/api/openclaw-ollama-evil/api/tags')).toBe(false);
  });

  it('allows default loopback-host API requests from loopback', async () => {
    await request(app)
      .post('/api/chat')
      .set('Host', '127.0.0.1:3080')
      .send({ message: 'hello' })
      .expect(200);
  });

  it('protects the MCP endpoint on public hosts', async () => {
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
      .expect(403);
  });

  it('fails closed for remote MCP traffic and admits both scoped token transports', async () => {
    app.locals.forcedIp = '198.51.100.20';
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';

    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .expect(403);

    process.env.AGENTX_MCP_TOKEN = 'mcp-token';
    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-MCP-Token', 'wrong-token')
      .expect(403);
    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer mcp-token')
      .expect(200);
    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-MCP-Token', 'mcp-token')
      .expect(200);
    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('Authorization', 'Bearer unrelated-token')
      .set('X-AgentX-MCP-Token', 'mcp-token')
      .expect(200);
  });

  it('preserves trusted local and remote operator access to the MCP boundary', async () => {
    await request(app)
      .post('/mcp')
      .set('Host', '127.0.0.1:3080')
      .expect(200);

    app.locals.forcedIp = '198.51.100.20';
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    await request(app)
      .post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Operator-Token', 'operator-token')
      .expect(200);
  });

  it('leaves non-API health checks open on public hosts', async () => {
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    await request(app)
      .get('/health')
      .set('Host', 'agentx.example.test')
      .expect(200);
  });

  it('honors additional public hosts from AGENTX_PUBLIC_HOSTS', async () => {
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';

    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'agentx.example.test')
      .expect(403);
  });

  it('blocks an unconfigured hostname even when it resolves to loopback', async () => {
    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'unconfigured.example.test')
      .set('Origin', 'http://unconfigured.example.test')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(403);
  });

  it('requires a token for an explicitly configured remote UI host', async () => {
    process.env.CORE_PUBLIC_URL = 'http://192.0.2.99:3080';
    app.locals.forcedIp = '192.0.2.10';

    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', '192.0.2.99:3080')
      .expect(403);
    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', '192.0.2.99:3080')
      .set('Origin', 'http://192.0.2.99:3080')
      .set('Sec-Fetch-Site', 'same-origin')
      .expect(403);

    process.env.AGENTX_OPERATOR_TOKEN = 'operator-token';
    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', '192.0.2.99:3080')
      .set('X-AgentX-Operator-Token', 'operator-token')
      .expect(200);
  });

  it('admits headerless tooling only through the explicit loopback-published bridge', async () => {
    app.locals.forcedIp = '192.0.2.10';
    process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI = 'true';

    for (const host of ['127.0.0.1:3180', 'localhost:3180']) {
      await request(app)
        .get('/api/nerve-center/status')
        .set('Host', host)
        .set('Sec-Fetch-Mode', 'cors')
        .expect(200);
    }

    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'unconfigured.example.test:3180')
      .expect(403);
    await request(app)
      .post('/api/chat')
      .set('Host', '127.0.0.1:3180')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ message: 'browser request' })
      .expect(403);
  });

  it('blocks cross-site browser requests even when their target Host is loopback', async () => {
    await request(app)
      .post('/api/chat')
      .set('Host', '127.0.0.1:3080')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ message: 'hello' })
      .expect(403);
  });

  it('blocks case-variant API paths with the same browser boundary', async () => {
    await request(app)
      .post('/API/Chat')
      .set('Host', '127.0.0.1:3080')
      .set('Origin', 'https://evil.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ message: 'hello' })
      .expect(403);
  });

  it('allows bounded internal container calls without making that hostname browser-trusted', async () => {
    app.locals.forcedIp = '172.20.0.12';
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';

    await request(app)
      .post('/api/chat')
      .set('Host', 'core:3080')
      .send({ message: 'service request' })
      .expect(200);

    await request(app)
      .post('/api/chat')
      .set('Host', 'core:3080')
      .set('Origin', 'https://attacker.example')
      .set('Sec-Fetch-Site', 'cross-site')
      .send({ message: 'browser request' })
      .expect(403);
  });

  it('does not treat arbitrary headerless remote hostnames as internal services', async () => {
    app.locals.forcedIp = '172.20.0.12';
    await request(app)
      .get('/api/nerve-center/status')
      .set('Host', 'attacker.example:3080')
      .expect(403);
  });

  it('admits each configured machine credential only on its owned route family', async () => {
    app.locals.forcedIp = '192.0.2.10';
    process.env.AGENTX_PUBLIC_HOSTS = 'agentx.example.test';
    process.env.AGENTX_MCP_TOKEN = 'mcp-token';
    process.env.AGENTX_CODEX_USAGE_TOKEN = 'usage-token';
    process.env.AGENTX_PLATFORM_EVENT_TOKEN = 'event-token';
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-token';
    process.env.AGENTX_MEMORY_REVIEW_TOKEN = 'memory-token';
    process.env.AGENTX_SCHEDULE_TOKEN = 'schedule-token';
    process.env.AGENTX_PIPELINE_TOKEN = 'pipeline-token';
    process.env.AGENTX_ALERT_DELIVERY_TOKEN = 'alert-token';

    await request(app).post('/mcp')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-MCP-Token', 'mcp-token')
      .expect(200);
    await request(app).post('/api/analytics/codex-usage')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Codex-Usage-Token', 'usage-token')
      .expect(200);
    await request(app).post('/api/platform-events')
      .set('Host', 'agentx.example.test')
      .set('X-Platform-Event-Token', 'event-token')
      .expect(200);
    await request(app).post('/api/inference/generate')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Benchmark-Token', 'benchmark-token')
      .expect(200);
    await request(app).post('/api/memory-review/runs')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Memory-Review-Token', 'memory-token')
      .expect(200);
    await request(app).get('/api/memory-review/runs/run-1/synthesis-input')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Memory-Review-Token', 'memory-token')
      .expect(200);
    await request(app).post('/api/cluster/schedule/claim')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Schedule-Token', 'schedule-token')
      .expect(200);
    await request(app).post('/api/pipeline/tasks/task-1/claim')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .expect(200);
    await request(app).get('/api/pipeline/tasks/next')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .expect(200);
    await request(app).get('/api/pipeline/tasks/task-1/worker')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .expect(200);
    await request(app).post('/api/todos')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .expect(200);
    await request(app).post('/api/alerts/alert-1/delivery-status')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Alert-Delivery-Token', 'alert-token')
      .expect(200);

    await request(app).post('/api/chat')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-MCP-Token', 'mcp-token')
      .expect(403);
    await request(app).post('/api/chat')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Benchmark-Token', 'benchmark-token')
      .expect(403);
    await request(app).post('/api/pipeline/tasks/task-1/status')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Schedule-Token', 'schedule-token')
      .expect(403);
    await request(app).post('/api/memory-review/runs/run-1/observations')
      .set('Host', 'agentx.example.test')
      .set('X-AgentX-Pipeline-Token', 'pipeline-token')
      .expect(403);
  });

  it('limits the Benchmark model-registry credential to collection and one-model reads', () => {
    expect(benchmarkCredentialPath('/api/models/registry', 'GET')).toBe(true);
    expect(benchmarkCredentialPath('/API/MODELS/REGISTRY/owner%2Fmodel%3A8b', 'GET')).toBe(true);

    expect(benchmarkCredentialPath('/api/models/registry/stats', 'GET')).toBe(false);
    expect(benchmarkCredentialPath('/api/models/registry/grouped', 'GET')).toBe(false);
    expect(benchmarkCredentialPath('/api/models/registry/model/context-info', 'GET')).toBe(false);
    expect(benchmarkCredentialPath('/api/models/registry/model/execution-config', 'GET')).toBe(false);
    expect(benchmarkCredentialPath('/api/models/registry/model', 'POST')).toBe(false);
  });
});
