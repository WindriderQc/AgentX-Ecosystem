jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/services/qualityScorer', () => ({
    scoreResponse: jest.fn()
}));
jest.mock('../../src/services/scoring/resolveJudgeConfig', () => ({
    resolveJudgeConfig: jest.fn((cfg) => ({ timeout: 30000, ...cfg }))
}));

const { scoreResponse } = require('../../src/services/qualityScorer');
const { resolveJudgeConfig } = require('../../src/services/scoring/resolveJudgeConfig');
const { runCalibrationBatch, buildAccuracyMatrix } = require('../../src/services/benchmark/calibrationRunner');

describe('Calibration Runner', () => {
    afterEach(() => jest.clearAllMocks());

    describe('buildAccuracyMatrix', () => {
        it('should compute per-cell deviation and pass/fail', () => {
            const referenceScores = [
                { entry: { category: 'coding', difficulty: 3 }, score: 8.0 },
                { entry: { category: 'coding', difficulty: 3 }, score: 7.0 },
                { entry: { category: 'creative', difficulty: 4 }, score: 9.0 }
            ];
            const challengerScores = [
                { entry: { category: 'coding', difficulty: 3 }, score: 7.5 },
                { entry: { category: 'coding', difficulty: 3 }, score: 7.0 },
                { entry: { category: 'creative', difficulty: 4 }, score: 6.0 }
            ];

            const matrix = buildAccuracyMatrix(referenceScores, challengerScores, 1.5);

            expect(matrix.cells).toHaveLength(2);

            const codingCell = matrix.cells.find(c => c.category === 'coding');
            expect(codingCell.avg_deviation).toBe(0.25);
            expect(codingCell.sample_count).toBe(2);
            expect(codingCell.pass).toBe(true);

            const creativeCell = matrix.cells.find(c => c.category === 'creative');
            expect(creativeCell.avg_deviation).toBe(3.0);
            expect(creativeCell.pass).toBe(false);
        });

        it('should calculate overall stats', () => {
            const referenceScores = [
                { entry: { category: 'math', difficulty: 1 }, score: 5.0 }
            ];
            const challengerScores = [
                { entry: { category: 'math', difficulty: 1 }, score: 4.0 }
            ];

            const matrix = buildAccuracyMatrix(referenceScores, challengerScores, 1.5);
            expect(matrix.overall_avg_deviation).toBe(1.0);
            expect(matrix.pass_rate).toBe(100);
        });
    });

    describe('runCalibrationBatch', () => {
        it('should score each ground truth entry and return scores array', async () => {
            scoreResponse.mockResolvedValue({
                quality_score: 7.5,
                breakdown: { correctness: 8, clarity: 7 },
                scoring_method: 'decomposed'
            });

            const entries = [
                { _id: '1', prompt: 'Write hello world', response: 'print("hello")',
                  category: 'coding', difficulty: 2, expected_answer: 'print("hello world")' }
            ];

            const scores = await runCalibrationBatch(entries, {
                model: 'qwen2.5:7b-instruct-q5_K_M',
                host: 'http://192.0.2.99:11434'
            });

            expect(scores).toHaveLength(1);
            expect(scores[0].score).toBe(7.5);
            expect(scores[0].entry.category).toBe('coding');
            expect(scoreResponse).toHaveBeenCalledTimes(1);
            expect(resolveJudgeConfig).toHaveBeenCalledWith({
                model: 'qwen2.5:7b-instruct-q5_K_M',
                host: 'http://192.0.2.99:11434'
            });
            expect(scoreResponse).toHaveBeenCalledWith(expect.objectContaining({
                prompt: expect.objectContaining({
                    category: 'coding',
                    scoring_type: 'coding',
                    prompt_level: 2
                }),
                judgeConfig: expect.objectContaining({
                    model: 'qwen2.5:7b-instruct-q5_K_M',
                    host: 'http://192.0.2.99:11434',
                    timeout: 30000
                })
            }));
        });

        it('should handle scoring failures gracefully', async () => {
            scoreResponse.mockRejectedValue(new Error('timeout'));

            const entries = [
                { _id: '1', prompt: 'p', response: 'r', category: 'math', difficulty: 1 }
            ];

            const scores = await runCalibrationBatch(entries, {
                model: 'test-model',
                host: 'http://localhost:11434'
            });

            expect(scores).toHaveLength(1);
            expect(scores[0].score).toBeNull();
            expect(scores[0].error).toBe('timeout');
        });
    });
});
