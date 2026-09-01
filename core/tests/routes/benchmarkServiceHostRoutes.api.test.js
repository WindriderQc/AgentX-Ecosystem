'use strict';

const originalOllamaHost = process.env.OLLAMA_HOST;
process.env.OLLAMA_HOST = 'http://primary:11434';

const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../src/services/modelRouterConfig', () => ({ HOSTS: {}, TASK_MODELS: {} }));
jest.mock('../../src/services/hostPreferenceService', () => ({
  claimBenchmark: jest.fn(),
  heartbeatBenchmarkClaim: jest.fn(),
  releaseBenchmarkClaim: jest.fn(),
  getByHost: jest.fn(),
  getPinnedEntries: jest.fn(pref => pref?.pinnedModels || []),
  warmHost: jest.fn()
}));
jest.mock('../../src/services/buddyEvents', () => ({ emit: jest.fn() }));

const hostPrefService = require('../../src/services/hostPreferenceService');
const hostPreferenceRoutes = require('../../routes/nerve-center-host-preferences');

const originalBenchmarkToken = process.env.AGENTX_BENCHMARK_TOKEN;
const originalInternalTrust = process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
const HOST_URL = 'http://primary:11434';
const ENCODED_HOST = encodeURIComponent(HOST_URL);

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/api/nerve-center', hostPreferenceRoutes);

const ROUTES = [
  {
    label: 'claim acquisition',
    method: 'post',
    path: `/api/nerve-center/host-preferences/${ENCODED_HOST}/benchmark-claim`,
    body: { batchId: 'batch-1', claimGeneration: '11111111-1111-4111-8111-111111111111' },
    sideEffects: [hostPrefService.claimBenchmark]
  },
  {
    label: 'claim heartbeat',
    method: 'post',
    path: `/api/nerve-center/host-preferences/${ENCODED_HOST}/benchmark-claim/batch-1/heartbeat`,
    body: {
      claimGeneration: '11111111-1111-4111-8111-111111111111',
      estimatedDurationMs: 60000
    },
    sideEffects: [hostPrefService.heartbeatBenchmarkClaim]
  },
  {
    label: 'claim release',
    method: 'delete',
    path: `/api/nerve-center/host-preferences/${ENCODED_HOST}/benchmark-claim/batch-1`,
    body: { claimGeneration: '11111111-1111-4111-8111-111111111111' },
    sideEffects: [hostPrefService.releaseBenchmarkClaim]
  },
  {
    label: 'host reload',
    method: 'post',
    path: `/api/nerve-center/host-preferences/${ENCODED_HOST}/reload`,
    sideEffects: [hostPrefService.getByHost, hostPrefService.warmHost]
  }
];

function machineRequest(routeCase, token) {
  let pending = request(app)[routeCase.method](routeCase.path)
    .set('Host', 'remote-benchmark.example')
    .set('X-Forwarded-For', '203.0.113.20');
  if (token !== undefined) pending = pending.set('X-AgentX-Benchmark-Token', token);
  if (routeCase.body !== undefined) pending = pending.send(routeCase.body);
  return pending;
}

describe('Benchmark service identity on Core host-control routes', () => {
  beforeAll(() => {
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';
  });

  afterAll(() => {
    if (originalBenchmarkToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = originalBenchmarkToken;
    if (originalInternalTrust === undefined) delete process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
    else process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = originalInternalTrust;
    if (originalOllamaHost === undefined) delete process.env.OLLAMA_HOST;
    else process.env.OLLAMA_HOST = originalOllamaHost;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    hostPrefService.claimBenchmark.mockResolvedValue({ claimed: true });
    hostPrefService.heartbeatBenchmarkClaim.mockResolvedValue({ heartbeat: true });
    hostPrefService.releaseBenchmarkClaim.mockResolvedValue({ released: true });
    hostPrefService.getByHost.mockResolvedValue({
      displayName: 'Primary',
      pinnedModels: [{ model: 'model-a' }]
    });
    hostPrefService.getPinnedEntries.mockImplementation(pref => pref?.pinnedModels || []);
    hostPrefService.warmHost.mockResolvedValue([{ model: 'model-a', status: 'loaded' }]);
  });

  test.each(ROUTES)('$label accepts the exact Benchmark service token', async (routeCase) => {
    const response = await machineRequest(routeCase, 'benchmark-secret');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('success');
    for (const sideEffect of routeCase.sideEffects) expect(sideEffect).toHaveBeenCalled();
  });

  test.each(ROUTES)('$label rejects a missing token before side effects', async (routeCase) => {
    const response = await machineRequest(routeCase);

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('BENCHMARK_SERVICE_ACCESS_REQUIRED');
    for (const sideEffect of routeCase.sideEffects) expect(sideEffect).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('$label rejects a wrong token before side effects', async (routeCase) => {
    const response = await machineRequest(routeCase, 'wrong-secret');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('BENCHMARK_SERVICE_ACCESS_REQUIRED');
    for (const sideEffect of routeCase.sideEffects) expect(sideEffect).not.toHaveBeenCalled();
  });

  it('preserves the explicit trusted internal-machine path', async () => {
    delete process.env.AGENTX_BENCHMARK_TOKEN;
    const claimRoute = ROUTES[0];
    const response = await request(app)[claimRoute.method](claimRoute.path)
      .set('Host', 'core:3080')
      .set('X-Forwarded-For', '172.30.0.8')
      .send(claimRoute.body);

    expect(response.status).toBe(200);
    expect(hostPrefService.claimBenchmark).toHaveBeenCalled();
    process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
  });

  it('preserves same-origin UI access to host reload without the Benchmark token', async () => {
    const response = await request(app)
      .post(`/api/nerve-center/host-preferences/${ENCODED_HOST}/reload`)
      .set('Host', '127.0.0.1:3180')
      .set('Origin', 'http://127.0.0.1:3180')
      .set('Sec-Fetch-Site', 'same-origin')
      .set('X-Forwarded-For', '127.0.0.1');

    expect(response.status).toBe(200);
    expect(hostPrefService.warmHost).toHaveBeenCalledWith(HOST_URL);
  });
});
