/**
 * Unit tests for generalistScore pure functions.
 * Tests the scoring formula, normalization, and category handling.
 */

const {
    normalizeQualityTo100,
    normalizeScoreTo100,
    normalizeCategoryKey,
    buildCategoryEvidenceView,
    calculateGeneralistScoreFromCategories,
    confidenceMargin,
    weightedConfidenceMargin,
    COVERAGE_PENALTY_MAX,
    DIFFICULTY_PENALTY_MAX,
    FULL_SCOPE_MIN_LEVEL,
    REQUIRED_PROMPT_LEVELS,
    MIN_CONSISTENCY_RESULTS,
    CONSISTENCY_BONUS,
    CONSISTENCY_STDDEV_THRESHOLD,
    EVIDENCE_CONFIDENCE_PENALTY_MAX,
    EMPTY_RESPONSE_FILTER_THRESHOLD
} = require('../../../src/services/benchmark/generalistScore');

// Minimal weight map used in all formula tests so results are deterministic
// regardless of changes to the real GENERALIST_CATEGORY_WEIGHTS config.
const TEST_WEIGHTS = {
    coding: 0.40,
    reasoning: 0.40,
    math: 0.20
};

describe('normalizeQualityTo100', () => {
    it('converts 0-10 scale to 0-100', () => {
        expect(normalizeQualityTo100(7.5)).toBe(75);
        expect(normalizeQualityTo100(10)).toBe(100);
        expect(normalizeQualityTo100(0)).toBe(0);
    });

    it('clamps out-of-range 0-10 values', () => {
        expect(normalizeQualityTo100(-1)).toBe(0);
        expect(normalizeQualityTo100(11)).toBe(100);
    });

    it('handles non-finite gracefully', () => {
        expect(normalizeQualityTo100(null)).toBe(0);
        expect(normalizeQualityTo100(undefined)).toBe(0);
        expect(normalizeQualityTo100('abc')).toBe(0);
        expect(normalizeQualityTo100(NaN)).toBe(0);
    });
});

describe('normalizeCategoryKey', () => {
    it('lowercases and trims whitespace', () => {
        expect(normalizeCategoryKey('  Instruction  ')).toBe('instruction');
        expect(normalizeCategoryKey('CODING')).toBe('coding');
    });

    it('remaps legacy benchmark categories to canonical categories', () => {
        expect(normalizeCategoryKey('code')).toBe('coding');
        expect(normalizeCategoryKey('refactoring')).toBe('coding');
        expect(normalizeCategoryKey('instruction_following')).toBe('instruction');
        expect(normalizeCategoryKey('multi-turn-reasoning')).toBe('reasoning');
        expect(normalizeCategoryKey('context-retention')).toBe('knowledge');
        expect(normalizeCategoryKey('dialogue')).toBe('creative');
    });

    it('returns null for falsy input', () => {
        expect(normalizeCategoryKey('')).toBeNull();
        expect(normalizeCategoryKey(null)).toBeNull();
        expect(normalizeCategoryKey(undefined)).toBeNull();
    });
});

describe('buildCategoryEvidenceView', () => {
    it('renders untested and attempted-unscored categories as unavailable', () => {
        const scores = {
            coding: { avg: 8.4, count: 4, attempted: true },
            reasoning: { count: 0, attempted: true, judge_failed: true }
        };
        const calculated = { coding: 84, reasoning: 0, math: 0 };

        const view = buildCategoryEvidenceView(scores, calculated, TEST_WEIGHTS);

        expect(view.categoryAverages).toEqual({ coding: 84, reasoning: null, math: null });
        expect(view.categoryEvidence).toEqual({
            coding: 'scored',
            reasoning: 'attempted_unscored',
            math: 'untested'
        });
    });

    it('preserves a measured zero without turning missing coverage into zero', () => {
        const scores = { coding: { avg: 0, count: 3, attempted: true } };
        const calculated = { coding: 0, reasoning: 0, math: 0 };

        const view = buildCategoryEvidenceView(scores, calculated, TEST_WEIGHTS);

        expect(view.categoryAverages.coding).toBe(0);
        expect(view.categoryEvidence.coding).toBe('scored');
        expect(view.categoryAverages.reasoning).toBeNull();
        expect(view.categoryEvidence.reasoning).toBe('untested');
    });

    it('labels quarantined categories as pending review rather than scored zero', () => {
        const scores = {
            coding: { avg: 8, count: 2, attempted: true },
            reasoning: { count: 0, attempted: true, review_pending: true }
        };
        const calculated = { coding: 80, reasoning: 0, math: 0 };

        const view = buildCategoryEvidenceView(scores, calculated, TEST_WEIGHTS);

        expect(view.categoryAverages.reasoning).toBeNull();
        expect(view.categoryEvidence.reasoning).toBe('review_pending');
    });
});

