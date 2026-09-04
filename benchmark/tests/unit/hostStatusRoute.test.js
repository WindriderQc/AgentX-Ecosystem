'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/profiler/hostProfileService', () => ({
  getById: jest.fn(),
  checkStatus: jest.fn(),
  updateStatus: jest.fn(),
  upsert: jest.fn(),
  updateBaseline: jest.fn(),
  invalidateBaselineReceipt: jest.fn(),
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
const baselineModelService = require('../../src/services/profiler/baselineModelService');
const { acquireProfilerClaimLease } = require('../../src/services/profiler/profilerClaimLifecycle');
const router = require('../../routes/profiler/hosts');

const app = express();
app.use(express.json());
app.use('/api/profiler/hosts', router);

describe('Profiler host status read/refresh split', () => {
  let lease;

  beforeEach(() => {
    jest.clearAllMocks();
    hostProfileService.upsert.mockReset().mockResolvedValue({});
    hostProfileService.invalidateBaselineReceipt.mockResolvedValue({ invalidated: true });
    lease = {
      signal: new AbortController().signal,
      assertActive: jest.fn(() => true),
      identityFor: jest.fn(() => ({ claimBatchId: 'profile-test', claimGeneration: 'generation-1' })),
      abandoned: false,
      abandon: jest.fn(async () => { lease.abandoned = true; }),
      finalize: jest.fn(async (options = {}) => {
        if (lease.abandoned) {
          throw Object.assign(new Error('held for TTL recovery'), { code: 'PROFILER_RUNTIME_RESTORE_FAILED' });
        }
        const receipt = {
          failed: 0,
          details: [{
            released: true,
            runtimeRestore: { verified: true, status: 'ready', mode: 'exact_runtime_snapshot' },
            releaseReceipt: { contract: 'agentx.benchmark-claim-release/v1' }
          }]
      };
      if (typeof options.beforeWorkloadRelease === 'function') {
          try {
            await options.beforeWorkloadRelease(receipt);
          } catch (error) {
            error.retainAdmission = true;
            throw error;
          }
      }
        return receipt;
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
    hostProfileService.releaseModel.mockResolvedValue({
      success: true,
      serverTerminalObserved: true,
      serverTerminalAt: new Date('2026-09-04T00:00:00.000Z')
    });
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    hostProfileService.upsert.mockResolvedValue({ status: 'online' });

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(200);
    expect(hostProfileService.upsert).toHaveBeenNthCalledWith(1, expect.objectContaining({
      hostId: 'primary',
      reconciliation: expect.objectContaining({
        state: 'pending_reconciliation',
        operation: 'release_model',
        model: 'qwen:7b'
      })
    }), {
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    expect(hostProfileService.upsert).toHaveBeenNthCalledWith(2, expect.objectContaining({
      reconciliation: expect.objectContaining({
        state: 'pending_reconciliation',
        serverTerminalObserved: true
      })
    }), {
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    });
    expect(hostProfileService.upsert).toHaveBeenNthCalledWith(3, expect.objectContaining({
      hostId: 'primary',
      status: 'online',
      dedicated: null,
      reconciliation: expect.objectContaining({
        state: 'resolved',
        releaseReceipt: { contract: 'agentx.benchmark-claim-release/v1' }
      })
    }), { signal: lease.signal, assertAuthorityActive: lease.assertActive });
    expect(hostProfileService.upsert.mock.invocationCallOrder[0])
      .toBeLessThan(lease.finalize.mock.invocationCallOrder[0]);
    expect(lease.finalize).toHaveBeenCalledWith(expect.objectContaining({
      byHost: {
        'http://localhost:11434': { excludedModels: ['qwen:7b'] }
      },
      beforeWorkloadRelease: expect.any(Function)
    }));
  });

  test('does not mutate runtime when the durable reconciliation marker cannot be written', async () => {
    const priorDedicated = { model: 'qwen:7b', expiresAt: new Date('2099-01-01T00:00:00.000Z') };
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      dedicated: priorDedicated
    });
    hostProfileService.releaseModel.mockResolvedValue({ success: true, serverTerminalObserved: true });
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    hostProfileService.upsert
      .mockRejectedValueOnce(new Error('ambiguous reconciliation acknowledgement'));

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(500);
    expect(hostProfileService.releaseModel).not.toHaveBeenCalled();
    expect(hostProfileService.upsert).toHaveBeenCalledTimes(1);
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
      expect.objectContaining({
        referenceModel: 'baseline:model',
        tokensPerSec: 40,
        persistenceReceipt: expect.any(String)
      }),
      { signal: lease.signal, assertAuthorityActive: lease.assertActive }
    );
    expect(hostProfileService.invalidateBaselineReceipt).toHaveBeenCalledWith(
      'primary',
      expect.any(String),
      priorBaseline
    );
    expect(lease.finalize).toHaveBeenCalled();
  });

  test('leaves durable reconciliation pending when the post-restore projection commit fails', async () => {
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      dedicated: { model: 'qwen:7b', expiresAt: new Date('2099-01-01T00:00:00.000Z') }
    });
    hostProfileService.releaseModel.mockResolvedValue({ success: true, serverTerminalObserved: true });
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    hostProfileService.upsert
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('projection commit unavailable'));

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(500);
    expect(hostProfileService.upsert).toHaveBeenCalledTimes(3);
    expect(hostProfileService.upsert.mock.calls[0][0].reconciliation.state).toBe('pending_reconciliation');
    expect(hostProfileService.upsert.mock.calls[2][0].reconciliation.state).toBe('resolved');
    expect(lease.abandon).toHaveBeenCalledWith(expect.objectContaining({ retainAdmission: true }));
    expect(lease.finalize).toHaveBeenCalledTimes(1);
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
    hostProfileService.invalidateBaselineReceipt.mockRejectedValue(compensationFailure);

    const response = await request(app)
      .post('/api/profiler/hosts/test/run')
      .send({ modelName: 'baseline:model', hostId: 'primary' });

    expect(response.status).toBe(500);
    expect(lease.abandon).toHaveBeenCalledWith(compensationFailure);
    expect(lease.abandoned).toBe(true);
    expect(lease.finalize).not.toHaveBeenCalled();
  });

  test('retains the host claim and workload admission when a baseline pull outcome is ambiguous', async () => {
    const pending = Object.assign(new Error('pull may still complete'), {
      code: 'BASELINE_PULL_RECONCILIATION_PENDING',
      retainAdmission: true
    });
    baselineModelService.ensureBaselineModel.mockRejectedValueOnce(pending);

    const response = await request(app)
      .post('/api/profiler/hosts/test/run')
      .send({ modelName: 'baseline:model', hostId: 'primary' });

    expect(response.status).toBe(500);
    expect(lease.abandon).toHaveBeenCalledWith(pending);
    expect(lease.finalize).not.toHaveBeenCalled();
    expect(testModelOnHost).not.toHaveBeenCalled();
  });

  test('retains the exact fence and never finalizes after an unacknowledged unload', async () => {
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      dedicated: { model: 'qwen:7b', expiresAt: new Date('2099-01-01T00:00:00.000Z') }
    });
    hostProfileService.releaseModel.mockRejectedValue(Object.assign(
      new Error('Ollama unload acknowledgement lost'),
      {
        code: 'PROFILER_RELEASE_RECONCILIATION_PENDING',
        retainAdmission: true,
        serverTerminalObserved: false
      }
    ));

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(500);
    expect(lease.abandon).toHaveBeenCalledWith(expect.objectContaining({
      code: 'PROFILER_RELEASE_RECONCILIATION_PENDING',
      retainAdmission: true
    }));
    expect(lease.finalize).not.toHaveBeenCalled();
    expect(hostProfileService.checkStatus).not.toHaveBeenCalled();
  });

  test('retains the exact fence when the server-terminal unload receipt cannot be persisted', async () => {
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      dedicated: { model: 'qwen:7b', expiresAt: new Date('2099-01-01T00:00:00.000Z') }
    });
    hostProfileService.releaseModel.mockResolvedValue({
      success: true,
      serverTerminalObserved: true,
      serverTerminalAt: new Date('2026-09-04T00:00:00.000Z')
    });
    hostProfileService.upsert
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('terminal receipt acknowledgement lost'));

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(503);
    expect(response.body.code).toBe('PROFILER_RELEASE_RECONCILIATION_PENDING');
    expect(lease.abandon).toHaveBeenCalledWith(expect.objectContaining({
      retainAdmission: true,
      serverTerminalObserved: true
    }));
    expect(lease.finalize).not.toHaveBeenCalled();
    expect(hostProfileService.checkStatus).not.toHaveBeenCalled();
  });
});
