/**
 * Tests for Format Compliance Scorer
 */

const { scoreFormatCompliance } = require('../../src/services/scoring/formatComplianceScorer');

jest.mock('../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));

describe('Format Compliance Scorer', () => {
    describe('no contract / none type', () => {
        it('should return nulls when no contract', () => {
            const result = scoreFormatCompliance('anything', null);
            expect(result.format_score).toBeNull();
            expect(result.format_compliant).toBeNull();
        });

        it('should return nulls when contract type is none', () => {
            const result = scoreFormatCompliance('anything', { type: 'none' });
            expect(result.format_score).toBeNull();
            expect(result.format_compliant).toBeNull();
        });

        it('should return nulls when contract has no type', () => {
            const result = scoreFormatCompliance('anything', {});
            expect(result.format_score).toBeNull();
            expect(result.format_compliant).toBeNull();
        });
    });

    describe('empty response', () => {
        it('should return 0 for empty string', () => {
            const result = scoreFormatCompliance('', { type: 'number_only' });
            expect(result.format_score).toBeLessThan(10);
            expect(result.format_compliant).toBe(false);
        });

        it('should return 0 for whitespace-only', () => {
            const result = scoreFormatCompliance('   ', { type: 'exact', template: 'hello' });
            expect(result.format_score).toBeLessThan(10);
            expect(result.format_compliant).toBe(false);
        });
    });

    describe('number_only', () => {
        it('should score 10 for plain integer', () => {
            const result = scoreFormatCompliance('42', { type: 'number_only' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 10 for plain decimal', () => {
            const result = scoreFormatCompliance('3.14159', { type: 'number_only' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 10 for negative number', () => {
            const result = scoreFormatCompliance('-7', { type: 'number_only' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 8 for LaTeX boxed (allow_latex default true)', () => {
            const result = scoreFormatCompliance('$\\boxed{7}$', { type: 'number_only' });
            expect(result.format_score).toBe(8);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 8 for LaTeX boxed without dollar signs', () => {
            const result = scoreFormatCompliance('\\boxed{42}', { type: 'number_only' });
            expect(result.format_score).toBe(8);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 4 for number buried in text', () => {
            const result = scoreFormatCompliance('The answer is 7 because of reasons', { type: 'number_only' });
            expect(result.format_score).toBe(4);
            expect(result.format_compliant).toBe(false);
        });

        it('should score 0 for no number at all', () => {
            const result = scoreFormatCompliance('I do not know the answer', { type: 'number_only' });
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should reject LaTeX when allow_latex is false', () => {
            const result = scoreFormatCompliance('$\\boxed{7}$', { type: 'number_only', allow_latex: false });
            expect(result.format_score).toBe(4);
            expect(result.format_compliant).toBe(false);
        });
    });

    describe('exact', () => {
        it('should score 10 for exact match', () => {
            const result = scoreFormatCompliance('Hello World', { type: 'exact', template: 'Hello World' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 7 for case-insensitive match', () => {
            const result = scoreFormatCompliance('hello world', { type: 'exact', template: 'Hello World' });
            expect(result.format_score).toBe(7);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 3 for partial match (contains template)', () => {
            const result = scoreFormatCompliance('I think the answer is Hello World, right?', { type: 'exact', template: 'Hello World' });
            expect(result.format_score).toBe(3);
            expect(result.format_compliant).toBe(false);
        });

        it('should score 0 for no match', () => {
            const result = scoreFormatCompliance('Goodbye Moon', { type: 'exact', template: 'Hello World' });
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should return nulls when template is empty', () => {
            const result = scoreFormatCompliance('anything', { type: 'exact', template: '' });
            expect(result.format_score).toBeNull();
        });
    });

    describe('regex', () => {
        it('should score 10 when pattern matches', () => {
            const result = scoreFormatCompliance('The value is 42.', { type: 'regex', pattern: '\\d+' });
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 0 when pattern does not match', () => {
            const result = scoreFormatCompliance('no numbers here', { type: 'regex', pattern: '^\\d+$' });
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should return nulls for invalid regex', () => {
            const result = scoreFormatCompliance('anything', { type: 'regex', pattern: '[invalid' });
            expect(result.format_score).toBeNull();
        });

        it('should return nulls when no pattern provided', () => {
            const result = scoreFormatCompliance('anything', { type: 'regex' });
            expect(result.format_score).toBeNull();
        });
    });

    describe('json_schema', () => {
        it('should score 10 for valid JSON with all required keys', () => {
            const result = scoreFormatCompliance(
                '{"name": "test", "value": 42}',
                { type: 'json_schema', schema_keys: ['name', 'value'] }
            );
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should accept required_keys as the canonical key declaration', () => {
            const result = scoreFormatCompliance(
                '{"schedule": [], "makespan": 9}',
                { type: 'json_schema', required_keys: ['schedule', 'makespan'] }
            );
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should penalize forbidden extra keys without failing required keys', () => {
            const result = scoreFormatCompliance(
                '{"schedule": [], "makespan": 9, "notes": "extra"}',
                { type: 'json_schema', required_keys: ['schedule', 'makespan'], forbidden_extra_keys: true }
            );
            expect(result.format_score).toBe(7);
            expect(result.format_compliant).toBe(false);
        });

        it('should score 5 for valid JSON missing required keys', () => {
            const result = scoreFormatCompliance(
                '{"name": "test"}',
                { type: 'json_schema', schema_keys: ['name', 'value'] }
            );
            expect(result.format_score).toBe(5);
            expect(result.format_compliant).toBe(false);
        });

        it('should score 10 for valid JSON when no keys required', () => {
            const result = scoreFormatCompliance(
                '{"anything": true}',
                { type: 'json_schema', schema_keys: [] }
            );
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 0 for non-JSON response', () => {
            const result = scoreFormatCompliance(
                'This is plain text',
                { type: 'json_schema', schema_keys: ['name'] }
            );
            expect(result.format_score).toBe(0);
            expect(result.format_compliant).toBe(false);
        });

        it('should handle JSON embedded in text', () => {
            const result = scoreFormatCompliance(
                'Here is the result: {"score": 5, "reason": "good"}',
                { type: 'json_schema', schema_keys: ['score', 'reason'] }
            );
            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should score 0 for array instead of object', () => {
            const result = scoreFormatCompliance(
                '[1, 2, 3]',
                { type: 'json_schema', schema_keys: ['value'] }
            );
            expect(result.format_score).toBe(0);
        });
    });

    describe('structured_text', () => {
        it('should validate alphabetical bullet list constraints', () => {
            const result = scoreFormatCompliance(
                '- Alpha\n- Bravo\n- Charlie',
                {
                    type: 'structured_text',
                    line_count: 3,
                    line_regexes: ['^-\\s+A\\w*$', '^-\\s+B\\w*$', '^-\\s+C\\w*$']
                }
            );

            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should fail when a structured bullet list breaks ordering constraints', () => {
            const result = scoreFormatCompliance(
                '- Alpha\n- Charlie\n- Bravo',
                {
                    type: 'structured_text',
                    line_count: 3,
                    line_regexes: ['^-\\s+A\\w*$', '^-\\s+B\\w*$', '^-\\s+C\\w*$']
                }
            );

            expect(result.format_score).toBeLessThan(10);
            expect(result.format_compliant).toBe(false);
        });

        it('should validate sentence count, word count, and second sentence prefix', () => {
            const result = scoreFormatCompliance(
                'Pack rain gear before sunrise today. Because umbrellas help, dry socks and light jackets keep every trail walk calm in steady rain.',
                {
                    type: 'structured_text',
                    sentence_count: 2,
                    second_sentence_starts_with: 'Because',
                    word_count: { min: 18, max: 22 },
                    required_terms: ['rain', 'umbrellas']
                }
            );

            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should validate paragraph and sentence requirements', () => {
            const result = scoreFormatCompliance(
                'Canary rollout starts with one quiet node. Metrics stay visible for quick rollback.\n\nRollback remains scripted and rehearsed before release. Teams pause traffic if error rates climb.\n\nChecklist: A; B. Final approvals follow after the smoke tests finish.',
                {
                    type: 'structured_text',
                    paragraph_count: 3,
                    sentences_per_paragraph: 2,
                    paragraph_required_terms: [
                        ['canary'],
                        ['rollback'],
                        ['Checklist: A; B']
                    ],
                    forbidden_line_pattern: '^\\s*[-*]'
                }
            );

            expect(result.format_score).toBe(10);
            expect(result.format_compliant).toBe(true);
        });

        it('should detect forbidden terms in acrostic constraints', () => {
            const result = scoreFormatCompliance(
                'Data dances softly around moonlit wires.\nA gentle circuit hums beyond the pier.\nTidal lanterns flicker over silent roofs.\nAmber windows answer distant harbor bells.',
                {
                    type: 'structured_text',
                    line_count: 4,
                    line_initials: ['D', 'A', 'T', 'A'],
                    line_word_count: { min: 6, max: 8 },
                    each_line_ends_with: '.',
                    forbidden_terms: ['data']
                }
            );

            expect(result.format_compliant).toBe(false);
            expect(result.format_score).toBeLessThan(10);
        });
    });
});
