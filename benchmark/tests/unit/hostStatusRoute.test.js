'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/profiler/hostProfileService', () => ({
  getById: jest.fn(),
  getByIdForAuthority: jest.fn(),
  checkStatus: jest.fn(),
  updateStatusMetadata: jest.fn(),
  upsertMetadata: jest.fn(),
  upsertAuthority: jest.fn(),
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
const mockPrepareProfilerAuthorityWrite = jest.fn();
const mockCompleteProfilerAuthorityWrite = jest.fn();
jest.mock('../../src/services/benchmark/benchmarkAuthorityReconciliation', () => ({
  prepareProfilerAuthorityWrite: (...args) => mockPrepareProfilerAuthorityWrite(...args),
  completeProfilerAuthorityWrite: (...args) => mockCompleteProfilerAuthorityWrite(...args)
}));
jest.mock('../../src/clients/coreApiClient', () => ({
  getWorkloadRecoveryIdentity: jest.fn(() => ({
    admissionId: 'admission-profiler',
    generation: 'admission-generation-profiler',
    principal: 'benchmark-service',
    recoveryId: 'recovery-profiler',
    recoveryRequestId: 'recovery-request-profiler'
  }))
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
  const originalOperatorToken = process.env.AGENTX_OPERATOR_TOKEN;

  beforeEach(() => {
    jest.clearAllMocks();
    hostProfileService.upsertMetadata.mockReset().mockResolvedValue({});
    hostProfileService.upsertAuthority.mockReset().mockResolvedValue({});
    hostProfileService.invalidateBaselineReceipt.mockResolvedValue({ invalidated: true });
    lease = {
      operationId: 'profiler-host-test-route',
      signal: new AbortController().signal,
      assertActive: jest.fn(() => true),
      identityFor: jest.fn(() => ({ claimBatchId: 'profile-test', claimGeneration: 'generation-1' })),
      authorityProof: jest.fn(() => ({
        admissionId: 'admission-profiler',
        generation: 'admission-generation-profiler',
        principal: 'benchmark-service'
      })),
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
    mockPrepareProfilerAuthorityWrite.mockReset().mockImplementation(async input => ({
      _id: 'journal-baseline-1',
      details: input.details
    }));
    mockCompleteProfilerAuthorityWrite.mockReset().mockResolvedValue({ record: { state: 'resolved' } });
    hostProfileService.getById.mockResolvedValue({
      hostId: 'primary',
      hostUrl: 'http://localhost:11434',
      status: 'online',
      lastSeenAt: new Date('2026-08-28T00:00:00.000Z'),
      dedicated: null,
    });
    hostProfileService.getByIdForAuthority.mockImplementation(
      (...args) => hostProfileService.getById(...args)
    );
    process.env.AGENTX_OPERATOR_TOKEN = 'test-operator-token';
  });

  afterAll(() => {
    if (originalOperatorToken === undefined) delete process.env.AGENTX_OPERATOR_TOKEN;
    else process.env.AGENTX_OPERATOR_TOKEN = originalOperatorToken;
  });

  test('PUT host profile rejects arbitrary evidence and runtime fields', async () => {
    const response = await request(app)
      .put('/api/profiler/hosts/primary')
      .set('authorization', 'Bearer test-operator-token')
      .send({
        displayName: 'Primary',
        baseline: { tokensPerSec: 999999 },
        dedicated: { model: 'untrusted:model' },
        reconciliation: { state: 'resolved' }
      });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      status: 'error',
      code: 'HOST_PROFILE_FIELD_NOT_WRITABLE'
    });
    expect(response.body.fields).toEqual(expect.arrayContaining(['baseline', 'dedicated', 'reconciliation']));
    expect(hostProfileService.upsertMetadata).not.toHaveBeenCalled();
    expect(hostProfileService.upsertAuthority).not.toHaveBeenCalled();
  });

  test('PUT host profile accepts only bounded operator-owned display and thread fields', async () => {
    hostProfileService.upsertMetadata.mockResolvedValue({ hostId: 'primary', displayName: 'Primary', cpu: { threadOverride: 8 } });

    const response = await request(app)
      .put('/api/profiler/hosts/primary')
      .set('authorization', 'Bearer test-operator-token')
      .send({ displayName: ' Primary ', cpu: { threadOverride: 8 } });

    expect(response.status).toBe(200);
    expect(hostProfileService.upsertMetadata).toHaveBeenCalledWith({
      displayName: 'Primary',
      cpu: { threadOverride: 8 },
      hostId: 'primary'
    });
  });

  test('GET returns stored evidence without probing or writing', async () => {
    const response = await request(app).get('/api/profiler/hosts/primary/status');

    expect(response.status).toBe(200);
    expect(response.body.data.status).toBe('online');
    expect(hostProfileService.checkStatus).not.toHaveBeenCalled();
    expect(hostProfileService.updateStatusMetadata).not.toHaveBeenCalled();
    expect(hostProfileService.upsertMetadata).not.toHaveBeenCalled();
    expect(hostProfileService.upsertAuthority).not.toHaveBeenCalled();
  });

  test('POST refresh owns the live probe and evidence update', async () => {
    hostProfileService.checkStatus.mockResolvedValue({ status: 'online', dedicated: null });
    hostProfileService.updateStatusMetadata.mockResolvedValue();

    const response = await request(app).post('/api/profiler/hosts/primary/status/refresh');

    expect(response.status).toBe(200);
    expect(hostProfileService.checkStatus).toHaveBeenCalledWith('http://localhost:11434');
    expect(hostProfileService.updateStatusMetadata).toHaveBeenCalledWith('primary', 'online');
    expect(hostProfileService.upsertAuthority).not.toHaveBeenCalled();
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
    hostProfileService.upsertAuthority.mockResolvedValue({ status: 'online' });

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(200);
    expect(hostProfileService.upsertAuthority).toHaveBeenNthCalledWith(1, expect.objectContaining({
      hostId: 'primary',
      reconciliation: expect.objectContaining({
        state: 'prepared',
        operation: 'release_model',
        model: 'qwen:7b'
      })
    }), expect.objectContaining({
      authorityService: 'profiler-release',
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    }));
    expect(hostProfileService.upsertAuthority).toHaveBeenNthCalledWith(2, expect.objectContaining({
      reconciliation: expect.objectContaining({
        state: 'mutating'
      })
    }), expect.objectContaining({
      authorityService: 'profiler-release',
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    }));
    expect(hostProfileService.upsertAuthority).toHaveBeenNthCalledWith(3, expect.objectContaining({
      reconciliation: expect.objectContaining({
        state: 'verified',
        serverTerminalObserved: true
      })
    }), expect.objectContaining({
      authorityService: 'profiler-release',
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    }));
    expect(hostProfileService.upsertAuthority).toHaveBeenNthCalledWith(4, expect.objectContaining({
      hostId: 'primary',
      status: 'online',
      dedicated: null,
      reconciliation: expect.objectContaining({
        state: 'resolved',
        releaseReceipt: { contract: 'agentx.benchmark-claim-release/v1' }
      })
    }), expect.objectContaining({
      authorityService: 'profiler-release',
      signal: lease.signal,
      assertAuthorityActive: lease.assertActive
    }));
    expect(hostProfileService.upsertAuthority.mock.invocationCallOrder[0])
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
    hostProfileService.upsertAuthority
      .mockRejectedValueOnce(new Error('ambiguous reconciliation acknowledgement'));

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(500);
    expect(hostProfileService.releaseModel).not.toHaveBeenCalled();
    expect(hostProfileService.upsertAuthority).toHaveBeenCalledTimes(1);
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
    hostProfileService.upsertAuthority.mockResolvedValue({ baseline: priorBaseline });

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
      expect.objectContaining({
        authorityService: 'profiler-baseline',
        authorityProof: expect.any(Object),
        expectedAuthorityGeneration: null,
        signal: lease.signal,
        assertAuthorityActive: lease.assertActive
      })
    );
    expect(mockPrepareProfilerAuthorityWrite.mock.invocationCallOrder[0])
      .toBeLessThan(hostProfileService.updateBaseline.mock.invocationCallOrder[0]);
    expect(mockCompleteProfilerAuthorityWrite).not.toHaveBeenCalled();
    expect(lease.abandon).toHaveBeenCalledWith(lost);
    expect(lease.finalize).not.toHaveBeenCalled();
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
    hostProfileService.upsertAuthority
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('projection commit unavailable'));

    const response = await request(app).post('/api/profiler/hosts/primary/release');

    expect(response.status).toBe(500);
    expect(hostProfileService.upsertAuthority).toHaveBeenCalledTimes(4);
    expect(hostProfileService.upsertAuthority.mock.calls[0][0].reconciliation.state).toBe('prepared');
    expect(hostProfileService.upsertAuthority.mock.calls[3][0].reconciliation.state).toBe('resolved');
    expect(lease.abandon).toHaveBeenCalledWith(expect.objectContaining({ retainAdmission: true }));
    expect(lease.finalize).toHaveBeenCalledTimes(1);
  });

  test('holds the lease for durable recovery when baseline journal finalization is ambiguous', async () => {
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
    hostProfileService.updateBaseline.mockResolvedValue({ baseline: { referenceModel: 'baseline:model' } });
    const compensationFailure = new Error('baseline compensation unavailable');
    mockCompleteProfilerAuthorityWrite.mockRejectedValue(compensationFailure);

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
    hostProfileService.upsertAuthority
      .mockResolvedValueOnce({})
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
