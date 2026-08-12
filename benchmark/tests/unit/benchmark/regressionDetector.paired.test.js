const {
    pairedModelCompare,
    assessComparability
} = require('../../../src/services/benchmark/regressionDetector');

function mk(prompts) {
    const entries = Object.entries(prompts);
    return {
        prompts: Object.fromEntries(entries.map(([name, value]) => [
            name,
            typeof value === 'number' ? { q: value, category: 'reasoning' } : value
        ])),
        avg_quality: entries.reduce((sum, [, value]) => sum + (typeof value === 'number' ? value : value.q), 0) / entries.length
    };
}

describe('pairedModelCompare', () => {
    test('ignores unpaired hard prompts when shared prompts did not regress', () => {
        const previous = mk({ a: 8, b: 8, c: 8 });
        const current = mk({ a: 8, b: 8, c: 8, hard1: 2, hard2: 2, hard3: 2 });

        const result = pairedModelCompare(current, previous);

        expect(result.method).toBe('paired');
        expect(result.meanDelta).toBe(0);
        expect(result.previous).toBe(80);
        expect(result.current).toBe(80);
    });

    test('requires paired confidence interval to exclude zero', () => {
        const result = pairedModelCompare(
            mk({ a: 8.1, b: 7.9, c: 8.2 }),
            mk({ a: 8.0, b: 8.0, c: 8.0 })
        );

        expect(result.method).toBe('paired');
        expect(result.significant).toBe(false);
    });

    test('falls back to low confidence when overlap is too small', () => {
        const result = pairedModelCompare(mk({ a: 8, b: 8 }), mk({ c: 5, d: 5 }));

        expect(result.method).toBe('unpaired_low_confidence');
        expect(result.significant).toBe(false);
        expect(result.n_pairs).toBe(0);
    });

    test('reports category deltas only from paired prompts', () => {
        const result = pairedModelCompare(
            mk({
                a: { q: 6, category: 'math' },
                b: { q: 6, category: 'math' },
                c: { q: 8, category: 'coding' }
            }),
            mk({
                a: { q: 8, category: 'math' },
                b: { q: 8, category: 'math' },
                c: { q: 8, category: 'coding' }
            })
        );

        expect(result.categoryDeltas).toEqual([
            expect.objectContaining({ category: 'math', meanDelta: -20, n: 2 })
        ]);
    });
});

describe('assessComparability', () => {
    test('accepts same major.minor scorer versions', () => {
        expect(assessComparability(['2.3.0'], ['2.3.4']).comparable).toBe(true);
    });

    test('rejects mixed versioned and unversioned batches', () => {
        const result = assessComparability(['2.3.0'], [null]);
        expect(result.comparable).toBe(false);
        expect(result.warnings.join(' ')).toMatch(/unversioned/);
    });
});
