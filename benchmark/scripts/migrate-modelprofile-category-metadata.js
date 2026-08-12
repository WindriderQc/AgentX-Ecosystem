#!/usr/bin/env node
'use strict';

/**
 * Backfill benchmark-owned modelprofiles metadata from legacy core modelregistries.
 *
 * Scope:
 * - reads legacy metadata from modelregistries in read-only mode
 * - only migrates models benchmark already knows about via modelprofiles or benchmarkresults
 * - writes only categories and benchmarkStats.bestCategory on modelprofiles
 * - upserts a minimal modelprofiles document when a benchmark-known model has no profile yet
 *
 * Usage:
 *   node scripts/migrate-modelprofile-category-metadata.js --dry-run
 *   node scripts/migrate-modelprofile-category-metadata.js
 */

const mongoose = require('mongoose');
const {
    buildMigrationPlan,
    normalizeModelName
} = require('../src/services/benchmark/modelProfileCategoryMigration');

const MONGO_URI = process.env.MONGODB_URI || 'mongodb://192.0.2.33:27017/agentx';
const DRY_RUN = process.argv.includes('--dry-run');

async function collectCounts(db) {
    const [profilesWithCategories, profilesWithBestCategory, totalProfiles] = await Promise.all([
        db.collection('modelprofiles').countDocuments({
            categories: { $exists: true, $type: 'array', $ne: [] }
        }),
        db.collection('modelprofiles').countDocuments({
            'benchmarkStats.bestCategory': { $nin: [null, ''] }
        }),
        db.collection('modelprofiles').countDocuments({})
    ]);

    return {
        totalProfiles,
        profilesWithCategories,
        profilesWithBestCategory
    };
}

async function loadMigrationInputs(db) {
    const [profileDocs, benchmarkResultNames, registryDocs] = await Promise.all([
        db.collection('modelprofiles')
            .find({}, { projection: { name: 1, categories: 1, 'benchmarkStats.bestCategory': 1 } })
            .toArray(),
        db.collection('benchmarkresults').distinct('model', { model: { $exists: true, $ne: null } }),
        db.collection('modelregistries')
            .find(
                {
                    $or: [
                        { categories: { $exists: true, $type: 'array', $ne: [] } },
                        { 'benchmarkStats.bestCategory': { $nin: [null, ''] } }
                    ]
                },
                {
                    projection: {
                        modelName: 1,
                        displayName: 1,
                        categories: 1,
                        'benchmarkStats.bestCategory': 1
                    }
                }
            )
            .toArray()
    ]);

    return { profileDocs, benchmarkResultNames, registryDocs };
}

function formatSummary({ beforeCounts, afterCounts, plan, executionResult }) {
    return {
        mongoUri: MONGO_URI,
        dryRun: DRY_RUN,
        beforeCounts,
        afterCounts,
        benchmarkKnownModels: plan.eligibleNames,
        migrationSummary: plan.summary,
        executionResult,
        details: plan.details
    };
}

async function migrate() {
    console.log(`Connecting to ${MONGO_URI}...`);
    await mongoose.connect(MONGO_URI, {
        serverSelectionTimeoutMS: 5000
    });

    const db = mongoose.connection.db;
    const beforeCounts = await collectCounts(db);
    const inputs = await loadMigrationInputs(db);
    const plan = buildMigrationPlan(inputs);

    console.log(JSON.stringify({
        stage: 'plan',
        dryRun: DRY_RUN,
        beforeCounts,
        benchmarkKnownModels: plan.eligibleNames,
        migrationSummary: plan.summary,
        details: plan.details
    }, null, 2));

    let executionResult = {
        acknowledged: DRY_RUN ? 'dry-run' : 'no-op',
        matchedCount: plan.summary.matchedRegistryDocs,
        modifiedCount: 0,
        upsertedCount: 0
    };

    if (!DRY_RUN && plan.operations.length > 0) {
        const result = await db.collection('modelprofiles').bulkWrite(plan.operations, { ordered: false });
        executionResult = {
            acknowledged: result.result?.ok === 1 ? 'executed' : 'executed',
            matchedCount: result.matchedCount || 0,
            modifiedCount: result.modifiedCount || 0,
            upsertedCount: result.upsertedCount || 0
        };
    }

    const afterCounts = await collectCounts(db);
    console.log(JSON.stringify(formatSummary({
        beforeCounts,
        afterCounts,
        plan,
        executionResult
    }), null, 2));

    const sample = await db.collection('modelprofiles')
        .find(
            { categories: { $exists: true, $type: 'array', $ne: [] } },
            { projection: { name: 1, categories: 1, 'benchmarkStats.bestCategory': 1 } }
        )
        .sort({ updatedAt: -1, name: 1 })
        .limit(5)
        .toArray();

    console.log(JSON.stringify({
        stage: 'sample',
        populatedProfiles: sample.map((doc) => ({
            name: normalizeModelName(doc.name),
            categories: doc.categories || [],
            bestCategory: doc?.benchmarkStats?.bestCategory || null
        }))
    }, null, 2));

    await mongoose.disconnect();
}

if (require.main === module) {
    migrate().catch(async (error) => {
        console.error('Migration failed:', error);
        try {
            await mongoose.disconnect();
        } catch (disconnectError) {
            console.error('Disconnect failed:', disconnectError);
        }
        process.exit(1);
    });
}

module.exports = {
    collectCounts,
    loadMigrationInputs,
    migrate
};
