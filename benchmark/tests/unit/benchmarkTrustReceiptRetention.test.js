'use strict';

jest.mock('../../config/logger', () => ({ info: jest.fn() }));
jest.mock('../../models/BenchmarkResult', () => ({
    aggregate: jest.fn(),
    countDocuments: jest.fn(),
    deleteMany: jest.fn(),
    distinct: jest.fn()
}));
jest.mock('../../models/BenchmarkBatch', () => ({
    find: jest.fn(),
    aggregate: jest.fn(),
    updateMany: jest.fn(),
    countDocuments: jest.fn()
}));
jest.mock('../../models/BenchmarkTimelineEntry', () => ({
    deleteMany: jest.fn()
}));
jest.mock('../../models/BenchmarkTrustReceipt', () => ({
    find: jest.fn(),
    verifyStoredRecord: jest.fn()
}));

const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../models/BenchmarkTimelineEntry');
const BenchmarkTrustReceipt = require('../../models/BenchmarkTrustReceipt');
const {
    archiveOldResults,
    pruneExcessBatches,
    purgeDeadModels
} = require('../../src/services/benchmark/dataRetention');

function staleBatch(id) {
    return {
        _id: id,
        completed_at: new Date('2026-01-01T00:00:00.000Z'),
        status: 'completed'
    };
}

const RECEIPTED_SOURCE_ID = `batch_${'d'.repeat(32)}`;

function queryResult(rows) {
    const lean = jest.fn().mockResolvedValue(rows);
    return { select: jest.fn().mockReturnValue({ lean }) };
}

function mockBatchFind({ stale = [], trustLinks = [] } = {}) {
    BenchmarkBatch.find.mockImplementation((query) => (
        query?._id ? queryResult(trustLinks) : queryResult(stale)
    ));
}

function mockReceiptedSourceIds(sourceIds = []) {
    BenchmarkTrustReceipt.find.mockReturnValue({
        lean: jest.fn().mockResolvedValue(sourceIds.map(sourceBatchId => ({ sourceBatchId })))
    });
}

beforeEach(() => {
    jest.clearAllMocks();
    BenchmarkResult.deleteMany.mockResolvedValue({ deletedCount: 0 });
    BenchmarkBatch.updateMany.mockResolvedValue({ modifiedCount: 0 });
    BenchmarkTimelineEntry.deleteMany.mockResolvedValue({ deletedCount: 0 });
    mockReceiptedSourceIds();
    BenchmarkTrustReceipt.verifyStoredRecord.mockImplementation(record => ({
        execution: { sourceBatchId: record.sourceBatchId }
    }));
    mockBatchFind();
});

