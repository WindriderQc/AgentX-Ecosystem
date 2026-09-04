'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/profiler/hostProfileService', () => ({
  getById: jest.fn(),
  checkStatus: jest.fn(),
  updateStatus: jest.fn(),
  upsert: jest.fn(),
  updateBaseline: jest.fn(),
  releaseModel: jest.fn(),
}));
jest.mock('../../src/services/hostTestService', () => ({
  testModelOnHost: jest.fn(),
  testAllModelsOnHost: jest.fn(),
  testModelAcrossHosts: jest.fn(),
  checkHost: jest.fn(),
  getConfig: jest.fn(() => ({}))
}));
jest.mock('../../src/services/profiler/baselineModelService', () => ({
  resolveConfiguredHost: jest.fn(() => ({ id: 'primary', url: 'http://localhost:11434' })),
  getBaselineModel: jest.fn(async () => 'baseline:model'),
  ensureBaselineModel: jest.fn(async () => ({ hostUrl: 'http://localhost:11434', pulled: false }))
}));
jest.mock('../../src/services/profiler/profilerClaimLifecycle', () => ({
  acquireProfilerClaimLease: jest.fn()
}));

const hostProfileService = require('../../src/services/profiler/hostProfileService');
const { testModelOnHost } = require('../../src/services/hostTestService');
const { acquireProfilerClaimLease } = require('../../src/services/profiler/profilerClaimLifecycle');
const router = require('../../routes/profiler/hosts');

const app = express();
app.use(express.json());
app.use('/api/profiler/hosts', router);

