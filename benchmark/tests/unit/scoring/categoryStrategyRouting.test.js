/**
 * Tests for TODO 0116: Category default strategy for instruction + translation.
 *
 * Covers delta rows 21, 22 from docs/benchmark/scoring-contract-v1.md §3:
 *   - Row 21: instruction default changed from 'deterministic' to 'decomposed';
 *     prompt-level override when output_contract.type === 'json_schema'
 *   - Row 22: translation default changed from 'reference' to 'decomposed';
 *     reference_fallback triggers when prompt.reference_answer exists
 *
 * Four combinations tested:
 *   (a) instruction w/o json_schema → decomposed
 *   (b) instruction w/ json_schema + expected_answer → deterministic
 *   (c) translation w/o reference_answer → decomposed
 *   (d) translation w/ reference_answer → reference
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

const { routeScoring, CATEGORY_STRATEGIES } = require('../../../src/services/qualityScorer');

const JUDGE_CONFIG = { host: 'http://localhost:11434', model: 'qwen2.5:7b', timeout: 5000 };

function mockBinaryResponse(answer) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: answer })
    });
}

/**
 * Mock fetch to return deterministic YES/NO for decomposed binary questions.
 * Hash the question text to get stable but varied answers.
 */
function mockDecomposedBinary() {
    mockFetchFn.mockImplementation((url, opts) => {
        const body = JSON.parse(opts.body);
        const questionLine = body.prompt.split('\n').pop();
        let sum = 0;
        for (let i = 0; i < questionLine.length; i++) sum += questionLine.charCodeAt(i);
        const answer = sum % 2 === 0 ? 'YES' : 'NO';
        return mockBinaryResponse(answer);
    });
}

/**
 * Mock fetch for reference scorer: returns similarity assessment.
 */
