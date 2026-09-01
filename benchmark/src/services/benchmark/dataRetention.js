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
const BenchmarkTrustReceipt = require('../../../models/BenchmarkTrustReceipt');
const { withBenchmarkTrustEvidenceLock } = require('./benchmarkTrustEvidenceLock');

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_KEEP_BATCHES = 3;

function normalizedBatchIds(batchIds) {
    return [...new Set((batchIds || [])
        .filter(batchId => batchId !== null && batchId !== undefined)
        .map(batchId => String(batchId))
        .filter(Boolean))];
}

function emptyProtection() {
    return { batchIds: new Set(), sourceBatchIds: new Set() };
}

async function getProtectedBatches(batchIds) {
    const candidates = normalizedBatchIds(batchIds);
    if (candidates.length === 0) return emptyProtection();

    const [linkedBatches, sealedResultBatchIds] = await Promise.all([
        BenchmarkBatch.find({
            _id: { $in: candidates }
        }).select('_id trust_batch_id trust_evidence_sealed').lean(),
        BenchmarkResult.distinct('batch_id', {
            batch_id: { $in: candidates },
            trust_evidence_sealed: true
        })
    ]);
    const candidateSourceIds = linkedBatches
        .map(batch => batch.trust_batch_id)
        .filter(sourceBatchId => typeof sourceBatchId === 'string');

    // Retention is an infrequent destructive operation, so verify the complete
    // append-only ledger before trusting any indexed projection. Querying by
    // sourceBatchId first would let a tampered projection hide the very receipt
    // that should protect its linked batch.
    const storedReceipts = await BenchmarkTrustReceipt.find({}).lean();
    const candidateSourceIdSet = new Set(candidateSourceIds);
    const receiptedSourceIds = new Set(storedReceipts
        .map(record => BenchmarkTrustReceipt.verifyStoredRecord(record).execution.sourceBatchId)
        .filter(sourceBatchId => candidateSourceIdSet.has(sourceBatchId)));
    const protectedLinks = linkedBatches.filter(batch => receiptedSourceIds.has(batch.trust_batch_id));
    const protectedBatchIds = new Set([
        ...protectedLinks.map(batch => String(batch._id)),
        ...linkedBatches
            .filter(batch => batch.trust_evidence_sealed === true)
            .map(batch => String(batch._id)),
        ...normalizedBatchIds(sealedResultBatchIds)
    ]);
    return {
        batchIds: protectedBatchIds,
        sourceBatchIds: new Set(linkedBatches
            .filter(batch => protectedBatchIds.has(String(batch._id)))
            .map(batch => batch.trust_batch_id)
            .filter(sourceBatchId => typeof sourceBatchId === 'string'))
    };
}

function protectionSummary(protection, protectedResults = 0) {
    const sourceIds = [...protection.sourceBatchIds].sort();
    return {
        protectedBatches: protection.batchIds.size,
        protectedResults,
        protectedSourceBatchIds: sourceIds
    };
}

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
    }).select('_id run_name description completed_at status total_tests').lean();

    return staleBatches;
}

/**
 * Archive (delete results for) old batches while keeping batch metadata.
 * @param {number} retentionDays - Days to keep results (default 90)
 * @param {boolean} dryRun - If true, don't actually delete
 * @returns {Object} { batchesProcessed, resultsDeleted }
 */
