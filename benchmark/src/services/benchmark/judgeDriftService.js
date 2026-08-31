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
const { CATEGORIES, loadUnionedGoldset } = require('./retroCalibration');

const DRIFT_THRESHOLDS = {
    drop_pp: 0.15,              // drop of 15 percentage points
    absolute_floor: 0.5,        // any slip below this fires
    min_sample_size: 5          // below this → insufficient_data
};

/**
 * Classify a single category's drift status.
 * @param {number|null} current_rho
 * @param {number|null} baseline_rho
 * @param {number} sample_size
 * @returns { status: 'ok'|'warning'|'alert'|'insufficient_data'|'no_baseline',
 *           drop_pp, reasons, triggered }
 */
function classifyDrift(current_rho, baseline_rho, sample_size) {
    if (sample_size < DRIFT_THRESHOLDS.min_sample_size) {
        return { status: 'insufficient_data', drop_pp: 0, reasons: [], triggered: false };
    }
    if (current_rho === null || current_rho === undefined) {
        return { status: 'insufficient_data', drop_pp: 0, reasons: [], triggered: false };
    }
    if (baseline_rho === null || baseline_rho === undefined) {
        // No baseline → classify based on absolute floor only.
        if (current_rho < DRIFT_THRESHOLDS.absolute_floor) {
            return {
                status: 'alert',
                drop_pp: 0,
                reasons: ['absolute_floor'],
                triggered: true
            };
        }
        return { status: 'no_baseline', drop_pp: 0, reasons: [], triggered: false };
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
 * Pull the latest N (default 30) courthouse/sprint reviews per category.
 * Returns pairs suitable for Pearson computation.
 *
 * @param {number} perCategory - default 30
 * @param {Array<string>} [categories]
 * @returns {Object} { [category]: { judge: number[], human: number[], entries: [...] } }
 */
async function gatherReviewSample(perCategory = 30, categories = CATEGORIES) {
    const result = {};
    for (const cat of categories) {
        const unioned = await loadUnionedGoldset({ category: cat });
        const scored = unioned
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

        result[cat] = {
            judge: scored.map(d => d.judge_score_at_review),
            human: scored.map(d => d.expert_scores?.overall),
            entries: scored,
            unioned_count: unioned.length,
            scored_count: scored.length,
            unscored_count: Math.max(0, unioned.length - scored.length),
            sample_source: 'unioned_goldset_scored_rows'
        };
    }
    return result;
}

/**
 * Compute drift for every category. Returns structure consumable by the
 * /api/benchmark/drift endpoint and the dashboard row.
 *
 * @param {Object} options - { perCategory=30, baseline? }
 * @returns {Object} { categories: [...], overall_status, baseline_label, ... }
 */
async function computeDrift(options = {}) {
    const { perCategory = 30 } = options;

    const baseline = options.baseline
        || (await CalibrationBaseline.getActive())
        || null;

    const baselineMap = {};
    if (baseline && Array.isArray(baseline.categories)) {
        for (const row of baseline.categories) {
            baselineMap[row.category] = row;
        }
    }

    const sample = await gatherReviewSample(perCategory);
    const rows = [];
    let worst_status = 'ok';
    const rankStatus = { ok: 0, no_baseline: 1, warning: 2, insufficient_data: 2, alert: 3 };

    for (const cat of CATEGORIES) {
        const pair = sample[cat] || { judge: [], human: [] };
        const n = pair.judge.length;
        const current_rho = n >= 2
            ? Number(calculatePearsonCorrelation(pair.judge, pair.human).toFixed(3))
            : null;
        const baseline_rho = baselineMap[cat] ? baselineMap[cat].rho : null;
        const classification = classifyDrift(current_rho, baseline_rho, n);

        rows.push({
            category: cat,
            sample_size: n,
            unioned_goldset_size: pair.unioned_count || n,
            unscored_goldset_size: pair.unscored_count || 0,
            sample_source: pair.sample_source || 'unknown',
            current_rho,
            baseline_rho,
            drop_pp: classification.drop_pp,
            status: classification.status,
            reasons: classification.reasons,
            triggered: classification.triggered
        });

        if ((rankStatus[classification.status] ?? 0) > (rankStatus[worst_status] ?? 0)) {
            worst_status = classification.status;
        }
    }

    // Overall status label: ok | warning | alert (collapse insufficient/no_baseline)
    let overall_status = 'ok';
    if (rows.some(r => r.status === 'alert')) overall_status = 'alert';
    else if (rows.some(r => r.status === 'warning')) overall_status = 'warning';

    const payload = {
        computed_at: new Date().toISOString(),
        per_category_sample: perCategory,
        baseline_label: baseline ? baseline.label : null,
        baseline_overall_rho: baseline ? baseline.overall_rho : null,
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
 *   label, source_sprint, categories:[{category, rho, sample_size, mae?, bias?}],
 *   overall_rho, overall_sample_size, notes
 * }
 */
async function ratifyBaseline(input) {
    if (!input.label) throw new Error('label required');
    if (!Array.isArray(input.categories)) throw new Error('categories[] required');

    // Materialize the target before releasing the current slot. The
    // constant-valued unique partial index on active_slot guarantees that two
    // concurrent ratifications can never leave two active baselines. MongoDB
    // standalone deployments do not support the multi-document transaction
    // this would otherwise require, so a race loser fails closed.
    const target = await CalibrationBaseline.findOneAndUpdate(
        { label: input.label },
        {
            $set: {
                label: input.label,
                source_sprint: input.source_sprint || null,
                overall_rho: input.overall_rho ?? null,
                overall_sample_size: input.overall_sample_size || 0,
                categories: input.categories,
                notes: input.notes || null
            },
            $setOnInsert: { active: false }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    await CalibrationBaseline.updateMany(
        { _id: { $ne: target._id }, active: true },
        { $set: { active: false }, $unset: { active_slot: '' } }
    );

    let doc;
    try {
        doc = await CalibrationBaseline.findOneAndUpdate(
            { _id: target._id },
            { $set: { active: true, active_slot: 'active' } },
            { new: true }
        );
    } catch (err) {
        if (err?.code === 11000) {
            const conflict = new Error('another calibration baseline won concurrent ratification');
            conflict.code = 'CALIBRATION_BASELINE_CONFLICT';
            throw conflict;
        }
        throw err;
    }
    logger.info('Calibration baseline ratified', { label: doc.label });
    return doc;
}

module.exports = {
    classifyDrift,
    gatherReviewSample,
    computeDrift,
    ratifyBaseline,
    DRIFT_THRESHOLDS
};
