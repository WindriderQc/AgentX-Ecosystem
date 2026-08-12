/**
 * GOLDEN regression tests for the generalist scoring formula (task 0228).
 *
 * PURPOSE: `generalistScore.js` is the single source of truth feeding the
 * dashboard and every leaderboard axis. Touching the formula silently shifts
 * all rankings. These tests snapshot the FULL numeric output of
 * `calculateGeneralistScoreFromCategories` over a fixed fixture matrix that
 * exercises every axis (quality / deterministic / subjective / composite-elite),
 * bias correction, optional confidence weighting, the evidence-confidence
 * penalty, coverage + difficulty penalties, the consistency bonus, and edge
 * cases.
 *
 * CONTRACT: the committed `__snapshots__/generalistScoreGolden.test.js.snap`
 * file IS the golden record. Any numeric drift makes these fail. They MUST pass
 * unchanged across the 0228 file split (proving the split is behavior-inert).
 * If a snapshot legitimately needs to change, that is a deliberate formula
 * change and must be reviewed line-by-line — never blanket `jest -u`.
 *
 * NOTE: fixtures use a FIXED local weight map so results are independent of the
 * real GENERALIST_CATEGORY_WEIGHTS config, and default profileParams so the
 * snapshot also locks the module-level constants (penalties/bonuses/targets).
 */

const {
    calculateGeneralistScoreFromCategories
} = require('../../../src/services/benchmark/generalistScore');

// Five-category fixed weight map (sums to 1.0). Independent of live config.
const GW = Object.freeze({
    coding: 0.30,
    reasoning: 0.25,
    math: 0.20,
    knowledge: 0.15,
    creative: 0.10
});

// A reusable full-coverage, hard-scope (L4/L5), high-count category map.
// `avg` is on the native scale of the axis under test, set per-case below.
function fullCoverage(avgByCat, { stddev = 0.5, count = 12, confidence } = {}) {
    const out = {};
    for (const cat of Object.keys(GW)) {
        out[cat] = {
            avg: avgByCat[cat],
            count,
            stddev,
            levels: [4, 5],
            attempted: true
        };
        if (confidence !== undefined) out[cat].avg_confidence = confidence;
    }
    return out;
}

describe('GOLDEN: calculateGeneralistScoreFromCategories — every axis', () => {
    // 0-10 native axis averages reused for quality/deterministic/subjective.
    const QUALITY_AVGS = { coding: 8, reasoning: 6.5, math: 9, knowledge: 7, creative: 5.5 };

    it('quality_score axis — full hard-scope coverage (defaults)', () => {
        const scores = fullCoverage(QUALITY_AVGS, { confidence: 0.9 });
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, {}, { scoreField: 'quality_score' }
        );
        expect(result).toMatchSnapshot();
    });

    it('deterministic_score axis — full hard-scope coverage (defaults)', () => {
        const scores = fullCoverage(QUALITY_AVGS, { confidence: 0.9 });
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, {}, { scoreField: 'deterministic_score' }
        );
        expect(result).toMatchSnapshot();
    });

    it('subjective_score axis — full hard-scope coverage (defaults)', () => {
        const scores = fullCoverage(QUALITY_AVGS, { confidence: 0.9 });
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, {}, { scoreField: 'subjective_score' }
        );
        expect(result).toMatchSnapshot();
    });

    it('composite_score axis (headline/elite, 0-100 native) — full hard-scope', () => {
        const compositeAvgs = { coding: 80, reasoning: 65, math: 90, knowledge: 70, creative: 55 };
        const scores = fullCoverage(compositeAvgs, { stddev: 5, confidence: 0.9 });
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, {}, { scoreField: 'composite_score' }
        );
        expect(result).toMatchSnapshot();
    });
});

describe('GOLDEN: bias correction + confidence weighting', () => {
    const QUALITY_AVGS = { coding: 8, reasoning: 6.5, math: 9, knowledge: 7, creative: 5.5 };

    it('quality_score with per-category bias correction enabled', () => {
        const scores = fullCoverage(QUALITY_AVGS, { confidence: 0.9 });
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, { biasCorrection: true }, { scoreField: 'quality_score' }
        );
        expect(result).toMatchSnapshot();
    });

    it('quality_score with confidence weighting enabled (mixed confidence)', () => {
        const scores = fullCoverage(QUALITY_AVGS, { confidence: 0.6 });
        // vary one category's confidence to exercise weighting math
        scores.coding.avg_confidence = 0.95;
        scores.creative.avg_confidence = 0.3;
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, { confidenceWeighting: true }, { scoreField: 'quality_score' }
        );
        expect(result).toMatchSnapshot();
    });
});

describe('GOLDEN: penalties', () => {
    const QUALITY_AVGS = { coding: 8, reasoning: 6.5, math: 9, knowledge: 7, creative: 5.5 };

    it('evidence-confidence penalty — avg confidence below target (defaults)', () => {
        const scores = fullCoverage(QUALITY_AVGS, { count: 20, confidence: 0.5 });
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, {}, { scoreField: 'quality_score' }
        );
        expect(result).toMatchSnapshot();
    });

    it('coverage penalty — only 2 of 5 categories tested', () => {
        const scores = {
            coding: { avg: 8, count: 12, stddev: 0.5, levels: [4, 5], attempted: true },
            reasoning: { avg: 7, count: 12, stddev: 0.5, levels: [4, 5], attempted: true }
            // math / knowledge / creative missing → coverage penalty
        };
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, {}, { scoreField: 'quality_score' }
        );
        expect(result).toMatchSnapshot();
    });

    it('difficulty penalty — full category coverage but only L1/L2 evidence', () => {
        const easy = {};
        for (const cat of Object.keys(GW)) {
            easy[cat] = { avg: 8, count: 12, stddev: 0.5, levels: [1, 2], attempted: true };
        }
        const result = calculateGeneralistScoreFromCategories(
            easy, GW, {}, { scoreField: 'quality_score' }
        );
        expect(result).toMatchSnapshot();
    });

    it('infra/judge-failed category is exempt from coverage penalty', () => {
        const scores = {
            coding: { avg: 8, count: 12, stddev: 0.5, levels: [4, 5], attempted: true },
            reasoning: { avg: 7, count: 12, stddev: 0.5, levels: [4, 5], attempted: true },
            math: { attempted: true, count: 0, judge_failed: true },
            knowledge: { avg: 7, count: 12, stddev: 0.5, levels: [4, 5], attempted: true },
            creative: { avg: 6, count: 12, stddev: 0.5, levels: [4, 5], attempted: true }
        };
        const result = calculateGeneralistScoreFromCategories(
            scores, GW, {}, { scoreField: 'quality_score' }
        );
        expect(result).toMatchSnapshot();
    });
});

describe('GOLDEN: edge cases', () => {
    it('empty category map returns zeroed breakdown', () => {
        const result = calculateGeneralistScoreFromCategories({}, GW, {}, { scoreField: 'quality_score' });
        expect(result).toMatchSnapshot();
    });

    it('null weights returns zeroed breakdown', () => {
        const result = calculateGeneralistScoreFromCategories({ coding: { avg: 8, count: 3, attempted: true } }, null);
        expect(result).toMatchSnapshot();
    });
});
