'use strict';

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
jest.mock('../../src/services/benchmark', () => ({}));
jest.mock('../../src/helpers/ollamaHostConfig', () => ({ getConfiguredHosts: jest.fn() }));
jest.mock('../../src/services/benchmark/ceilingDetection', () => ({}));
jest.mock('../../src/services/benchmark/generalistScore', () => ({}));
jest.mock('../../src/services/benchmark/regressionDetector', () => ({}));
jest.mock('../../src/services/benchmark/dataRetention', () => ({}));
jest.mock('../../src/services/benchmark/benchmarkTrustEvidenceLock', () => ({
    withBenchmarkTrustEvidenceLock: jest.fn(async (_operation, task) => task())
}));
jest.mock('../../models/BenchmarkResult', () => ({ deleteMany: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/BenchmarkBatch', () => ({ deleteMany: jest.fn(), countDocuments: jest.fn() }));
jest.mock('../../models/BenchmarkTrustReceipt', () => ({ countDocuments: jest.fn() }));

const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkTrustReceipt = require('../../models/BenchmarkTrustReceipt');
const analyticsRouter = require('../../routes/benchmark/analytics');

function getResetHandler() {
    const layer = analyticsRouter.stack.find(candidate => (
        candidate.route?.path === '/retention/reset-all' && candidate.route.methods.post
    ));
    if (!layer) throw new Error('POST /retention/reset-all handler not found');
    return layer.route.stack.at(-1).handle;
}

function createResponse() {
    const response = { statusCode: 200, body: undefined };
    response.status = jest.fn((statusCode) => {
        response.statusCode = statusCode;
        return response;
    });
    response.json = jest.fn((body) => {
        response.body = body;
        return response;
    });
    return response;
}

describe('Benchmark trust receipt reset guard', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        BenchmarkResult.deleteMany.mockResolvedValue({ deletedCount: 7 });
        BenchmarkBatch.deleteMany.mockResolvedValue({ deletedCount: 2 });
        BenchmarkResult.countDocuments.mockResolvedValue(0);
        BenchmarkBatch.countDocuments.mockResolvedValue(0);
    });

    test('blocks reset before any evidence is deleted when receipts exist', async () => {
        BenchmarkTrustReceipt.countDocuments.mockResolvedValue(3);
        const response = createResponse();

        await getResetHandler()({ body: { confirm: 'RESET' } }, response);

        expect(response.statusCode).toBe(409);
        expect(response.body).toEqual({
            status: 'error',
            code: 'BENCHMARK_TRUST_EVIDENCE_PROTECTS_RESET',
            error: 'Reset is blocked while receipts or sealed benchmark evidence require preservation or manual recovery',
            protected_receipts: 3,
            sealed_results: 0,
            sealed_batches: 0
        });
        expect(BenchmarkResult.deleteMany).not.toHaveBeenCalled();
        expect(BenchmarkBatch.deleteMany).not.toHaveBeenCalled();
    });

    test.each([
        ['sealed results', 2, 0],
        ['sealed batches', 0, 1]
    ])('blocks reset before deletion when crash recovery left %s', async (_label, resultCount, batchCount) => {
        BenchmarkTrustReceipt.countDocuments.mockResolvedValue(0);
        BenchmarkResult.countDocuments.mockResolvedValue(resultCount);
        BenchmarkBatch.countDocuments.mockResolvedValue(batchCount);
        const response = createResponse();

        await getResetHandler()({ body: { confirm: 'RESET' } }, response);

        expect(response.statusCode).toBe(409);
        expect(response.body).toMatchObject({
            code: 'BENCHMARK_TRUST_EVIDENCE_PROTECTS_RESET',
            protected_receipts: 0,
            sealed_results: resultCount,
            sealed_batches: batchCount
        });
        expect(BenchmarkResult.deleteMany).not.toHaveBeenCalled();
        expect(BenchmarkBatch.deleteMany).not.toHaveBeenCalled();
    });

    test('preserves the existing reset path when no receipt references evidence', async () => {
        BenchmarkTrustReceipt.countDocuments.mockResolvedValue(0);
        const response = createResponse();

        await getResetHandler()({ body: { confirm: 'RESET' } }, response);

        expect(response.statusCode).toBe(200);
        expect(BenchmarkResult.deleteMany).toHaveBeenCalledWith({});
        expect(BenchmarkBatch.deleteMany).toHaveBeenCalledWith({});
        expect(response.body).toMatchObject({
            status: 'success',
            data: { results_deleted: 7, batches_deleted: 2 }
        });
    });
});
