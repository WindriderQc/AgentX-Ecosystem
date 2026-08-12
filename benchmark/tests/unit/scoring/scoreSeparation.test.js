/**
 * Tests for TODO 0112: Score separation — semantic + format independence.
 *
 * Covers delta rows 6, 7 from docs/benchmark/scoring-contract-v1.md §3:
 *   - Row 6: semantic_score is populated only when format_score !== null.
 *     When format_score is null (no output_contract), semantic_score must be null.
 *   - Row 7: enrichWithDualScores wraps every return path in scoreResponse that
 *     produces a scored result (except skipped, empty_response, llm_failed).
 */

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('node-fetch', () => jest.fn());
const mockFetchFn = require('node-fetch');

jest.mock('../../../src/helpers/httpAgent', () => ({
    getFetchOptions: (url, opts) => opts
}));

jest.mock('../../../src/services/scoring/judgeRuntimeConfig', () => ({
    normalizeJudgeNumCtx: jest.fn(() => 8192)
}));

jest.mock('../../../src/services/scoring/judgeCall', () => {
    const actual = jest.requireActual('../../../src/services/scoring/judgeCall');
    return {
        ...actual,
        callJudge: jest.fn(),
        incrementJudgeFailureCount: jest.fn()
    };
});
const judgeCall = require('../../../src/services/scoring/judgeCall');

const { scoreResponse } = require('../../../src/services/qualityScorer');
const decomposedJudge = require('../../../src/services/decomposedJudge');

function mockBinary(answer) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: answer })
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

// ── Row 6: semantic_score independence ────────────────────────────────────

describe('Row 6 — semantic_score only when format_score is non-null', () => {
    test('prompt WITH output_contract + LLM-judge path → format_score non-null, semantic_score non-null', async () => {
        // Route through decomposed judge — all binary YES → quality_score ~10
        mockFetchFn.mockImplementation(() => mockBinary('YES'));

        const result = await scoreResponse({
            response: '42',
            prompt: {
                prompt: 'What is 6*7?',
                scoring_type: 'math',
                category: 'math',
                output_contract: { type: 'number_only' }
            }
        });

        // format_score should be non-null (number_only contract evaluated)
        expect(result.format_score).not.toBeNull();
        // semantic_score should be populated since format_score is non-null
        expect(result.semantic_score).not.toBeNull();
        expect(typeof result.semantic_score).toBe('number');
    });

    test('prompt WITHOUT output_contract → format_score null AND semantic_score null', async () => {
        // Route through decomposed judge — all binary YES
        mockFetchFn.mockImplementation(() => mockBinary('YES'));

        const result = await scoreResponse({
            response: 'Photosynthesis converts light energy into chemical energy.',
            prompt: {
                prompt: 'Explain photosynthesis.',
                scoring_type: 'knowledge',
                category: 'knowledge'
                // no output_contract
            }
        });

        expect(result.format_score).toBeNull();
        expect(result.semantic_score).toBeNull();
    });

    test('deterministic match WITHOUT output_contract → semantic_score null', async () => {
        const result = await scoreResponse({
            response: '42',
            prompt: {
                prompt: 'What is 6*7?',
                scoring_type: 'math',
                category: 'math',
                expected_answer: '42',
                deterministic_scoring: {
                    type: 'exact',
                    expected: '42'
                }
                // no output_contract
            }
        });

        expect(result.scoring_method).toBe('deterministic');
        expect(result.quality_score).toBeGreaterThan(0);
        expect(result.format_score).toBeNull();
        expect(result.semantic_score).toBeNull();
    });

    test('deterministic match WITH output_contract → semantic_score = max(quality_score, 8)', async () => {
        const result = await scoreResponse({
            response: '42',
            prompt: {
                prompt: 'What is 6*7?',
                scoring_type: 'math',
                category: 'math',
                expected_answer: '42',
                deterministic_scoring: {
                    type: 'exact',
                    expected: '42'
                },
                output_contract: { type: 'number_only' }
            }
        });

        expect(result.scoring_method).toBe('deterministic');
        expect(result.format_score).not.toBeNull();
        expect(result.semantic_score).toBe(Math.max(result.quality_score, 8));
    });
});

// ── Row 7: enrichWithDualScores branch coverage ──────────────────────────

