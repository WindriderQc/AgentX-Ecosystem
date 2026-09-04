const BenchmarkResult = require('../../../models/BenchmarkResult');
const HostPerformanceSnapshot = require('../../../models/HostPerformanceSnapshot');
const ModelProfile = require('../../../models/ModelProfile');
const { normalizeModelTag: normalizeModelName } = require('../../../../shared/modelNames');

function inferModelCategory(modelName) {
    const normalized = normalizeModelName(modelName).toLowerCase();
    if (!normalized) return 'generalist';
    if (/(embed|bge-|nomic-embed|mxbai-embed|snowflake-arctic-embed|all-minilm)/.test(normalized)) return 'embedding';
    if (/(coder|codegemma|deepseek-coder|starcoder|codellama)/.test(normalized)) return 'coding';
    if (/(reason|r1|math|logic|think)/.test(normalized)) return 'reasoning';
    if (/(ops|tool|function|router|command)/.test(normalized)) return 'ops';
    if (/(judge|reward|critic)/.test(normalized)) return 'judge';
    return 'generalist';
}

function getTopCategoryFromAverages(categoryAverages = {}, modelName = '') {
    const entries = Object.entries(categoryAverages || {}).filter(([, value]) => (
        value !== null && value !== undefined && Number.isFinite(Number(value))
    ));
    if (!entries.length) {
        return inferModelCategory(modelName);
    }

    entries.sort((left, right) => {
        const scoreDelta = Number(right[1]) - Number(left[1]);
        if (scoreDelta !== 0) return scoreDelta;
        return String(left[0]).localeCompare(String(right[0]));
    });

    return String(entries[0][0] || inferModelCategory(modelName)).toLowerCase();
}

async function getRecommendedCategoriesByModel(modelNames = [], matchQuery = {}) {
    const normalizedNames = [...new Set((modelNames || []).map(normalizeModelName).filter(Boolean))];
    const categoryMap = new Map();

    if (normalizedNames.length === 0) {
        return categoryMap;
    }

    const aggregateMatch = {
        ...(matchQuery || {}),
        success: true,
        infra_error: { $ne: true },
        needs_review: { $ne: true },
        excluded_from_leaderboard: { $ne: true },
        quality_score: { $ne: null },
        model: { $in: normalizedNames }
    };

    const rows = await BenchmarkResult.aggregate([
        { $match: aggregateMatch },
        {
            $group: {
                _id: {
                    model: '$model',
                    category: '$prompt_category'
                },
                avg_quality: { $avg: '$quality_score' },
                count: { $sum: 1 }
            }
        }
    ]);

    const grouped = new Map();
    rows.forEach((row) => {
        const model = normalizeModelName(row?._id?.model);
        const category = String(row?._id?.category || '').trim().toLowerCase();
        if (!model || !category) return;
        if (!grouped.has(model)) grouped.set(model, []);
        grouped.get(model).push({
            category,
            avg_quality: Number(row.avg_quality) || 0,
            count: Number(row.count) || 0
        });
    });

    const registryDocs = await ModelProfile.find({
        name: { $in: normalizedNames }
    }).lean();

    const registryCategoryMap = new Map();
    registryDocs.forEach((doc) => {
        const normalized = normalizeModelName(doc.name);
        if (!normalized) return;
        registryCategoryMap.set(normalized, {
            recommended: doc?.benchmarkStats?.bestCategory || null,
            manual: Array.isArray(doc?.categories)
                ? doc.categories
                : (typeof doc?.categories === 'string' && doc.categories.trim() ? [doc.categories.trim()] : [])
        });
    });

    normalizedNames.forEach((modelName) => {
        const categories = grouped.get(modelName) || [];
        if (!categories.length) {
            categoryMap.set(
                modelName,
                registryCategoryMap.get(modelName)?.recommended || inferModelCategory(modelName)
            );
            return;
        }

        categories.sort((left, right) => {
            const scoreDelta = right.avg_quality - left.avg_quality;
            if (scoreDelta !== 0) return scoreDelta;
            const countDelta = right.count - left.count;
            if (countDelta !== 0) return countDelta;
            return left.category.localeCompare(right.category);
        });

        categoryMap.set(modelName, categories[0].category);
    });

    return categoryMap;
}

