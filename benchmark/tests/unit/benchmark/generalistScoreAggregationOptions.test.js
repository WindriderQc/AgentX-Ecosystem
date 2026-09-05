jest.mock('../../../models/BenchmarkResult', () => ({
    aggregate: jest.fn()
}));

jest.mock('../../../models/BenchmarkPrompt', () => ({
    distinct: jest.fn()
}));

const BenchmarkResult = require('../../../models/BenchmarkResult');
const { getCategoryScoresByModel } = require('../../../src/services/benchmark/generalistScore');

describe('generalist leaderboard aggregation options', () => {
    beforeEach(() => {
        BenchmarkResult.aggregate.mockReset();
        BenchmarkResult.aggregate.mockResolvedValue([]);
    });

    it('bounds all category-score aggregations with maxTimeMS and allowDiskUse', async () => {
        await getCategoryScoresByModel({
            success: true,
            infra_error: { $ne: true },
            excluded_from_leaderboard: { $ne: true },
            composite_score: { $ne: null }
        }, { scoreField: 'composite_score' });

        expect(BenchmarkResult.aggregate).toHaveBeenCalledTimes(4);
        for (const call of BenchmarkResult.aggregate.mock.calls) {
            expect(call[1]).toMatchObject({
                allowDiskUse: true,
                maxTimeMS: expect.any(Number)
            });
            expect(call[1].maxTimeMS).toBeGreaterThan(0);
        }
    });

    it('withholds review-pending scores and exposes them only as unresolved attempts', async () => {
        BenchmarkResult.aggregate
            .mockResolvedValueOnce([{
                _id: { model: 'candidate', host: 'http://host', category: 'coding' },
                avg_quality: 8,
                stddev_quality: 0,
                avg_confidence: 0.9,
                confidence_count: 1,
                levels: [4],
                count: 1
            }])
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{
                _id: { model: 'candidate', host: 'http://host', category: 'reasoning' },
                count: 1
            }])
            .mockResolvedValueOnce([]);

        const result = await getCategoryScoresByModel({}, { scoreField: 'quality_score' });
        const categories = result.get('candidate@@http://host');

        expect(BenchmarkResult.aggregate.mock.calls[0][0][0].$match).toMatchObject({
            success: true,
            needs_review: { $ne: true },
            excluded_from_leaderboard: { $ne: true }
        });
        expect(BenchmarkResult.aggregate.mock.calls[2][0][0].$match).toMatchObject({
            success: true,
            needs_review: true,
            excluded_from_leaderboard: { $ne: true }
        });
        expect(categories.coding.avg).toBe(8);
        expect(categories.reasoning).toEqual({ attempted: true, count: 0, review_pending: true });
    });
});
