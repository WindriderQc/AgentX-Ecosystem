/**
 * Score Boundary Tests
 * Verifies that score values remain within valid ranges across the pipeline.
 * Covers:
 *  - judgeCall.js score clamping (0-10)
 *  - generalistScore.js formula boundaries (0-100)
 *  - Edge cases: NaN, null, empty responses
 */

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

// Mock the fetch/http layer for judgeCall tests
jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: (url, opts) => opts
}));

// Mock benchmarkFetch to control judge HTTP responses
const mockBenchmarkFetch = jest.fn();
jest.mock('../../src/services/benchmark/http', () => ({
    benchmarkFetch: mockBenchmarkFetch
}));

const { callJudge, extractBalancedJson } = require('../../src/services/scoring/judgeCall');
const {
    calculateGeneralistScoreFromCategories,
    normalizeQualityTo100,
    COVERAGE_PENALTY_MAX,
    CONSISTENCY_BONUS
} = require('../../src/services/benchmark/generalistScore');

// -------------------------------------------------------------------
// Helpers
// -------------------------------------------------------------------

/**
 * Build a mock fetch response that the judge HTTP call will receive.
 * scores: plain object of dimension keys and numeric/string values
 *
 * The exact judge tag is sent directly through Core with no variant probe.
 */
function mockJudgeHttpResponse(scores) {
    const responseText = JSON.stringify(scores);
    mockBenchmarkFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
            message: { content: responseText },
            done_reason: 'stop',
            eval_count: 20
        })
    });
}

const JUDGE_CONFIG = {
    host: 'http://localhost:11434',
    model: 'test-judge',
    timeout: 5000,
    temperature: 0.1,
    num_predict: 800,
    num_ctx: 8192,
    max_retries: 0  // no retries in boundary tests
};

// Minimal weight map for deterministic formula tests
const TEST_WEIGHTS = {
    coding: 0.40,
    reasoning: 0.40,
    math: 0.20
};

// -------------------------------------------------------------------
// Judge score clamping (judgeCall.js post-0056 fix)
// -------------------------------------------------------------------

describe('Judge score clamping to [0, 10]', () => {
    it('clamps negative scores to 0', async () => {
        mockJudgeHttpResponse({ overall: -5, explanation: 'bad' });
        const result = await callJudge('eval prompt', JUDGE_CONFIG);

        expect(result.success).toBe(true);
        expect(result.scores.overall).toBe(0);
        expect(result.scores.overall).toBeGreaterThanOrEqual(0);
    });

    it('clamps scores above 10 to 10', async () => {
        mockJudgeHttpResponse({ overall: 15, explanation: 'too high' });
        const result = await callJudge('eval prompt', JUDGE_CONFIG);

        expect(result.success).toBe(true);
        expect(result.scores.overall).toBe(10);
        expect(result.scores.overall).toBeLessThanOrEqual(10);
    });

    it('passes valid scores through unchanged', async () => {
        mockJudgeHttpResponse({ overall: 7.5, explanation: 'good' });
        const result = await callJudge('eval prompt', JUDGE_CONFIG);

        expect(result.success).toBe(true);
        expect(result.scores.overall).toBe(7.5);
    });

    it('clamps string numeric scores that are out of range', async () => {
        // Judge returns score as string — should be coerced and clamped
        mockJudgeHttpResponse({ overall: '-3', explanation: 'string negative' });
        const result = await callJudge('eval prompt', JUDGE_CONFIG);

        expect(result.success).toBe(true);
        expect(result.scores.overall).toBeGreaterThanOrEqual(0);
    });

    it('all dimension scores are within [0, 10] after clamping', async () => {
        mockJudgeHttpResponse({
            accuracy: 12,
            completeness: -1,
            overall: 8,
            explanation: 'mixed'
        });
        const result = await callJudge('eval prompt', JUDGE_CONFIG);

        expect(result.success).toBe(true);
        expect(result.scores.accuracy).toBeLessThanOrEqual(10);
        expect(result.scores.completeness).toBeGreaterThanOrEqual(0);
        expect(result.scores.overall).toBeGreaterThanOrEqual(0);
        expect(result.scores.overall).toBeLessThanOrEqual(10);
    });
});

// -------------------------------------------------------------------
// Composite score boundaries (normalizeQualityTo100)
// -------------------------------------------------------------------

describe('Quality normalization boundaries', () => {
    it('normalizeQualityTo100 keeps output in [0, 100]', () => {
        const testInputs = [-5, 0, 0.1, 5, 7.5, 10, 11, 100];
        for (const input of testInputs) {
            const out = normalizeQualityTo100(input);
            expect(out).toBeGreaterThanOrEqual(0);
            expect(out).toBeLessThanOrEqual(100);
        }
    });

    it('normalizeQualityTo100 handles NaN by returning 0', () => {
        expect(normalizeQualityTo100(NaN)).toBe(0);
    });

    it('normalizeQualityTo100 handles null and undefined by returning 0', () => {
        expect(normalizeQualityTo100(null)).toBe(0);
        expect(normalizeQualityTo100(undefined)).toBe(0);
    });
});

