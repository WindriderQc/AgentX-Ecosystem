const {
    validateSemanticOutput,
    _internal: { extractAllNumbers }
} = require('../../../src/services/scoring/semanticOutputValidators');

describe('semanticOutputValidators numeric answer normalization', () => {
    test.each([
        ['ASCII space', '5 000'],
        ['non-breaking space', '5\u00a0000'],
        ['narrow non-breaking space', '5\u202f000'],
        ['comma', '5,000']
    ])('recognizes %s thousands formatting', (_label, formatted) => {
        const values = extractAllNumbers(`Maximum area: ${formatted} square metres.`);
        expect(values).toContain(5000);
    });

    test('scores the observed fenced-river answer as correct without losing its other values', () => {
        const response = 'Width 50 m, length 100 m, maximum area 5 000 m².';
        const result = validateSemanticOutput(response, '', {
            semantic_validator: 'numeric_answer',
            answer_numbers: [50, 100, 5000],
            answer_tolerance: 0.01
        });

        expect(result).toMatchObject({ matched: true, score: 10, method: 'numeric_answer' });
        expect(result.comparison.found).toEqual(expect.arrayContaining([50, 100, 5000]));
    });
});