describe('Profiler host status read/refresh split', () => {
  let lease;

  beforeEach(() => {
    jest.clearAllMocks();
    lease = {
      signal: new AbortController().signal,
      assertActive: jest.fn(() => true),
      identityFor: jest.fn(() => ({ claimBatchId: 'profile-test', claimGeneration: 'generation-1' })),
      abandoned: false,
      abandon: jest.fn(async () => { lease.abandoned = true; }),
      finalize: jest.fn(async () => {
        if (lease.abandoned) {
          throw Object.assign(new Error('held for TTL recovery'), { code: 'PROFILER_RUNTIME_RESTORE_FAILED' });
        }
        return {
          failed: 0,
          details: [{
            released: true,
            runtimeRestore: { verified: true, status: 'ready', mode: 'exact_runtime_snapshot' }
          }]
        };
      })
    };
    acquireProfilerClaimLease.mockResolvedValue(lease);
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      lastSeenAt: new Date('2026-08-28T00:00:00.000Z'),
      dedicated: null,
    });
  });

  test('GET returns stored evidence without probing or writing', async () => {
    const response = await request(app).get('/api/profiler/hosts/primary/status');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('online');
    expect(hostProfileService.checkStatus).not.toHaveBeenCalled();
    expect(hostProfileService.updateStatus).not.toHaveBeenCalled();
    expect(hostProfileService.upsert).not.toHaveBeenCalled();
  });

  test('POST refresh owns the live probe and evidence update', async () => {
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    hostProfileService.updateStatus.mockResolvedValue();
    hostProfileService.upsert.mockResolvedValue();

    const response = await request(app).post('/api/profiler/hosts/primary/status/refresh');

    expect(response.status).toBe(200);
    expect(hostProfileService.checkStatus).toHaveBeenCalledWith('http://localhost:11434');
    expect(hostProfileService.updateStatus).toHaveBeenCalledWith('primary', 'online');
    expect(hostProfileService.upsert).toHaveBeenCalled();
  });

  test('persists the released projection under the lease before final release', async () => {
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      dedicated: { model: 'qwen:7b', expiresAt: new Date('2099-01-01T00:00:00.000Z') }
    });
    hostProfileService.releaseModel.mockResolvedValue({ success: true });
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    hostProfileService.upsert.mockResolvedValue({ status: 'online' });

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(200);
    expect(hostProfileService.upsert).toHaveBeenCalledWith({
      hostId: 'primary',
      status: 'online',
      dedicated: null
    }, {
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    expect(hostProfileService.upsert.mock.invocationCallOrder[0])
      .toBeLessThan(lease.finalize.mock.invocationCallOrder[0]);
    expect(lease.finalize).toHaveBeenCalledWith({
      byHost: {
        'http://localhost:11434': { excludedModels: ['qwen:7b'] }
      }
    });
  });

  test('compensates an ambiguous projection write before restoring and releasing the lease', async () => {
    const priorDedicated = { model: 'qwen:7b', expiresAt: new Date('2099-01-01T00:00:00.000Z') };
    let storedProjection = { status: 'online', dedicated: priorDedicated };
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      dedicated: priorDedicated
    });
    hostProfileService.releaseModel.mockResolvedValue({ success: true });
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    hostProfileService.upsert
      .mockImplementationOnce(async data => {
        storedProjection = { status: data.status, dedicated: data.dedicated };
        throw new Error('ambiguous projection acknowledgement');
      })
      .mockImplementationOnce(async data => {
        storedProjection = { status: data.status, dedicated: data.dedicated };
        return data;
      });

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(500);
    expect(storedProjection).toEqual({ status: 'online', dedicated: priorDedicated });
    expect(hostProfileService.upsert).toHaveBeenNthCalledWith(2, {
      hostId: 'primary',
      status: 'online',
      dedicated: priorDedicated
    }, {
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    expect(hostProfileService.upsert.mock.invocationCallOrder[1])
      .toBeLessThan(lease.finalize.mock.invocationCallOrder[0]);
    expect(lease.finalize).toHaveBeenCalledWith();
  });

  test('retracts an ambiguously committed baseline when lease authority is lost after write', async () => {
    const priorBaseline = { referenceModel: 'old:model', tokensPerSec: 10 };
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      baseline: priorBaseline,
      dedicated: null
    });
    testModelOnHost.mockResolvedValue({
      status: 'pass',
      tokensPerSec: 40,
      latencyMs: 1000,
      timeToFirstTokenMs: 50,
      ttftMeasurement: 'streamed_wall_clock',
      testedAt: new Date('2026-09-04T00:00:00.000Z')
    });
    let authorityLost = false;
    const lost = Object.assign(new Error('baseline claim lost after write'), { code: 'BENCHMARK_CLAIM_LOST' });
    lease.assertActive.mockImplementation(() => {
      if (authorityLost) throw lost;
      return true;
    });
    hostProfileService.updateBaseline.mockImplementation(async () => {
      authorityLost = true;
      return { baseline: { referenceModel: 'baseline:model' } };
    });
    hostProfileService.upsert.mockResolvedValue({ baseline: priorBaseline });

    const response = await request(app)
      .post('/api/profiler/hosts/test/run')
      .send({ modelName: 'baseline:model', hostId: 'primary' });

    expect(response.status).toBe(500);
    expect(hostProfileService.updateBaseline).toHaveBeenCalledWith(
      'primary',
      expect.objectContaining({ referenceModel: 'baseline:model', tokensPerSec: 40 }),
      { signal: lease.signal, assertAuthorityActive: lease.assertActive }
    );
    expect(hostProfileService.upsert).toHaveBeenCalledWith({
      hostId: 'primary',
      baseline: priorBaseline
    });
    expect(lease.finalize).toHaveBeenCalled();
  });

  test('holds the lease for TTL recovery when release projection compensation fails', async () => {
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      dedicated: { model: 'qwen:7b', expiresAt: new Date('2099-01-01T00:00:00.000Z') }
    });
    hostProfileService.releaseModel.mockResolvedValue({ success: true });
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    const compensationFailure = new Error('projection compensation unavailable');
    hostProfileService.upsert
      .mockRejectedValueOnce(new Error('ambiguous projection acknowledgement'))
      .mockRejectedValueOnce(compensationFailure);

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(500);
    expect(lease.abandon).toHaveBeenCalledWith(compensationFailure);
    expect(lease.abandoned).toBe(true);
    expect(lease.finalize).toHaveBeenCalled();
  });

  test('holds the lease for TTL recovery when baseline projection compensation fails', async () => {
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      baseline: { referenceModel: 'old:model', tokensPerSec: 10 },
      dedicated: null
    });
    testModelOnHost.mockResolvedValue({
      status: 'pass',
      tokensPerSec: 40,
      latencyMs: 1000,
      timeToFirstTokenMs: 50,
      testedAt: new Date('2026-09-04T00:00:00.000Z')
    });
    let authorityLost = false;
    lease.assertActive.mockImplementation(() => {
      if (authorityLost) throw new Error('baseline claim lost after write');
      return true;
    });
    hostProfileService.updateBaseline.mockImplementation(async () => {
      authorityLost = true;
      return { baseline: { referenceModel: 'baseline:model' } };
    });
    const compensationFailure = new Error('baseline compensation unavailable');
    hostProfileService.upsert.mockRejectedValue(compensationFailure);

    const response = await request(app)
      .post('/api/profiler/hosts/test/run')
      .send({ modelName: 'baseline:model', hostId: 'primary' });

    expect(response.status).toBe(500);
    expect(lease.abandon).toHaveBeenCalledWith(compensationFailure);
    expect(lease.abandoned).toBe(true);
    expect(lease.finalize).toHaveBeenCalled();
  });
});
