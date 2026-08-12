const { harmonicMean, efficiencyScore, paretoFrontier } = require('../../src/services/benchmark/efficiencyMap');

jest.mock('../../models/BenchmarkResult', () => ({
    aggregate: jest.fn()
}));
jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));
const BenchmarkResult = require('../../models/BenchmarkResult');
const { getEfficiencyMap } = require('../../src/services/benchmark/efficiencyMap');

describe('efficiencyMap', () => {
    describe('harmonicMean', () => {
        it('returns 0 when either value is 0', () => {
            expect(harmonicMean(0, 50)).toBe(0);
            expect(harmonicMean(50, 0)).toBe(0);
        });

        it('penalizes imbalance', () => {
            expect(harmonicMean(90, 5)).toBeCloseTo(9.47, 1);
        });

        it('rewards balance', () => {
            expect(harmonicMean(75, 75)).toBe(75);
        });

        it('handles equal mid-range values', () => {
            expect(harmonicMean(50, 50)).toBe(50);
        });
    });

    describe('efficiencyScore', () => {
        it('returns 0 when quality below floor (3.0)', () => {
            expect(efficiencyScore(2.9, 100)).toBe(0);
        });

        it('computes harmonic mean of normalized quality and capped speed', () => {
            // quality 8.0 => nQ = 80, speed 40 => nS = 40
            // HM(80, 40) = 2*80*40 / (80+40) = 6400/120 = 53.33
            expect(efficiencyScore(8.0, 40)).toBeCloseTo(53.33, 1);
        });

        it('caps speed at 100', () => {
            // quality 8.0 => nQ = 80, speed 150 => nS = 100
            // HM(80, 100) = 2*80*100 / (80+100) = 16000/180 = 88.89
            expect(efficiencyScore(8.0, 150)).toBeCloseTo(88.89, 1);
        });

        it('handles perfect scores', () => {
            expect(efficiencyScore(10, 100)).toBe(100);
        });
    });

    describe('paretoFrontier', () => {
        it('returns all points when none dominate each other', () => {
            const points = [
                { model: 'a', host: 'h1', quality: 9, tokPerSec: 10 },
                { model: 'b', host: 'h1', quality: 7, tokPerSec: 30 },
                { model: 'c', host: 'h1', quality: 5, tokPerSec: 50 },
            ];
            const frontier = paretoFrontier(points);
            expect(frontier).toHaveLength(3);
        });

        it('excludes dominated points', () => {
            const points = [
                { model: 'a', host: 'h1', quality: 9, tokPerSec: 40 },
                { model: 'b', host: 'h1', quality: 7, tokPerSec: 30 },
                { model: 'c', host: 'h1', quality: 5, tokPerSec: 50 },
            ];
            const frontier = paretoFrontier(points);
            expect(frontier).toHaveLength(2);
            expect(frontier.map(p => p.model)).toEqual(['a', 'c']);
        });

        it('returns empty array for empty input', () => {
            expect(paretoFrontier([])).toEqual([]);
        });

        it('returns single point for single input', () => {
            const points = [{ model: 'a', host: 'h1', quality: 8, tokPerSec: 20 }];
            expect(paretoFrontier(points)).toHaveLength(1);
        });
    });

    describe('getEfficiencyMap — match filters and calibrated tps', () => {
        beforeEach(() => {
            BenchmarkResult.aggregate.mockReset();
        });

        it('passes infra_error and excluded_from_leaderboard filters into both aggregations', async () => {
            BenchmarkResult.aggregate.mockResolvedValue([]);
            await getEfficiencyMap();

            expect(BenchmarkResult.aggregate).toHaveBeenCalledTimes(2);
            for (const call of BenchmarkResult.aggregate.mock.calls) {
                const pipeline = call[0];
                const matchStage = pipeline.find(s => s.$match && s.$match.success === true);
                expect(matchStage.$match.infra_error).toEqual({ $ne: true });
                expect(matchStage.$match.excluded_from_leaderboard).toEqual({ $ne: true });
            }
        });

        it('uses performance_baseline.tokensPerSec via $ifNull for avgTokPerSec', async () => {
            BenchmarkResult.aggregate.mockResolvedValue([]);
            await getEfficiencyMap();

            const rawPipeline = BenchmarkResult.aggregate.mock.calls[0][0];
            const groupStage = rawPipeline.find(s => s.$group);
            const tpsExpr = groupStage.$group.avgTokPerSec.$avg;
            // tokens_per_sec is stored numeric now -- no $toDouble cast.
            const ifNullPath = tpsExpr.$ifNull;
            expect(ifNullPath[0]).toBe('$performance_baseline.tokensPerSec');
            expect(ifNullPath[1]).toBe('$tokens_per_sec');
        });
    });
});
