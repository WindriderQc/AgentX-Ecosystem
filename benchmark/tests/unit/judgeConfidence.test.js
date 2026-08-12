/**
 * Tests for Judge Confidence Service
 */

const {
    assess,
    quickCheck,
    aggregateConfidence,
    calculateScoreSpread,
    checkExplanationQuality,
    checkLevelScoreMismatch,
    checkScoreClustering,
    estimatePromptComplexity,
    extractConfidenceFeatures
} = require('../../src/services/judgeConfidence');

describe('Judge Confidence Service', () => {
    describe('calculateScoreSpread', () => {
        it('should calculate spread of scores', () => {
            const breakdown = { accuracy: 8, clarity: 6, completeness: 9 };
            expect(calculateScoreSpread(breakdown)).toBe(3);
        });

        it('should return 0 for single score', () => {
            const breakdown = { accuracy: 8 };
            expect(calculateScoreSpread(breakdown)).toBe(0);
        });

        it('should handle empty/invalid input', () => {
            expect(calculateScoreSpread(null)).toBe(0);
            expect(calculateScoreSpread({})).toBe(0);
        });

        it('should ignore non-numeric values', () => {
            const breakdown = { accuracy: 8, clarity: 6, explanation: 'text' };
            expect(calculateScoreSpread(breakdown)).toBe(2);
        });
    });

    describe('checkExplanationQuality', () => {
        it('should flag no explanation as vague', () => {
            const result = checkExplanationQuality(null);
            expect(result.isVague).toBe(true);
            expect(result.reason).toContain('No explanation');
        });

        it('should flag short explanations as vague', () => {
            const result = checkExplanationQuality('Good');
            expect(result.isVague).toBe(true);
            expect(result.reason).toContain('too short');
        });

        it('should flag generic phrases', () => {
            const result = checkExplanationQuality(
                'The response is overall good and meets requirements with acceptable quality.'
            );
            expect(result.isVague).toBe(true);
            expect(result.reason).toContain('generic phrase');
        });

        it('should accept detailed explanations', () => {
            const result = checkExplanationQuality(
                'The code correctly implements the sorting algorithm with O(n log n) complexity. ' +
                'Variable names are descriptive and the logic is broken into clear functions. ' +
                'However, error handling is missing for edge cases. Score: 7/10.'
            );
            expect(result.isVague).toBe(false);
        });
    });

    describe('checkLevelScoreMismatch', () => {
        it('should flag level 4+ with near-perfect score', () => {
            const result = checkLevelScoreMismatch(4, 9.5);
            expect(result.suspicious).toBe(true);
        });

        it('should flag level 5 with very high score', () => {
            const result = checkLevelScoreMismatch(5, 9.0);
            expect(result.suspicious).toBe(true);
        });

        it('should flag level 5 with suspiciously high score', () => {
            const result = checkLevelScoreMismatch(5, 8.5);
            expect(result.suspicious).toBe(true);
        });

        it('should not flag normal level-score combinations', () => {
            expect(checkLevelScoreMismatch(3, 9.0).suspicious).toBe(false);
            expect(checkLevelScoreMismatch(3, 10).suspicious).toBe(false);
            expect(checkLevelScoreMismatch(5, 7.0).suspicious).toBe(false);
        });
    });

    describe('checkScoreClustering', () => {
        it('should flag suspiciously low spread', () => {
            const breakdown = { a: 7.5, b: 7.8, c: 7.6, d: 7.7 };
            const result = checkScoreClustering(breakdown);
            expect(result.suspicious).toBe(true);
            expect(result.reason).toContain('low score spread');
        });

        it('should flag all identical scores', () => {
            const breakdown = { a: 8, b: 8, c: 8, d: 8 };
            const result = checkScoreClustering(breakdown);
            expect(result.suspicious).toBe(true);
            // When all scores are identical, spread is 0 so it triggers the low spread check
            expect(result.reason).toContain('score spread');
        });

        it('should not flag normal score distribution', () => {
            const breakdown = { a: 9, b: 7, c: 8, d: 6 };
            const result = checkScoreClustering(breakdown);
            expect(result.suspicious).toBe(false);
        });
    });

    describe('estimatePromptComplexity', () => {
        it('should use level as base complexity', () => {
            expect(estimatePromptComplexity({ level: 5 })).toBe(5);
        });

        it('should increase for long prompts', () => {
            const longPrompt = 'a'.repeat(2500);
            expect(estimatePromptComplexity({ level: 5, prompt: longPrompt })).toBeGreaterThan(5);
        });

        it('should increase for hard categories', () => {
            expect(estimatePromptComplexity({ level: 5, category: 'reasoning' })).toBeGreaterThan(5);
        });

        it('should stay within the internal 1-10 complexity scale', () => {
            const result = estimatePromptComplexity({
                level: 5,
                prompt: 'a'.repeat(10000),
                category: 'reasoning'
            });
            expect(result).toBeLessThanOrEqual(10);
        });

        it('should floor at 1', () => {
            const result = estimatePromptComplexity({ level: 0 });
            expect(result).toBeGreaterThanOrEqual(1);
        });
    });

    describe('assess', () => {
        it('should return high confidence for good results', () => {
            const scoreResult = {
                quality_score: 7.5,
                breakdown: { a: 8, b: 7, c: 8, d: 7 },
                explanation: 'The response correctly addresses the question with clear reasoning. ' +
                    'Score breakdown: accuracy 8/10, clarity 7/10, completeness 8/10.'
            };
            const prompt = { level: 5 };

            const result = assess(scoreResult, prompt);
            expect(result.judge_confidence).toBeGreaterThanOrEqual(0.7);
            expect(result.needs_review).toBe(false);
        });

        it('should flag low-quality results for review', () => {
            const scoreResult = {
                quality_score: 9.5,
                breakdown: { a: 9, b: 9, c: 9, d: 9 },
                explanation: 'Good'
            };
            const prompt = { level: 5 };

            const result = assess(scoreResult, prompt);
            expect(result.needs_review).toBe(true);
            expect(result.issues.length).toBeGreaterThan(0);
        });

        it('should detect truncation issues', () => {
            const scoreResult = {
                quality_score: 7,
                breakdown: { a: 7, b: 7, c: 7 },
                explanation: 'Reasonable explanation here that meets length requirements.',
                truncation: { judge_truncated: true }
            };
            const prompt = { level: 5 };

            const result = assess(scoreResult, prompt);
            expect(result.issues.some(i => i.includes('truncated'))).toBe(true);
        });

        it('should handle failed LLM judge', () => {
            const scoreResult = {
                quality_score: 0,
                scoring_method: 'llm_failed'
            };
            const prompt = { level: 5 };

            const result = assess(scoreResult, prompt);
            expect(result.judge_confidence).toBeLessThanOrEqual(0.1);
            expect(result.needs_review).toBe(true);
        });

        it('should force review when decomposed judge subcalls failed', () => {
            const scoreResult = {
                quality_score: 0,
                scoring_method: 'decomposed',
                breakdown: { accuracy: 0, completeness: 0, clarity: 0 },
                decomposed_breakdown: {
                    accuracy: [
                        { question: 'q1', answer: null, contributed: false, error: true },
                        { question: 'q2', answer: null, contributed: false, error: true }
                    ],
                    completeness: [
                        { question: 'q3', answer: null, contributed: false, error: true }
                    ]
                },
                judge_reliable: false,
                judge_errors: 3,
                failed_dimensions: []
            };

            const result = assess(scoreResult, { level: 4, category: 'math' });
            expect(result.judge_confidence).toBeLessThanOrEqual(0.3);
            expect(result.needs_review).toBe(true);
            expect(result.issues.some(i => i.includes('Judge execution reliability issue'))).toBe(true);
        });
    });

    describe('quickCheck', () => {
        it('should return lower confidence for high level + high score', () => {
            const result = quickCheck(9.0, 5);
            expect(result.confidence).toBeLessThan(1);
        });

        it('should return high confidence for normal combinations', () => {
            const result = quickCheck(7.0, 3);
            expect(result.confidence).toBe(1.0);
            expect(result.needsReview).toBe(false);
        });
    });

    describe('aggregateConfidence', () => {
        it('should calculate aggregate statistics', () => {
            const results = [
                { judge_confidence: 0.8, needs_review: false },
                { judge_confidence: 0.6, needs_review: true },
                { judge_confidence: 0.9, needs_review: false }
            ];

            const agg = aggregateConfidence(results);
            expect(agg.avgConfidence).toBeCloseTo(0.77, 1);
            expect(agg.minConfidence).toBe(0.6);
            expect(agg.maxConfidence).toBe(0.9);
            expect(agg.reviewNeeded).toBe(1);
            expect(agg.reviewPercent).toBe(33);
            expect(agg.total).toBe(3);
        });

        it('should handle empty results', () => {
            const agg = aggregateConfidence([]);
            expect(agg.avgConfidence).toBe(0);
            expect(agg.total).toBe(0);
        });
    });

    describe('real-corpus calibration regression (TODO 0131v2)', () => {
        it('treats intrinsic coding dimension spread as high confidence under category profiles', () => {
            const scoreResult = {
                quality_score: 8.2,
                scoring_method: 'decomposed',
                breakdown: null,
                decomposed_breakdown: {
                    correctness: [
                        { question: 'q1', contributed: true, weight: 1 },
                        { question: 'q2', contributed: true, weight: 1 },
                        { question: 'q3', contributed: true, weight: 1 }
                    ],
                    clarity: [
                        { question: 'q1', contributed: true, weight: 1 },
                        { question: 'q2', contributed: true, weight: 1 },
                        { question: 'q3', contributed: true, weight: 1 }
                    ],
                    efficiency: [
                        { question: 'q1', contributed: true, weight: 1 },
                        { question: 'q2', contributed: true, weight: 1 },
                        { question: 'q3', contributed: true, weight: 1 }
                    ],
                    robustness: [
                        { question: 'q1', contributed: true, weight: 1 },
                        { question: 'q2', contributed: false, weight: 1 },
                        { question: 'q3', contributed: false, weight: 1 }
                    ]
                }
            };

            const codingFeatures = extractConfidenceFeatures(scoreResult, { level: 2, category: 'coding' });
            const coding = assess(scoreResult, { level: 2, category: 'coding' });
            const math = assess(scoreResult, { level: 2, category: 'math' });

            expect(codingFeatures.maxDeviation).toBeGreaterThan(0.4);
            expect(codingFeatures.expectedMaxDeviation).toBeGreaterThan(codingFeatures.maxDeviation);
            expect(codingFeatures.outlierDeviation).toBe(0);

            expect(coding.judge_confidence).toBeGreaterThanOrEqual(0.85);
            expect(coding.needs_review).toBe(false);
            expect(coding.review_reason).toBeNull();

            // Same decomposed spread remains more suspicious in a category whose
            // fitted profile expects tighter inter-dimension agreement.
            expect(math.judge_confidence).toBeLessThan(0.7);
            expect(math.needs_review).toBe(true);
        });
    });
});
