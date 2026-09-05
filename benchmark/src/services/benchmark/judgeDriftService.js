/**
 * 0129 — Judge Drift Service
 *
 * Computes per-category Pearson ρ between judge scores and human scores from
 * the latest N courthouse-review entries. Compares against the currently
 * active CalibrationBaseline and classifies drift status.
 *
 * Drift alert fires when a category's ρ either:
 *   (a) drops by ≥ 15 percentage points from baseline, OR
 *   (b) falls below 0.5 absolute.
 *
 * Either condition triggers — quarterly-boundary evaluation. Callers batch
 * reviews into a window before calling computeDrift; this service only returns
 * product-owned drift evidence and does not write to an external Data service.
 */

const logger = require('../../../config/logger');
const CalibrationBaseline = require('../../../models/CalibrationBaseline');
const {
    calculatePearsonCorrelation
} = require('../judgeValidationHelpers');
const { CATEGORIES, loadQualifiedHumanGroundTruth } = require('./retroCalibration');

const JUDGE_IDENTITY_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const SCORE_MIN = 0;
const SCORE_MAX = 10;
const MAX_PER_CATEGORY_SAMPLE_SIZE = 1000;

const DRIFT_THRESHOLDS = {
    drop_pp: 0.15,              // drop of 15 percentage points
    absolute_floor: 0.5,        // any slip below this fires
    min_sample_size: 5          // below this → insufficient_data
};

