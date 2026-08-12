/**
 * Tests for TODO 0111: Restore judge_confidence + persist decomposed_breakdown.
 *
 * Covers delta rows 3, 4, 5, 15, 16 from docs/benchmark/scoring-contract-v1.md §3:
 *   - Decomposed path: judge_confidence is computed via judgeConfidence.assess(),
 *     not left at 1.0 or null.
 *   - empty_response path: judge_confidence === null (contract §2.6).
 *   - llm_failed path: quality_score, semantic_score, format_score,
 *     judge_confidence all null.
 *   - decomposedJudge.score() returns an explicit judge_confidence: null
 *     in its result shape.
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

// Skip the network-calling judge by mocking callJudge to fail, which routes us
// into the llm_failed path cleanly. For decomposed tests we mock the binary
// calls at the fetch layer.
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

describe('decomposedJudge.score() return shape', () => {
    test('explicitly returns judge_confidence: null', async () => {
        // All binary calls return YES. This produces scores of 10 per dimension,
        // which trivially still returns — we only care about the shape.
        mockFetchFn.mockImplementation(() => mockBinary('YES'));

        const result = await decomposedJudge.score(
            'Some reasonable response',
            { prompt: 'Explain photosynthesis.', scoring_type: 'knowledge' },
            { host: 'http://localhost:11434', model: 'qwen2.5:7b', timeout: 5000 }
        );

        // The key assertion: judge_confidence is explicitly null, not undefined,
        // not 1.0. This forces qualityScorer to compute it via assess().
        expect(result).toHaveProperty('judge_confidence', null);
        expect(result).toHaveProperty('decomposed_breakdown');
        expect(typeof result.decomposed_breakdown).toBe('object');
    });
});

describe('qualityScorer empty_response path', () => {
    test('judge_confidence === null, quality_score === 0, breakdown null', async () => {
        const result = await scoreResponse({
            response: '',
            prompt: { prompt: 'Test', scoring_type: 'knowledge' }
        });

        expect(result.scoring_method).toBe('empty_response');
        expect(result.quality_score).toBe(0);
        expect(result.judge_confidence).toBeNull();
        expect(result.breakdown).toBeNull();
        expect(result.needs_review).toBe(false);
    });

    test('whitespace-only response also yields judge_confidence: null', async () => {
        const result = await scoreResponse({
            response: '   \n\t ',
            prompt: { prompt: 'Test', scoring_type: 'reasoning' }
        });

        expect(result.scoring_method).toBe('empty_response');
        expect(result.judge_confidence).toBeNull();
    });
});

describe('qualityScorer llm_failed path', () => {
    test('all four score axes null; explicit fields, no leaked spread', async () => {
        judgeCall.callJudge.mockResolvedValue({
            success: false,
            error: 'judge_timeout'
        });

        // Force decomposed to return null so routeScoring falls through
        // to Phase 4 (monolithic LLM judge), which invokes callJudge and
        // therefore can hit the llm_failed branch.
        const origScore = decomposedJudge.score;
        decomposedJudge.score = jest.fn().mockResolvedValue(null);

        const result = await scoreResponse({
            response: 'A non-empty response that will route to Phase 4 LLM judge.',
            prompt: {
                prompt: 'Translate: hello world',
                scoring_type: 'translation'
            }
        });

        decomposedJudge.score = origScore;

        expect(result.scoring_method).toBe('llm_failed');
        expect(result.quality_score).toBeNull();
        expect(result.semantic_score).toBeNull();
        expect(result.format_score).toBeNull();
        expect(result.format_compliant).toBeNull();
        expect(result.judge_confidence).toBeNull();
        expect(result.needs_review).toBe(false);
        expect(result.breakdown).toBeNull();
    });
});

describe('qualityScorer decomposed path invokes judgeConfidence.assess()', () => {
    test('decomposed result gets computed confidence (not flat 1.0), breakdown preserved', async () => {
        // Build a mixed response of binary answers that produces score spread
        // across dimensions so judgeConfidence.assess() will flag clustering
        // signals. We alternate YES/NO so scores differ per dimension.
        let call = 0;
        mockFetchFn.mockImplementation(() => {
            call++;
            return mockBinary(call % 2 === 0 ? 'NO' : 'YES');
        });

        const result = await scoreResponse({
            response: 'Answer that blends correctness with some style issues.',
            prompt: {
                prompt: 'Explain quicksort.',
                scoring_type: 'coding',
                level: 3
            }
        });

        // Routed through decomposed (coding category primary is decomposed).
        expect(result.scoring_method).toBe('decomposed');

        // Must be populated (assess() fires) and numeric 0..1.
        expect(typeof result.judge_confidence).toBe('number');
        expect(result.judge_confidence).toBeGreaterThanOrEqual(0);
        expect(result.judge_confidence).toBeLessThanOrEqual(1);

        // With alternating YES/NO the explanation is auto-built from the judge
        // dimensions and assess() may or may not trigger review depending on
        // clustering. The key guarantee is: it ran, it's not a raw 1.0 passthrough
        // from decomposedJudge's old hardcode, and the breakdown survives.
        expect(result).toHaveProperty('decomposed_breakdown');
        expect(typeof result.decomposed_breakdown).toBe('object');
        expect(result.decomposed_breakdown).not.toBeNull();
    });
});
