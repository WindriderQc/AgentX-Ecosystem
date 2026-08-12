const mongoose = require('mongoose');

// Mock Mongoose models
jest.mock('../../models/BenchmarkResult', () => {
    const mockFind = jest.fn();
    return { find: mockFind };
});

jest.mock('../../models/JudgeGroundTruth', () => {
    const mockFind = jest.fn();
    const mockFindOne = jest.fn();
    const mockCreate = jest.fn();
    return { find: mockFind, findOne: mockFindOne, create: mockCreate };
});

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const BenchmarkResult = require('../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const { getJudgeFeedbackStats, autoPromoteGroundTruth } = require('../../src/services/judgeFeedbackLoop');

beforeEach(() => jest.clearAllMocks());

describe('judgeFeedbackLoop', () => {
    describe('getJudgeFeedbackStats', () => {
        it('returns empty stats when no reviewed results', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([])
                })
            });
            const result = await getJudgeFeedbackStats();
            expect(result).toEqual({ byCategory: {}, overall: { count: 0 } });
        });

        it('computes per-category stats from reviewed results', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { prompt_category: 'reasoning', quality_score: 8, human_score: 7 },
                        { prompt_category: 'reasoning', quality_score: 6, human_score: 8 },
                        { prompt_category: 'coding', quality_score: 9, human_score: 5 },
                    ])
                })
            });

            const result = await getJudgeFeedbackStats();

            expect(result.overall.count).toBe(3);
            expect(result.byCategory.reasoning).toBeDefined();
            expect(result.byCategory.reasoning.count).toBe(2);
            expect(result.byCategory.coding).toBeDefined();
            expect(result.byCategory.coding.count).toBe(1);
        });

        it('detects harsh (judge < human) and lenient (judge > human) rates', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { prompt_category: 'cat', quality_score: 5, human_score: 8 },   // harsh (dev = -3)
                        { prompt_category: 'cat', quality_score: 9, human_score: 6 },   // lenient (dev = +3)
                        { prompt_category: 'cat', quality_score: 7, human_score: 7 },   // neutral
                    ])
                })
            });

            const result = await getJudgeFeedbackStats();
            expect(result.byCategory.cat.harshRate).toBeGreaterThan(0);
            expect(result.byCategory.cat.lenientRate).toBeGreaterThan(0);
        });

        it('counts high-divergence results (>=2.0)', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { prompt_category: 'a', quality_score: 8, human_score: 5 },   // dev = 3 (high)
                        { prompt_category: 'a', quality_score: 7, human_score: 6.5 }, // dev = 0.5 (low)
                    ])
                })
            });

            const result = await getJudgeFeedbackStats();
            expect(result.overall.highDivergenceCount).toBe(1);
            expect(result.overall.highDivergenceRate).toBe(0.5);
        });
    });

    describe('autoPromoteGroundTruth', () => {
        it('skips results below divergence threshold', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { _id: 'id1', prompt_name: 'p1', prompt: 'test', response: 'resp',
                          prompt_category: 'cat', quality_score: 7, human_score: 6, model: 'm1' }
                    ])
                })
            });
            JudgeGroundTruth.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([])
                })
            });

            const result = await autoPromoteGroundTruth();
            expect(result.skipped).toBe(1);
            expect(result.promoted).toBe(0);
            expect(JudgeGroundTruth.create).not.toHaveBeenCalled();
        });

        it('promotes results with high divergence', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { _id: 'id1', prompt_name: 'p1', prompt: 'test prompt', response: 'test resp',
                          prompt_category: 'reasoning', quality_score: 9, human_score: 5, model: 'llama3', human_notes: 'wrong' }
                    ])
                })
            });
            JudgeGroundTruth.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([])
                })
            });
            JudgeGroundTruth.create.mockResolvedValue({});

            const result = await autoPromoteGroundTruth();
            expect(result.promoted).toBe(1);
            expect(JudgeGroundTruth.create).toHaveBeenCalledWith(
                expect.objectContaining({
                    name: 'auto_p1_llama3_id1',
                    category: 'reasoning',
                    expert_scores: { overall: 5, dimensions: {} },
                    expert_rationale: 'wrong',
                    tags: ['auto-promoted'],
                    created_by: 'auto-feedback-loop'
                })
            );
        });

        it('skips results that already have ground truth entries', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { _id: 'id1', prompt_name: 'p1', prompt: 'test', response: 'resp',
                          quality_score: 9, human_score: 5, model: 'm1' }
                    ])
                })
            });
            JudgeGroundTruth.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([{ name: 'auto_p1_m1_id1' }])
                })
            });

            const result = await autoPromoteGroundTruth();
            expect(result.skipped).toBe(1);
            expect(result.promoted).toBe(0);
        });

        it('handles create errors gracefully', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { _id: 'id1', prompt_name: 'p1', prompt: 'test', response: 'resp',
                          quality_score: 9, human_score: 5, model: 'm1' }
                    ])
                })
            });
            JudgeGroundTruth.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([])
                })
            });
            JudgeGroundTruth.create.mockRejectedValue(new Error('duplicate key'));

            const result = await autoPromoteGroundTruth();
            expect(result.promoted).toBe(0);
            expect(result.skipped).toBe(1);
        });

        it('returns zero counts for empty candidate set', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([])
                })
            });
            JudgeGroundTruth.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([])
                })
            });

            const result = await autoPromoteGroundTruth();
            expect(result.promoted).toBe(0);
            expect(result.skipped).toBe(0);
        });
    });

    // Regression: courthouse override now writes human_score into quality_score
    // and preserves the original judge score on judge_quality_score. The
    // feedback loop must compute drift against judge_quality_score (when set),
    // not against quality_score, otherwise drift collapses to zero on every
    // overridden row.
    describe('respects judge_quality_score on overridden rows', () => {
        it('uses judge_quality_score for drift when present (overridden rows)', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        // After override: quality_score == human_score == 5;
                        // judge_quality_score holds the original 9. Drift must
                        // be 4.0, not 0.0.
                        { prompt_category: 'cat', quality_score: 5, human_score: 5, judge_quality_score: 9 }
                    ])
                })
            });

            const result = await getJudgeFeedbackStats();
            expect(result.byCategory.cat.avgDeviation).toBeCloseTo(4.0, 1);
            expect(result.overall.highDivergenceCount).toBe(1);
        });

        it('falls back to quality_score for legacy rows without judge_quality_score', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        { prompt_category: 'cat', quality_score: 9, human_score: 5 }
                    ])
                })
            });

            const result = await getJudgeFeedbackStats();
            expect(result.byCategory.cat.avgDeviation).toBeCloseTo(4.0, 1);
        });

        it('autoPromoteGroundTruth uses judge_quality_score for divergence and rationale', async () => {
            BenchmarkResult.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([
                        // Without the fix this row would skip (5 - 5 = 0 < threshold).
                        { _id: 'id1', prompt_name: 'p1', prompt: 'test', response: 'resp',
                          prompt_category: 'reasoning', quality_score: 5, human_score: 5,
                          judge_quality_score: 9, model: 'llama3', human_notes: 'judge too lenient' }
                    ])
                })
            });
            JudgeGroundTruth.find.mockReturnValue({
                select: jest.fn().mockReturnValue({
                    lean: jest.fn().mockResolvedValue([])
                })
            });
            JudgeGroundTruth.create.mockResolvedValue({});

            const result = await autoPromoteGroundTruth();
            expect(result.promoted).toBe(1);
            expect(JudgeGroundTruth.create).toHaveBeenCalledWith(
                expect.objectContaining({ expert_scores: { overall: 5, dimensions: {} } })
            );
        });
    });
});