function mockReferenceScorer() {
    let callCount = 0;
    mockFetchFn.mockImplementation((url, opts) => {
        callCount++;
        const body = JSON.parse(opts.body);
        // Reference scorer makes multiple calls: key points, contradictions, similarity
        if (body.prompt.includes('Answer ONLY "YES" or "NO"')) {
            return mockBinaryResponse('YES');
        }
        if (body.prompt.includes('Rate the overall similarity')) {
            return Promise.resolve({
                ok: true,
                json: () => Promise.resolve({ response: 'EQUIVALENT - Score: 9/10' })
            });
        }
        return mockBinaryResponse('NO');
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('CATEGORY_STRATEGIES defaults (scoringConfigs.js)', () => {
    test('instruction primary is decomposed', () => {
        expect(CATEGORY_STRATEGIES.instruction.primary).toBe('decomposed');
    });

    test('translation primary is decomposed', () => {
        expect(CATEGORY_STRATEGIES.translation.primary).toBe('decomposed');
    });

    test('translation has reference_fallback: true', () => {
        expect(CATEGORY_STRATEGIES.translation.reference_fallback).toBe(true);
    });
});

describe('routeScoring: instruction category', () => {
    test('(a) instruction without json_schema → decomposed path', async () => {
        mockDecomposedBinary();

        const prompt = {
            name: 'test-instruction-freetext',
            scoring_type: 'instruction',
            category: 'instruction',
            prompt: 'Write a 3-sentence summary of photosynthesis.',
            expected_answer: 'Photosynthesis is the process...'
        };

        const result = await routeScoring(
            'Photosynthesis converts sunlight into energy...',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('decomposed');
        expect(result.scoring_type).toBe('instruction');
    });

    test('(b) instruction with json_schema + expected_answer → deterministic path', async () => {
        const prompt = {
            name: 'test-instruction-json',
            scoring_type: 'instruction',
            category: 'instruction',
            prompt: 'Sort these words by length and return as JSON array: ["cat", "elephant", "dog"]',
            expected_answer: '["cat","dog","elephant"]',
            output_contract: { type: 'json_schema' }
        };

        const result = await routeScoring(
            '["cat","dog","elephant"]',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('deterministic');
        expect(result.deterministic_type).toBe('json');
        expect(result.matched_expected).toBe(true);
        expect(result.judge_confidence).toBe(1.0);
    });

    test('(b2) instruction with json_schema but no match → falls through to decomposed', async () => {
        mockDecomposedBinary();

        const prompt = {
            name: 'test-instruction-json-nomatch',
            scoring_type: 'instruction',
            category: 'instruction',
            prompt: 'Sort these words by length and return as JSON array: ["cat", "elephant", "dog"]',
            expected_answer: '["cat","dog","elephant"]',
            output_contract: { type: 'json_schema' }
        };

        const result = await routeScoring(
            'The sorted words are cat, dog, elephant.',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        // Should fall through to decomposed when JSON parse fails
        expect(result.scoring_method).toBe('decomposed');
    });

    test('(b3) instruction with explicit deterministic JSON mismatch → deterministic failure, no LLM fallback', async () => {
        mockDecomposedBinary();

        const prompt = {
            name: 'test-instruction-json-explicit-nomatch',
            scoring_type: 'instruction',
            category: 'instruction',
            prompt: 'Return the exact JSON schedule.',
            expected_answer: '{"schedule":[{"id":"J1"}],"makespan":9}',
            deterministic_scoring: { type: 'json' },
            output_contract: {
                type: 'json_schema',
                required_keys: ['schedule', 'makespan'],
                forbidden_extra_keys: true
            }
        };

        const result = await routeScoring(
            '{"schedule":[],"makespan":0}',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('deterministic');
        expect(result.deterministic_type).toBe('json');
        expect(result.quality_score).toBe(0);
        expect(result.matched_expected).toBe(false);
        expect(mockFetchFn).not.toHaveBeenCalled();
    });

    test('(b4) instruction with explicit deterministic malformed JSON → deterministic failure, no LLM fallback', async () => {
        mockDecomposedBinary();

        const prompt = {
            name: 'test-instruction-json-explicit-malformed',
            scoring_type: 'instruction',
            category: 'instruction',
            prompt: 'Return the exact JSON schedule.',
            expected_answer: '{"schedule":[],"makespan":9}',
            deterministic_scoring: { type: 'json' },
            output_contract: {
                type: 'json_schema',
                required_keys: ['schedule', 'makespan'],
                forbidden_extra_keys: true
            }
        };

        const result = await routeScoring(
            'not json',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('deterministic');
        expect(result.deterministic_type).toBe('json');
        expect(result.quality_score).toBe(0);
        expect(result.matched_expected).toBe(false);
        expect(mockFetchFn).not.toHaveBeenCalled();
    });

    test('instruction with json_schema but no expected_answer → decomposed', async () => {
        mockDecomposedBinary();

        const prompt = {
            name: 'test-instruction-json-noexpected',
            scoring_type: 'instruction',
            category: 'instruction',
            prompt: 'Generate a JSON object with name and age fields',
            output_contract: { type: 'json_schema' }
            // no expected_answer
        };

        const result = await routeScoring(
            '{"name": "Alice", "age": 30}',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('decomposed');
    });
});

describe('routeScoring: translation category', () => {
    test('(c) translation without reference_answer → decomposed path', async () => {
        mockDecomposedBinary();

        const prompt = {
            name: 'test-translation-noref',
            scoring_type: 'translation',
            category: 'translation',
            prompt: 'Translate to French: "The cat sat on the mat."'
        };

        const result = await routeScoring(
            'Le chat était assis sur le tapis.',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('decomposed');
        expect(result.scoring_type).toBe('translation');
    });

    test('(d) translation with reference_answer → reference path', async () => {
        mockReferenceScorer();

        const prompt = {
            name: 'test-translation-withref',
            scoring_type: 'translation',
            category: 'translation',
            prompt: 'Translate to French: "The cat sat on the mat."',
            reference_answer: 'Le chat était assis sur le tapis.'
        };

        const result = await routeScoring(
            'Le chat était assis sur le tapis.',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('reference');
    });
});

describe('prompt-level signal precedence', () => {
    test('output_contract.type overrides category default for instruction', async () => {
        // Instruction default is decomposed, but json_schema should override to deterministic
        const prompt = {
            name: 'test-precedence-instruction',
            scoring_type: 'instruction',
            category: 'instruction',
            prompt: 'Return the sum as JSON: {"result": 42}',
            expected_answer: '{"result": 42}',
            output_contract: { type: 'json_schema' }
        };

        const result = await routeScoring(
            '{"result": 42}',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('deterministic');
    });

    test('reference_answer overrides category default for translation', async () => {
        mockReferenceScorer();

        // Translation default is decomposed, but reference_answer should trigger reference-scorer
        const prompt = {
            name: 'test-precedence-translation',
            scoring_type: 'translation',
            category: 'translation',
            prompt: 'Translate to Spanish: "Hello world"',
            reference_answer: 'Hola mundo'
        };

        const result = await routeScoring(
            'Hola mundo',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('reference');
    });

    test('non-json_schema output_contract does not trigger deterministic for instruction', async () => {
        mockDecomposedBinary();

        const prompt = {
            name: 'test-no-override-instruction',
            scoring_type: 'instruction',
            category: 'instruction',
            prompt: 'Write a summary in exactly 3 sentences.',
            output_contract: { type: 'structured_text' }
        };

        const result = await routeScoring(
            'This is sentence one. This is sentence two. This is sentence three.',
            prompt,
            JUDGE_CONFIG
        );

        expect(result).not.toBeNull();
        expect(result.scoring_method).toBe('decomposed');
    });
});
