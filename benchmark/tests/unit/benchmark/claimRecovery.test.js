'use strict';

const mockGetBenchmarkClaims = jest.fn();
const mockReleaseBenchmarkClaim = jest.fn();
const mockAcquireBenchmarkClaims = jest.fn();

jest.mock('../../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../../src/clients/coreApiClient', () => ({
    getBenchmarkClaims: mockGetBenchmarkClaims,
    releaseBenchmarkClaim: mockReleaseBenchmarkClaim
}));
jest.mock('../../../src/services/benchmark/benchmarkClaimLifecycle', () => ({
    acquireBenchmarkClaims: mockAcquireBenchmarkClaims,
    estimateBenchmarkClaimDurationMs: jest.fn(() => 60_000)
}));
jest.mock('../../../src/services/benchmark/judgeHostResolution', () => ({
    resolveJudgeHost: jest.fn(() => ({ judgeHost: null }))
}));
jest.mock('../../../src/services/benchmark/batchHelpers', () => ({
    groupModelsByHost: jest.fn(() => ({}))
}));

const logger = require('../../../config/logger');

const mockBenchmarkBatch = {
    find: jest.fn(),
    findById: jest.fn(),
    finalizeTrustEvidenceBatch: jest.fn(),
    updateOne: jest.fn()
};
jest.mock('../../../models/BenchmarkBatch', () => mockBenchmarkBatch);

const {
    recoverLeakedClaims,
    reacquireActiveBatchClaims,
    startPriorRuntimeTrustBatchRecoverySweep
} = require('../../../src/services/benchmark/claimRecovery');

function queryResult(value) {
    return {
        select: jest.fn().mockReturnThis(),
        lean: jest.fn().mockResolvedValue(value)
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockBenchmarkBatch.find.mockReturnValue(queryResult([]));
    mockBenchmarkBatch.findById.mockReturnValue(queryResult(null));
    mockBenchmarkBatch.finalizeTrustEvidenceBatch.mockResolvedValue({ status: 'interrupted' });
    mockBenchmarkBatch.updateOne.mockResolvedValue({ matchedCount: 1 });
    mockGetBenchmarkClaims.mockResolvedValue([]);
    mockReleaseBenchmarkClaim.mockResolvedValue({ released: true });
    mockAcquireBenchmarkClaims.mockResolvedValue([]);
});

test('immediately interrupts a prior Trust runner even when its heartbeat is fresh', async () => {
    const prior = {
        _id: '507f1f77bcf86cd799439011',
        status: 'running',
        last_activity_at: new Date(),
        trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
    };
    mockBenchmarkBatch.find.mockReturnValueOnce(queryResult([prior]));

    const outcome = await recoverLeakedClaims();

    expect(mockBenchmarkBatch.find).toHaveBeenCalledWith(expect.objectContaining({
        status: { $in: ['running', 'judging'] },
        trust_evidence_context: { $ne: null },
        started_at: { $lt: expect.any(Date) }
    }));
    expect(mockBenchmarkBatch.finalizeTrustEvidenceBatch).toHaveBeenCalledWith(prior._id, {
        status: 'interrupted',
        failureReason: 'process_restart',
        allowUnstarted: true
    });
    expect(outcome.interruptedTrustBatches).toEqual([prior._id]);
});

test('releases a claim after the prior Trust batch was interrupted', async () => {
    const batchId = '507f1f77bcf86cd799439012';
    mockGetBenchmarkClaims.mockResolvedValue([{ batchId, hostUrl: 'http://host.internal:11434' }]);
    mockBenchmarkBatch.findById.mockReturnValue(queryResult({
        _id: batchId,
        status: 'interrupted',
        trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
    }));

    const outcome = await recoverLeakedClaims();

    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith('http://host.internal:11434', batchId);
    expect(outcome.released).toBe(1);
    expect(outcome.failed).toBe(0);
});

test('reports a refused startup release as failed rather than released', async () => {
    const batchId = '507f1f77bcf86cd799439099';
    mockGetBenchmarkClaims.mockResolvedValue([{ batchId, hostUrl: 'http://host.internal:11434' }]);
    mockBenchmarkBatch.findById.mockReturnValue(queryResult({
        _id: batchId,
        status: 'interrupted',
        trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
    }));
    mockReleaseBenchmarkClaim.mockResolvedValue({ released: false, reason: 'claim generation changed' });

    const outcome = await recoverLeakedClaims();

    expect(outcome).toMatchObject({ released: 0, failed: 1 });
    expect(outcome.details).toEqual([expect.objectContaining({
        batchId,
        reason: 'batch-interrupted',
        releaseReason: 'claim generation changed'
    })]);
    expect(logger.info).not.toHaveBeenCalledWith(
        '[ClaimRecovery] All claims reconciled, none required release',
        expect.any(Object)
    );
    expect(logger.warn).toHaveBeenCalledWith(
        '[ClaimRecovery] Some leaked claims remain active after startup reconciliation',
        expect.objectContaining({ count: 1 })
    );
});

test('does not re-claim Trust work that startup recovery already finalized', async () => {
    mockBenchmarkBatch.find.mockReturnValue(queryResult([{
        _id: '507f1f77bcf86cd799439013',
        status: 'running',
        last_activity_at: new Date(),
        host: 'http://host.internal:11434',
        models: ['candidate-model'],
        trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
    }]));

    const outcome = await reacquireActiveBatchClaims();

    expect(outcome).toEqual({ checked: 1, reacquired: 0 });
    expect(mockAcquireBenchmarkClaims).not.toHaveBeenCalled();
});

