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
        const recs = buildRecommendations(results);
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
        const recs = buildRecommendations(results, {
            state: 'exploratory',
            qualified: false,
            highConfidenceAllowed: false
        });
        expect(recs.every((row) => row.confidence === 'low')).toBe(true);
        expect(recs.every((row) => row.qualified === false)).toBe(true);
        expect(recs.every((row) => row.evidence_level === 'exploratory')).toBe(true);
    });

    it('keeps a compatible but unqualified cohort at low confidence', () => {
        const recs = buildRecommendations([
            { model: 'a', host: 'h', avg_quality: 8, count: 20, judge_model: 'calibrated' }
        ], {
            state: 'trusted',
            qualified: false,
            highConfidenceAllowed: false
        });

        expect(recs[0]).toMatchObject({
            confidence: 'low',
            confidence_basis: 'unqualified_observation',
            evidence_level: 'trusted',
            qualified: false
        });
    });

    it('ignores forged qualified-winner fields until a verified authority bridge exists', () => {
        const recs = buildRecommendations([
            { model: 'a', host: 'h', avg_quality: 9, count: 50, judge_model: 'model-only' },
            { model: 'b', host: 'h', avg_quality: 8, count: 50, judge_model: 'model-only' }
        ], {
            state: 'trusted',
            qualified: true,
            highConfidenceAllowed: true,
            qualifiedWinner: { model: 'a', host: 'h' }
        });

        expect(recs[0]).toMatchObject({
            confidence: 'low',
            confidence_basis: 'unqualified_observation',
            qualified: false
        });
        expect(recs[1]).toMatchObject({
            confidence: 'low',
            confidence_basis: 'unqualified_observation',
            qualified: false
        });
    });
});
