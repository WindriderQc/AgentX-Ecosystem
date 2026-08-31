'use strict';

jest.mock('../../config/logger', () => ({ error: jest.fn() }));
jest.mock('../../src/services/benchmark/benchmarkTrustReceiptStore', () => ({
    DEFAULT_BATCH_READ_LIMIT: 20,
    getBenchmarkTrustReceiptById: jest.fn(),
    listBenchmarkTrustReceiptsBySourceBatch: jest.fn()
}));

const store = require('../../src/services/benchmark/benchmarkTrustReceiptStore');
const router = require('../../routes/benchmark/trustReceipts');

function getHandler(path) {
    const layer = router.stack.find(candidate => (
        candidate.route?.path === path && candidate.route.methods.get
    ));
    if (!layer) throw new Error(`GET ${path} handler not found`);
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

const listHandler = getHandler('/trust-receipts');
const exactHandler = getHandler('/trust-receipts/:receiptId');

describe('Benchmark trust receipt read routes', () => {
    beforeEach(() => jest.clearAllMocks());

    test('reads one exact receipt without exposing a mutation route', async () => {
        const receipt = { receiptId: 'a'.repeat(64) };
        store.getBenchmarkTrustReceiptById.mockResolvedValue(receipt);
        const response = createResponse();

        await exactHandler({ params: { receiptId: receipt.receiptId } }, response);

        expect(response.statusCode).toBe(200);
        expect(response.body).toEqual({ status: 'success', data: receipt });
        expect(store.getBenchmarkTrustReceiptById).toHaveBeenCalledWith(receipt.receiptId);
        expect(router.stack.some(layer => layer.route?.methods.post)).toBe(false);
    });

    test('returns 404 for an absent exact receipt', async () => {
        store.getBenchmarkTrustReceiptById.mockResolvedValue(null);
        const response = createResponse();

        await exactHandler({ params: { receiptId: 'b'.repeat(64) } }, response);

        expect(response.statusCode).toBe(404);
        expect(response.body.code).toBe('BENCHMARK_TRUST_RECEIPT_NOT_FOUND');
    });

    test('lists a bounded opaque source batch and applies the default limit', async () => {
        const sourceBatchId = `batch_${'d'.repeat(32)}`;
        store.listBenchmarkTrustReceiptsBySourceBatch.mockResolvedValue([{ receiptId: 'one' }]);
        const response = createResponse();

        await listHandler({ query: { source_batch_id: sourceBatchId } }, response);

        expect(response.statusCode).toBe(200);
        expect(response.body.data).toEqual({ receipts: [{ receiptId: 'one' }], count: 1 });
        expect(store.listBenchmarkTrustReceiptsBySourceBatch)
            .toHaveBeenCalledWith(sourceBatchId, { limit: 20 });
    });

    test('rejects missing source batch and propagates bounded store errors', async () => {
        const missing = createResponse();
        await listHandler({ query: {} }, missing);
        expect(missing.statusCode).toBe(400);
        expect(missing.body.code).toBe('SOURCE_BATCH_ID_REQUIRED');

        const error = Object.assign(new Error('limit must be bounded'), {
            code: 'INVALID_READ_LIMIT',
            statusCode: 400
        });
        store.listBenchmarkTrustReceiptsBySourceBatch.mockRejectedValue(error);
        const response = createResponse();

        await listHandler({
            query: { source_batch_id: `batch_${'d'.repeat(32)}`, limit: '101' }
        }, response);

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({
            status: 'error',
            code: 'INVALID_READ_LIMIT',
            error: 'limit must be bounded'
        });
    });
});
