'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../../src/services/profiler/profilerOrchestrator', () => ({
  profile: jest.fn().mockResolvedValue({ ok: true }),
  scout: jest.fn().mockResolvedValue([]),
  fullPipeline: jest.fn().mockResolvedValue([])
}));
jest.mock('../../../src/services/profiler/hostProfileService', () => ({
  getById: jest.fn(),
  getAll: jest.fn()
}));
jest.mock('../../../src/services/profiler/modelProfileService', () => ({
  getAll: jest.fn()
}));
jest.mock('../../../src/services/hostTestService', () => ({
  checkHost: jest.fn()
}));
jest.mock('../../../src/clients/coreApiClient', () => ({
  acquireWorkloadAdmission: jest.fn().mockResolvedValue({ acquired: true }),
  heartbeatWorkloadAdmission: jest.fn().mockResolvedValue({ heartbeat: true }),
  releaseWorkloadAdmission: jest.fn().mockResolvedValue({ released: true }),
  getDedicationStatuses: jest.fn().mockResolvedValue([]),
  resolveHostKey: jest.fn(),
  restoreDedication: jest.fn().mockResolvedValue(undefined),
  claimHostForBenchmark: jest.fn().mockResolvedValue({ claimed: true }),
  heartbeatBenchmarkClaim: jest.fn().mockResolvedValue({ heartbeat: true }),
  releaseBenchmarkClaim: jest.fn().mockResolvedValue({ released: true }),
  getBenchmarkClaimIdentity: jest.fn((_host, batchId) => ({ claimBatchId: batchId, claimGeneration: 'generation-1' }))
}));
jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));

const orchestrator = require('../../../src/services/profiler/profilerOrchestrator');
const hostProfileService = require('../../../src/services/profiler/hostProfileService');
const modelProfileService = require('../../../src/services/profiler/modelProfileService');
const hostTestService = require('../../../src/services/hostTestService');
const coreApiClient = require('../../../src/clients/coreApiClient');
const { activeProfileQueues, clearActiveProfilingState } = require('../../../src/services/profiler/activeProfileState');
const { startProfileHostQueue } = require('../../../routes/profiler/pipeline');
const pipelineRouter = require('../../../routes/profiler/pipeline');

const pipelineApp = express();
pipelineApp.use(express.json());
pipelineApp.use('/api/profiler/pipeline', pipelineRouter);

const flushPromises = () => new Promise(resolve => setImmediate(resolve));

