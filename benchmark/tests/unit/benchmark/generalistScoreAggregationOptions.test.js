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

        expect(BenchmarkResult.aggregate).toHaveBeenCalledTimes(3);
        for (const call of BenchmarkResult.aggregate.mock.calls) {
            expect(call[1]).toMatchObject({
                allowDiskUse: true,
                maxTimeMS: expect.any(Number)
            });
            expect(call[1].maxTimeMS).toBeGreaterThan(0);
        }
    });
});