describe('BenchmarkTrustReceipt retention protection', () => {
    test('fails closed before deletion when a stored receipt projection is tampered', async () => {
        mockBatchFind({
            stale: [staleBatch('batch-receipted')],
            trustLinks: [{ _id: 'batch-receipted', trust_batch_id: RECEIPTED_SOURCE_ID }]
        });
        mockReceiptedSourceIds([RECEIPTED_SOURCE_ID]);
        BenchmarkTrustReceipt.verifyStoredRecord.mockImplementation(() => {
            const error = new Error('tampered receipt projection');
            error.code = 'BENCHMARK_TRUST_RECEIPT_TAMPERED';
            throw error;
        });

        await expect(archiveOldResults(90, false)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_RECEIPT_TAMPERED'
        });
        expect(BenchmarkResult.deleteMany).not.toHaveBeenCalled();
        expect(BenchmarkTimelineEntry.deleteMany).not.toHaveBeenCalled();
        expect(BenchmarkBatch.updateMany).not.toHaveBeenCalled();
        expect(BenchmarkTrustReceipt.find).toHaveBeenCalledWith({});
    });

    test('cannot hide a tampered receipt from retention by changing its indexed source projection', async () => {
        mockBatchFind({
            stale: [staleBatch('batch-receipted')],
            trustLinks: [{ _id: 'batch-receipted', trust_batch_id: RECEIPTED_SOURCE_ID }]
        });
        mockReceiptedSourceIds(['batch_ffffffffffffffffffffffffffffffff']);
        BenchmarkTrustReceipt.verifyStoredRecord.mockImplementation(() => {
            const error = new Error('indexed projection does not match payload');
            error.code = 'BENCHMARK_TRUST_RECEIPT_TAMPERED';
            throw error;
        });

        await expect(archiveOldResults(90, false)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_RECEIPT_TAMPERED'
        });
        expect(BenchmarkTrustReceipt.find).toHaveBeenCalledWith({});
        expect(BenchmarkResult.deleteMany).not.toHaveBeenCalled();
        expect(BenchmarkTimelineEntry.deleteMany).not.toHaveBeenCalled();
        expect(BenchmarkBatch.updateMany).not.toHaveBeenCalled();
    });

    test('archive dry-run exposes protected evidence without counting it as archivable', async () => {
        mockBatchFind({
            stale: [staleBatch('batch-open'), staleBatch('batch-receipted')],
            trustLinks: [{ _id: 'batch-receipted', trust_batch_id: RECEIPTED_SOURCE_ID }]
        });
        mockReceiptedSourceIds([RECEIPTED_SOURCE_ID]);
        BenchmarkResult.countDocuments.mockImplementation(async ({ batch_id: batchFilter }) => (
            batchFilter.$in.includes('batch-receipted') ? 7 : 4
        ));

        const result = await archiveOldResults(90, true);

        expect(result).toEqual({
            batchesProcessed: 1,
            resultsDeleted: 4,
            protectedBatches: 1,
            protectedResults: 7,
            protectedSourceBatchIds: [RECEIPTED_SOURCE_ID],
            dryRun: true
        });
        expect(BenchmarkResult.deleteMany).not.toHaveBeenCalled();
        expect(BenchmarkTimelineEntry.deleteMany).not.toHaveBeenCalled();
        expect(BenchmarkBatch.updateMany).not.toHaveBeenCalled();
    });

    test('archive deletes and compacts only batches with no receipt', async () => {
        mockBatchFind({
            stale: [staleBatch('batch-open'), staleBatch('batch-receipted')],
            trustLinks: [{ _id: 'batch-receipted', trust_batch_id: RECEIPTED_SOURCE_ID }]
        });
        mockReceiptedSourceIds([RECEIPTED_SOURCE_ID]);
        BenchmarkResult.countDocuments.mockImplementation(async ({ batch_id: batchFilter }) => (
            batchFilter.$in.includes('batch-receipted') ? 7 : 4
        ));
        BenchmarkResult.deleteMany.mockResolvedValue({ deletedCount: 4 });

        const result = await archiveOldResults(90, false);

        expect(BenchmarkResult.deleteMany).toHaveBeenCalledWith({
            batch_id: { $in: ['batch-open'] }
        });
        expect(BenchmarkTimelineEntry.deleteMany).toHaveBeenCalledWith({
            batchId: { $in: ['batch-open'] }
        });
        expect(BenchmarkBatch.updateMany.mock.calls[0][0]).toEqual({
            _id: { $in: ['batch-open'] }
        });
        expect(result).toMatchObject({
            batchesProcessed: 1,
            resultsDeleted: 4,
            protectedBatches: 1,
            protectedResults: 7,
            protectedSourceBatchIds: [RECEIPTED_SOURCE_ID]
        });
    });

    test.each([
        ['dry-run', true],
        ['apply', false]
    ])('prune %s protects receipted excess batches and preserves unprotected pruning', async (_label, dryRun) => {
        BenchmarkBatch.aggregate.mockResolvedValue([{
            _id: 'model-a',
            batches: [
                { batchId: 'batch-latest' },
                { batchId: 'batch-open' },
                { batchId: 'batch-receipted' }
            ],
            count: 3
        }]);
        mockBatchFind({
            trustLinks: [{ _id: 'batch-receipted', trust_batch_id: RECEIPTED_SOURCE_ID }]
        });
        mockReceiptedSourceIds([RECEIPTED_SOURCE_ID]);
        BenchmarkResult.countDocuments.mockImplementation(async ({ batch_id: batchFilter }) => (
            batchFilter.$in.includes('batch-receipted') ? 2 : 3
        ));
        BenchmarkResult.deleteMany.mockResolvedValue({ deletedCount: 3 });

        const result = await pruneExcessBatches(1, dryRun);

        expect(result).toEqual({
            modelsProcessed: 1,
            resultsDeleted: 3,
            modelsProtected: 1,
            protectedBatches: 1,
            protectedResults: 2,
            protectedSourceBatchIds: [RECEIPTED_SOURCE_ID],
            dryRun
        });
        if (dryRun) {
            expect(BenchmarkResult.deleteMany).not.toHaveBeenCalled();
        } else {
            expect(BenchmarkResult.deleteMany).toHaveBeenCalledWith({
                model: 'model-a',
                batch_id: { $in: ['batch-open'] }
            });
        }
    });

    test.each([
        ['dry-run', true],
        ['apply', false]
    ])('dead-model purge %s excludes receipted batches from deletion counts and filters', async (_label, dryRun) => {
        BenchmarkResult.aggregate.mockResolvedValue([{
            _id: { model: 'dead-model', host: 'host-a' },
            total: 6,
            empty: 6,
            emptyRate: 1
        }]);
        BenchmarkResult.distinct.mockResolvedValue(['batch-open', 'batch-receipted']);
        mockBatchFind({
            trustLinks: [{ _id: 'batch-receipted', trust_batch_id: RECEIPTED_SOURCE_ID }]
        });
        mockReceiptedSourceIds([RECEIPTED_SOURCE_ID]);
        BenchmarkResult.countDocuments.mockImplementation(async ({ batch_id: batchFilter }) => (
            batchFilter.$in ? 2 : 4
        ));
        BenchmarkResult.deleteMany.mockResolvedValue({ deletedCount: 4 });

        const result = await purgeDeadModels(dryRun);

        expect(result).toEqual({
            modelsDeleted: 1,
            resultsDeleted: 4,
            models: [{ model: 'dead-model', host: 'host-a', results: 4, emptyRate: 100 }],
            modelsProtected: 1,
            protectedModels: [{ model: 'dead-model', host: 'host-a', results: 2, emptyRate: 100 }],
            protectedBatches: 1,
            protectedResults: 2,
            protectedSourceBatchIds: [RECEIPTED_SOURCE_ID],
            dryRun
        });
        if (dryRun) {
            expect(BenchmarkResult.deleteMany).not.toHaveBeenCalled();
        } else {
            expect(BenchmarkResult.deleteMany).toHaveBeenCalledWith({
                model: 'dead-model',
                host: 'host-a',
                batch_id: { $nin: ['batch-receipted'] }
            });
        }
    });

    test('a fully protected dead model is visible but never counted or submitted for deletion', async () => {
        BenchmarkResult.aggregate.mockResolvedValue([{
            _id: { model: 'protected-model', host: 'host-a' },
            total: 5,
            empty: 5,
            emptyRate: 1
        }]);
        BenchmarkResult.distinct.mockResolvedValue(['batch-receipted']);
        mockBatchFind({
            trustLinks: [{ _id: 'batch-receipted', trust_batch_id: RECEIPTED_SOURCE_ID }]
        });
        mockReceiptedSourceIds([RECEIPTED_SOURCE_ID]);
        BenchmarkResult.countDocuments.mockImplementation(async ({ batch_id: batchFilter }) => (
            batchFilter.$in ? 5 : 0
        ));

        const result = await purgeDeadModels(false);

        expect(result).toMatchObject({
            modelsDeleted: 0,
            resultsDeleted: 0,
            modelsProtected: 1,
            protectedResults: 5,
            protectedSourceBatchIds: [RECEIPTED_SOURCE_ID]
        });
        expect(BenchmarkResult.deleteMany).not.toHaveBeenCalled();
    });
});
