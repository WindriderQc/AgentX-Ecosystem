const path = require('path');
const { loadConfigGoldset } = require('./retroCalibration');

function finiteValue(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function calibrationScore(value) {
    const numeric = finiteValue(value);
    return numeric !== null && numeric >= 0 && numeric <= 10 ? numeric : null;
}

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
        || calibrationScore(entry.expert_scores?.overall) === null
    );
    if (missing.length > 0) {
        throw new Error(`Calibration set has ${missing.length} invalid entries`);
    }
}

function evaluateCalibrationCase(entry, actual) {
    const humanScore = calibrationScore(entry.expert_scores.overall);
    const judgeScore = calibrationScore(actual.quality_score);
    const specifiedTolerance = finiteValue(entry.tolerance);
    const tolerance = specifiedTolerance !== null && specifiedTolerance >= 0 ? specifiedTolerance : 1.0;
    const absoluteError = judgeScore !== null && humanScore !== null ? Math.abs(judgeScore - humanScore) : null;
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

function isAccuracyCalibrationValid(summary) {
    // Correlation measures ordering and can be perfect despite a large bias.
    // Use the existing calibration tolerances and require every case scored.
    return summary.total > 0 && summary.scored === summary.total
        && Number.isFinite(summary.correlation) && summary.correlation >= 0.8
        && Number.isFinite(summary.mae) && summary.mae <= 1.5
        && Number.isFinite(summary.agreement_rate) && summary.agreement_rate >= 75;
}

module.exports = {
    isAccuracyCalibrationValid,
    loadCalibrationSet,
    validateCalibrationSet,
    evaluateCalibrationCase,
    summarizeCalibrationResults
};
