'use strict';

/**
 * TODO 0137 — Creative category decomposed-judge audit, deterministic replay test.
 *
 * Context: Round-2 (2026-04-21) creative ρ = 0.620 with two severe disagreements
 *   - R026 (creative, judge=4.3, human=9)
 *   - R021 (creative, judge=2.6, human=7)
 * Round-1 (2026-04-20) showed the same failure pattern
 *   - R006 (creative, judge=3.4, human=9)
 *   - R004 (creative, judge=9.1, human=9)   — well-scored control
 *
 * Diagnosis: creative dimensions overweight narrative form (originality+coherence+
 * engagement = 0.85) while `relevance` is only 0.15. When prompts ask for dialog or
 * clarifying questions, narrative checks fire false-negative even though the response
 * is correct and relevant for the requested form.
 *
 * Fix: reweight creative to {originality:0.20, coherence:0.20, engagement:0.25,
 * relevance:0.35} and reword narrative-biased questions to be form-aware.
 *
 * This test replays the stored `breakdown` (per-question contributed/weight) against
 * the new category-level weights (no live LLM) and asserts at least 3/4 of the
 * flagged rows move closer to human scores.
 */

const { ENHANCED_SCORING_CONFIGS } = require('../../../src/services/scoring/scoringConfigs');

// Round-2 flagged creative rows (reveal key 2026-04-21) and round-1 creative rows
// (reveal key 2026-04-20). R004 is a well-scored creative control.
const FLAGGED = [
    { id: 'R026', revealDate: '2026-04-21' },
    { id: 'R021', revealDate: '2026-04-21' },
    { id: 'R006', revealDate: '2026-04-20' },
    { id: 'R004', revealDate: '2026-04-20' }
];

const HUMAN_SCORES = {
    R026: 9,
    R021: 7,
    R006: 9,
    R004: 9
};

const CATEGORY_BY_ROW = {
    R026: 'creative',
    R021: 'creative',
    R006: 'creative',
    R004: 'creative'
};

const REPLAY_ROWS = {
    R026: {
        quality_score: 4.3,
        breakdown: makeBreakdown({ originality: 3.0, coherence: 3.5, engagement: 3.5, relevance: 10.0 })
    },
    R021: {
        quality_score: 2.6,
        breakdown: makeBreakdown({ originality: 0.0, coherence: 3.5, engagement: 0.0, relevance: 10.0 })
    },
    R006: {
        quality_score: 3.4,
        breakdown: makeBreakdown({ originality: 0.0, coherence: 3.5, engagement: 3.5, relevance: 10.0 })
    },
    R004: {
        quality_score: 9.1,
        breakdown: makeBreakdown({ originality: 10.0, coherence: 10.0, engagement: 6.5, relevance: 10.0 })
    }
};

function round1(value) {
    return Math.round(value * 10) / 10;
}

function makeQuestionBreakdown(score) {
    if (score <= 0) {
        return [{ question: 'fixture', weight: 10, contributed: false }];
    }
    if (score >= 10) {
        return [{ question: 'fixture', weight: 10, contributed: true }];
    }
    return [
        { question: 'fixture-pass', weight: score, contributed: true },
        { question: 'fixture-fail', weight: 10 - score, contributed: false }
    ];
}

function makeBreakdown(dimensionScores) {
    return Object.fromEntries(
        Object.entries(dimensionScores).map(([dimension, score]) => [
            dimension,
            makeQuestionBreakdown(score)
        ])
    );
}

function scoreDimensionFromBreakdown(questionBreakdown) {
    const total = questionBreakdown.reduce((sum, item) => sum + Number(item.weight || 0), 0);
    const earned = questionBreakdown.reduce((sum, item) => {
        return sum + (item.contributed ? Number(item.weight || 0) : 0);
    }, 0);
    if (total <= 0) return 0;
    return round1((earned / total) * 10);
}

function scoreFromDecomposedBreakdown(category, breakdown) {
    const dimensionWeights = ENHANCED_SCORING_CONFIGS[category].core_dimensions;
    const dimensionScores = {};

    for (const [dimension, questions] of Object.entries(breakdown)) {
        if (!Array.isArray(questions)) continue;
        dimensionScores[dimension] = scoreDimensionFromBreakdown(questions);
    }

    const weighted = dimensionWeights.reduce((sum, dim) => {
        const dimScore = Number(dimensionScores[dim.name] || 0);
        return sum + (dimScore * dim.weight);
    }, 0);

    return round1(weighted);
}

describe('TODO 0137 creative category audit replay (deterministic, no LLM calls)', () => {
    test('creative core_dimensions weights match 0137 reweight spec', () => {
        const dims = ENHANCED_SCORING_CONFIGS.creative.core_dimensions;
        const byName = Object.fromEntries(dims.map(d => [d.name, d.weight]));
        expect(byName.originality).toBeCloseTo(0.20, 3);
        expect(byName.coherence).toBeCloseTo(0.20, 3);
        expect(byName.engagement).toBeCloseTo(0.25, 3);
        expect(byName.relevance).toBeCloseTo(0.35, 3);
        const sum = dims.reduce((acc, d) => acc + d.weight, 0);
        expect(Math.abs(sum - 1.0)).toBeLessThan(0.001);
    });

    test('at least 3/4 flagged creative rows move closer to human scores after reweight', () => {
        const improvements = [];
        const details = [];

        for (const { id, revealDate } of FLAGGED) {
            const row = REPLAY_ROWS[id];
            expect(row).toBeDefined();
            expect(row.breakdown).toBeDefined();

            const category = CATEGORY_BY_ROW[id];
            const human = HUMAN_SCORES[id];
            const oldJudge = Number(row.quality_score);
            const newJudge = scoreFromDecomposedBreakdown(category, row.breakdown);

            const oldDistance = Math.abs(oldJudge - human);
            const newDistance = Math.abs(newJudge - human);

            details.push({ id, oldJudge, newJudge, human, oldDistance, newDistance });

            if (newDistance < oldDistance) {
                improvements.push(id);
            }
        }

        // Attach diagnostic info for any test failure.
        if (improvements.length < 3) {
            // eslint-disable-next-line no-console
            console.error('0137 replay details:', JSON.stringify(details, null, 2));
        }

        expect(improvements.length).toBeGreaterThanOrEqual(3);
        // The three dialog-shaped rows must be in the improved set; R004 (narrative
        // control) was already correctly scored, so it need not move.
        expect(improvements).toEqual(expect.arrayContaining(['R026', 'R021', 'R006']));
    });
});
