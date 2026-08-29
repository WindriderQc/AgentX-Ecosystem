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

        it.each([null, undefined, 0, -1, NaN, Infinity, -Infinity])(
            'preserves unavailable or invalid throughput (%p) as unscored',
            throughput => {
                expect(efficiencyScore(8, throughput)).toBeNull();
            }
        );
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

        it('excludes zero and non-finite throughput from the frontier', () => {
            const points = [
                { model: 'measured', host: 'h1', quality: 7, tokPerSec: 20 },
                { model: 'missing', host: 'h1', quality: 10, tokPerSec: null },
                { model: 'zero', host: 'h1', quality: 9, tokPerSec: 0 },
                { model: 'nan', host: 'h1', quality: 8, tokPerSec: NaN },
                { model: 'infinite', host: 'h1', quality: 8, tokPerSec: Infinity },
            ];

            expect(paretoFrontier(points).map(point => point.model)).toEqual(['measured']);
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

        it('prefers finite positive calibrated throughput and otherwise falls back to raw throughput', async () => {
            BenchmarkResult.aggregate.mockResolvedValue([]);
            await getEfficiencyMap();

            const rawPipeline = BenchmarkResult.aggregate.mock.calls[0][0];
            const groupStage = rawPipeline.find(s => s.$group);
            const tpsExpr = groupStage.$group.avgTokPerSec.$avg;
            expect(tpsExpr.$let.vars).toEqual({
                calibrated: '$performance_baseline.tokensPerSec',
                raw: '$tokens_per_sec'
            });

            const [calibratedPredicate, calibratedValue, rawFallback] = tpsExpr.$let.in.$cond;
            expect(calibratedValue).toBe('$$calibrated');
            expect(calibratedPredicate.$and).toEqual(expect.arrayContaining([
                { $isNumber: '$$calibrated' },
                { $gt: ['$$calibrated', 0] }
            ]));
            expect(rawFallback.$cond[1]).toBe('$$raw');
            expect(rawFallback.$cond[2]).toBeNull();
            expect(rawFallback.$cond[0].$and).toEqual(expect.arrayContaining([
                { $isNumber: '$$raw' },
                { $gt: ['$$raw', 0] }
            ]));
        });

        it('quarantines quality-only and invalid-throughput combinations instead of ranking them at zero', async () => {
            BenchmarkResult.aggregate
                .mockResolvedValueOnce([
                    {
                        _id: { model: 'measured', host: 'host-a' },
                        avgQuality: 8,
                        avgTokPerSec: 40,
                        avgTtft: 120,
                        avgLatency: 900,
                        testCount: 6,
                        throughputTestCount: 4
                    },
                    {
                        _id: { model: 'missing', host: 'host-a' },
                        avgQuality: 9.5,
                        avgTokPerSec: null,
                        testCount: 6,
                        throughputTestCount: 0
                    },
                    {
                        _id: { model: 'zero', host: 'host-a' },
                        avgQuality: 9,
                        avgTokPerSec: 0,
                        testCount: 6,
                        throughputTestCount: 0
                    },
                    {
                        _id: { model: 'nan', host: 'host-a' },
                        avgQuality: 9,
                        avgTokPerSec: NaN,
                        testCount: 6,
                        throughputTestCount: 0
                    },
                    {
                        _id: { model: 'infinite', host: 'host-a' },
                        avgQuality: 9,
                        avgTokPerSec: Infinity,
                        testCount: 6,
                        throughputTestCount: 0
                    }
                ])
                .mockResolvedValueOnce([]);

            const map = await getEfficiencyMap();

            expect(map.entries).toHaveLength(1);
            expect(map.entries[0]).toMatchObject({
                model: 'measured',
                avgTokPerSec: 40,
                throughputTestCount: 4,
                rankStatus: 'ranked'
            });
            expect(map.unranked).toHaveLength(4);
            expect(map.unranked.map(entry => entry.model)).toEqual(['missing', 'zero', 'nan', 'infinite']);
            for (const entry of map.unranked) {
                expect(entry).toMatchObject({
                    avgTokPerSec: null,
                    efficiencyScore: null,
                    paretoOptimal: false,
                    rankStatus: 'unranked',
                    unrankedReason: 'missing_throughput'
                });
            }
            expect(map.meta).toMatchObject({ rankedCombinations: 1, unrankedCombinations: 4 });
        });

        it('orders measured combinations by efficiency rather than quality alone', async () => {
            BenchmarkResult.aggregate
                .mockResolvedValueOnce([
                    {
                        _id: { model: 'quality-only-winner', host: 'host-a' },
                        avgQuality: 10,
                        avgTokPerSec: 1,
                        testCount: 5,
                        throughputTestCount: 5
                    },
                    {
                        _id: { model: 'efficient-winner', host: 'host-a' },
                        avgQuality: 8,
                        avgTokPerSec: 80,
                        testCount: 5,
                        throughputTestCount: 5
                    }
                ])
                .mockResolvedValueOnce([]);

            const map = await getEfficiencyMap();

            expect(map.entries.map(entry => entry.model)).toEqual([
                'efficient-winner',
                'quality-only-winner'
            ]);
        });
    });
});