function requireJudgeIdentityFingerprint(value) {
    if (typeof value !== 'string' || !JUDGE_IDENTITY_FINGERPRINT_PATTERN.test(value)) {
        const error = new Error('judge_identity_fingerprint must be a 64-character lowercase SHA-256 fingerprint');
        error.code = 'INVALID_JUDGE_IDENTITY_FINGERPRINT';
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function isFiniteCorrelation(value) {
    return Number.isFinite(value) && value >= -1 && value <= 1;
}

function isFiniteScore(value) {
    return Number.isFinite(value) && value >= SCORE_MIN && value <= SCORE_MAX;
}

function isNonNegativeInteger(value) {
    return Number.isSafeInteger(value) && value >= 0;
}

function requirePerCategorySampleSize(value) {
    if (!Number.isSafeInteger(value)
        || value < DRIFT_THRESHOLDS.min_sample_size
        || value > MAX_PER_CATEGORY_SAMPLE_SIZE) {
        const error = new Error(
            `perCategory must be a safe integer from ${DRIFT_THRESHOLDS.min_sample_size} through ${MAX_PER_CATEGORY_SAMPLE_SIZE}`
        );
        error.code = 'INVALID_DRIFT_SAMPLE_SIZE';
        error.statusCode = 400;
        throw error;
    }
    return value;
}

function inspectBaselineContract(baseline) {
    if (!baseline) return [];

    const reasons = [];
    if (!isFiniteCorrelation(baseline.overall_rho)) {
        reasons.push('invalid_baseline_overall_correlation');
    }
    if (!isNonNegativeInteger(baseline.overall_sample_size)) {
        reasons.push('invalid_baseline_overall_sample_size');
    }
    if (baseline.categories !== undefined && !Array.isArray(baseline.categories)) {
        reasons.push('invalid_baseline_categories');
        return reasons;
    }

    const seen = new Set();
    for (const row of baseline.categories || []) {
        if (!row || !CATEGORIES.includes(row.category)) {
            reasons.push('invalid_baseline_category');
            continue;
        }
        if (seen.has(row.category)) reasons.push('duplicate_baseline_category');
        seen.add(row.category);
        if (!isFiniteCorrelation(row.rho)) reasons.push('invalid_baseline_correlation');
        if (!isNonNegativeInteger(row.sample_size)
            || row.sample_size < DRIFT_THRESHOLDS.min_sample_size) {
            reasons.push('invalid_baseline_sample_size');
        }
        if (row.mae !== null && row.mae !== undefined
            && (!Number.isFinite(row.mae) || row.mae < 0)) {
            reasons.push('invalid_baseline_mae');
        }
        if (row.bias !== null && row.bias !== undefined && !Number.isFinite(row.bias)) {
            reasons.push('invalid_baseline_bias');
        }
    }
    if (seen.size !== CATEGORIES.length
        || CATEGORIES.some(category => !seen.has(category))) {
        reasons.push('incomplete_baseline_categories');
    }
    const categorySampleTotal = (baseline.categories || []).reduce((total, row) => (
        total + (isNonNegativeInteger(row?.sample_size) ? row.sample_size : 0)
    ), 0);
    if (isNonNegativeInteger(baseline.overall_sample_size)
        && baseline.overall_sample_size !== categorySampleTotal) {
        reasons.push('inconsistent_baseline_sample_size');
    }
    return [...new Set(reasons)];
}

/**
 * Classify a single category's drift status.
 * @param {number|null} current_rho
 * @param {number|null} baseline_rho
 * @param {number} sample_size
 * @returns { status: 'ok'|'warning'|'alert'|'insufficient_data'|'no_baseline',
 *           drop_pp, reasons, triggered }
 */
function classifyDrift(current_rho, baseline_rho, sample_size) {
    if (!isNonNegativeInteger(sample_size)) {
        return {
            status: 'insufficient_data',
            drop_pp: 0,
            reasons: ['invalid_sample_size'],
            triggered: false
        };
    }
    if (sample_size < DRIFT_THRESHOLDS.min_sample_size) {
        return { status: 'insufficient_data', drop_pp: 0, reasons: [], triggered: false };
    }
    if (current_rho === null || current_rho === undefined) {
        return { status: 'insufficient_data', drop_pp: 0, reasons: [], triggered: false };
    }
    if (!isFiniteCorrelation(current_rho)) {
        return {
            status: 'insufficient_data',
            drop_pp: 0,
            reasons: ['invalid_current_correlation'],
            triggered: false
        };
    }
    if (baseline_rho === null || baseline_rho === undefined) {
        return { status: 'no_baseline', drop_pp: 0, reasons: [], triggered: false };
    }
    if (!isFiniteCorrelation(baseline_rho)) {
        return {
            status: 'insufficient_data',
            drop_pp: 0,
            reasons: ['invalid_baseline_correlation'],
            triggered: false
        };
    }

    const reasons = [];
    const drop_pp = baseline_rho - current_rho; // positive = regression
    if (drop_pp >= DRIFT_THRESHOLDS.drop_pp) reasons.push('drop_15pp');
    if (current_rho < DRIFT_THRESHOLDS.absolute_floor) reasons.push('absolute_floor');

    const triggered = reasons.length > 0;
    let status = 'ok';
    if (triggered) status = 'alert';
    else if (drop_pp >= DRIFT_THRESHOLDS.drop_pp / 2) status = 'warning'; // 7.5pp nudge
    else if (current_rho < DRIFT_THRESHOLDS.absolute_floor + 0.1) status = 'warning';

    return { status, drop_pp: Math.round(drop_pp * 1000) / 1000, reasons, triggered };
}

/**
 * Pull the latest N (default 30) independently authored or adjudicated human
 * reviews per category. Historical source labels alone are not qualification.
 * Returns pairs suitable for Pearson computation.
 *
 * @param {number} perCategory - default 30
 * @param {Array<string>} [categories]
 * @param {string} judgeIdentityFingerprint - exact lowercase SHA-256 identity
 * @returns {Object} { [category]: { judge: number[], human: number[], entries: [...] } }
 */
async function gatherReviewSample(
    perCategory = 30,
    categories = CATEGORIES,
    judgeIdentityFingerprint
) {
    requirePerCategorySampleSize(perCategory);
    const exactJudgeIdentity = requireJudgeIdentityFingerprint(judgeIdentityFingerprint);
    const result = {};
    for (const cat of categories) {
        const qualifiedHuman = await loadQualifiedHumanGroundTruth({
            category: cat,
            judge_identity_fingerprint: exactJudgeIdentity
        });
        const scoreBearing = qualifiedHuman
            .filter(d => d.expert_scores?.overall !== null
                && d.expert_scores?.overall !== undefined
                && d.judge_score_at_review !== null
                && d.judge_score_at_review !== undefined)
            .sort((a, b) => {
                const bDate = new Date(b.reviewed_at || b.createdAt || 0).getTime();
                const aDate = new Date(a.reviewed_at || a.createdAt || 0).getTime();
                return bDate - aDate;
            })
            .slice(0, perCategory);
        const invalidNumeric = scoreBearing.filter(d => (
            !isFiniteScore(d.judge_score_at_review)
            || !isFiniteScore(d.expert_scores?.overall)
        ));
        const scored = scoreBearing.filter(d => (
            isFiniteScore(d.judge_score_at_review)
            && isFiniteScore(d.expert_scores?.overall)
        ));

        result[cat] = {
            judge: scored.map(d => d.judge_score_at_review),
            human: scored.map(d => d.expert_scores?.overall),
            entries: scored,
            qualified_human_count: qualifiedHuman.length,
            scored_count: scored.length,
            unscored_qualified_human_count: Math.max(0, qualifiedHuman.length - scored.length),
            invalid_numeric_count: invalidNumeric.length,
            sample_source: 'qualified_human_ground_truth'
        };
    }
    return result;
}

/**
 * Compute drift for every category. Returns structure consumable by the
 * /api/benchmark/drift endpoint and the dashboard row.
 *
 * @param {Object} options - { perCategory=30, judge_identity_fingerprint }
 * @returns {Object} { categories: [...], overall_status, baseline_label, ... }
 */
async function computeDrift(options = {}) {
    const perCategory = requirePerCategorySampleSize(options.perCategory ?? 30);
    const judgeIdentityFingerprint = requireJudgeIdentityFingerprint(
        options.judge_identity_fingerprint
    );
    if (Object.prototype.hasOwnProperty.call(options, 'baseline')) {
        const error = new Error('caller-supplied calibration baselines are forbidden; the active exact-identity baseline is authoritative');
        error.code = 'CALLER_SUPPLIED_CALIBRATION_BASELINE_FORBIDDEN';
        error.statusCode = 400;
        throw error;
    }

    const baselineCandidate = (await CalibrationBaseline.getActive(judgeIdentityFingerprint)) || null;
    const baselineIdentityMismatch = Boolean(
        baselineCandidate
        && baselineCandidate.judge_identity_fingerprint !== judgeIdentityFingerprint
    );
    const baseline = baselineIdentityMismatch ? null : baselineCandidate;
    const baselineUnavailableReason = baselineIdentityMismatch
        ? 'baseline_identity_mismatch'
        : (!baseline ? 'baseline_not_found' : null);
    const baselineContractReasons = inspectBaselineContract(baseline);
    const baselineContractInvalid = baselineContractReasons.length > 0;

    const baselineMap = {};
    if (baseline && !baselineContractInvalid && Array.isArray(baseline.categories)) {
        for (const row of baseline.categories) {
            baselineMap[row.category] = row;
        }
    }

    const sample = await gatherReviewSample(
        perCategory,
        CATEGORIES,
        judgeIdentityFingerprint
    );
    const rows = [];
    let worst_status = 'ok';
    const rankStatus = { ok: 0, no_baseline: 1, warning: 2, insufficient_data: 2, alert: 3 };

    for (const cat of CATEGORIES) {
        const pair = sample[cat] || { judge: [], human: [] };
        const n = pair.judge.length;
        const correlationReasons = [];
        if ((pair.unscored_qualified_human_count || 0) > 0) {
            correlationReasons.push('incomplete_qualified_score_series');
        }
        if ((pair.invalid_numeric_count || 0) > 0
            || pair.judge.some(value => !isFiniteScore(value))
            || pair.human.some(value => !isFiniteScore(value))) {
            correlationReasons.push('invalid_score_series');
        }
        if (pair.judge.length !== pair.human.length) {
            correlationReasons.push('mismatched_score_series');
        }
        if (n >= 2 && correlationReasons.length === 0 && new Set(pair.judge).size === 1) {
            correlationReasons.push('constant_judge_series');
        }
        if (n >= 2 && correlationReasons.length === 0 && new Set(pair.human).size === 1) {
            correlationReasons.push('constant_human_series');
        }
        let current_rho = null;
        if (n >= 2 && correlationReasons.length === 0) {
            const computedCorrelation = calculatePearsonCorrelation(pair.judge, pair.human);
            if (isFiniteCorrelation(computedCorrelation)) {
                current_rho = Number(computedCorrelation.toFixed(3));
            } else {
                correlationReasons.push('invalid_current_correlation');
            }
        }
        const rawBaselineRho = baselineContractInvalid
            ? Number.NaN
            : (baselineMap[cat] ? baselineMap[cat].rho : null);
        const classification = classifyDrift(current_rho, rawBaselineRho, n);
        const baseline_rho = isFiniteCorrelation(rawBaselineRho) ? rawBaselineRho : null;

        rows.push({
            category: cat,
            sample_size: n,
            qualified_human_source_size: pair.qualified_human_count || n,
            unscored_qualified_human_size: pair.unscored_qualified_human_count || 0,
            invalid_numeric_sample_size: pair.invalid_numeric_count || 0,
            sample_source: pair.sample_source || 'unknown',
            current_rho,
            baseline_rho,
            drop_pp: classification.drop_pp,
            status: classification.status,
            reasons: [
                ...classification.reasons,
                ...correlationReasons,
                ...baselineContractReasons,
                ...(baselineUnavailableReason ? [baselineUnavailableReason] : [])
            ],
            triggered: classification.triggered
        });

        if ((rankStatus[classification.status] ?? 0) > (rankStatus[worst_status] ?? 0)) {
            worst_status = classification.status;
        }
    }

    // Missing evidence is an explicit non-OK state. It must never be rendered
    // as healthy drift simply because no comparison could be made.
    let overall_status = 'ok';
    if (rows.some(r => r.status === 'alert')) overall_status = 'alert';
    else if (rows.some(r => r.status === 'warning')) overall_status = 'warning';
    else if (rows.some(r => r.status === 'insufficient_data')) overall_status = 'insufficient_data';
    else if (rows.some(r => r.status === 'no_baseline')) overall_status = 'no_baseline';

    const payload = {
        computed_at: new Date().toISOString(),
        judge_identity_fingerprint: judgeIdentityFingerprint,
        per_category_sample: perCategory,
        baseline_label: baseline ? baseline.label : null,
        baseline_overall_rho: baseline && isFiniteCorrelation(baseline.overall_rho)
            ? baseline.overall_rho
            : null,
        overall_status,
        worst_category_status: worst_status,
        thresholds: DRIFT_THRESHOLDS,
        categories: rows
    };

    logger.info('Drift computed', {
        overall_status,
        triggered_count: rows.filter(r => r.triggered).length,
        baseline_label: payload.baseline_label
    });

    return payload;
}

/**
 * Ratify a new baseline from a sprint snapshot. Marks all prior baselines
 * inactive and the new one active.
 *
 * @param {Object} input - {
 *   label, judge_identity_fingerprint, source_sprint,
 *   categories:[{category, rho, sample_size, mae?, bias?}],
 *   overall_rho, overall_sample_size, notes
 * }
 */
async function ratifyBaseline(input) {
    if (!input.label) throw new Error('label required');
    if (!Array.isArray(input.categories)) throw new Error('categories[] required');
    const judgeIdentityFingerprint = requireJudgeIdentityFingerprint(
        input.judge_identity_fingerprint
    );
    const doc = await CalibrationBaseline.ratifyExactIdentity({
        ...input,
        judge_identity_fingerprint: judgeIdentityFingerprint
    });
    logger.info('Calibration baseline ratified', { label: doc.label });
    return doc;
}

module.exports = {
    requireJudgeIdentityFingerprint,
    classifyDrift,
    gatherReviewSample,
    computeDrift,
    ratifyBaseline,
    DRIFT_THRESHOLDS
};
