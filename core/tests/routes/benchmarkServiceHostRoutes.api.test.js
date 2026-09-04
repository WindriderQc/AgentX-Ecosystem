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
jest.mock('../../src/services/runtimeCoordinationService', () => ({
  acquireWorkload: jest.fn(),
  heartbeat: jest.fn(),
  release: jest.fn(),
  acquireMaintenance: jest.fn(),
  listActive: jest.fn()
}));

const hostPrefService = require('../../src/services/hostPreferenceService');
const runtimeCoordinationService = require('../../src/services/runtimeCoordinationService');
const hostPreferenceRoutes = require('../../routes/nerve-center-host-preferences');

const originalBenchmarkToken = process.env.AGENTX_BENCHMARK_TOKEN;
const originalOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;
const originalInternalTrust = process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS;
const HOST_URL = 'http://primary:11434';
const ENCODED_HOST = encodeURIComponent(HOST_URL);

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use('/api/nerve-center', hostPreferenceRoutes);

const ROUTES = [
  {
    label: 'runtime workload admission',
    method: 'post',
    path: '/api/nerve-center/workload-admissions',
    body: {
      requestId: 'request-batch-1',
      workloadId: 'batch-1',
      kind: 'benchmark',
      generation: 'client-must-not-control-this'
    },
    expectedMissingCode: 'BENCHMARK_COORDINATION_AUTH_REQUIRED',
    sideEffects: [runtimeCoordinationService.acquireWorkload]
  },
  {
    label: 'runtime workload heartbeat',
    method: 'post',
    path: '/api/nerve-center/workload-admissions/admission-core/heartbeat',
    body: { generation: 'generation-core', ttlMs: 60_000 },
    expectedMissingCode: 'BENCHMARK_COORDINATION_AUTH_REQUIRED',
    sideEffects: [runtimeCoordinationService.heartbeat]
  },
  {
    label: 'runtime workload release',
    method: 'delete',
    path: '/api/nerve-center/workload-admissions/admission-core',
    body: { generation: 'generation-core' },
    expectedMissingCode: 'BENCHMARK_COORDINATION_AUTH_REQUIRED',
    sideEffects: [runtimeCoordinationService.release]
  },
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
    process.env.AGENTX_OPERATOR_TOKEN = 'operator-secret';
    process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS = 'true';
  });

  afterAll(() => {
    if (originalBenchmarkToken === undefined) delete process.env.AGENTX_BENCHMARK_TOKEN;
    else process.env.AGENTX_BENCHMARK_TOKEN = originalBenchmarkToken;
    if (originalOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalOperatorToken;
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
    runtimeCoordinationService.acquireWorkload.mockResolvedValue({
      acquired: true,
      admissionId: 'admission-core',
      generation: 'generation-core',
      principal: 'benchmark-service',
      requestId: 'request-batch-1',
      workloadId: 'batch-1',
      kind: 'benchmark',
      batchId: null
    });
    runtimeCoordinationService.heartbeat.mockResolvedValue({
      heartbeat: true,
      admissionId: 'admission-core',
      generation: 'generation-core',
      principal: 'benchmark-service',
      requestId: 'request-batch-1',
      workloadId: 'batch-1',
      kind: 'benchmark',
      batchId: null,
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    });
    runtimeCoordinationService.release.mockResolvedValue({
      released: true,
      admissionId: 'admission-core',
      generation: 'generation-core',
      principal: 'benchmark-service',
      requestId: 'request-batch-1',
      workloadId: 'batch-1',
      kind: 'benchmark',
      batchId: null,
      releasedAt: new Date()
    });
    runtimeCoordinationService.acquireMaintenance.mockResolvedValue({
      acquired: true,
      leaseId: 'lease-core',
      generation: 'maintenance-generation-core',
      principal: 'operator-token',
      requestId: 'deploy-request-1',
      scope: 'force-recreate',
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    });
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
    expect(response.body.code).toBe(routeCase.expectedMissingCode || 'BENCHMARK_SERVICE_ACCESS_REQUIRED');
    for (const sideEffect of routeCase.sideEffects) expect(sideEffect).not.toHaveBeenCalled();
  });

  test.each(ROUTES)('$label rejects a wrong token before side effects', async (routeCase) => {
    const response = await machineRequest(routeCase, 'wrong-secret');

    expect(response.status).toBe(403);
    expect(response.body.code).toBe(routeCase.expectedMissingCode || 'BENCHMARK_SERVICE_ACCESS_REQUIRED');
    for (const sideEffect of routeCase.sideEffects) expect(sideEffect).not.toHaveBeenCalled();
  });

  it('preserves the explicit trusted internal-machine path', async () => {
    delete process.env.AGENTX_BENCHMARK_TOKEN;
    try {
      const claimRoute = ROUTES.find(item => item.label === 'claim acquisition');
      const response = await request(app)[claimRoute.method](claimRoute.path)
        .set('Host', 'core:3080')
        .set('X-Forwarded-For', '172.30.0.8')
        .send(claimRoute.body);

      expect(response.status).toBe(200);
      expect(hostPrefService.claimBenchmark).toHaveBeenCalled();
    } finally {
      process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
    }
  });

  it('derives workload principal from Benchmark auth and ignores client generation', async () => {
    const routeCase = ROUTES.find(item => item.label === 'runtime workload admission');
    const response = await machineRequest(routeCase, 'benchmark-secret');
    expect(response.status).toBe(200);
    expect(runtimeCoordinationService.acquireWorkload).toHaveBeenCalledWith({
      principal: 'benchmark-service',
      requestId: 'request-batch-1',
      workloadId: 'batch-1',
      kind: 'benchmark',
      batchId: undefined,
      hosts: undefined,
      ttl: undefined
    });
    expect(response.body.data.generation).toBe('generation-core');
  });

  it('binds workload heartbeat and release to the authenticated Benchmark principal and exact proof', async () => {
    const heartbeatRoute = ROUTES.find(item => item.label === 'runtime workload heartbeat');
    const releaseRoute = ROUTES.find(item => item.label === 'runtime workload release');

    const heartbeatResponse = await machineRequest(heartbeatRoute, 'benchmark-secret');
    expect(heartbeatResponse.body.data).toMatchObject({
      heartbeat: true,
      admissionId: 'admission-core',
      generation: 'generation-core',
      principal: 'benchmark-service',
      requestId: 'request-batch-1',
      workloadId: 'batch-1'
    });
    expect(runtimeCoordinationService.heartbeat).toHaveBeenCalledWith('workload', {
      id: 'admission-core',
      generation: 'generation-core',
      principal: 'benchmark-service',
      ttl: 60_000
    });

    const releaseResponse = await machineRequest(releaseRoute, 'benchmark-secret');
    expect(releaseResponse.body.data).toMatchObject({
      released: true,
      admissionId: 'admission-core',
      generation: 'generation-core',
      principal: 'benchmark-service',
      requestId: 'request-batch-1',
      workloadId: 'batch-1'
    });
    expect(runtimeCoordinationService.release).toHaveBeenCalledWith('workload', {
      id: 'admission-core',
      generation: 'generation-core',
      principal: 'benchmark-service'
    });
  });

  it('does not grant workload admission to the secret-free trusted-machine fallback', async () => {
    delete process.env.AGENTX_BENCHMARK_TOKEN;
    try {
      const routeCase = ROUTES.find(item => item.label === 'runtime workload admission');
      const response = await request(app)[routeCase.method](routeCase.path)
        .set('Host', 'core:3080')
        .set('X-Forwarded-For', '172.30.0.8')
        .send(routeCase.body);
      expect(response.status).toBe(403);
      expect(runtimeCoordinationService.acquireWorkload).not.toHaveBeenCalled();
    } finally {
      process.env.AGENTX_BENCHMARK_TOKEN = 'benchmark-secret';
    }
  });

  it('returns identity-bound maintenance acquire, heartbeat, and release receipts from Core state', async () => {
    const proof = {
      leaseId: 'lease-core',
      generation: 'maintenance-generation-core',
      principal: 'operator-token',
      requestId: 'deploy-request-1',
      scope: 'force-recreate'
    };
    runtimeCoordinationService.heartbeat.mockResolvedValueOnce({
      heartbeat: true,
      ...proof,
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000)
    });
    runtimeCoordinationService.release.mockResolvedValueOnce({
      released: true,
      ...proof,
      releasedAt: new Date()
    });

    const acquire = await request(app)
      .post('/api/nerve-center/maintenance-leases')
      .set('Host', 'remote-aiops.example')
      .set('X-Forwarded-For', '203.0.113.30')
      .set('Authorization', 'Bearer operator-secret')
      .send({ requestId: proof.requestId, scope: proof.scope, generation: 'client-forgery' });
    expect(acquire.status).toBe(200);
    expect(acquire.body.data).toMatchObject({ acquired: true, ...proof });
    expect(runtimeCoordinationService.acquireMaintenance).toHaveBeenCalledWith({
      principal: 'operator-token',
      requestId: proof.requestId,
      scope: proof.scope,
      ttl: undefined
    });

    const heartbeat = await request(app)
      .post(`/api/nerve-center/maintenance-leases/${proof.leaseId}/heartbeat`)
      .set('Host', 'remote-aiops.example')
      .set('X-Forwarded-For', '203.0.113.30')
      .set('Authorization', 'Bearer operator-secret')
      .send({ generation: proof.generation, ttlMs: 60_000 });
    expect(heartbeat.body.data).toMatchObject({ heartbeat: true, ...proof });

    const release = await request(app)
      .delete(`/api/nerve-center/maintenance-leases/${proof.leaseId}`)
      .set('Host', 'remote-aiops.example')
      .set('X-Forwarded-For', '203.0.113.30')
      .set('Authorization', 'Bearer operator-secret')
      .send({ generation: proof.generation });
    expect(release.body.data).toMatchObject({ released: true, ...proof });
    expect(Number.isFinite(Date.parse(release.body.data.releasedAt))).toBe(true);
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
