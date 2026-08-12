/**
 * Unit tests for decomposedJudge.js
 * Tests majority voting, prompt structure, context limits, and model options
 */

jest.mock('node-fetch');
const mockFetchFn = require('node-fetch');

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../src/helpers/httpAgent', () => ({
    getFetchOptions: (url, opts) => opts
}));

jest.mock('../../src/services/scoring/judgeRuntimeConfig', () => ({
    normalizeJudgeNumCtx: jest.fn((value) => {
        const parsed = Number(value);
        if (!Number.isFinite(parsed)) return 8192;
        return Math.max(512, Math.min(131072, Math.round(parsed)));
    })
}));

const { askBinaryQuestion, scoreDimension, score, DECOMPOSED_QUESTIONS } = require('../../src/services/decomposedJudge');
const logger = require('../../config/logger');

const JUDGE_CONFIG = { host: 'http://localhost:11434', model: 'qwen2.5:7b', timeout: 5000 };

function mockFetchResponse(text) {
    return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ response: text })
    });
}

function mockFetchSequence(responses) {
    let i = 0;
    mockFetchFn.mockImplementation(() => {
        const text = responses[i % responses.length];
        i++;
        if (text instanceof Error) return Promise.reject(text);
        return mockFetchResponse(text);
    });
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('Default voting (single call, voting_count=1)', () => {
    test('YES → true (1 call)', async () => {
        mockFetchSequence(['YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(true);
        expect(mockFetchFn).toHaveBeenCalledTimes(1);
    });

    test('NO → false (1 call)', async () => {
        mockFetchSequence(['NO']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(false);
        expect(mockFetchFn).toHaveBeenCalledTimes(1);
    });

    test('single failure → retry succeeds', async () => {
        // First call errors, second call returns YES. Retry should recover.
        mockFetchSequence([new Error('timeout'), 'YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(true);
        expect(mockFetchFn).toHaveBeenCalledTimes(2);
        expect(logger.warn).toHaveBeenCalledWith('Binary call failed, retrying once', expect.any(Object));
    });

    test('failure + retry failure → defaults to null', async () => {
        mockFetchSequence([new Error('timeout'), new Error('timeout')]);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(null);
        expect(mockFetchFn).toHaveBeenCalledTimes(2);
        expect(logger.error).toHaveBeenCalledWith('Binary call failed after retry', expect.any(Object));
    });

    test('ambiguous response defaults to NO', async () => {
        mockFetchSequence(['maybe']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(false);
    });

    test('YES with preamble tokens is treated as ambiguous', async () => {
        mockFetchSequence(['Based on the analysis, YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);
        expect(result).toBe(false);
        expect(mockFetchFn).toHaveBeenCalledTimes(1);
    });
});

describe('Majority voting (voting_count: 3)', () => {
    const VOTING_CONFIG = { ...JUDGE_CONFIG, voting_count: 3 };

    test('3 YES → YES', async () => {
        mockFetchSequence(['YES', 'YES', 'YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(true);
        expect(mockFetchFn).toHaveBeenCalledTimes(3);
    });

    test('3 NO → NO', async () => {
        mockFetchSequence(['NO', 'NO', 'NO']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(false);
    });

    test('2 YES + 1 NO → YES (majority wins)', async () => {
        mockFetchSequence(['YES', 'NO', 'YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(true);
        expect(logger.warn).toHaveBeenCalledWith('Binary vote disagreement', expect.any(Object));
    });

    test('1 YES + 2 NO → NO (majority wins)', async () => {
        mockFetchSequence(['YES', 'NO', 'NO']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(false);
        expect(logger.warn).toHaveBeenCalledWith('Binary vote disagreement', expect.any(Object));
    });

    test('no disagreement log when unanimous YES', async () => {
        mockFetchSequence(['YES', 'YES', 'YES']);
        await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(logger.warn).not.toHaveBeenCalledWith('Binary vote disagreement', expect.any(Object));
    });

    test('no disagreement log when unanimous NO', async () => {
        mockFetchSequence(['NO', 'NO', 'NO']);
        await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(logger.warn).not.toHaveBeenCalledWith('Binary vote disagreement', expect.any(Object));
    });

    test('2 failures + 1 YES → uses single success', async () => {
        mockFetchSequence([new Error('timeout'), new Error('timeout'), 'YES']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(true);
    });

    test('2 failures + 1 NO → uses single success', async () => {
        mockFetchSequence([new Error('timeout'), new Error('timeout'), 'NO']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(false);
    });

    test('all 3 fail → defaults to null', async () => {
        mockFetchSequence([new Error('fail'), new Error('fail'), new Error('fail')]);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(null);
        expect(logger.error).toHaveBeenCalledWith('All 3 binary votes failed', expect.any(Object));
    });

    test('ambiguous responses default to NO', async () => {
        mockFetchSequence(['maybe', 'perhaps', 'unclear']);
        const result = await askBinaryQuestion('response', 'Is this good?', VOTING_CONFIG);
        expect(result).toBe(false);
    });
});

describe('Prompt structure and context limits', () => {
    test('prompt includes role instruction and labeled sections', async () => {
        mockFetchSequence(['YES']);
        const task = 'Write a function';
        const expected = 'function foo() {}';
        await askBinaryQuestion('some response', 'Is it correct?', JUDGE_CONFIG, { task, expected });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).toContain('You are evaluating ONE specific aspect');
        expect(body.prompt).toContain('TASK:\n');
        expect(body.prompt).toContain('EXPECTED ANSWER:\n');
        expect(body.prompt).toContain('RESPONSE_START\n');
        expect(body.prompt).toContain('\nRESPONSE_END');
        expect(body.prompt).toContain('Answer ONLY "YES" or "NO" for this specific question:');
    });

    test('task truncated at 2000 chars', async () => {
        mockFetchSequence(['YES']);
        const longTask = 'x'.repeat(5000);
        await askBinaryQuestion('resp', 'q?', JUDGE_CONFIG, { task: longTask });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        // Task should be truncated — prompt should NOT contain the full 5000 chars
        expect(body.prompt).not.toContain('x'.repeat(2001));
        expect(body.prompt).toContain('x'.repeat(2000));
    });

    test('expected truncated at 1000 chars', async () => {
        mockFetchSequence(['YES']);
        const longExpected = 'e'.repeat(2000);
        await askBinaryQuestion('resp', 'q?', JUDGE_CONFIG, { task: 'task', expected: longExpected });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).not.toContain('e'.repeat(1001));
        expect(body.prompt).toContain('e'.repeat(1000));
    });

    test('response truncated at configured char budget', async () => {
        mockFetchSequence(['YES']);
        const longResponse = 'r'.repeat(5000);
        await askBinaryQuestion(longResponse, 'q?', { ...JUDGE_CONFIG, response_char_budget: 3000 });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).not.toContain('r'.repeat(3001));
        expect(body.prompt).toContain('r'.repeat(3000));
    });

    test('no task context → no TASK/EXPECTED sections', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG);

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).not.toContain('TASK:');
        expect(body.prompt).not.toContain('EXPECTED ANSWER:');
        expect(body.prompt).toContain('RESPONSE_START');
        expect(body.prompt).toContain('RESPONSE_END');
    });

    test('task without expected → TASK but no EXPECTED section', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG, { task: 'do stuff' });

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.prompt).toContain('TASK:');
        expect(body.prompt).not.toContain('EXPECTED ANSWER:');
    });
});

describe('Model options', () => {
    test('sends num_predict: 20, num_ctx: 8192 (default), temperature: 0.1', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG);

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.options.num_predict).toBe(20);
        expect(body.options.num_ctx).toBe(8192);
        expect(body.options.temperature).toBe(0.1);
    });

    test('sends correct model name', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG);

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.model).toBe('qwen2.5:7b');
    });

    test('stream is false', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'q?', JUDGE_CONFIG);

        const body = JSON.parse(mockFetchFn.mock.calls[0][1].body);
        expect(body.stream).toBe(false);
    });
});