async function archiveOldResultsUnlocked(retentionDays = DEFAULT_RETENTION_DAYS, dryRun = false) {
    const staleBatches = await getStaleBatches(retentionDays);

    if (staleBatches.length === 0) {
        return {
            batchesProcessed: 0,
            resultsDeleted: 0,
            ...protectionSummary(emptyProtection())
        };
    }

    const batchIds = staleBatches.map(b => b._id.toString());
    const protectionState = await getProtectedBatches(batchIds);
    const protectedBatchIds = protectionState.batchIds;
    const deletableBatches = staleBatches.filter(batch => !protectedBatchIds.has(batch._id.toString()));
    const deletableBatchIds = deletableBatches.map(batch => batch._id.toString());
    const protectedIds = [...protectedBatchIds];
    const [resultCount, protectedResultCount] = await Promise.all([
        deletableBatchIds.length > 0
            ? BenchmarkResult.countDocuments({ batch_id: { $in: deletableBatchIds } })
            : 0,
        protectedIds.length > 0
            ? BenchmarkResult.countDocuments({ batch_id: { $in: protectedIds } })
            : 0
    ]);
    const protection = protectionSummary(protectionState, protectedResultCount);

    if (dryRun) {
        logger.info('Dry run: would archive old batch results', {
            batches: deletableBatches.length,
            results: resultCount,
            ...protection,
            oldestBatch: deletableBatches[deletableBatches.length - 1]?.completed_at
        });
        return {
            batchesProcessed: deletableBatches.length,
            resultsDeleted: resultCount,
            ...protection,
            dryRun: true
        };
    }

    // Delete results in chunks to avoid memory spikes
    const CHUNK_SIZE = 500;
    let totalDeleted = 0;
    for (let i = 0; i < deletableBatchIds.length; i += CHUNK_SIZE) {
        const chunk = deletableBatchIds.slice(i, i + CHUNK_SIZE);
        const { deletedCount } = await BenchmarkResult.deleteMany({ batch_id: { $in: chunk } });
        totalDeleted += deletedCount;
    }

    // Delete externalized timeline entries for archived batches
    const staleBatchObjectIds = deletableBatches.map(b => b._id);
    if (staleBatchObjectIds.length > 0) {
        await BenchmarkTimelineEntry.deleteMany({ batchId: { $in: staleBatchObjectIds } }).catch(() => {});

        // Compact only unreferenced archived batches. A receipt protects both
        // the external results and the batch-local evidence arrays it binds.
        // BenchmarkBatch rejects every update pipeline so no computed field
        // expression can dynamically reach trust source context. The stale
        // rows were read under the shared evidence lock, so compact them with
        // explicit classic updates instead.
        await Promise.all(deletableBatches.map(batch => BenchmarkBatch.updateOne(
            { _id: batch._id },
            {
                $set: {
                    timeline: [],
                    results: [],
                    description: `${batch.description || ''} [archived]`
                }
            }
        )));
    }

    logger.info('Archived old batch results', {
        batchesProcessed: deletableBatches.length,
        resultsDeleted: totalDeleted,
        ...protection,
        retentionDays
    });

    return {
        batchesProcessed: deletableBatches.length,
        resultsDeleted: totalDeleted,
        ...protection
    };
}

async function archiveOldResults(retentionDays = DEFAULT_RETENTION_DAYS, dryRun = false) {
    if (dryRun) return archiveOldResultsUnlocked(retentionDays, true);
    return withBenchmarkTrustEvidenceLock(
        'archive-old-benchmark-results',
        () => archiveOldResultsUnlocked(retentionDays, false)
    );
}

/**
 * Identify models with excessive batches and find which results to prune.
 * Keeps only the latest N batches per model.
 * @param {number} keepBatches - Number of recent batches to keep per model (default 3)
 * @param {boolean} dryRun - If true, don't actually delete
 * @returns {Object} { modelsProcessed, resultsDeleted }
 */
