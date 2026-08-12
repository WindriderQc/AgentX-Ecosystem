/**
 * Unit tests for multiJudge consensus logic
 * Tests median calculation and divergence detection.
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock scoreResponse to avoid real LLM calls
jest.mock('../../../src/services/qualityScorer', () => ({
    scoreResponse: jest.fn(),
    JUDGE_CONFIG: { model: 'default-judge', host: 'http://localhost:11434' }
}));

const multiJudgeModule = require('../../../src/services/benchmark/multiJudge');
const {
    multiJudgeScore,
    shouldEscalateToMultiJudge,
    stdev,
    MAX_SCORE_STDEV,
    AGREEMENT_REVIEW_THRESHOLD
} = multiJudgeModule;
const { scoreResponse } = require('../../../src/services/qualityScorer');

function makePrompt(category = 'reasoning') {
    return { prompt: 'Test prompt', level: 3, category };
}

function makeJudge(score, host = 'http://localhost:11434') {
    return { model: 'judge-model', host, tier: 'standard', _score: score };
}

describe('module surface', () => {
    it('does not expose the retired aggregate agreement helper', () => {
        expect(multiJudgeModule).not.toHaveProperty('calculateJudgeAgreement');
    });
    it('does not expose the retired category-escalation helper', () => {
        expect(multiJudgeModule).not.toHaveProperty('shouldUseMultiJudge');
    });
});

describe('multiJudgeScore', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('throws when no judges provided', async () => {
        await expect(multiJudgeScore({
            response: 'hello',
            prompt: makePrompt(),
            judges: []
        })).rejects.toThrow('At least one judge config is required');
    });

    it('returns single_judge consensus when only one judge succeeds', async () => {
        scoreResponse.mockResolvedValueOnce({
            quality_score: 7,
            explanation: 'ok',
            scoring_method: 'llm_judge'
        });

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [makeJudge(7)]
        });

        expect(result.consensus).toBe('single_judge');
        expect(result.finalScore).toBe(7);
        expect(result.divergent).toBe(false);
    });

    it('returns agreement when two judges agree within threshold', async () => {
        scoreResponse
            .mockResolvedValueOnce({ quality_score: 7, explanation: 'a', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 8, explanation: 'b', scoring_method: 'llm_judge' });

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [makeJudge(7), makeJudge(8)]
        });

        expect(result.consensus).toBe('agreement');
        expect(result.divergent).toBe(false);
        expect(result.finalScore).toBe(7.5); // median of [7, 8]
        expect(result.tiebreakerUsed).toBe(false);
    });

    it('detects divergence when judges differ by > 2.0', async () => {
        scoreResponse
            .mockResolvedValueOnce({ quality_score: 5, explanation: 'low', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 8, explanation: 'high', scoring_method: 'llm_judge' });

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [makeJudge(5), makeJudge(8)],
            tiebreakerJudge: null  // no tiebreaker
        });

        expect(result.divergent).toBe(true);
        expect(result.consensus).toBe('divergent_unresolved');
        expect(result.tiebreakerUsed).toBe(false);
    });

    it('uses tiebreaker to resolve divergence', async () => {
        scoreResponse
            .mockResolvedValueOnce({ quality_score: 4, explanation: 'low', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 8, explanation: 'high', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 6, explanation: 'mid', scoring_method: 'llm_judge' }); // tiebreaker

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [makeJudge(4), makeJudge(8)],
            tiebreakerJudge: { model: 'premium-judge', host: 'http://localhost:11434', tier: 'advanced' }
        });

        expect(result.divergent).toBe(true);
        expect(result.tiebreakerUsed).toBe(true);
        expect(result.consensus).toBe('tiebreaker_resolved');
        // median of [4, 8, 6] = 6
        expect(result.finalScore).toBe(6);
    });

    it('reuses a seeded primary judge result without rescoring the same judge', async () => {
        scoreResponse.mockResolvedValueOnce({
            quality_score: 8,
            explanation: 'second judge',
            scoring_method: 'llm_judge'
        });

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [
                { model: 'primary-judge', host: 'http://localhost:11434', tier: 'standard' },
                { model: 'secondary-judge', host: 'http://localhost:11435', tier: 'standard' }
            ],
            seedJudgeResult: {
                judge_model: 'primary-judge',
                judge_host: 'http://localhost:11434',
                judge_tier: 'standard',
                quality_score: 7,
                explanation: 'seeded primary',
                scoring_time_ms: 10,
                scoring_method: 'llm_judge',
                success: true
            }
        });

        expect(scoreResponse).toHaveBeenCalledTimes(1);
        expect(result.finalScore).toBe(7.5);
    });

    it('returns no_valid_scores when all judges fail', async () => {
        scoreResponse.mockRejectedValue(new Error('LLM error'));

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [makeJudge(5), makeJudge(7)]
        });

        expect(result.consensus).toBe('no_valid_scores');
        expect(result.finalScore).toBeNull();
    });
});

describe('shouldEscalateToMultiJudge', () => {
    const enabledConfig = {
        enabled: true,
        judges: [{ model: 'a', host: 'h1' }, { model: 'b', host: 'h2' }]
    };

    it('escalates on low confidence', () => {
        expect(shouldEscalateToMultiJudge({
            category: 'reasoning',
            scoringMethod: 'llm_judge',
            judgeConfidence: 0.5,
            needsReview: false,
            multiJudgeConfig: enabledConfig
        })).toBe(true);
    });

    it('escalates on judge failure', () => {
        expect(shouldEscalateToMultiJudge({
            category: 'reasoning',
            scoringMethod: 'llm_failed',
            judgeConfidence: null,
            needsReview: false,
            multiJudgeConfig: enabledConfig
        })).toBe(true);
    });

    it('escalates on decomposed judge subcall failures', () => {
        expect(shouldEscalateToMultiJudge({
            category: 'math',
            scoringMethod: 'decomposed',
            judgeConfidence: 0.85,
            needsReview: false,
            judgeReliable: false,
            judgeErrors: 4,
            multiJudgeConfig: enabledConfig
        })).toBe(true);
    });

    it('does not escalate when disabled', () => {
        expect(shouldEscalateToMultiJudge({
            category: 'reasoning',
            scoringMethod: 'llm_judge',
            judgeConfidence: 0.4,
            needsReview: true,
            multiJudgeConfig: { enabled: false, judges: [] }
        })).toBe(false);
    });
});

describe('agreement computation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('unanimous judges produce agreement close to 1', async () => {
        scoreResponse
            .mockResolvedValueOnce({ quality_score: 7, explanation: 'a', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 7, explanation: 'b', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 7, explanation: 'c', scoring_method: 'llm_judge' });

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [makeJudge(7), makeJudge(7), makeJudge(7)]
        });

        expect(result.finalScore).toBe(7);
        expect(result.agreement).toBe(1);
    });

    it('split judges (3 vs 9) produce low agreement and would trigger needs_review', async () => {
        // 3 judges give 3, 2 judges give 9 → stdev ≈ 2.94 → agreement ≈ 0.412
        scoreResponse
            .mockResolvedValueOnce({ quality_score: 3, explanation: 'low', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 3, explanation: 'low', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 3, explanation: 'low', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 9, explanation: 'high', scoring_method: 'llm_judge' })
            .mockResolvedValueOnce({ quality_score: 9, explanation: 'high', scoring_method: 'llm_judge' });

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [makeJudge(3), makeJudge(3), makeJudge(3), makeJudge(9), makeJudge(9)]
        });

        expect(result.agreement).toBeLessThan(AGREEMENT_REVIEW_THRESHOLD);
        expect(result.agreement).toBeGreaterThan(0);
        // median of [3,3,3,9,9] = 3
        expect(result.finalScore).toBe(3);
    });

    it('single judge (n=1) returns agreement null', async () => {
        scoreResponse.mockResolvedValueOnce({
            quality_score: 6,
            explanation: 'ok',
            scoring_method: 'llm_judge'
        });

        const result = await multiJudgeScore({
            response: 'answer',
            prompt: makePrompt(),
            judges: [makeJudge(6)]
        });

        expect(result.consensus).toBe('single_judge');
        expect(result.agreement).toBeUndefined();
    });
});