describe('scoreDimension', () => {
    test('all YES → score 10', async () => {
        mockFetchSequence(['YES', 'YES']);
        const questions = [
            { q: 'Q1?', weight: 0.5 },
            { q: 'Q2?', weight: 0.5 }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result.score).toBe(10);
        expect(result.breakdown).toHaveLength(2);
        expect(result.breakdown.every(b => b.contributed)).toBe(true);
    });

    test('all NO → score 0', async () => {
        mockFetchSequence(['NO', 'NO']);
        const questions = [
            { q: 'Q1?', weight: 0.5 },
            { q: 'Q2?', weight: 0.5 }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result.score).toBe(0);
    });

    test('inverted question: YES→false contribution', async () => {
        mockFetchFn.mockImplementation(() => mockFetchResponse('YES'));

        const questions = [
            { q: 'Is it good?', weight: 0.5 },
            { q: 'Is it buggy?', weight: 0.5, invert: true }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        // Q1: YES → contributed true (weight 0.5)
        // Q2: YES inverted → contributed false (weight 0)
        expect(result.score).toBe(5);
        expect(result.breakdown[0].contributed).toBe(true);
        expect(result.breakdown[1].contributed).toBe(false);
    });

    test('weighted scoring is proportional', async () => {
        // First question YES (weight 0.8), second NO (weight 0.2)
        let callCount = 0;
        mockFetchFn.mockImplementation(() => {
            callCount++;
            // Call 1 for Q1, call 2 for Q2 (single vote each)
            const answer = callCount <= 1 ? 'YES' : 'NO';
            return mockFetchResponse(answer);
        });

        const questions = [
            { q: 'Q1?', weight: 0.8 },
            { q: 'Q2?', weight: 0.2 }
        ];
        const result = await scoreDimension('response', questions, JUDGE_CONFIG);
        expect(result.score).toBe(8);
    });
});

describe('DECOMPOSED_QUESTIONS coverage', () => {
    test('all 7 benchmark categories exist', () => {
        expect(Object.keys(DECOMPOSED_QUESTIONS).sort()).toEqual([
            'coding',
            'creative',
            'instruction',
            'knowledge',
            'math',
            'reasoning',
            'translation'
        ]);
    });

    test('instruction category exists with expected dimensions', () => {
        const instruction = DECOMPOSED_QUESTIONS.instruction;
        expect(instruction).toBeDefined();
        expect(instruction.instruction_adherence).toBeDefined();
        expect(instruction.constraint_compliance).toBeDefined();
        expect(instruction.format_accuracy).toBeDefined();
        expect(instruction.completeness).toBeDefined();
    });

    test('all categories have weights summing to ~1 per dimension', () => {
        for (const [cat, dimensions] of Object.entries(DECOMPOSED_QUESTIONS)) {
            for (const [dim, questions] of Object.entries(dimensions)) {
                const totalWeight = questions.reduce((sum, q) => sum + q.weight, 0);
                expect(totalWeight).toBeCloseTo(1.0, 1);
            }
        }
    });

    test('all questions have required fields', () => {
        for (const [cat, dimensions] of Object.entries(DECOMPOSED_QUESTIONS)) {
            for (const [dim, questions] of Object.entries(dimensions)) {
                for (const q of questions) {
                    expect(q.q).toBeDefined();
                    expect(typeof q.q).toBe('string');
                    expect(q.weight).toBeDefined();
                    expect(typeof q.weight).toBe('number');
                    expect(q.weight).toBeGreaterThan(0);
                    expect(q.weight).toBeLessThanOrEqual(1);
                }
            }
        }
    });
});

describe('think parameter handling', () => {
    test('should send think:false by default in request body', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'Is this good?', JUDGE_CONFIG);

        const callArgs = mockFetchFn.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.think).toBe(false);
    });

    test('should respect think:true when explicitly set in judge config', async () => {
        mockFetchSequence(['YES']);
        await askBinaryQuestion('response', 'Is this good?', { ...JUDGE_CONFIG, think: true });

        const callArgs = mockFetchFn.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.think).toBe(true);
    });

    test('should send think:false even when config omits think field', async () => {
        mockFetchSequence(['YES']);
        const configNoThink = { host: 'http://localhost:11434', model: 'test-model', timeout: 5000 };
        await askBinaryQuestion('response', 'Is this good?', configNoThink);

        const callArgs = mockFetchFn.mock.calls[0];
        const body = JSON.parse(callArgs[1].body);
        expect(body.think).toBe(false);
    });
});