async function getModelsForCategory(category, matchQuery = {}) {
    const normalizedCategory = String(category || '').trim().toLowerCase();
    if (!normalizedCategory) return [];

    const modelNames = await BenchmarkResult.distinct('model', {
        ...(matchQuery || {}),
        model: { $exists: true, $ne: null }
    });

    const categoryMap = await getRecommendedCategoriesByModel(modelNames, matchQuery);
    return modelNames.filter((modelName) => categoryMap.get(normalizeModelName(modelName)) === normalizedCategory);
}

function buildHostPerformanceSnapshot(snapshot) {
    if (!snapshot) return null;
    return {
        status: snapshot.status || null,
        testedAt: snapshot.testedAt || null,
        tokensPerSec: snapshot.tokensPerSec ?? null,
        promptEvalTokensPerSec: snapshot.promptEvalTokensPerSec ?? null,
        latencyMs: snapshot.latencyMs ?? null,
        timeToFirstTokenMs: snapshot.timeToFirstTokenMs ?? null,
        ttftMeasurement: snapshot.ttftMeasurement || undefined,
        vramUsedMiB: snapshot.vramUsedMiB ?? null,
        vramTotalMiB: snapshot.vramTotalMiB ?? null,
        numCtx: snapshot.numCtx ?? null,
        numCtxSource: snapshot.numCtxSource ?? null,
        error: snapshot.error || null,
        source: snapshot.source || 'benchmark_host_test'
    };
}

async function getLatestHardwareSnapshotsForModels(modelNames = []) {
    const normalizedNames = [...new Set((modelNames || []).map(normalizeModelName).filter(Boolean))];
    const snapshotsByModel = {};

    if (!normalizedNames.length) {
        return snapshotsByModel;
    }

    const snapshots = await HostPerformanceSnapshot.find({
        modelName: { $in: normalizedNames },
        authorityState: { $nin: ['authority_invalidated', 'pending_reconciliation'] }
    })
        .sort({ testedAt: -1 })
        .lean();

    snapshots.forEach((snapshot) => {
        const model = normalizeModelName(snapshot.modelName);
        const host = String(snapshot.hostUrl || '');
        if (!model) return;
        if (!snapshotsByModel[model]) {
            snapshotsByModel[model] = {
                latestAny: null,
                latestPass: null,
                byHost: {}
            };
        }

        const shapedSnapshot = buildHostPerformanceSnapshot(snapshot);
        if (!snapshotsByModel[model].latestAny) snapshotsByModel[model].latestAny = shapedSnapshot;
        if (!snapshotsByModel[model].latestPass && shapedSnapshot.status === 'pass') {
            snapshotsByModel[model].latestPass = shapedSnapshot;
        }

        if (!snapshotsByModel[model].byHost[host]) {
            snapshotsByModel[model].byHost[host] = {
                latest: shapedSnapshot,
                latestPass: shapedSnapshot.status === 'pass' ? shapedSnapshot : null
            };
        } else if (!snapshotsByModel[model].byHost[host].latestPass && shapedSnapshot.status === 'pass') {
            snapshotsByModel[model].byHost[host].latestPass = shapedSnapshot;
        }
    });

    return snapshotsByModel;
}

async function getRegistryMetadataByModel(modelNames = []) {
    const normalizedNames = [...new Set((modelNames || []).map(normalizeModelName).filter(Boolean))];
    const metadataMap = new Map();

    if (!normalizedNames.length) {
        return metadataMap;
    }

    const docs = await ModelProfile.find({
        name: { $in: normalizedNames }
    }).lean();

    docs.forEach((doc) => {
        const modelName = normalizeModelName(doc.name);
        if (!modelName) return;
        metadataMap.set(modelName, {
            recommendedCategory: doc?.benchmarkStats?.bestCategory || null,
            manualCategories: Array.isArray(doc?.categories)
                ? doc.categories
                : (typeof doc?.categories === 'string' && doc.categories.trim() ? [doc.categories.trim()] : [])
        });
    });

    return metadataMap;
}

module.exports = {
    normalizeModelName,
    inferModelCategory,
    getTopCategoryFromAverages,
    getRecommendedCategoriesByModel,
    getModelsForCategory,
    getLatestHardwareSnapshotsForModels,
    getRegistryMetadataByModel
};