describe('calculateGeneralistScoreFromCategories', () => {
    describe('perfect coverage', () => {
        it('computes weighted quality when all categories have scores', () => {
            const scores = {
                coding: { avg: 8, count: 5, stddev: 0.5, attempted: true },
                reasoning: { avg: 6, count: 5, stddev: 0.5, attempted: true },
                math: { avg: 10, count: 5, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                minConsistencyResults: 0,
                evidenceConfidencePenaltyMax: 0
            });

            // weightedQuality = (8*10*0.4 + 6*10*0.4 + 10*10*0.2) / 1.0
            // = (32 + 24 + 20) = 76
            expect(result.generalistScore).toBeCloseTo(76 + CONSISTENCY_BONUS, 1);
            expect(result.coveragePenalty).toBe(0);
            expect(result.coverage).toBe(100);
            expect(result.testedCategories).toBe(3);
        });
    });

    describe('coverage penalty', () => {
        it('penalizes missing categories proportional to weight', () => {
            const scores = {
                coding: { avg: 8, count: 5, stddev: 1, attempted: true }
                // reasoning (0.40) and math (0.20) are missing
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                minConsistencyResults: 0
            });

            const expectedPenalty = (0.40 + 0.20) * COVERAGE_PENALTY_MAX; // 12.0
            expect(result.coveragePenalty).toBeCloseTo(expectedPenalty, 1);
        });

        it('coverage percent reflects tested fraction', () => {
            const scores = {
                coding: { avg: 8, count: 3, stddev: 0, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
            expect(result.coverage).toBe(33); // 1/3 = 33%
        });

        it('penalizes full category coverage when evidence is only low difficulty', () => {
            const scores = {
                coding: { avg: 8, count: 5, stddev: 1, levels: [1, 1], attempted: true },
                reasoning: { avg: 8, count: 5, stddev: 1, levels: [1, 2], attempted: true },
                math: { avg: 8, count: 5, stddev: 1, levels: [1], attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                minConsistencyResults: 0
            });

            expect(result.coveragePenalty).toBe(0);
            expect(result.difficultyPenalty).toBe(DIFFICULTY_PENALTY_MAX);
            expect(result.difficultyCoverage).toBe(0);
            expect(result.fullScopeMinLevel).toBe(FULL_SCOPE_MIN_LEVEL);
            expect(result.requiredPromptLevels).toEqual(REQUIRED_PROMPT_LEVELS);
            expect(result.maxPromptLevel).toBe(2);
        });

        it('penalizes categories that have only L4 evidence when L5 is required too', () => {
            const scores = {
                coding: { avg: 8, count: 5, stddev: 1, levels: [4], attempted: true },
                reasoning: { avg: 8, count: 5, stddev: 1, levels: [4], attempted: true },
                math: { avg: 8, count: 5, stddev: 1, levels: [4], attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                minConsistencyResults: 0
            });

            expect(result.coveragePenalty).toBe(0);
            expect(result.difficultyPenalty).toBe(DIFFICULTY_PENALTY_MAX / 2);
            expect(result.difficultyCoverage).toBe(50);
            expect(result.fullScopeEligible).toBe(false);
            expect(result.missingRequiredLevelsByCategory.coding).toEqual([5]);
        });

        it('does not penalize categories that have all required hard levels', () => {
            const scores = {
                coding: { avg: 8, count: 10, stddev: 1, levels: [4, 5], attempted: true },
                reasoning: { avg: 8, count: 10, stddev: 1, levels: [4, 5], attempted: true },
                math: { avg: 8, count: 8, stddev: 1, levels: [4, 5], attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                minConsistencyResults: 0
            });

            expect(result.coveragePenalty).toBe(0);
            expect(result.difficultyPenalty).toBe(0);
            expect(result.difficultyCoverage).toBe(100);
            expect(result.maxPromptLevel).toBe(5);
            expect(result.fullScopeEligible).toBe(true);
        });
    });

    describe('attempted-but-no-score (infrastructure / judge failures)', () => {
        it('does not penalize coverage for attempted categories with no quality score', () => {
            const scores = {
                coding: { avg: 8, count: 5, stddev: 1, attempted: true },
                reasoning: { attempted: true, count: 0 },  // infra/judge failure
                math: { avg: 7, count: 3, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                minConsistencyResults: 0
            });

            expect(result.coveragePenalty).toBe(0);
            expect(result.coverage).toBe(100);
            expect(result.testedCategories).toBe(3);
        });

        it('treats judge_failed categories (count=0, attempted=true) same as infra failures', () => {
            const scores = {
                coding: { avg: 7, count: 3, stddev: 0.5, attempted: true },
                reasoning: { attempted: true, count: 0, judge_failed: true },
                math: { avg: 9, count: 2, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

            expect(result.coveragePenalty).toBe(0);
            expect(result.testedCategories).toBe(3);
        });
    });

    describe('consistency bonus', () => {
        it('awards bonus when avg within-category stddev is below threshold', () => {
            const scores = {
                coding: { avg: 8, count: 3, stddev: 0.5, attempted: true },
                reasoning: { avg: 8, count: 3, stddev: 0.5, attempted: true },
                math: { avg: 8, count: 3, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                minConsistencyResults: 0
            });
            // avg stddev = 5 (normalized to 0-100) < CONSISTENCY_STDDEV_THRESHOLD (15)
            expect(result.consistencyBonus).toBe(CONSISTENCY_BONUS);
        });

        it('withholds bonus when avg stddev exceeds threshold', () => {
            const scores = {
                coding: { avg: 8, count: 3, stddev: 2, attempted: true },    // 20 on 0-100
                reasoning: { avg: 8, count: 3, stddev: 2, attempted: true }, // 20 on 0-100
                math: { avg: 8, count: 3, stddev: 2, attempted: true }       // 20 on 0-100
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
            expect(result.consistencyBonus).toBe(0);
        });

        it('withholds consistency bonus when sample size is below the evidence floor', () => {
            const scores = {
                coding: { avg: 8, count: 10, stddev: 0.5, attempted: true },
                reasoning: { avg: 8, count: 10, stddev: 0.5, attempted: true },
                math: { avg: 8, count: 7, stddev: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

            expect(result.consistencyBonus).toBe(0);
            expect(result.minConsistencyResults).toBe(MIN_CONSISTENCY_RESULTS);
        });

        it('withholds consistency bonus for near-zero quality models', () => {
            const scores = {
                coding: { avg: 0.5, count: 3, stddev: 0.1, attempted: true },
                reasoning: { avg: 0.5, count: 3, stddev: 0.1, attempted: true },
                math: { avg: 0.5, count: 3, stddev: 0.1, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
            expect(result.consistencyBonus).toBe(0);
        });

        it('uses prompt-mean residual stddev when available', () => {
            const scores = {
                coding: {
                    avg: 8,
                    count: 20,
                    stddev: 3.0,
                    residual_stddev: 0.2,
                    residual_count: 20,
                    consistency_basis: 'prompt_residual',
                    attempted: true
                },
                reasoning: {
                    avg: 8,
                    count: 20,
                    stddev: 3.0,
                    residual_stddev: 0.2,
                    residual_count: 20,
                    consistency_basis: 'prompt_residual',
                    attempted: true
                },
                math: {
                    avg: 8,
                    count: 20,
                    stddev: 3.0,
                    residual_stddev: 0.2,
                    residual_count: 20,
                    consistency_basis: 'prompt_residual',
                    attempted: true
                }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

            expect(result.avgWithinCategoryStdDev).toBe(2);
            expect(result.consistencyBonus).toBe(CONSISTENCY_BONUS);
            expect(result.consistencyBasis.coding).toBe('prompt_residual');
        });

        it('skips aggregation-marked single-model prompts for consistency basis', () => {
            const scores = {
                coding: { avg: 8, count: 20, stddev: 0, consistency_basis: 'none', attempted: true },
                reasoning: { avg: 8, count: 20, stddev: 0, consistency_basis: 'none', attempted: true },
                math: { avg: 8, count: 20, stddev: 0, consistency_basis: 'none', attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

            expect(result.avgWithinCategoryStdDev).toBeNull();
            expect(result.consistencyBonus).toBe(0);
            expect(result.consistencyBasis.coding).toBe('none');
        });
    });

    describe('evidence confidence penalty', () => {
        it('deducts a bounded penalty when average judge confidence is below target', () => {
            const scores = {
                coding: { avg: 8, count: 20, stddev: 1, avg_confidence: 0.5, attempted: true },
                reasoning: { avg: 8, count: 20, stddev: 1, avg_confidence: 0.5, attempted: true },
                math: { avg: 8, count: 20, stddev: 1, avg_confidence: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                minConsistencyResults: 0,
                evidenceConfidenceTarget: 0.75,
                evidenceConfidencePenaltyMax: EVIDENCE_CONFIDENCE_PENALTY_MAX
            });

            expect(result.evidenceConfidence).toBe(0.5);
            expect(result.evidenceConfidencePenalty).toBeCloseTo(2.7, 1);
            expect(result.generalistScore).toBeCloseTo(80 - 2.7 + CONSISTENCY_BONUS, 1);
        });

        it('does not double-penalize when confidence weighting is enabled', () => {
            const scores = {
                coding: { avg: 8, count: 20, stddev: 1, avg_confidence: 0.5, attempted: true },
                reasoning: { avg: 8, count: 20, stddev: 1, avg_confidence: 0.5, attempted: true },
                math: { avg: 8, count: 20, stddev: 1, avg_confidence: 0.5, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                confidenceWeighting: true,
                minConsistencyResults: 0
            });

            expect(result.evidenceConfidencePenalty).toBe(0);
            expect(result.confidenceWeighted).toBe(true);
        });

        it('keeps missing judge confidence unknown instead of inventing a fallback', () => {
            const scores = {
                coding: { avg: 8, count: 20, stddev: 1, attempted: true },
                reasoning: { avg: 8, count: 20, stddev: 1, attempted: true },
                math: { avg: 8, count: 20, stddev: 1, attempted: true }
            };

            const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS, {
                confidenceWeighting: true,
                minConsistencyResults: 0
            });

            expect(result.evidenceConfidence).toBeNull();
            expect(result.evidenceConfidenceCoverage).toBe(0);
            expect(result.categoryConfidence).toEqual({
                coding: null,
                reasoning: null,
                math: null
            });
        });
    });

    describe('edge cases', () => {
        it('returns zero generalistScore for empty scores', () => {
            const result = calculateGeneralistScoreFromCategories({}, TEST_WEIGHTS);
            expect(result.generalistScore).toBe(0);
            expect(result.testedCategories).toBe(0);
        });

        it('generalistScore is never negative', () => {
            // Extreme penalty scenario
            const result = calculateGeneralistScoreFromCategories({
                coding: { avg: 0.1, count: 1, attempted: true }
            }, TEST_WEIGHTS);
            expect(result.generalistScore).toBeGreaterThanOrEqual(0);
        });

        it('handles null/undefined weights gracefully', () => {
            const result = calculateGeneralistScoreFromCategories({}, null);
            expect(result.generalistScore).toBe(0);
        });
    });
});

describe('confidenceMargin', () => {
    it('returns null for n < 2', () => {
        expect(confidenceMargin(10, 1)).toBeNull();
        expect(confidenceMargin(10, 0)).toBeNull();
    });

    it('returns null for non-finite stddev', () => {
        expect(confidenceMargin(NaN, 5)).toBeNull();
    });

    it('decreases as n increases', () => {
        const small = confidenceMargin(15, 3);
        const large = confidenceMargin(15, 30);
        expect(small).toBeGreaterThan(large);
    });
});

describe('weightedConfidenceMargin', () => {
    it('combines category weights using independent prompt means while retaining repeat evidence', () => {
        const result = weightedConfidenceMargin({
            coding: {
                avg: 8, count: 8, uncertainty_stddev: 1, uncertainty_count: 4, repeat_count: 8
            },
            reasoning: {
                avg: 7, count: 6, uncertainty_stddev: 2, uncertainty_count: 3, repeat_count: 6
            }
        }, { coding: 0.75, reasoning: 0.25 }, 'quality_score');

        expect(result.margin).toBeGreaterThan(0);
        expect(result.sampleSize).toBe(7);
        expect(result.repeatCount).toBe(14);
        expect(result.method).toBe('weighted_category_prompt_means_t95');
    });

    it('returns unknown when any scored category lacks measurable fixture variance', () => {
        const result = weightedConfidenceMargin({
            coding: { avg: 8, count: 1, uncertainty_stddev: null, uncertainty_count: 1 }
        }, { coding: 1 }, 'quality_score');

        expect(result.margin).toBeNull();
        expect(result.method).toBeNull();
    });
});

describe('constants sanity checks', () => {
    it('COVERAGE_PENALTY_MAX is positive', () => {
        expect(COVERAGE_PENALTY_MAX).toBeGreaterThan(0);
    });

    it('CONSISTENCY_BONUS is positive', () => {
        expect(CONSISTENCY_BONUS).toBeGreaterThan(0);
    });

    it('EMPTY_RESPONSE_FILTER_THRESHOLD is between 0 and 1', () => {
        expect(EMPTY_RESPONSE_FILTER_THRESHOLD).toBeGreaterThan(0);
        expect(EMPTY_RESPONSE_FILTER_THRESHOLD).toBeLessThanOrEqual(1);
    });
});

describe('normalizeScoreTo100 — composite axis (option B)', () => {
    it('passes composite_score (0-100) through without rescaling', () => {
        expect(normalizeScoreTo100(75, 'composite_score')).toBe(75);
        expect(normalizeScoreTo100(100, 'composite_score')).toBe(100);
        expect(normalizeScoreTo100(0, 'composite_score')).toBe(0);
    });

    it('clamps composite_score to [0, 100]', () => {
        expect(normalizeScoreTo100(150, 'composite_score')).toBe(100);
        expect(normalizeScoreTo100(-5, 'composite_score')).toBe(0);
    });

    it('rescales 0-10 fields by x10 (matches normalizeQualityTo100)', () => {
        expect(normalizeScoreTo100(7.5, 'quality_score')).toBe(75);
        expect(normalizeScoreTo100(7.5, 'deterministic_score')).toBe(75);
        expect(normalizeScoreTo100(7.5, 'subjective_score')).toBe(75);
    });

    it('handles unknown score field by defaulting to 0-10 scale', () => {
        expect(normalizeScoreTo100(5, 'mystery_field')).toBe(50);
    });
});

describe('calculateGeneralistScoreFromCategories — scoreField option', () => {
    const TEST_WEIGHTS = { coding: 0.5, reasoning: 0.5 };

    it('treats avg as 0-10 by default (back-compat: existing tests still pass)', () => {
        const scores = {
            coding: { avg: 8, count: 5, stddev: 0.5, attempted: true },
            reasoning: { avg: 8, count: 5, stddev: 0.5, attempted: true }
        };
        const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
        // avg 8 (0-10) → 80 (0-100); + consistency bonus
        expect(result.weightedSum).toBe(80);
    });

    it('treats avg as 0-100 when scoreField=composite_score (no x10 rescale)', () => {
        const scores = {
            coding: { avg: 80, count: 5, stddev: 5, attempted: true },
            reasoning: { avg: 80, count: 5, stddev: 5, attempted: true }
        };
        const result = calculateGeneralistScoreFromCategories(
            scores, TEST_WEIGHTS, {}, { scoreField: 'composite_score' }
        );
        // avg 80 (already 0-100) → 80; if the rescale were still active it
        // would clamp to 10 then x10 = 100, which would fail this assertion.
        expect(result.weightedSum).toBe(80);
    });

    it('skips bias correction for non-quality axes even when profile opts in', () => {
        const scores = {
            coding: { avg: 80, count: 5, stddev: 5, attempted: true },
            reasoning: { avg: 80, count: 5, stddev: 5, attempted: true }
        };
        const withCorrection = calculateGeneralistScoreFromCategories(
            scores, TEST_WEIGHTS, { biasCorrection: true }, { scoreField: 'composite_score' }
        );
        const withoutCorrection = calculateGeneralistScoreFromCategories(
            scores, TEST_WEIGHTS, { biasCorrection: false }, { scoreField: 'composite_score' }
        );
        // Composite axis must ignore the (quality-calibrated) bias correction
        // entirely, so the two results must agree.
        expect(withCorrection.weightedSum).toBe(withoutCorrection.weightedSum);
    });

    it('scales stddev to 0-100 based on scoreField', () => {
        const qualityScores = {
            coding: { avg: 8, count: 5, stddev: 1.0, attempted: true },
            reasoning: { avg: 8, count: 5, stddev: 1.0, attempted: true }
        };
        const compositeScores = {
            coding: { avg: 80, count: 5, stddev: 10, attempted: true },
            reasoning: { avg: 80, count: 5, stddev: 10, attempted: true }
        };
        const qualityResult = calculateGeneralistScoreFromCategories(qualityScores, TEST_WEIGHTS);
        const compositeResult = calculateGeneralistScoreFromCategories(
            compositeScores, TEST_WEIGHTS, {}, { scoreField: 'composite_score' }
        );
        // stddev 1.0 (0-10 scale) and stddev 10 (0-100 scale) describe the
        // same dispersion → both should report the same avgWithinCategoryStdDev.
        expect(qualityResult.avgWithinCategoryStdDev).toBe(compositeResult.avgWithinCategoryStdDev);
    });
});
