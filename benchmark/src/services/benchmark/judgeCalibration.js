const path = require('path');
const { loadConfigGoldset } = require('./retroCalibration');

function loadCalibrationSet(filePath) {
    const resolved = filePath || path.join(__dirname, '..', '..', '..', 'data', 'judge-calibration-set.json');
    return loadConfigGoldset(resolved);
}

function validateCalibrationSet(entries) {
    if (!Array.isArray(entries) || entries.length === 0) {
        throw new Error('Calibration set is empty');
    }
    const missing = entries.filter((entry) =>
        !entry.prompt
        || !entry.response
        || !entry.category
        || !Number.isFinite(Number(entry.expert_scores?.overall))
    );
    if (missing.length > 0) {
        throw new Error(`Calibration set has ${missing.length} invalid entries`);
    }
}

function evaluateCalibrationCase(entry, actual) {
    const humanScore = Number(entry.expert_scores.overall);
    const judgeScore = Number(actual.quality_score);
    const tolerance = Number.isFinite(Number(entry.tolerance)) ? Number(entry.tolerance) : 1.0;
    const absoluteError = Number.isFinite(judgeScore) ? Math.abs(judgeScore - humanScore) : null;
    const withinTolerance = absoluteError !== null && absoluteError <= tolerance;
    const expectedReview = entry.expected_review === true;
    const reviewMatch = actual.needs_review === expectedReview;

    return {
        id: entry.name || entry._id,
        category: entry.category,
        tier: entry._config_tier || null,
        human_score: humanScore,
        judge_score: Number.isFinite(judgeScore) ? judgeScore : null,
        tolerance,
        absolute_error: absoluteError,
        within_tolerance: withinTolerance,
        expected_review: expectedReview,
        needs_review: !!actual.needs_review,
        review_match: reviewMatch,
        scoring_method: actual.scoring_method || null,
        judge_confidence: actual.judge_confidence ?? null
    };
}

function summarizeCalibrationResults(results) {
    const scored = results.filter((result) => result.absolute_error !== null);
    const total = results.length;
    const within = results.filter((result) => result.within_tolerance).length;
    const reviewMatches = results.filter((result) => result.review_match).length;
    const mae = scored.length > 0
        ? scored.reduce((sum, result) => sum + result.absolute_error, 0) / scored.length
        : null;

    const byCategory = {};
    for (const result of results) {
        if (!byCategory[result.category]) {
            byCategory[result.category] = { count: 0, within_tolerance: 0, mae_sum: 0, scored: 0 };
        }
        const bucket = byCategory[result.category];
        bucket.count += 1;
        if (result.within_tolerance) bucket.within_tolerance += 1;
        if (result.absolute_error !== null) {
            bucket.scored += 1;
            bucket.mae_sum += result.absolute_error;
        }
    }

    for (const bucket of Object.values(byCategory)) {
        bucket.tolerance_rate = bucket.count > 0 ? Math.round((bucket.within_tolerance / bucket.count) * 100) : 0;
        bucket.mae = bucket.scored > 0 ? Math.round((bucket.mae_sum / bucket.scored) * 100) / 100 : null;
        delete bucket.mae_sum;
    }

    return {
        total,
        scored: scored.length,
        within_tolerance: within,
        tolerance_rate: total > 0 ? Math.round((within / total) * 100) : 0,
        review_matches: reviewMatches,
        review_match_rate: total > 0 ? Math.round((reviewMatches / total) * 100) : 0,
        mae: mae === null ? null : Math.round(mae * 100) / 100,
        by_category: byCategory
    };
}

module.exports = {
    loadCalibrationSet,
    validateCalibrationSet,
    evaluateCalibrationCase,
    summarizeCalibrationResults
};
