#!/usr/bin/env node
'use strict';

/**
 * Assign opaque, immutable Product identifiers to legacy Benchmark batches.
 * The script never derives an identifier from a MongoDB key and never prints
 * either identifier. Run --dry-run first; apply is an explicit operator step.
 */
const mongoose = require('mongoose');
const {
    TRUST_BATCH_ID_PATTERN,
    createTrustBatchId
} = require('../src/services/benchmark/trustBatchIdentity');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';
const DRY_RUN = process.argv.includes('--dry-run');
const INDEX_NAME = 'uniq_benchmark_batch_trust_batch_id';
const MISSING_FILTER = Object.freeze({
    $or: [
        { trust_batch_id: { $exists: false } },
        { trust_batch_id: null }
    ]
});

function isDuplicateKey(error) {
    return error?.code === 11000;
}

async function auditExistingTrustBatchIds(collection) {
    const rows = await collection.find(
        { trust_batch_id: { $exists: true, $ne: null } },
        { projection: { trust_batch_id: 1 } }
    ).toArray();
    const seen = new Set();
    for (const row of rows) {
        const value = row.trust_batch_id;
        if (typeof value !== 'string' || !TRUST_BATCH_ID_PATTERN.test(value)) {
            const error = new Error('Existing Benchmark batch has a malformed opaque trust id');
            error.code = 'INVALID_EXISTING_TRUST_BATCH_ID';
            throw error;
        }
        if (seen.has(value)) {
            const error = new Error('Existing Benchmark batches contain a duplicate opaque trust id');
            error.code = 'DUPLICATE_EXISTING_TRUST_BATCH_ID';
            throw error;
        }
        seen.add(value);
    }
    return rows.length;
}

async function assignOneTrustBatchId(collection, documentId, createId = createTrustBatchId) {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
            const result = await collection.updateOne(
                { _id: documentId, ...MISSING_FILTER },
                { $set: { trust_batch_id: createId() } }
            );
            return result.modifiedCount === 1 ? 'assigned' : 'skipped';
        } catch (error) {
            if (!isDuplicateKey(error) || attempt === 4) throw error;
        }
    }
    return 'skipped';
}

async function backfillBenchmarkTrustBatchIds({
    collection,
    dryRun = false,
    createId = createTrustBatchId
}) {
    const existingValidCount = await auditExistingTrustBatchIds(collection);
    const pendingCount = await collection.countDocuments(MISSING_FILTER);
    const summary = {
        dryRun,
        existingValidCount,
        pendingCount,
        assignedCount: 0,
        skippedCount: 0,
        indexName: INDEX_NAME
    };
    if (dryRun) return summary;

    // Install the uniqueness guard before assigning any value. Missing values
    // are outside the partial index, so this is safe for legacy rows and makes
    // the E11000 retry in assignOneTrustBatchId effective on the first apply.
    await collection.createIndex(
        { trust_batch_id: 1 },
        {
            unique: true,
            partialFilterExpression: { trust_batch_id: { $type: 'string' } },
            name: INDEX_NAME
        }
    );

    const cursor = collection.find(MISSING_FILTER, { projection: { _id: 1 } });
    for await (const row of cursor) {
        const outcome = await assignOneTrustBatchId(collection, row._id, createId);
        if (outcome === 'assigned') summary.assignedCount += 1;
        else summary.skippedCount += 1;
    }
    return summary;
}

async function migrate() {
    await mongoose.connect(MONGO_URI);
    const collection = mongoose.connection.collection('benchmarkbatches');
    const summary = await backfillBenchmarkTrustBatchIds({ collection, dryRun: DRY_RUN });
    console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) {
    migrate()
        .catch((error) => {
            console.error(error);
            process.exitCode = 1;
        })
        .finally(async () => mongoose.disconnect());
}

module.exports = {
    INDEX_NAME,
    MISSING_FILTER,
    assignOneTrustBatchId,
    auditExistingTrustBatchIds,
    backfillBenchmarkTrustBatchIds,
    migrate
};
