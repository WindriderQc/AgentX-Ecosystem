#!/usr/bin/env node
'use strict';

/**
 * Migration: Convert BenchmarkResult.tokens_per_sec from String to Number.
 *
 * Background: the BenchmarkResult schema now stores `tokens_per_sec` as a
 * Number (with a coercing setter), and the aggregation pipelines no longer
 * wrap the field in `$toDouble`. Legacy rows written before the schema change
 * may still hold the value as a BSON string. This backfill converts those
 * string rows to numbers so the cast-free aggregations compute correctly.
 *
 * Safety / scope:
 * - reads and writes ONLY the benchmark-owned `benchmarkresults` collection
 * - touches ONLY documents where `tokens_per_sec` is a BSON string (type 2)
 * - already-numeric rows are left untouched
 * - idempotent: re-running after a successful pass finds nothing to convert
 * - non-numeric / unparseable strings are coerced to 0 (matches the schema
 *   setter, which maps non-finite input to 0)
 *
 * Does NOT touch BenchmarkTimelineEntry.tokens_per_sec -- that collection's
 * field is intentionally Mixed and is not read by any $toDouble aggregation.
 *
 * Usage:
 *   node scripts/migrate-tokens-per-sec-to-number.js --dry-run
 *   node scripts/migrate-tokens-per-sec-to-number.js
 *
 * NOTE: This is an operator-run, one-off migration. Do NOT run it as part of
 * automated CI or against a database you do not intend to mutate.
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 500;

/**
 * Coerce a raw tokens_per_sec value to a finite Number, mirroring the
 * BenchmarkResult schema setter. Non-finite / unparseable values become 0.
 */
function coerceToNumber(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : 0;
}

async function migrate() {
    console.log(`Connecting to ${MONGO_URI}...`);
    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    const collection = db.collection('benchmarkresults');

    // BSON type 2 == string
    const stringFilter = { tokens_per_sec: { $type: 'string' } };
    const stringCount = await collection.countDocuments(stringFilter);

    console.log(`Found ${stringCount} documents with string tokens_per_sec`);

    if (stringCount === 0) {
        console.log('Nothing to migrate. (already numeric / idempotent no-op)');
        await mongoose.disconnect();
        return;
    }

    if (DRY_RUN) {
        const sample = await collection.find(stringFilter)
            .limit(5)
            .project({ _id: 1, tokens_per_sec: 1 })
            .toArray();
        console.log('Sample documents that would be converted:');
        for (const doc of sample) {
            console.log(`  _id: ${doc._id}  tokens_per_sec: "${doc.tokens_per_sec}" -> ${coerceToNumber(doc.tokens_per_sec)}`);
        }
        console.log(`\nDry run complete. ${stringCount} documents would be updated.`);
        await mongoose.disconnect();
        return;
    }

    let converted = 0;
    let zeroed = 0;
    const cursor = collection.find(stringFilter)
        .project({ _id: 1, tokens_per_sec: 1 })
        .batchSize(BATCH_SIZE);

    let bulkOps = [];

    const flush = async () => {
        if (bulkOps.length === 0) return;
        const result = await collection.bulkWrite(bulkOps, { ordered: false });
        converted += result.modifiedCount;
        process.stdout.write(`\r  Converted ${converted}/${stringCount}...`);
        bulkOps = [];
    };

    for await (const doc of cursor) {
        const numeric = coerceToNumber(doc.tokens_per_sec);
        // Track strings that could not be parsed (coerced to 0).
        if (!Number.isFinite(Number(doc.tokens_per_sec))) {
            zeroed++;
        }
        bulkOps.push({
            updateOne: {
                // Re-assert the string type guard so concurrent writers (which
                // already store numbers) are never clobbered.
                filter: { _id: doc._id, tokens_per_sec: { $type: 'string' } },
                update: { $set: { tokens_per_sec: numeric } }
            }
        });

        if (bulkOps.length >= BATCH_SIZE) {
            await flush();
        }
    }

    await flush();

    console.log(`\nMigration complete: ${converted} converted` +
        (zeroed > 0 ? ` (${zeroed} unparseable strings coerced to 0)` : '') + '.');

    const remaining = await collection.countDocuments(stringFilter);
    if (remaining > 0) {
        console.warn(`Warning: ${remaining} documents still have string tokens_per_sec.`);
    } else {
        console.log('Verification passed: no string tokens_per_sec values remain.');
    }

    await mongoose.disconnect();
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
