/**
 * Benchmark Category Parity Validator
 * Keeps scoring categories, weight categories, and prompt coverage aligned.
 */

const logger = require('../../../config/logger');
const BenchmarkPrompt = require('../../../models/BenchmarkPrompt');
const { GENERALIST_CATEGORY_WEIGHTS } = require('../../../config/categories');
const { ENHANCED_SCORING_CONFIGS } = require('../scoring/scoringConfigs');
const { normalizeCategoryKey } = require('./generalistScore');

function uniqueNormalizedList(values) {
    const normalized = (Array.isArray(values) ? values : [])
        .map(normalizeCategoryKey)
        .filter(Boolean);
    return Array.from(new Set(normalized));
}

function toSortedDiff(from, against) {
    const rhs = new Set(Array.isArray(against) ? against : []);
    return (Array.isArray(from) ? from : [])
        .filter((item) => !rhs.has(item))
        .sort();
}

async function getCategoryParitySnapshot({ promptCategories = null } = {}) {
    const scoringCategories = uniqueNormalizedList(Object.keys(ENHANCED_SCORING_CONFIGS || {}));
    const weightCategories = uniqueNormalizedList(Object.keys(GENERALIST_CATEGORY_WEIGHTS || {}));
    const schemaCategories = uniqueNormalizedList(
        BenchmarkPrompt?.schema?.path('category')?.enumValues || []
    );

    const activePromptCategoriesRaw = promptCategories || await BenchmarkPrompt.distinct('category');
    const activePromptCategories = uniqueNormalizedList(activePromptCategoriesRaw);

    const drift = {
        in_scoring_not_in_weights: toSortedDiff(scoringCategories, weightCategories),
        in_weights_not_in_scoring: toSortedDiff(weightCategories, scoringCategories),
        in_scoring_not_in_prompt_schema: toSortedDiff(scoringCategories, schemaCategories),
        in_prompt_schema_not_in_scoring: toSortedDiff(schemaCategories, scoringCategories),
        in_scoring_not_in_active_prompts: toSortedDiff(scoringCategories, activePromptCategories),
        in_active_prompts_not_in_scoring: toSortedDiff(activePromptCategories, scoringCategories)
    };

    const hasDrift = Object.values(drift).some((items) => items.length > 0);

    return {
        hasDrift,
        scoringCategories,
        weightCategories,
        promptSchemaCategories: schemaCategories,
        activePromptCategories,
        drift
    };
}

async function validateCategoryParity({ throwOnDrift = false } = {}) {
    const snapshot = await getCategoryParitySnapshot();

    if (snapshot.hasDrift) {
        logger.warn('Benchmark category parity drift detected', snapshot.drift);
        if (throwOnDrift) {
            throw new Error(`Benchmark category parity drift: ${JSON.stringify(snapshot.drift)}`);
        }
    } else {
        logger.info('Benchmark category parity healthy', {
            categories: snapshot.scoringCategories.length
        });
    }

    return snapshot;
}

module.exports = {
    normalizeCategoryKey,
    getCategoryParitySnapshot,
    validateCategoryParity
};