test('deferred recovery retries a failed prior Trust finalizer with one immutable boot cutoff', async () => {
    jest.useFakeTimers();
    const cutoff = new Date('2026-09-01T12:00:00.000Z');
    const prior = {
        _id: '507f1f77bcf86cd799439014',
        status: 'running',
        trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
    };
    mockBenchmarkBatch.find
        .mockReturnValueOnce(queryResult([prior]))
        .mockReturnValueOnce(queryResult([prior]));
    mockBenchmarkBatch.finalizeTrustEvidenceBatch
        .mockRejectedValueOnce(new Error('temporary lock contention'))
        .mockResolvedValueOnce({ status: 'interrupted' });

    const sweep = startPriorRuntimeTrustBatchRecoverySweep({
        recoveryStartedAt: cutoff,
        retryMs: 100
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(mockBenchmarkBatch.finalizeTrustEvidenceBatch).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(mockBenchmarkBatch.finalizeTrustEvidenceBatch).toHaveBeenCalledTimes(2);

    for (const [filter] of mockBenchmarkBatch.find.mock.calls) {
        expect(filter.started_at.$lt).toEqual(cutoff);
    }
    await jest.advanceTimersByTimeAsync(500);
    expect(mockBenchmarkBatch.find).toHaveBeenCalledTimes(2);
    sweep.stop();
    jest.useRealTimers();
});

test('deferred recovery releases the exact claim after a retry finalizes the prior Trust batch', async () => {
    jest.useFakeTimers();
    const cutoff = new Date('2026-09-01T12:00:00.000Z');
    const batchId = '507f1f77bcf86cd799439015';
    const hostUrl = 'http://host.internal:11434';
    const prior = {
        _id: batchId,
        status: 'running',
        started_at: new Date('2026-09-01T11:00:00.000Z'),
        trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
    };
    mockBenchmarkBatch.find
        .mockReturnValueOnce(queryResult([prior]))
        .mockReturnValueOnce(queryResult([prior]));
    mockBenchmarkBatch.finalizeTrustEvidenceBatch
        .mockRejectedValueOnce(new Error('temporary lock contention'))
        .mockResolvedValueOnce({ status: 'interrupted' });
    mockGetBenchmarkClaims.mockResolvedValue([{ batchId, hostUrl }]);
    mockBenchmarkBatch.findById
        .mockReturnValueOnce(queryResult(prior))
        .mockReturnValueOnce(queryResult({ ...prior, status: 'interrupted' }));

    const sweep = startPriorRuntimeTrustBatchRecoverySweep({
        recoveryStartedAt: cutoff,
        retryMs: 100
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(mockReleaseBenchmarkClaim).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(100);
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledWith(hostUrl, batchId);
    await jest.advanceTimersByTimeAsync(300);
    expect(mockBenchmarkBatch.find).toHaveBeenCalledTimes(2);
    sweep.stop();
    jest.useRealTimers();
});

test('deferred recovery retries an exact claim release failure', async () => {
    jest.useFakeTimers();
    const cutoff = new Date('2026-09-01T12:00:00.000Z');
    const batchId = '507f1f77bcf86cd799439016';
    const hostUrl = 'http://host.internal:11434';
    const terminal = {
        _id: batchId,
        status: 'interrupted',
        started_at: new Date('2026-09-01T11:00:00.000Z'),
        trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
    };
    mockGetBenchmarkClaims.mockResolvedValue([{ batchId, hostUrl }]);
    mockBenchmarkBatch.findById.mockReturnValue(queryResult(terminal));
    mockReleaseBenchmarkClaim
        .mockRejectedValueOnce(new Error('core unavailable'))
        .mockResolvedValueOnce({ released: true });

    const sweep = startPriorRuntimeTrustBatchRecoverySweep({
        recoveryStartedAt: cutoff,
        retryMs: 100
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(300);
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledTimes(2);
    sweep.stop();
    jest.useRealTimers();
});

test('deferred recovery retries when Core refuses an exact claim release without throwing', async () => {
    jest.useFakeTimers();
    const cutoff = new Date('2026-09-01T12:00:00.000Z');
    const batchId = '507f1f77bcf86cd799439017';
    const hostUrl = 'http://host.internal:11434';
    const terminal = {
        _id: batchId,
        status: 'interrupted',
        started_at: new Date('2026-09-01T11:00:00.000Z'),
        trust_evidence_context: { schema: 'agentx.benchmark-trust-source-context/v2' }
    };
    mockGetBenchmarkClaims.mockResolvedValue([{ batchId, hostUrl }]);
    mockBenchmarkBatch.findById.mockReturnValue(queryResult(terminal));
    mockReleaseBenchmarkClaim
        .mockResolvedValueOnce({ released: false, reason: 'claim changed owner' })
        .mockResolvedValueOnce({ released: true });

    const sweep = startPriorRuntimeTrustBatchRecoverySweep({
        recoveryStartedAt: cutoff,
        retryMs: 100
    });
    await jest.advanceTimersByTimeAsync(100);
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(100);
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(300);
    expect(mockReleaseBenchmarkClaim).toHaveBeenCalledTimes(2);
    sweep.stop();
    jest.useRealTimers();
});