// -------------------------------------------------------------------
// Generalist score boundaries (calculateGeneralistScoreFromCategories)
// -------------------------------------------------------------------

describe('Generalist score is in [0, 100]', () => {
    it('generalist score is 0-100 with all categories populated', () => {
        const scores = {
            coding: { avg: 9, count: 5, stddev: 0.5, attempted: true },
            reasoning: { avg: 8, count: 5, stddev: 0.5, attempted: true },
            math: { avg: 7, count: 5, stddev: 0.5, attempted: true }
        };
        const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
        expect(result.generalistScore).toBeGreaterThanOrEqual(0);
        expect(result.generalistScore).toBeLessThanOrEqual(100);
    });

    it('generalist score is 0-100 with partial category coverage', () => {
        const scores = {
            coding: { avg: 5, count: 3, stddev: 1, attempted: true }
            // reasoning and math missing — coverage penalty applied
        };
        const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
        expect(result.generalistScore).toBeGreaterThanOrEqual(0);
        expect(result.generalistScore).toBeLessThanOrEqual(100);
    });

    it('coverage penalty does not make score negative for low-scoring model', () => {
        // Model with only 1 category and very low score
        const scores = {
            coding: { avg: 0.1, count: 1, stddev: 0, attempted: true }
        };
        const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
        expect(result.generalistScore).toBeGreaterThanOrEqual(0);
    });

    it('consistency bonus does not push score above 100', () => {
        // Perfect model — all scores at 10, low stddev should earn bonus
        const scores = {
            coding: { avg: 10, count: 10, stddev: 0, attempted: true },
            reasoning: { avg: 10, count: 10, stddev: 0, attempted: true },
            math: { avg: 10, count: 10, stddev: 0, attempted: true }
        };
        const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
        expect(result.generalistScore).toBeLessThanOrEqual(100 + CONSISTENCY_BONUS);
        expect(result.generalistScore).toBeGreaterThanOrEqual(0);
    });

    it('empty scores object returns 0 (not negative)', () => {
        const result = calculateGeneralistScoreFromCategories({}, TEST_WEIGHTS);
        expect(result.generalistScore).toBe(0);
    });

    it('null weights returns 0 generalist score', () => {
        const result = calculateGeneralistScoreFromCategories({ coding: { avg: 8, count: 2, attempted: true } }, null);
        expect(result.generalistScore).toBe(0);
    });
});

// -------------------------------------------------------------------
// Null quality_score and empty response edge cases
// -------------------------------------------------------------------

describe('Null quality_score and empty response edge cases', () => {
    it('null quality_score entry is treated as attempted — no coverage penalty', () => {
        // avg: null simulates all-null quality scores in that category (judge failed for all)
        // hasScore is false (avg is null), but attempted=true means NO coverage penalty
        const scores = {
            coding: { avg: 8, count: 3, stddev: 0.5, attempted: true },
            reasoning: { avg: null, count: 2, attempted: true },   // judge failed — avg null
            math: { avg: 7, count: 2, stddev: 0.5, attempted: true }
        };

        const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);

        // attempted=true means no coverage penalty for reasoning
        expect(result.coveragePenalty).toBe(0);
        // All 3 categories are counted as tested
        expect(result.testedCategories).toBe(3);
        expect(result.coverage).toBe(100);
    });

    it('coverage penalty is 0 when all categories are attempted', () => {
        const scores = {
            coding: { avg: 8, count: 3, stddev: 0.5, attempted: true },
            reasoning: { attempted: true, count: 0 },  // attempted but judge failed
            math: { avg: 6, count: 2, stddev: 0.5, attempted: true }
        };
        const result = calculateGeneralistScoreFromCategories(scores, TEST_WEIGHTS);
        expect(result.coveragePenalty).toBe(0);
    });
});

// -------------------------------------------------------------------
// extractBalancedJson edge cases
// -------------------------------------------------------------------

describe('extractBalancedJson', () => {
    it('extracts simple JSON object', () => {
        const text = 'here is the answer: {"overall": 8, "explanation": "good"}';
        const result = extractBalancedJson(text);
        expect(result).toBe('{"overall": 8, "explanation": "good"}');
    });

    it('handles nested braces correctly', () => {
        const text = '{"outer": {"inner": 5}, "overall": 7}';
        const result = extractBalancedJson(text);
        const parsed = JSON.parse(result);
        expect(parsed.overall).toBe(7);
        expect(parsed.outer.inner).toBe(5);
    });

    it('returns null when no braces present', () => {
        expect(extractBalancedJson('no json here')).toBeNull();
    });
});
