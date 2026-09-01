'use strict';

const {
    INDEX_NAME,
    assignOneTrustBatchId,
    auditExistingTrustBatchIds,
    backfillBenchmarkTrustBatchIds
} = require('../../scripts/migrate-benchmark-trust-batch-ids');

function asyncCursor(rows) {
    return {
        async *[Symbol.asyncIterator]() {
            yield* rows;
        }
    };
}

function collectionFixture({ existing = [], pending = [] } = {}) {
    return {
        countDocuments: jest.fn().mockResolvedValue(pending.length),
        find: jest.fn((query) => (
            query?.trust_batch_id?.$exists ? { toArray: async () => existing } : asyncCursor(pending)
        )),
        updateOne: jest.fn().mockResolvedValue({ modifiedCount: 1 }),
        createIndex: jest.fn().mockResolvedValue(INDEX_NAME)
    };
}

describe('Benchmark trust batch id migration', () => {
    test('dry-run reports counts without assigning ids or indexes', async () => {
        const collection = collectionFixture({
            existing: [{ trust_batch_id: `batch_${'a'.repeat(32)}` }],
            pending: [{ _id: 'mongo-id-hidden' }, { _id: 'mongo-id-hidden-2' }]
        });

        const result = await backfillBenchmarkTrustBatchIds({ collection, dryRun: true });

        expect(result).toEqual({
            dryRun: true,
            existingValidCount: 1,
            pendingCount: 2,
            assignedCount: 0,
            skippedCount: 0,
            indexName: INDEX_NAME
        });
        expect(collection.updateOne).not.toHaveBeenCalled();
        expect(collection.createIndex).not.toHaveBeenCalled();
    });

    test('assigns opaque ids conditionally and creates the unique partial index', async () => {
        const collection = collectionFixture({
            pending: [{ _id: 'hidden-a' }, { _id: 'hidden-b' }]
        });
        const values = [`batch_${'b'.repeat(32)}`, `batch_${'c'.repeat(32)}`];

        const result = await backfillBenchmarkTrustBatchIds({
            collection,
            createId: () => values.shift()
        });

        expect(result.assignedCount).toBe(2);
        expect(collection.updateOne).toHaveBeenCalledTimes(2);
        expect(collection.updateOne.mock.calls.map((call) => call[1].$set.trust_batch_id))
            .toEqual([`batch_${'b'.repeat(32)}`, `batch_${'c'.repeat(32)}`]);
        expect(collection.createIndex).toHaveBeenCalledWith(
            { trust_batch_id: 1 },
            {
                unique: true,
                partialFilterExpression: { trust_batch_id: { $type: 'string' } },
                name: INDEX_NAME
            }
        );
    });

    test('retries a random collision and never overwrites a concurrently migrated batch', async () => {
        const collection = collectionFixture();
        collection.updateOne
            .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: 11000 }))
            .mockResolvedValueOnce({ modifiedCount: 0 });
        const ids = [`batch_${'d'.repeat(32)}`, `batch_${'e'.repeat(32)}`];

        await expect(assignOneTrustBatchId(collection, 'hidden-id', () => ids.shift()))
            .resolves.toBe('skipped');
        expect(collection.updateOne).toHaveBeenCalledTimes(2);
        expect(collection.updateOne.mock.calls[0][0]).toMatchObject({ _id: 'hidden-id' });
        expect(collection.updateOne.mock.calls[0][0].$or).toBeDefined();
    });

    test.each([
        [[{ trust_batch_id: 'not-opaque' }], 'INVALID_EXISTING_TRUST_BATCH_ID'],
        [[
            { trust_batch_id: `batch_${'f'.repeat(32)}` },
            { trust_batch_id: `batch_${'f'.repeat(32)}` }
        ], 'DUPLICATE_EXISTING_TRUST_BATCH_ID']
    ])('fails closed on malformed or duplicate existing state', async (existing, code) => {
        const collection = collectionFixture({ existing });
        await expect(auditExistingTrustBatchIds(collection)).rejects.toMatchObject({ code });
    });
});
