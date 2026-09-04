'use strict';

jest.mock('../../../models/BenchmarkResult', () => ({
    findById: jest.fn(),
    updateOne: jest.fn()
}));

jest.mock('../../../models/BenchmarkPrompt', () => ({
    findOne: jest.fn()
}));

jest.mock('../../../src/services/qualityScorer', () => ({
    scoreResponse: jest.fn(),
    calculateCompositeScore: jest.fn(() => ({
        composite_score: 7,
        composite_profile_used: 'knowledge',
        normalized: {}
    }))
}));

const BenchmarkResult = require('../../../models/BenchmarkResult');
const { scoreResponse } = require('../../../src/services/qualityScorer');
const { judgeResult } = require('../../../src/services/benchmark/judgeExecutor');

beforeEach(() => {
    jest.clearAllMocks();
    BenchmarkResult.findById.mockResolvedValue({
        _id: '507f1f77bcf86cd799439011',
        success: true,
        response: 'model answer',
        prompt: 'question',
        prompt_name: 'cancel-test',
        prompt_level: 1,
        prompt_category: 'knowledge',
        scoring_type: 'knowledge',
        prompt_snapshot_embedded: true,
        latency: 100,
        tokens_per_sec: 20
    });
});
describe('judgeResult cancellation persistence boundary', () => {
    it('rejects a score completed after cancellation without persisting it', async () => {
        const controller = new AbortController();
        scoreResponse.mockImplementation(async () => {
            controller.abort(new Error('private batch stop reason'));
            return {
                quality_score: 8,
                scoring_method: 'llm_judge',
                scoring_type: 'knowledge',
                explanation: 'must not persist',
                breakdown: { overall: 8 },
                judge_confidence: 0.9
            };
        });

        await expect(judgeResult(
            '507f1f77bcf86cd799439011',
            {
                host: 'http://judge:11434',
                model: 'judge:test',
                cancelSignal: controller.signal
            }
        )).rejects.toMatchObject({
            code: 'BENCHMARK_BATCH_STOPPED',
            message: 'Benchmark batch judging cancelled'
        });

        expect(BenchmarkResult.updateOne).not.toHaveBeenCalled();
    });

    it('invalidates a judge score whose database write races cancellation', async () => {
        const controller = new AbortController();
        const lost = Object.assign(new Error('judge workload admission lost'), {
            code: 'BENCHMARK_CLAIM_LOST'
        });
        scoreResponse.mockResolvedValue({
            quality_score: 8,
            scoring_method: 'llm_judge',
            scoring_type: 'knowledge',
            explanation: 'score',
            breakdown: { overall: 8 },
            judge_confidence: 0.9
        });
        BenchmarkResult.updateOne
            .mockImplementationOnce(async () => {
                controller.abort(lost);
                return { matchedCount: 1 };
            })
            .mockResolvedValueOnce({ matchedCount: 1 });

        await expect(judgeResult(
            '507f1f77bcf86cd799439011',
            { host: 'http://judge:11434', model: 'judge:test', cancelSignal: controller.signal }
        )).rejects.toMatchObject({
            code: 'BENCHMARK_BATCH_STOPPED',
            authorityCompensated: true
        });

        expect(BenchmarkResult.updateOne).toHaveBeenCalledTimes(2);
        expect(BenchmarkResult.updateOne.mock.calls[1][1]).toEqual({
            $set: expect.objectContaining({ scoring_method: 'authority_invalidated' })
        });
    });

    it('retains admission when an ambiguous judge write cannot be invalidated', async () => {
        const controller = new AbortController();
        const lost = Object.assign(new Error('judge workload admission lost'), {
            code: 'BENCHMARK_CLAIM_LOST'
        });
        scoreResponse.mockResolvedValue({
            quality_score: 8,
            scoring_method: 'llm_judge',
            scoring_type: 'knowledge',
            explanation: 'score',
            breakdown: { overall: 8 },
            judge_confidence: 0.9
        });
        BenchmarkResult.updateOne
            .mockImplementationOnce(async () => {
                controller.abort(lost);
                return { matchedCount: 1 };
            })
            .mockRejectedValueOnce(new Error('invalidation unavailable'));

        await expect(judgeResult(
            '507f1f77bcf86cd799439011',
            { host: 'http://judge:11434', model: 'judge:test', cancelSignal: controller.signal }
        )).rejects.toMatchObject({
            code: 'JUDGE_AUTHORITY_RECONCILIATION_PENDING',
            retainAdmission: true,
            compensationError: expect.any(Error)
        });
    });
});