describe('Row 7 — enrichWithDualScores wraps all scored return paths', () => {
    test('quick scoring path sets format_score when output_contract present', async () => {
        const result = await scoreResponse({
            response: '42',
            prompt: {
                prompt: 'What is 6*7?',
                scoring_type: 'math',
                category: 'math',
                expected_answer: '42',
                output_contract: { type: 'number_only' }
            }
        });

        // Whether deterministic or quick, format_score must be populated
        expect(result.format_score).not.toBeNull();
        expect(typeof result.format_score).toBe('number');
        expect(result.format_compliant).not.toBeNull();
    });

    test('decomposed judge path sets format_score when output_contract present', async () => {
        mockFetchFn.mockImplementation(() => mockBinary('YES'));

        const result = await scoreResponse({
            response: 'The answer is a well-structured JSON: {"key": "value"}',
            prompt: {
                prompt: 'Generate a JSON object.',
                scoring_type: 'coding',
                category: 'coding',
                output_contract: { type: 'json_schema', schema_keys: ['key'] }
            }
        });

        expect(result.format_score).not.toBeNull();
        expect(typeof result.format_score).toBe('number');
    });

    test('empty_response path has explicit null format_score and semantic_score', async () => {
        const result = await scoreResponse({
            response: '',
            prompt: {
                prompt: 'Test',
                scoring_type: 'knowledge',
                output_contract: { type: 'number_only' }
            }
        });

        expect(result.scoring_method).toBe('empty_response');
        expect(result.format_score).toBeNull();
        expect(result.format_compliant).toBeNull();
        expect(result.semantic_score).toBeNull();
    });

    test('skipped path has explicit null format_score and semantic_score', async () => {
        const result = await scoreResponse({
            response: 'Some response',
            prompt: {
                prompt: 'Test',
                scoring_type: 'knowledge',
                output_contract: { type: 'number_only' }
            },
            skipLLM: true
        });

        expect(result.scoring_method).toBe('skipped');
        expect(result.format_score).toBeNull();
        expect(result.format_compliant).toBeNull();
        expect(result.semantic_score).toBeNull();
    });

    test('llm_failed path has explicit null format_score and semantic_score', async () => {
        // Force routeScoring Phase 3 to return null so we fall through to
        // Phase 4 monolithic judge — which we mock to fail.
        const origScore = decomposedJudge.score;
        decomposedJudge.score = jest.fn().mockResolvedValue(null);
        judgeCall.callJudge.mockResolvedValue({ success: false, error: 'timeout' });

        const result = await scoreResponse({
            response: 'Some response that needs LLM judging',
            prompt: {
                prompt: 'Write a creative story.',
                scoring_type: 'creative',
                category: 'creative',
                output_contract: { type: 'structured_text' }
            }
        });

        expect(result.scoring_method).toBe('llm_failed');
        expect(result.format_score).toBeNull();
        expect(result.semantic_score).toBeNull();
        expect(result.quality_score).toBeNull();

        decomposedJudge.score = origScore;
    });

    test('Phase 4 monolithic LLM-judge path sets format_score when output_contract present', async () => {
        // Mock callJudge to return a successful judge result
        judgeCall.callJudge.mockResolvedValue({
            success: true,
            scores: { overall: 7.5, explanation: 'Good answer' },
            raw: '{"overall": 7.5}'
        });

        // Force decomposed to return null so routeScoring falls through
        // to Phase 4 (monolithic LLM judge) where callJudge is invoked.
        const origScore = decomposedJudge.score;
        decomposedJudge.score = jest.fn().mockResolvedValue(null);

        const result = await scoreResponse({
            response: 'Bonjour, comment allez-vous?',
            prompt: {
                prompt: 'Translate "Hello, how are you?" to French.',
                scoring_type: 'translation',
                category: 'translation',
                output_contract: { type: 'exact', template: 'Bonjour, comment allez-vous?' }
            }
        });

        decomposedJudge.score = origScore;

        expect(result.scoring_method).toBe('llm_judge');
        expect(result.format_score).not.toBeNull();
        expect(typeof result.format_score).toBe('number');
        // semantic_score should be set because format_score is non-null
        expect(result.semantic_score).not.toBeNull();
    });
});
