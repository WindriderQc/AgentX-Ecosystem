'use strict';

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

const {
    abortActiveBatchRequests,
    _registerActiveBatchController: registerActiveBatchController,
    _getActiveBatchRequestCount: getActiveBatchRequestCount
} = require('../../../src/services/benchmark/batchOrchestrator');

describe('benchmark in-flight request registry', () => {
    it('aborts only the exact batch and is idempotent', () => {
        const batchAController = new AbortController();
        const batchBController = new AbortController();
        const unregisterA = registerActiveBatchController('batch-a', batchAController);
        const unregisterB = registerActiveBatchController('batch-b', batchBController);

        expect(abortActiveBatchRequests('batch-a')).toEqual({
            batchId: 'batch-a',
            activeRequestCount: 1,
            abortedRequestCount: 1
        });
        expect(batchAController.signal.aborted).toBe(true);
        expect(batchAController.signal.reason).toMatchObject({
            code: 'BENCHMARK_BATCH_STOPPED'
        });
        expect(batchBController.signal.aborted).toBe(false);

        expect(abortActiveBatchRequests('batch-a')).toEqual({
            batchId: 'batch-a',
            activeRequestCount: 1,
            abortedRequestCount: 0
        });

        unregisterA();
        unregisterB();
        expect(getActiveBatchRequestCount('batch-a')).toBe(0);
        expect(getActiveBatchRequestCount('batch-b')).toBe(0);
    });

    it('does not let stale cleanup remove a newer controller for the same batch', () => {
        const oldController = new AbortController();
        const unregisterOld = registerActiveBatchController('batch-reused', oldController);
        expect(unregisterOld()).toBe(true);

        const newerController = new AbortController();
        const unregisterNewer = registerActiveBatchController('batch-reused', newerController);

        expect(unregisterOld()).toBe(false);
        expect(getActiveBatchRequestCount('batch-reused')).toBe(1);
        expect(abortActiveBatchRequests('batch-reused').abortedRequestCount).toBe(1);
        expect(newerController.signal.aborted).toBe(true);

        expect(unregisterNewer()).toBe(true);
        expect(getActiveBatchRequestCount('batch-reused')).toBe(0);
        expect(abortActiveBatchRequests('batch-reused')).toEqual({
            batchId: 'batch-reused',
            activeRequestCount: 0,
            abortedRequestCount: 0
        });
    });
});
