/**
 * Calibration Runner
 * Scores ground truth entries with a given judge config and builds accuracy matrices.
 */

const logger = require('../../../config/logger');
const { scoreResponse } = require('../qualityScorer');
const { resolveJudgeConfig } = require('../scoring/resolveJudgeConfig');
const { normalizeScoringCategory, DEFAULT_SCORING_CATEGORY } = require('../scoring/scoringConfigs');
const { throwIfJudgeCancelled } = require('../scoring/judgeCall');

/**
 * Score a batch of ground truth entries using a specific judge config.
 * @param {Array} entries - Ground truth entries (from JudgeGroundTruth.getForValidation)
 * @param {Object} judgeConfig - { model, host, timeout, temperature, num_predict }
 * @returns {Array} Array of { entry, score, breakdown, error }
 */
async function runCalibrationBatch(entries, judgeConfig) {
    const results = [];
    const resolvedJudgeConfig = resolveJudgeConfig(judgeConfig);

    for (const entry of entries) {
        try {
            throwIfJudgeCancelled(resolvedJudgeConfig);
            const result = await scoreResponse({
                response: entry.response,
                prompt: {
                    prompt: entry.prompt,
                    expected_answer: entry.expected_answer || '',
                    category: entry.category,
                    scoring_type: normalizeScoringCategory(entry.category, DEFAULT_SCORING_CATEGORY),
                    prompt_level: entry.difficulty,
                    name: entry.name || null,
                    scoring_dimensions: null
                },
                judgeConfig: resolvedJudgeConfig
            });
            throwIfJudgeCancelled(resolvedJudgeConfig);

            results.push({
                entry: { _id: entry._id, category: entry.category, difficulty: entry.difficulty },
                score: result.quality_score,
                breakdown: result.breakdown || {},
                error: null
            });
        } catch (err) {
            if (resolvedJudgeConfig.cancelSignal?.aborted || resolvedJudgeConfig.signal?.aborted) throw err;
            logger.warn('Calibration scoring failed for entry', {
                entry_id: entry._id, error: err.message
            });
            results.push({
                entry: { _id: entry._id, category: entry.category, difficulty: entry.difficulty },
                score: null,
                breakdown: {},
                error: err.message
            });
        }
    }

    return results;
}

/**
 * Build an accuracy matrix from reference and challenger score arrays.
 * @param {Array} referenceScores - [{ entry: { category, difficulty }, score }]
 * @param {Array} challengerScores - same shape
 * @param {number} passThreshold - max avg deviation to pass (default 1.5)
 * @returns {Object} entry-weighted deviation/pass rate plus cell summaries
 */
function buildAccuracyMatrix(referenceScores, challengerScores, passThreshold = 1.5) {
    const cellMap = new Map();
    const allDeviations = [];

    for (let i = 0; i < referenceScores.length; i++) {
        const ref = referenceScores[i];
        const chal = challengerScores[i];

        if (ref.score === null || chal.score === null) continue;

        const key = `${ref.entry.category}::${ref.entry.difficulty}`;
        if (!cellMap.has(key)) {
            cellMap.set(key, {
                category: ref.entry.category,
                difficulty: ref.entry.difficulty,
                deviations: []
            });
        }

        const deviation = Math.abs(ref.score - chal.score);
        cellMap.get(key).deviations.push(deviation);
        allDeviations.push(deviation);
    }

    const cells = [];
    for (const cell of cellMap.values()) {
        const avgDev = cell.deviations.reduce((a, b) => a + b, 0) / cell.deviations.length;
        const rounded = Math.round(avgDev * 100) / 100;
        cells.push({
            category: cell.category,
            difficulty: cell.difficulty,
            avg_deviation: rounded,
            sample_count: cell.deviations.length,
            pass: rounded <= passThreshold
        });
    }

    const overallAvg = allDeviations.length > 0
        ? Math.round((allDeviations.reduce((a, b) => a + b, 0) / allDeviations.length) * 100) / 100
        : 0;
    const entryPassCount = allDeviations.filter(deviation => deviation <= passThreshold).length;
    const passRate = allDeviations.length > 0
        ? Math.round((entryPassCount / allDeviations.length) * 100)
        : 0;
    const cellPassCount = cells.filter(c => c.pass).length;
    const cellPassRate = cells.length > 0 ? Math.round((cellPassCount / cells.length) * 100) : 0;

    return {
        cells,
        overall_avg_deviation: overallAvg,
        pass_rate: passRate,
        cell_pass_rate: cellPassRate,
        scored_entry_count: allDeviations.length
    };
}

module.exports = { runCalibrationBatch, buildAccuracyMatrix };