async function pruneExcessBatchesUnlocked(keepBatches = DEFAULT_KEEP_BATCHES, dryRun = false) {
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

    const candidateBatchIds = batchesByModel.flatMap(modelGroup => (
        modelGroup.batches.slice(keepBatches).map(batch => batch.batchId)
    ));
    const protectionState = await getProtectedBatches(candidateBatchIds);
    const protectedBatchIds = protectionState.batchIds;
    const protectedIds = [...protectedBatchIds];
    let modelsProcessed = 0;
    let modelsProtected = 0;
    let totalDeleted = 0;
    let totalProtected = 0;

    for (const modelGroup of batchesByModel) {
        const model = modelGroup._id;
        const excessBatches = modelGroup.batches.slice(keepBatches);
        const batchIds = excessBatches.map(b => b.batchId);
        const deletableBatchIds = batchIds.filter(batchId => !protectedBatchIds.has(String(batchId)));
        const protectedModelBatchIds = batchIds.filter(batchId => protectedBatchIds.has(String(batchId)));

        if (batchIds.length === 0) continue;

        const [count, protectedCount] = await Promise.all([
            deletableBatchIds.length > 0
                ? BenchmarkResult.countDocuments({ model, batch_id: { $in: deletableBatchIds } })
                : 0,
            protectedModelBatchIds.length > 0
                ? BenchmarkResult.countDocuments({ model, batch_id: { $in: protectedModelBatchIds } })
                : 0
        ]);
        if (protectedCount > 0) {
            modelsProtected++;
            totalProtected += protectedCount;
        }

        if (count === 0) continue;

        if (!dryRun) {
            const { deletedCount } = await BenchmarkResult.deleteMany({
                model,
                batch_id: { $in: deletableBatchIds }
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
        modelsProtected,
        protectedResults: totalProtected,
        protectedBatches: protectedIds.length,
        keepBatches,
        dryRun
    });

    return {
        modelsProcessed,
        resultsDeleted: totalDeleted,
        modelsProtected,
        ...protectionSummary(protectionState, totalProtected),
        dryRun: !!dryRun
    };
}

async function pruneExcessBatches(keepBatches = DEFAULT_KEEP_BATCHES, dryRun = false) {
    if (dryRun) return pruneExcessBatchesUnlocked(keepBatches, true);
    return withBenchmarkTrustEvidenceLock(
        'prune-excess-benchmark-results',
        () => pruneExcessBatchesUnlocked(keepBatches, false)
    );
}

/**
 * Purge all results from dead/filtered models (100% empty responses).
 * @param {boolean} dryRun - If true, count but don't delete
 * @returns {Object} { modelsDeleted, resultsDeleted }
 */
async function purgeDeadModelsUnlocked(dryRun = false) {
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
        return {
            modelsDeleted: 0,
            resultsDeleted: 0,
            modelsProtected: 0,
            ...protectionSummary(emptyProtection())
        };
    }

    const modelFilters = emptyModels.map(model => ({ model: model._id.model, host: model._id.host }));
    const candidateBatchIds = await BenchmarkResult.distinct('batch_id', { $or: modelFilters });
    const protectionState = await getProtectedBatches(candidateBatchIds);
    const protectedBatchIds = protectionState.batchIds;
    const protectedIds = [...protectedBatchIds];
    let totalDeleted = 0;
    let totalProtected = 0;
    const purgedModels = [];
    const protectedModels = [];

    for (const m of emptyModels) {
        const filter = { model: m._id.model, host: m._id.host };
        const deletableFilter = protectedIds.length > 0
            ? { ...filter, batch_id: { $nin: protectedIds } }
            : filter;
        const [count, protectedCount] = await Promise.all([
            BenchmarkResult.countDocuments(deletableFilter),
            protectedIds.length > 0
                ? BenchmarkResult.countDocuments({ ...filter, batch_id: { $in: protectedIds } })
                : 0
        ]);

        if (count > 0) {
            if (!dryRun) {
                const { deletedCount } = await BenchmarkResult.deleteMany(deletableFilter);
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

        if (protectedCount > 0) {
            totalProtected += protectedCount;
            protectedModels.push({
                model: m._id.model,
                host: m._id.host,
                results: protectedCount,
                emptyRate: Math.round(m.emptyRate * 100)
            });
        }
    }

    logger.info('Purged dead models', {
        modelsDeleted: purgedModels.length,
        resultsDeleted: totalDeleted,
        modelsProtected: protectedModels.length,
        protectedResults: totalProtected,
        protectedBatches: protectedIds.length,
        models: purgedModels.map(m => m.model),
        dryRun
    });

    return {
        modelsDeleted: purgedModels.length,
        resultsDeleted: totalDeleted,
        models: purgedModels,
        modelsProtected: protectedModels.length,
        ...protectionSummary(protectionState, totalProtected),
        dryRun: !!dryRun
    };
}

async function purgeDeadModels(dryRun = false) {
    if (dryRun) return purgeDeadModelsUnlocked(true);
    return withBenchmarkTrustEvidenceLock(
        'purge-dead-benchmark-results',
        () => purgeDeadModelsUnlocked(false)
    );
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
    getProtectedBatches,
    getStaleBatches,
    archiveOldResults,
    pruneExcessBatches,
    purgeDeadModels,
    getRetentionStats
};
