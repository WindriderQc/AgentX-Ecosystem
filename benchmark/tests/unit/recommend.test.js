jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const { buildRecommendations } = require('../../routes/benchmark/recommend');

describe('Recommend API', () => {
    it('should rank models by quality score', () => {
        const results = [
            { model: 'qwen3:14b', host: '192.0.2.12', avg_quality: 8.4, count: 24 },
            { model: 'qwen2.5:7b', host: '192.0.2.99', avg_quality: 7.1, count: 8 }
        ];
        const calibratedJudges = new Set(['qwen2.5:7b-instruct-q5_K_M']);

        const recs = buildRecommendations(results, calibratedJudges);
        expect(recs).toHaveLength(2);
        expect(recs[0].model).toBe('qwen3:14b');
        expect(recs[0].quality_score).toBe(8.4);
    });

    it('never assigns high confidence to exploratory evidence even with volume and calibration', () => {
        const results = [
            { model: 'a', host: 'h', avg_quality: 8.0, count: 15, judge_model: 'calibrated-judge' },
            { model: 'b', host: 'h', avg_quality: 7.0, count: 5, judge_model: 'calibrated-judge' },
            { model: 'c', host: 'h', avg_quality: 6.0, count: 20, judge_model: 'unknown-judge' }
        ];
        const calibrated = new Set(['calibrated-judge']);

        const recs = buildRecommendations(results, calibrated, {
            state: 'exploratory',
            qualified: false,
            highConfidenceAllowed: false
        });
        expect(recs.every((row) => row.confidence === 'low')).toBe(true);
        expect(recs.every((row) => row.qualified === false)).toBe(true);
        expect(recs.every((row) => row.evidence_level === 'exploratory')).toBe(true);
    });

    it('caps a compatible but insufficiently qualified cohort at medium confidence', () => {
        const recs = buildRecommendations([
            { model: 'a', host: 'h', avg_quality: 8, count: 20, judge_model: 'calibrated' }
        ], new Set(['calibrated']), {
            state: 'trusted',
            qualified: false,
            highConfidenceAllowed: false
        });

        expect(recs[0]).toMatchObject({
            confidence: 'medium',
            confidence_basis: 'trusted_cohort_with_model_only_calibration',
            evidence_level: 'trusted',
            qualified: false
        });
    });

    it('never turns a model-only JudgeAccuracyMatrix into qualification or high confidence', () => {
        const recs = buildRecommendations([
            { model: 'a', host: 'h', avg_quality: 9, count: 50, judge_model: 'model-only' }
        ], new Set(['model-only']), {
            state: 'trusted',
            qualified: true,
            highConfidenceAllowed: true,
            qualifiedWinner: { model: 'a', host: 'h' }
        });

        expect(recs[0]).toMatchObject({
            confidence: 'medium',
            confidence_basis: 'trusted_cohort_with_model_only_calibration',
            qualified: false
        });
        expect(recs[0].confidence).not.toBe('high');
    });
});
