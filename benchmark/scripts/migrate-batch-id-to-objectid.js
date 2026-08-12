#!/usr/bin/env node
/**
 * Migration: Convert BenchmarkResult.batch_id from String to ObjectId.
 *
 * Idempotent — only updates documents where batch_id is a string.
 * Run with --dry-run to preview without making changes.
 *
 * Usage:
 *   node scripts/migrate-batch-id-to-objectid.js
 *   node scripts/migrate-batch-id-to-objectid.js --dry-run
 */

const mongoose = require('mongoose');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';
const DRY_RUN = process.argv.includes('--dry-run');
const BATCH_SIZE = 500;

async function migrate() {
    console.log(`Connecting to ${MONGO_URI}...`);
    await mongoose.connect(MONGO_URI);
    const db = mongoose.connection.db;
    const collection = db.collection('benchmarkresults');

    // Find all documents where batch_id is a string (type 2 in BSON)
    const stringCount = await collection.countDocuments({
        batch_id: { $type: 'string' }
    });

    console.log(`Found ${stringCount} documents with string batch_id`);

    if (stringCount === 0) {
        console.log('Nothing to migrate.');
        await mongoose.disconnect();
        return;
    }

    if (DRY_RUN) {
        // Show a sample of what would be converted
        const sample = await collection.find({ batch_id: { $type: 'string' } })
            .limit(5)
            .project({ _id: 1, batch_id: 1 })
            .toArray();
        console.log('Sample documents that would be converted:');
        for (const doc of sample) {
            console.log(`  _id: ${doc._id}  batch_id: "${doc.batch_id}" → ObjectId("${doc.batch_id}")`);
        }
        console.log(`\nDry run complete. ${stringCount} documents would be updated.`);
        await mongoose.disconnect();
        return;
    }

    // Process in batches using a cursor to avoid loading all docs into memory
    let converted = 0;
    let skipped = 0;
    const cursor = collection.find({ batch_id: { $type: 'string' } })
        .project({ _id: 1, batch_id: 1 })
        .batchSize(BATCH_SIZE);

    let bulkOps = [];

    for await (const doc of cursor) {
        // Validate the string is a valid 24-hex ObjectId
        if (!mongoose.Types.ObjectId.isValid(doc.batch_id)) {
            console.warn(`  Skipping _id=${doc._id}: batch_id "${doc.batch_id}" is not a valid ObjectId`);
            skipped++;
            continue;
        }

        bulkOps.push({
            updateOne: {
                filter: { _id: doc._id, batch_id: { $type: 'string' } },
                update: { $set: { batch_id: new mongoose.Types.ObjectId(doc.batch_id) } }
            }
        });

        if (bulkOps.length >= BATCH_SIZE) {
            const result = await collection.bulkWrite(bulkOps, { ordered: false });
            converted += result.modifiedCount;
            process.stdout.write(`\r  Converted ${converted}/${stringCount}...`);
            bulkOps = [];
        }
    }

    // Flush remaining
    if (bulkOps.length > 0) {
        const result = await collection.bulkWrite(bulkOps, { ordered: false });
        converted += result.modifiedCount;
    }

    console.log(`\nMigration complete: ${converted} converted, ${skipped} skipped.`);

    // Verify: count remaining strings
    const remaining = await collection.countDocuments({ batch_id: { $type: 'string' } });
    if (remaining > 0) {
        console.warn(`Warning: ${remaining} documents still have string batch_id (likely invalid ObjectId strings).`);
    } else {
        console.log('Verification passed: no string batch_id values remain.');
    }

    await mongoose.disconnect();
}

migrate().catch(err => {
    console.error('Migration failed:', err);
    process.exit(1);
});
