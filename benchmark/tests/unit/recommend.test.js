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

    it('should assign confidence levels', () => {
        const results = [
            { model: 'a', host: 'h', avg_quality: 8.0, count: 15, judge_model: 'calibrated-judge' },
            { model: 'b', host: 'h', avg_quality: 7.0, count: 5, judge_model: 'calibrated-judge' },
            { model: 'c', host: 'h', avg_quality: 6.0, count: 20, judge_model: 'unknown-judge' }
        ];
        const calibrated = new Set(['calibrated-judge']);

        const recs = buildRecommendations(results, calibrated);
        expect(recs[0].confidence).toBe('high');
        expect(recs[1].confidence).toBe('medium');
        expect(recs[2].confidence).toBe('medium');
    });
});
