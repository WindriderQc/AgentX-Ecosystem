'use strict';

const BenchmarkBatch = require('../../models/BenchmarkBatch');

function batchFixture() {
    return {
        run_name: 'trust-source-id-test',
        host: 'opaque-test-host',
        models: ['model-a'],
        levels: [1],
        total_tests: 1
    };
}

describe('BenchmarkBatch opaque trust mapping', () => {
    test('assigns a unique privacy-safe immutable id to every new batch', () => {
        const left = new BenchmarkBatch(batchFixture());
        const right = new BenchmarkBatch(batchFixture());

        expect(left.trust_batch_id).toMatch(/^batch_[0-9a-f]{32}$/);
        expect(right.trust_batch_id).toMatch(/^batch_[0-9a-f]{32}$/);
        expect(left.trust_batch_id).not.toBe(right.trust_batch_id);
        expect(BenchmarkBatch.schema.path('trust_batch_id').options.immutable).toBe(true);
    });

    test('enforces a unique partial index while allowing unmigrated legacy batches', () => {
        const index = BenchmarkBatch.schema.indexes().find(([, options]) => (
            options?.name === 'uniq_benchmark_batch_trust_batch_id'
        ));

        expect(index).toBeDefined();
        expect(index[0]).toEqual({ trust_batch_id: 1 });
        expect(index[1]).toMatchObject({
            unique: true,
            partialFilterExpression: { trust_batch_id: { $type: 'string' } }
        });

        const campaignIndex = BenchmarkBatch.schema.indexes().find(([, options]) => (
            options?.name === 'uniq_benchmark_batch_trust_campaign_spec_id'
        ));
        expect(campaignIndex).toBeDefined();
        expect(campaignIndex[0]).toEqual({ trust_campaign_spec_id: 1 });
        expect(campaignIndex[1]).toMatchObject({
            unique: true,
            partialFilterExpression: { trust_campaign_spec_id: { $type: 'string' } }
        });
    });
});
