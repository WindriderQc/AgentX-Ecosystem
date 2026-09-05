'use strict';

const mockLockModel = {
    create: jest.fn(),
    findOneAndUpdate: jest.fn(),
    updateOne: jest.fn(),
    deleteOne: jest.fn()
};

jest.mock('../../../models/BenchmarkTrustEvidenceLock', () => mockLockModel);

const {
    DEFAULT_WAIT_MS,
    acquireBenchmarkTrustEvidenceLock,
    recoverExpiredBenchmarkTrustEvidenceLock,
    releaseBenchmarkTrustEvidenceLock,
    renewBenchmarkTrustEvidenceLock
} = require('../../../src/services/benchmark/benchmarkTrustEvidenceLock');

test('allows the full bounded wait window for serialized evidence mutations', () => {
    expect(DEFAULT_WAIT_MS).toBe(30_000);
});

beforeEach(() => {
    jest.clearAllMocks();
    mockLockModel.create.mockResolvedValue({});
    mockLockModel.findOneAndUpdate.mockResolvedValue(null);
    mockLockModel.updateOne.mockResolvedValue({ matchedCount: 1 });
    mockLockModel.deleteOne.mockResolvedValue({ deletedCount: 1 });
});

test('acquires and releases a fresh owner-token-fenced lease', async () => {
    const ownerToken = await acquireBenchmarkTrustEvidenceLock('fresh-lock');
    await releaseBenchmarkTrustEvidenceLock(ownerToken);

    expect(ownerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(mockLockModel.create).toHaveBeenCalledWith(expect.objectContaining({
        _id: 'benchmark-trust-evidence-mutation-v1',
        ownerToken,
        operation: 'fresh-lock',
        acquiredAt: expect.any(Date)
    }));
    expect(mockLockModel.deleteOne).toHaveBeenCalledWith({
        _id: 'benchmark-trust-evidence-mutation-v1',
        ownerToken
    });
});

test('never steals an expired lease automatically because protected writes are not token-fenced', async () => {
    mockLockModel.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));

    await expect(acquireBenchmarkTrustEvidenceLock('recover-crashed-owner', {
        waitMs: 0,
        leaseMs: 1_000
    })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_MUTATION_BUSY' });

    expect(mockLockModel.findOneAndUpdate).not.toHaveBeenCalled();
});

test('does not steal a live unexpired lease', async () => {
    mockLockModel.create.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));
    mockLockModel.findOneAndUpdate.mockResolvedValue(null);

    await expect(acquireBenchmarkTrustEvidenceLock('live-owner', {
        waitMs: 0,
        leaseMs: 1_000
    })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_MUTATION_BUSY' });
});

test('fails closed when renewal or release loses owner-token fencing', async () => {
    mockLockModel.updateOne.mockResolvedValue({ matchedCount: 0 });
    await expect(renewBenchmarkTrustEvidenceLock('a'.repeat(64)))
        .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_LOCK_LOST' });

    mockLockModel.deleteOne.mockResolvedValue({ deletedCount: 0 });
    await expect(releaseBenchmarkTrustEvidenceLock('b'.repeat(64)))
        .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_LOCK_LOST' });
});

test('recovers only an expired exact inspected lease after explicit abandoned-owner confirmation', async () => {
    const ownerToken = 'c'.repeat(64);
    const acquiredAt = new Date('2026-09-01T12:00:00.000Z');
    const now = new Date('2026-09-01T12:00:02.000Z');

    await expect(recoverExpiredBenchmarkTrustEvidenceLock({
        ownerToken,
        acquiredAt,
        leaseMs: 1_000,
        now
    })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_LOCK_RECOVERY_CONFIRMATION_REQUIRED' });

    mockLockModel.deleteOne.mockResolvedValueOnce({ deletedCount: 1 });
    await expect(recoverExpiredBenchmarkTrustEvidenceLock({
        ownerToken,
        acquiredAt,
        leaseMs: 1_000,
        now,
        confirmAbandoned: true
    })).resolves.toEqual({ recovered: true });
    expect(mockLockModel.deleteOne).toHaveBeenLastCalledWith({
        _id: 'benchmark-trust-evidence-mutation-v1',
        ownerToken,
        acquiredAt
    });
});

test('refuses recovery when a lease is fresh or changed after inspection', async () => {
    const ownerToken = 'd'.repeat(64);
    const now = new Date('2026-09-01T12:00:02.000Z');
    await expect(recoverExpiredBenchmarkTrustEvidenceLock({
        ownerToken,
        acquiredAt: new Date('2026-09-01T12:00:01.500Z'),
        leaseMs: 1_000,
        now,
        confirmAbandoned: true
    })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_LOCK_NOT_EXPIRED' });

    mockLockModel.deleteOne.mockResolvedValueOnce({ deletedCount: 0 });
    await expect(recoverExpiredBenchmarkTrustEvidenceLock({
        ownerToken,
        acquiredAt: new Date('2026-09-01T12:00:00.000Z'),
        leaseMs: 1_000,
        now,
        confirmAbandoned: true
    })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_LOCK_RECOVERY_STALE' });
});
