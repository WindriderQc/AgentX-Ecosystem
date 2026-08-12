/**
 * Tests for TODO 0138 — Reasoning judge output-contract awareness.
 *
 * Covers the format-gate applied inside `enrichWithDualScores` in
 * `qualityScorer.js` for reasoning rows that violate their output_contract.
 *
 * Fix summary:
 *   - Prompt category === 'reasoning'
 *   - Prompt has non-null output_contract
 *   - format_score < 5.0 (on 0..10 scale; equivalent to < 0.5 normalized)
 *   → cap quality_score at max(3, quality_score × 0.5)
 *   → force judge_confidence ≤ 0.5
 *   → force needs_review = true
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

const { scoreResponse } = require('../../../src/services/qualityScorer');

function mockBinary(answer) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: answer })
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('0138 — Reasoning format-gate', () => {
    test('reasoning + output_contract + format violation → quality capped, confidence ≤ 0.5, needs_review=true', async () => {
        // Route through decomposed judge. All binary YES → decomposed returns
        // quality_score ≈ 10. We use a response that fails the output_contract
        // (exact template "a,MISSING,c" but response has surrounding prose).
        mockFetchFn.mockImplementation(() => mockBinary('YES'));

        const result = await scoreResponse({
            response: 'The fields, after replacing the missing middle one, are: a, MISSING, c. So the answer is a,MISSING,c.',
            prompt: {
                prompt: 'Parse the CSV row a,,c into three fields. If a field is missing, replace it with MISSING. Output the fields joined by commas.',
                scoring_type: 'reasoning',
                category: 'reasoning',
                output_contract: {
                    type: 'exact',
                    template: 'a,MISSING,c'
                }
            }
        });

        // Format compliance is weak (prose wraps the answer) — format_score < 5
        expect(result.format_score).not.toBeNull();
        expect(result.format_score).toBeLessThan(5);

        // Judge originally scored high (all YES → ~10). Gate caps to max(3, q*0.5).
        // We don't assert the exact pre-gate value; we assert the gated state:
        expect(result.quality_score).toBeLessThanOrEqual(5);
        expect(result.quality_score).toBeGreaterThanOrEqual(3);

        // Confidence capped at 0.5
        expect(result.judge_confidence).toBeLessThanOrEqual(0.5);

        // needs_review forced
        expect(result.needs_review).toBe(true);

        // Diagnostic flag
        expect(result.format_gated).toBe(true);
    });

    test('reasoning WITHOUT output_contract → gate does not fire, result passes through unchanged', async () => {
        mockFetchFn.mockImplementation(() => mockBinary('YES'));

        const result = await scoreResponse({
            response: 'This is a long-winded explanation without any specific format.',
            prompt: {
                prompt: 'Explain the three boxes logic puzzle.',
                scoring_type: 'reasoning',
                category: 'reasoning'
                // no output_contract
            }
        });

        expect(result.format_score).toBeNull();
        expect(result.format_gated).toBeUndefined();
        // Confidence should be whatever judgeConfidence.assess() decides — NOT forced to 0.5
        // quality_score stays where the judge put it (not artificially capped).
        // A permissive range: ensure it wasn't capped at or below 5.
        expect(result.quality_score).toBeGreaterThan(5);
    });

    test('R034 deterministic replay — reasoning + format-violating response drops quality_score below the human-score ceiling', async () => {
        // R034 in docs/benchmark/0128-reveal-key-2026-04-21.json:
        //   prompt_category: reasoning
        //   judge quality_score=7, judge_confidence=1.00, human=3
        //   rationale: "The final parsed value is correct, but it violates the
        //   instruction to output only the fields joined by commas."
        //
        // We simulate the decomposed judge producing quality_score ≈ 7.5
        // (the judge was confidently wrong at 7) on a response that wraps the
        // correct value `a,MISSING,c` in prose — violating the exact-output
        // contract. After the gate, quality_score must drop to ≤ 5 — closer to
        // the human score of 3 and out of the confident-wrong zone.
        //
        // We configure the decomposed judge to return 3 of 4 YES answers so the
        // weighted decomposed score lands around ~7–7.5.
        let call = 0;
        mockFetchFn.mockImplementation(() => {
            call += 1;
            return mockBinary(call === 4 ? 'NO' : 'YES');
        });

        const result = await scoreResponse({
            response: `The parsed CSV row "a,,c" can be broken down into three fields as follows:

1. First field: "a"
2. Second field: (empty)
3. Third field: "c"

Since we are to replace any missing field with "MISSING", the second field is empty and should be replaced.

So, the output will be:

\`a,MISSING,c\`

Joined by commas, it looks like this:

\`a,MISSING,c\``,
            prompt: {
                prompt: 'Parse the CSV row a,,c into three fields. If a field is missing, replace it with MISSING. Output the fields joined by commas.',
                name: 'Malformed CSV Field Handling',
                scoring_type: 'reasoning',
                category: 'reasoning',
                expected_answer: 'a,MISSING,c',
                output_contract: {
                    type: 'exact',
                    template: 'a,MISSING,c'
                }
            }
        });

        // Format violation is deterministic: response is prose, not "a,MISSING,c" exactly.
        expect(result.format_score).not.toBeNull();
        expect(result.format_score).toBeLessThan(5);

        // Before the gate, R034's judge gave 7. After the gate, quality_score
        // must drop to ≤ 5 — moves toward the human score of 3.
        expect(result.quality_score).toBeLessThanOrEqual(5);

        // Confidence capped — confident-wrong is no longer possible.
        expect(result.judge_confidence).toBeLessThanOrEqual(0.5);
        expect(result.needs_review).toBe(true);
        expect(result.format_gated).toBe(true);
    });

    test('non-reasoning category (coding) WITH format violation → gate does NOT fire (scope guard)', async () => {
        // Per TODO 0138 constraint: do not apply the format-gate to other
        // categories — coding/instruction handle their own format via 0135.
        mockFetchFn.mockImplementation(() => mockBinary('YES'));

        const result = await scoreResponse({
            response: 'Some code response that does not match the exact template.',
            prompt: {
                prompt: 'Write the word HELLO exactly.',
                scoring_type: 'coding',
                category: 'coding',
                output_contract: {
                    type: 'exact',
                    template: 'HELLO'
                }
            }
        });

        expect(result.format_gated).toBeUndefined();
        // Coding gate untouched — no confidence cap imposed by 0138.
        // (coding may have its own confidence story; we only assert no 0138 stamp.)
    });
});
