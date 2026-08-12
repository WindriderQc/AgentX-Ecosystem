/**
 * Data Retention & Cleanup
 * ========================
 *
 * Manages benchmark data lifecycle:
 * - Archive results from old batches (> retention period)
 * - Keep only latest N batches per model for active leaderboard
 * - Purge results from filtered/dead models
 * - Compact timeline data from completed batches
 *
 * Used by: scheduled cleanup, admin API
 */

const logger = require('../../../config/logger');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkTimelineEntry = require('../../../models/BenchmarkTimelineEntry');

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_KEEP_BATCHES = 3;

/**
 * Get stale batches older than retention period.
 * @param {number} retentionDays - Days to keep (default 90)
 * @returns {Array} Batch IDs eligible for archival
 */
async function getStaleBatches(retentionDays = DEFAULT_RETENTION_DAYS) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const staleBatches = await BenchmarkBatch.find({
        status: { $in: ['completed', 'failed', 'stopped', 'interrupted'] },
        completed_at: { $lt: cutoff }
    }).select('_id run_name completed_at status total_tests').lean();

    return staleBatches;
}

/**
 * Archive (delete results for) old batches while keeping batch metadata.
 * @param {number} retentionDays - Days to keep results (default 90)
 * @param {boolean} dryRun - If true, don't actually delete
 * @returns {Object} { batchesProcessed, resultsDeleted }
 */
async function archiveOldResults(retentionDays = DEFAULT_RETENTION_DAYS, dryRun = false) {
    const staleBatches = await getStaleBatches(retentionDays);

    if (staleBatches.length === 0) {
        return { batchesProcessed: 0, resultsDeleted: 0 };
    }

    const batchIds = staleBatches.map(b => b._id.toString());
    const resultCount = await BenchmarkResult.countDocuments({ batch_id: { $in: batchIds } });

    if (dryRun) {
        logger.info('Dry run: would archive old batch results', {
            batches: staleBatches.length,
            results: resultCount,
            oldestBatch: staleBatches[staleBatches.length - 1]?.completed_at
        });
        return { batchesProcessed: staleBatches.length, resultsDeleted: resultCount, dryRun: true };
    }

    // Delete results in chunks to avoid memory spikes
    const CHUNK_SIZE = 500;
    let totalDeleted = 0;
    for (let i = 0; i < batchIds.length; i += CHUNK_SIZE) {
        const chunk = batchIds.slice(i, i + CHUNK_SIZE);
        const { deletedCount } = await BenchmarkResult.deleteMany({ batch_id: { $in: chunk } });
        totalDeleted += deletedCount;
    }

    // Delete externalized timeline entries for archived batches
    const staleBatchObjectIds = staleBatches.map(b => b._id);
    await BenchmarkTimelineEntry.deleteMany({ batchId: { $in: staleBatchObjectIds } }).catch(() => {});

    // Compact archived batches (clear embedded arrays, mark description)
    await BenchmarkBatch.updateMany(
        { _id: { $in: staleBatchObjectIds } },
        [
            {
                $set: {
                    timeline: [],
                    results: [],
                    // Append [archived] to each batch's own description (pipeline update)
                    description: {
                        $concat: [{ $ifNull: ['$description', ''] }, ' [archived]']
                    }
                }
            }
        ]
    );

    logger.info('Archived old batch results', {
        batchesProcessed: staleBatches.length,
        resultsDeleted: totalDeleted,
        retentionDays
    });

    return { batchesProcessed: staleBatches.length, resultsDeleted: totalDeleted };
}

/**
 * Identify models with excessive batches and find which results to prune.
 * Keeps only the latest N batches per model.
 * @param {number} keepBatches - Number of recent batches to keep per model (default 3)
 * @param {boolean} dryRun - If true, don't actually delete
 * @returns {Object} { modelsProcessed, resultsDeleted }
 */
