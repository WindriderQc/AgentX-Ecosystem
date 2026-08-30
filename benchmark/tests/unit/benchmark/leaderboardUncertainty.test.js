const {
    weightedConfidenceMargin
} = require('../../../src/services/benchmark/generalistScoreNormalizers');

describe('leaderboard uncertainty contract', () => {
    test('combines independent prompt means without counting repeats as fixtures', () => {
        const result = weightedConfidenceMargin({
            coding: {
                avg: 8,
                count: 12,
                uncertainty_count: 4,
                uncertainty_stddev: 1,
                repeat_count: 12
            },
            reasoning: {
                avg: 7,
                count: 8,
                uncertainty_count: 4,
                uncertainty_stddev: 1,
                repeat_count: 8
            }
        }, { coding: 0.5, reasoning: 0.5 }, 'quality_score');

        expect(result).toEqual({
            margin: 8.7,
            sampleSize: 8,
            repeatCount: 20,
            method: 'weighted_category_prompt_means_t95'
        });
    });

    test('returns unknown unless every covered category has repeated prompt evidence', () => {
        const result = weightedConfidenceMargin({
            coding: {
                avg: 8,
                count: 4,
                uncertainty_count: 1,
                uncertainty_stddev: 0,
                repeat_count: 4
            }
        }, { coding: 1 }, 'quality_score');

        expect(result).toEqual({ margin: null, sampleSize: 0, repeatCount: 0, method: null });
    });
});
