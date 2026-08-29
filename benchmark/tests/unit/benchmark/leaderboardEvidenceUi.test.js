const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { getTopCategoryFromAverages } = require('../../../src/services/benchmark/modelMetadata');

const PUBLIC_ROOT = path.join(__dirname, '../../../public/js/leaderboard-v2');

function loadBrowserModule(fileName, exportsSource, stubs = {}) {
    const sourcePath = path.join(PUBLIC_ROOT, fileName);
    let source = fs.readFileSync(sourcePath, 'utf8');
    source = source.replace(/^import[\s\S]*?;\r?\n/gm, '');
    source = source.replace(/export\s+(async\s+)?function\s+/g, (_, asyncKeyword = '') => `${asyncKeyword}function `);
    source += `\nmodule.exports = { ${exportsSource} };\n`;

    const context = {
        module: { exports: {} },
        exports: {},
        console,
        scoreColor: () => '#4fc3f7',
        document: { addEventListener: jest.fn() },
        localStorage: { getItem: jest.fn(() => null) },
        ...stubs
    };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

describe('leaderboard evidence-honesty UI', () => {
    test('does not recommend an unavailable category as if null were zero', () => {
        expect(getTopCategoryFromAverages(
            { coding: null, reasoning: 0, math: null },
            'plain-model'
        )).toBe('reasoning');
        expect(getTopCategoryFromAverages(
            { coding: null, reasoning: null },
            'plain-model'
        )).toBe('generalist');
    });

    test('keeps unavailable categories out of score bars', () => {
        const { buildCategoryScores, buildCategoryDimensions } = loadBrowserModule(
            'index.js',
            'buildCategoryScores, buildCategoryDimensions'
        );

        const scores = buildCategoryScores({ coding: 84, reasoning: null });
        const dimensions = buildCategoryDimensions(scores);

        expect(scores.coding).toBe(8.4);
        expect(scores.reasoning).toBeNull();
        expect(dimensions).toHaveLength(1);
        expect(dimensions[0].name).toBe('coding');
        expect(dimensions[0].yesRate).toBeCloseTo(0.84);
    });

    test('renders missing category bars as unavailable, never measured zero', () => {
        const { categoryBars, categoryExtremes, sortRankings } = loadBrowserModule(
            'combined-board.js',
            'categoryBars, categoryExtremes, sortRankings'
        );

        const html = categoryBars(
            [{ name: 'coding', yesRate: 0.84 }],
            { coding: 'scored', reasoning: 'untested' }
        );

        expect(html).toContain('Coding: 84%');
        expect(html).toContain('Reasoning: not tested');
        expect(html).not.toContain('Reasoning: 0%');

        expect(categoryExtremes({ categoryScores: { coding: null, reasoning: null } })).toMatchObject({
            best: null,
            watch: null
        });
        const sorted = sortRankings([
            { model: 'missing', score: 9, categoryScores: { reasoning: null } },
            { model: 'scored', score: 5, categoryScores: { reasoning: 0 } }
        ], 'reasoning');
        expect(sorted[0].model).toBe('scored');
    });

    test('calls a partial-scope #1 Partial leader, not Champion', () => {
        const { renderPodium } = loadBrowserModule('podium.js', 'renderPodium');
        const container = { innerHTML: '' };

        renderPodium(container, [{
            model: 'partial-model',
            host: 'http://localhost:11434',
            generalistScore: 72,
            fullScopeEligible: false,
            evidenceStatus: 'partial_scope',
            totalTests: 4,
            categoryAverages: { coding: 84, reasoning: null },
            categoryEvidence: { coding: 'scored', reasoning: 'untested' }
        }]);

        expect(container.innerHTML).toContain('Partial leader');
        expect(container.innerHTML).not.toContain('>Champion<');
        expect(container.innerHTML).toContain('Reasoning: not tested');
    });

    test('retains Champion for explicit full-scope evidence', () => {
        const { renderPodium } = loadBrowserModule('podium.js', 'renderPodium');
        const container = { innerHTML: '' };

        renderPodium(container, [{
            model: 'full-model',
            generalistScore: 88,
            fullScopeEligible: true,
            evidenceStatus: 'full_scope',
            totalTests: 50,
            categoryAverages: { coding: 88, reasoning: 87 }
        }]);

        expect(container.innerHTML).toContain('>Champion<');
        expect(container.innerHTML).not.toContain('Partial leader');
    });
});