describe('profile-host queue depth selection', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearActiveProfilingState();
    hostProfileService.getById.mockResolvedValue({
      hostId: 'host-beta',
      hostUrl: 'http://localhost:11434',
      displayName: 'Example Host'
    });
    hostProfileService.getAll.mockResolvedValue([{ hostId: 'host-beta', hostUrl: 'http://localhost:11434', status: 'online' }]);
    hostTestService.checkHost.mockResolvedValue({
      available: true,
      models: ['llama3:8b']
    });
    modelProfileService.getAll.mockResolvedValue([]);
    orchestrator.profile.mockResolvedValue({ ok: true });
    coreApiClient.acquireWorkloadAdmission.mockResolvedValue({ acquired: true });
    coreApiClient.heartbeatWorkloadAdmission.mockResolvedValue({ heartbeat: true });
    coreApiClient.releaseWorkloadAdmission.mockResolvedValue({ released: true });
  });

  afterEach(() => {
    clearActiveProfilingState();
  });

  it('defaults a per-host profile queue to standard depth', async () => {
    const started = await startProfileHostQueue({ hostId: 'host-beta', skipRecentDays: 0 });

    expect(started.depth).toBe('standard');
    expect(activeProfileQueues.get(started.queueId).depth).toBe('standard');

    await flushPromises();
    expect(orchestrator.profile).toHaveBeenCalledWith(
      'llama3:8b',
      'host-beta',
      'http://localhost:11434',
      'standard',
      expect.any(Object)
    );
  });

  it('fails closed before queue start when the host claim is rejected', async () => {
    coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: false, reason: 'benchmark batch-42 holds this host' });

    await expect(startProfileHostQueue({ hostId: 'host-beta', skipRecentDays: 0 }))
      .rejects.toMatchObject({ code: 'PROFILER_CLAIM_UNAVAILABLE' });
    expect(orchestrator.profile).not.toHaveBeenCalled();
    expect(coreApiClient.releaseBenchmarkClaim).not.toHaveBeenCalled();
  });

  it('fails closed when the claim call itself fails (core unreachable)', async () => {
    coreApiClient.claimHostForBenchmark.mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(startProfileHostQueue({ hostId: 'host-beta', skipRecentDays: 0 }))
      .rejects.toMatchObject({ code: 'PROFILER_CLAIM_UNAVAILABLE', statusCode: 503 });
    expect(orchestrator.profile).not.toHaveBeenCalled();
    expect(coreApiClient.releaseBenchmarkClaim).not.toHaveBeenCalled();
  });

  it('releases the claim after a claimed profile completes', async () => {
    coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: true });

    const started = await startProfileHostQueue({ hostId: 'host-beta', skipRecentDays: 0 });
    await flushPromises();

    const tracker = activeProfileQueues.get(started.queueId);
    expect(tracker.models[0].status).toBe('completed');
    expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalledWith('http://localhost:11434', expect.stringMatching(/^profiler-queue-/));
  });

  it('honors explicit full depth for a per-host profile queue', async () => {
    const started = await startProfileHostQueue({ hostId: 'host-beta', depth: 'full', skipRecentDays: 0 });

    expect(started.depth).toBe('full');

    await flushPromises();
    expect(orchestrator.profile).toHaveBeenCalledWith(
      'llama3:8b',
      'host-beta',
      'http://localhost:11434',
      'full',
      expect.any(Object)
    );
  });
});

describe('full pipeline claim and depth contract', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hostProfileService.getAll.mockResolvedValue([{ hostId: 'host-beta', hostUrl: 'http://localhost:11434', status: 'online' }]);
    coreApiClient.claimHostForBenchmark.mockResolvedValue({ claimed: true });
    coreApiClient.heartbeatBenchmarkClaim.mockResolvedValue({ heartbeat: true });
    coreApiClient.releaseBenchmarkClaim.mockResolvedValue({ released: true });
    coreApiClient.acquireWorkloadAdmission.mockResolvedValue({ acquired: true });
    coreApiClient.heartbeatWorkloadAdmission.mockResolvedValue({ heartbeat: true });
    coreApiClient.releaseWorkloadAdmission.mockResolvedValue({ released: true });
  });
  it('claims every online host and delegates to the Full pipeline', async () => {
    const response = await request(pipelineApp)
      .post('/api/profiler/pipeline/full')
      .send({ modelName: 'qwen:7b' });

    expect(response.status).toBe(200);
    expect(orchestrator.fullPipeline).toHaveBeenCalledWith(
      'qwen:7b',
      [expect.objectContaining({ hostId: 'host-beta' })],
      expect.objectContaining({ assertClaimActive: expect.any(Function), claimIdentityFor: expect.any(Function) })
    );
    expect(coreApiClient.releaseBenchmarkClaim).toHaveBeenCalled();
  });
});

describe('profiler scout target authority', () => {
  it('ignores a client-supplied URL and resolves the admitted persisted host by ID', async () => {
    hostProfileService.getById.mockResolvedValue({
      hostId: 'host-beta',
      hostUrl: 'http://localhost:11434'
    });
    orchestrator.scout.mockResolvedValue([{ hostId: 'host-beta', fit: true }]);

    const response = await request(pipelineApp)
      .post('/api/profiler/pipeline/scout')
      .send({
        modelName: 'qwen:7b',
        hosts: [{ hostId: 'host-beta', hostUrl: 'http://169.254.169.254:11434' }]
      });

    expect(response.status).toBe(200);
    expect(orchestrator.scout).toHaveBeenCalledWith('qwen:7b', [{
      hostId: 'host-beta',
      hostUrl: 'http://localhost:11434'
    }], expect.any(Object));
  });
});
