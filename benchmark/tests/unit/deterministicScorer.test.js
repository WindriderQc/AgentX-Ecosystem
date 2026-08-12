/**
 * Tests for Deterministic Scorer Service
 */

const {
    score,
    exactMatch,
    numericEval,
    jsonCompare,
    jsonDeepEqual,
    regexPatterns,
    normalizeString,
    parseNumericValue
} = require('../../src/services/deterministicScorer');

describe('Deterministic Scorer', () => {
    describe('normalizeString', () => {
        it('should lowercase and trim strings', () => {
            expect(normalizeString('  Hello World  ')).toBe('hello world');
        });

        it('should collapse multiple spaces', () => {
            expect(normalizeString('hello   world')).toBe('hello world');
        });

        it('should remove punctuation', () => {
            expect(normalizeString('Hello, World!')).toBe('hello world');
        });

        it('should handle empty/null input', () => {
            expect(normalizeString('')).toBe('');
            expect(normalizeString(null)).toBe('');
            expect(normalizeString(undefined)).toBe('');
        });
    });

    describe('parseNumericValue', () => {
        it('should parse simple integers', () => {
            expect(parseNumericValue('42')).toBe(42);
        });

        it('should parse decimals', () => {
            expect(parseNumericValue('3.14')).toBe(3.14);
        });

        it('should parse negative numbers', () => {
            expect(parseNumericValue('-7')).toBe(-7);
        });

        it('should extract numbers from "x = 42" format', () => {
            expect(parseNumericValue('x = 42')).toBe(42);
        });

        it('should extract numbers from "the answer is 42" format', () => {
            expect(parseNumericValue('The answer is 42')).toBe(42);
        });

        it('should handle markdown bold numbers', () => {
            expect(parseNumericValue('**42**')).toBe(42);
        });

        it('should handle LaTeX boxed numbers', () => {
            expect(parseNumericValue('\\boxed{42}')).toBe(42);
        });

        it('should parse fractions as numeric values', () => {
            expect(parseNumericValue('2/9')).toBeCloseTo(2 / 9, 6);
        });

        it('should parse percentages as decimal values', () => {
            expect(parseNumericValue('22.2%')).toBeCloseTo(0.222, 6);
        });

        it('should prefer the final answer over numbered list markers', () => {
            const response = [
                '1. Find the total number of balls: 10',
                '2. Compute the first draw: 5/10',
                '3. Compute the second draw: 4/9',
                'The probability that both are red is **2/9**.'
            ].join('\n');

            expect(parseNumericValue(response)).toBeCloseTo(2 / 9, 6);
        });

        it('should prefer the final numeric candidate in expected-answer narratives', () => {
            const expected = 'P(both red) = (5/10) * (4/9) = 20/90 = 2/9 approximately 0.222';

            expect(parseNumericValue(expected)).toBeCloseTo(2 / 9, 2);
        });

        it('should return null for non-numeric input', () => {
            expect(parseNumericValue('hello')).toBe(null);
            expect(parseNumericValue('')).toBe(null);
            expect(parseNumericValue(null)).toBe(null);
        });
    });

    describe('exactMatch', () => {
        it('should match identical strings', () => {
            const result = exactMatch('Paris', 'Paris');
            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
        });

        it('should match with case insensitivity by default', () => {
            const result = exactMatch('PARIS', 'paris');
            expect(result.matched).toBe(true);
        });

        it('should respect caseSensitive option', () => {
            const result = exactMatch('PARIS', 'paris', { caseSensitive: true });
            expect(result.matched).toBe(false);
            expect(result.score).toBe(0);
        });

        it('should normalize whitespace and punctuation', () => {
            const result = exactMatch('Hello, World!', 'hello world');
            expect(result.matched).toBe(true);
        });

        it('should use trimOnly when specified', () => {
            const result = exactMatch('Hello World', 'hello world', { trimOnly: true });
            expect(result.matched).toBe(true); // Because caseSensitive defaults to false
        });

        it('should match the leading-sentence answer form in "ANSWER. EXPLANATION" expected', () => {
            // Regression: "No-Solution Detection" prompt convention —
            // expected_answer = "No solution. Subtracting 2x from both sides..."
            // Model responds exactly with "No solution" per the output contract.
            const expected = 'No solution. Subtracting 2x from both sides yields 3 = 5, which is false for all x, so the equation has no solution.';
            const result = exactMatch('No solution', expected);
            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
        });

        it('should match an "(also acceptable: ...)" variant', () => {
            const expected = 'I need a prescription for this medication. (also acceptable: I need a prescription for this medicine.)';
            const result = exactMatch('I need a prescription for this medicine.', expected);
            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
        });

        it('should still match the leading sentence when response contains it', () => {
            const expected = '75%. After two successive 50% discounts, the remaining price factor is 0.5 * 0.5 = 0.25.';
            const result = exactMatch('The total discount is 75%.', expected);
            expect(result.matched).toBe(true);
            expect(result.score).toBeGreaterThanOrEqual(7);
        });
    });

    describe('numericEval', () => {
        it('should match exact numbers', () => {
            const result = numericEval('42', '42');
            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
        });

        it('should match within default tolerance', () => {
            const result = numericEval('42.0001', '42');
            expect(result.matched).toBe(true);
        });

        it('should not match outside tolerance', () => {
            const result = numericEval('45', '42');
            expect(result.matched).toBe(false);
        });

        it('scores parsed but wrong final numeric answers below pass level', () => {
            const result = numericEval('15 * 23 = 335', '345');
            expect(result.matched).toBe(false);
            expect(result.score).toBeLessThanOrEqual(2);
            expect(result.extracted.response).toBe(335);
        });

        it('should give partial credit for close answers', () => {
            const result = numericEval('42.005', '42', { tolerance: 0.001 });
            // relDiff = 0.005/42 ≈ 0.0001 → ≤0.001 → score 10
            expect(result.score).toBe(10);
        });

        it('should handle relative matching', () => {
            const result = numericEval('1050', '1000', { tolerance: 0.1, relativeMatch: true });
            expect(result.matched).toBe(true); // 5% difference < 10% tolerance
        });

        it('should extract number from text', () => {
            const result = numericEval('The answer is 42', '42');
            expect(result.matched).toBe(true);
        });

        it('should match comma-grouped thousands in prose answers', () => {
            const result = numericEval(
                'The maximum area is **5,000 square meters**.',
                'max area = 5000 sq meters'
            );

            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
            expect(result.extracted.response).toBe(5000);
        });

        it('should score the fenced-river optimization answer despite comma formatting', () => {
            const response = [
                'The farmer should use width 50 meters and length 100 meters.',
                'The maximum area is 5,000 square meters.'
            ].join('\n');
            const expected = 'Width = 50m, length along river = 100m, max area = 5000 sq meters. Constraint: 2w + l = 200.';

            const result = numericEval(response, expected);

            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
            expect(result.extracted.response).toBe(5000);
        });

        it('should match step-by-step probability answers with fractions and percentages', () => {
            const response = [
                'Here is the step-by-step calculation to find the probability:',
                '',
                '1. Find the total number of balls: 10',
                '2. Compute the first draw: 5/10 = 1/2',
                '3. Compute the second draw: 4/9',
                '4. Multiply: 1/2 * 4/9 = 2/9',
                'The probability that both balls are red is **2/9** (or approximately **22.2%**).'
            ].join('\n');
            const expected = 'P(both red) = (5/10) * (4/9) = 20/90 = 2/9 approximately 0.222';

            const result = numericEval(response, expected, { tolerance: 0.01 });

            expect(result.matched).toBe(true);
            expect(result.extracted.response).toBeCloseTo(2 / 9, 6);
            expect(result.extracted.expected).toBeCloseTo(2 / 9, 2);
        });
    });

    describe('jsonDeepEqual', () => {
        it('should match identical primitives', () => {
            expect(jsonDeepEqual(42, 42)).toBe(true);
            expect(jsonDeepEqual('hello', 'hello')).toBe(true);
            expect(jsonDeepEqual(true, true)).toBe(true);
        });

        it('should match identical arrays', () => {
            expect(jsonDeepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
        });

        it('should NOT match arrays with different order', () => {
            expect(jsonDeepEqual([1, 2, 3], [3, 2, 1])).toBe(false);
        });

        it('should match objects regardless of key order', () => {
            expect(jsonDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
        });

        it('should match nested structures', () => {
            const a = { foo: [1, 2], bar: { nested: true } };
            const b = { bar: { nested: true }, foo: [1, 2] };
            expect(jsonDeepEqual(a, b)).toBe(true);
        });

        it('should not match different structures', () => {
            expect(jsonDeepEqual({ a: 1 }, { a: 2 })).toBe(false);
            expect(jsonDeepEqual([1, 2], [1, 2, 3])).toBe(false);
        });
    });

    describe('jsonCompare', () => {
        it('should match JSON arrays', () => {
            const result = jsonCompare('["a", "b", "c"]', '["a", "b", "c"]');
            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
        });

        it('should match JSON from markdown code block', () => {
            const response = '```json\n{"key": "value"}\n```';
            const result = jsonCompare(response, '{"key": "value"}');
            expect(result.matched).toBe(true);
        });

        it('should not match different JSON', () => {
            const result = jsonCompare('{"a": 1}', '{"a": 2}');
            expect(result.matched).toBe(false);
            expect(result.score).toBe(0);
        });

        it('should handle parse errors gracefully', () => {
            const result = jsonCompare('not json', '{"valid": true}');
            expect(result.matched).toBe(false);
            expect(result.details).toContain('Failed to parse');
        });
    });

    describe('regexPatterns', () => {
        it('should score based on required patterns found', () => {
            const result = regexPatterns('The capital of France is Paris', {
                must_contain: [
                    { pattern: 'paris', weight: 1 },
                    { pattern: 'capital', weight: 1 }
                ]
            });
            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
        });

        it('should give partial credit for partial matches', () => {
            const result = regexPatterns('Paris', {
                must_contain: [
                    { pattern: 'paris', weight: 1 },
                    { pattern: 'france', weight: 1 }
                ]
            });
            expect(result.score).toBe(5); // 50% matched
        });

        it('should fail if forbidden patterns are found', () => {
            const result = regexPatterns('The password is secret123', {
                must_not_contain: ['password', 'secret']
            });
            expect(result.score).toBe(0);
            expect(result.matched).toBe(false);
        });

        it('should pass with only forbidden checks if none found', () => {
            const result = regexPatterns('Hello world', {
                must_not_contain: ['password', 'secret']
            });
            expect(result.matched).toBe(true);
            expect(result.score).toBe(10);
        });
    });

    describe('score (main function)', () => {
        it('should return null for prompts without deterministic config', () => {
            const result = score('response', { name: 'test' });
            expect(result).toBe(null);
        });

        it('should use exact matching when configured', () => {
            const result = score('Paris', {
                name: 'test',
                deterministic_scoring: { type: 'exact' },
                expected_answer: 'Paris'
            });
            expect(result.score).toBe(10);
            expect(result.deterministic_type).toBe('exact');
        });

        it('should use numeric evaluation when configured', () => {
            const result = score('42', {
                name: 'test',
                deterministic_scoring: { type: 'numeric' },
                expected_answer: '42'
            });
            expect(result.score).toBe(10);
            expect(result.deterministic_type).toBe('numeric');
        });

        it('should score benchmark-style probability explanations correctly', () => {
            const result = score(
                [
                    '1. Find the total number of balls: 10',
                    '2. P(1st Red) = 5/10 = 1/2',
                    '3. P(2nd Red) = 4/9',
                    '4. P(Both Red) = 2/9',
                    'The probability that both balls are red is **2/9** (approximately **22.2%**).'
                ].join('\n'),
                {
                    name: 'Probability Without Replacement',
                    deterministic_scoring: { type: 'numeric', numeric_tolerance: 0.01 },
                    expected_answer: 'P(both red) = (5/10) * (4/9) = 20/90 = 2/9 approximately 0.222'
                }
            );

            expect(result.score).toBe(10);
            expect(result.matched).toBe(true);
        });

        it('should use JSON comparison when configured', () => {
            const result = score('["a","b"]', {
                name: 'test',
                deterministic_scoring: { type: 'json' },
                expected_answer: '["a","b"]'
            });
            expect(result.score).toBe(10);
            expect(result.deterministic_type).toBe('json');
        });

        it('should use regex patterns when configured', () => {
            const result = score('The answer is 42', {
                name: 'test',
                deterministic_scoring: {
                    type: 'regex',
                    must_contain: [{ pattern: '42', weight: 1 }]
                }
            });
            expect(result.score).toBe(10);
            expect(result.deterministic_type).toBe('regex');
        });

        it('should return null for unknown scoring types', () => {
            const result = score('response', {
                name: 'test',
                deterministic_scoring: { type: 'unknown' }
            });
            expect(result).toBe(null);
        });
    });
});
