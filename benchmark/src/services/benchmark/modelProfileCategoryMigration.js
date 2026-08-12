'use strict';

function normalizeModelName(modelName) {
    return String(modelName || '').trim().replace(/:latest$/i, '');
}

function normalizeOptionalString(value) {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function normalizeCategories(categories) {
    if (!Array.isArray(categories)) {
        return [];
    }

    const seen = new Set();
    const normalized = [];

    categories.forEach((value) => {
        const category = normalizeOptionalString(value);
        if (!category || seen.has(category)) return;
        seen.add(category);
        normalized.push(category);
    });

    return normalized;
}

function areStringArraysEqual(left = [], right = []) {
    if (left.length !== right.length) {
        return false;
    }

    return left.every((value, index) => value === right[index]);
}

function buildEligibleNameSet({ profileDocs = [], benchmarkResultNames = [] } = {}) {
    const eligibleNames = new Set();

    profileDocs.forEach((doc) => {
        const normalized = normalizeModelName(doc?.name);
        if (normalized) eligibleNames.add(normalized);
    });

    benchmarkResultNames.forEach((name) => {
        const normalized = normalizeModelName(name);
        if (normalized) eligibleNames.add(normalized);
    });

    return eligibleNames;
}

function buildMigrationPlan({
    registryDocs = [],
    profileDocs = [],
    benchmarkResultNames = []
} = {}) {
    const eligibleNames = buildEligibleNameSet({ profileDocs, benchmarkResultNames });
    const existingProfilesByName = new Map();

    profileDocs.forEach((doc) => {
        const normalized = normalizeModelName(doc?.name);
        if (!normalized) return;
        existingProfilesByName.set(normalized, doc);
    });

    const summary = {
        eligibleModelCount: eligibleNames.size,
        registryDocsVisited: 0,
        matchedRegistryDocs: 0,
        skippedUnmatched: 0,
        skippedNoUsefulData: 0,
        skippedNoChange: 0,
        plannedInserts: 0,
        plannedUpdates: 0
    };

    const operations = [];
    const details = [];

    registryDocs.forEach((registryDoc) => {
        summary.registryDocsVisited += 1;

        const normalizedName = normalizeModelName(registryDoc?.modelName);
        const categories = normalizeCategories(registryDoc?.categories);
        const bestCategory = normalizeOptionalString(registryDoc?.benchmarkStats?.bestCategory);
        const hasUsefulMetadata = categories.length > 0 || Boolean(bestCategory);

        if (!normalizedName || !hasUsefulMetadata) {
            summary.skippedNoUsefulData += 1;
            return;
        }

        if (!eligibleNames.has(normalizedName)) {
            summary.skippedUnmatched += 1;
            details.push({
                modelName: normalizedName,
                action: 'skip-unmatched'
            });
            return;
        }

        summary.matchedRegistryDocs += 1;

        const existingProfile = existingProfilesByName.get(normalizedName) || null;
        const existingCategories = normalizeCategories(existingProfile?.categories);
        const existingBestCategory = normalizeOptionalString(existingProfile?.benchmarkStats?.bestCategory);
        const needsInsert = !existingProfile;
        const needsCategoryUpdate = !areStringArraysEqual(existingCategories, categories);
        const needsBestCategoryUpdate = Boolean(bestCategory) && bestCategory !== existingBestCategory;

        if (!needsInsert && !needsCategoryUpdate && !needsBestCategoryUpdate) {
            summary.skippedNoChange += 1;
            details.push({
                modelName: normalizedName,
                action: 'skip-no-change'
            });
            return;
        }

        const setFields = {};
        if (needsCategoryUpdate) {
            setFields.categories = categories;
        }
        if (needsBestCategoryUpdate) {
            setFields['benchmarkStats.bestCategory'] = bestCategory;
        }

        operations.push({
            updateOne: {
                filter: existingProfile?._id
                    ? { _id: existingProfile._id }
                    : { name: normalizedName },
                update: {
                    ...(Object.keys(setFields).length ? { $set: setFields } : {}),
                    $setOnInsert: {
                        name: normalizedName,
                        displayName: normalizeOptionalString(registryDoc?.displayName) || normalizedName.split(':')[0],
                        tags: []
                    }
                },
                upsert: true
            }
        });

        if (needsInsert) {
            summary.plannedInserts += 1;
        } else {
            summary.plannedUpdates += 1;
        }

        details.push({
            modelName: normalizedName,
            action: needsInsert ? 'insert' : 'update',
            categories,
            bestCategory
        });
    });

    return {
        eligibleNames: [...eligibleNames].sort(),
        operations,
        details,
        summary
    };
}

module.exports = {
    areStringArraysEqual,
    buildEligibleNameSet,
    buildMigrationPlan,
    normalizeCategories,
    normalizeModelName,
    normalizeOptionalString
};