async function pruneExcessBatches(keepBatches = DEFAULT_KEEP_BATCHES, dryRun = false) {
    // Get all completed batches grouped by model
    const batchesByModel = await BenchmarkBatch.aggregate([
        { $match: { status: 'completed' } },
        { $unwind: '$models' },
        { $sort: { completed_at: -1 } },
        {
            $group: {
                _id: '$models',
                batches: {
                    $push: {
                        batchId: { $toString: '$_id' },
                        completedAt: '$completed_at'
                    }
                },
                count: { $sum: 1 }
            }
        },
        { $match: { count: { $gt: keepBatches } } }
    ]);

    let modelsProcessed = 0;
    let totalDeleted = 0;

    for (const modelGroup of batchesByModel) {
        const model = modelGroup._id;
        const excessBatches = modelGroup.batches.slice(keepBatches);
        const batchIds = excessBatches.map(b => b.batchId);

        if (batchIds.length === 0) continue;

        const count = await BenchmarkResult.countDocuments({
            model,
            batch_id: { $in: batchIds }
        });

        if (count === 0) continue;

        if (!dryRun) {
            const { deletedCount } = await BenchmarkResult.deleteMany({
                model,
                batch_id: { $in: batchIds }
            });
            totalDeleted += deletedCount;
        } else {
            totalDeleted += count;
        }
        modelsProcessed++;
    }

    logger.info('Pruned excess batch results', {
        modelsProcessed,
        resultsDeleted: totalDeleted,
        keepBatches,
        dryRun
    });

    return { modelsProcessed, resultsDeleted: totalDeleted, dryRun: !!dryRun };
}

/**
 * Purge all results from dead/filtered models (100% empty responses).
 * @param {boolean} dryRun - If true, count but don't delete
 * @returns {Object} { modelsDeleted, resultsDeleted }
 */
async function purgeDeadModels(dryRun = false) {
    // Find models with 100% empty responses
    const emptyModels = await BenchmarkResult.aggregate([
        { $match: { success: true } },
        {
            $group: {
                _id: { model: '$model', host: '$host' },
                total: { $sum: 1 },
                empty: {
                    $sum: {
                        $cond: [{ $eq: ['$scoring_method', 'empty_response'] }, 1, 0]
                    }
                }
            }
        },
        {
            $addFields: {
                emptyRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$empty', '$total'] }, 0] }
            }
        },
        { $match: { emptyRate: { $gte: 0.95 } } }
    ]);

    if (emptyModels.length === 0) {
        return { modelsDeleted: 0, resultsDeleted: 0 };
    }

    let totalDeleted = 0;
    const purgedModels = [];

    for (const m of emptyModels) {
        const filter = { model: m._id.model, host: m._id.host };
        const count = await BenchmarkResult.countDocuments(filter);

        if (!dryRun) {
            const { deletedCount } = await BenchmarkResult.deleteMany(filter);
            totalDeleted += deletedCount;
        } else {
            totalDeleted += count;
        }

        purgedModels.push({
            model: m._id.model,
            host: m._id.host,
            results: count,
            emptyRate: Math.round(m.emptyRate * 100)
        });
    }

    logger.info('Purged dead models', {
        modelsDeleted: purgedModels.length,
        resultsDeleted: totalDeleted,
        models: purgedModels.map(m => m.model),
        dryRun
    });

    return {
        modelsDeleted: purgedModels.length,
        resultsDeleted: totalDeleted,
        models: purgedModels,
        dryRun: !!dryRun
    };
}

/**
 * Get overall retention statistics.
 * @returns {Object} Stats about data volume and cleanup potential
 */
async function getRetentionStats() {
    const [totalResults, totalBatches, oldBatches, emptyModelStats] = await Promise.all([
        BenchmarkResult.countDocuments(),
        BenchmarkBatch.countDocuments(),
        getStaleBatches(DEFAULT_RETENTION_DAYS),
        BenchmarkResult.aggregate([
            { $match: { success: true } },
            {
                $group: {
                    _id: { model: '$model', host: '$host' },
                    total: { $sum: 1 },
                    empty: {
                        $sum: {
                            $cond: [{ $eq: ['$scoring_method', 'empty_response'] }, 1, 0]
                        }
                    }
                }
            },
            {
                $addFields: {
                    emptyRate: { $cond: [{ $gt: ['$total', 0] }, { $divide: ['$empty', '$total'] }, 0] }
                }
            },
            { $match: { emptyRate: { $gte: 0.95 } } }
        ])
    ]);

    const deadModelResults = emptyModelStats.reduce((sum, m) => sum + m.total, 0);

    return {
        totalResults,
        totalBatches,
        staleBatches: oldBatches.length,
        deadModels: emptyModelStats.length,
        deadModelResults,
        retentionDays: DEFAULT_RETENTION_DAYS,
        keepBatches: DEFAULT_KEEP_BATCHES
    };
}

module.exports = {
    DEFAULT_RETENTION_DAYS,
    DEFAULT_KEEP_BATCHES,
    getStaleBatches,
    archiveOldResults,
    pruneExcessBatches,
    purgeDeadModels,
    getRetentionStats
};
