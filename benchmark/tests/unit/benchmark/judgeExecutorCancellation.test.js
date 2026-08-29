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
});
