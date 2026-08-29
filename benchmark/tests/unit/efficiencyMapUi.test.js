const fs = require('fs');
const path = require('path');
const vm = require('vm');

const UI_ROOT = path.join(__dirname, '../../public/js/efficiency-map');

function loadBrowserModule(filename, exportNames, stubs = {}) {
    const sourcePath = path.join(UI_ROOT, filename);
    let source = fs.readFileSync(sourcePath, 'utf8');
    source = source.replace(/^import\s+.*;\r?\n/gm, '');
    source = source
        .replace(/^export\s+function\s+/gm, 'function ')
        .replace(/^export\s+const\s+/gm, 'const ');
    source += `\nmodule.exports = { ${exportNames.join(', ')} };\n`;

    const context = {
        module: { exports: {} },
        exports: {},
        console,
        ...stubs
    };
    context.global = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

const evidence = loadBrowserModule('evidence.js', [
    'isRankableEfficiencyEntry',
    'rankableEfficiencyEntries',
    'NO_THROUGHPUT_MESSAGE'
]);

const hero = loadBrowserModule('hero-picks.js', ['renderHeroPicks'], {
    scoreColor: () => '#fff',
    ...evidence
});

const scatter = loadBrowserModule('scatter-plot.js', ['renderScatterPlot'], {
    scoreColor: () => '#fff',
    ...evidence
});

const table = loadBrowserModule('ranked-table.js', ['renderRankedTable'], {
    scoreColor: () => '#fff',
    ...evidence,
    Blob: class {},
    URL: class {}
});

function entry(overrides = {}) {
    return {
        model: 'model-a',
        host: 'http://host-a:11434',
        avgQuality: 8,
        avgTokPerSec: 40,
        avgTtft: 100,
        efficiencyScore: 53.33,
        paretoOptimal: false,
        testCount: 6,
        ...overrides
    };
}

function fakeContainer(clientWidth = 700) {
    return {
        clientWidth,
        innerHTML: '',
        querySelector: () => ({
            innerHTML: '',
            classList: { add() {}, remove() {} },
            style: {},
            getBoundingClientRect: () => ({ left: 0, top: 0 })
        }),
        querySelectorAll: () => []
    };
}

describe('Efficiency Map UI evidence guards', () => {
    it('keeps only finite positive measured entries and sorts them by efficiency', () => {
        const entries = [
            entry({ model: 'slower', efficiencyScore: 20 }),
            entry({ model: 'missing', avgQuality: 10, avgTokPerSec: null, efficiencyScore: null }),
            entry({ model: 'zero', avgQuality: 10, avgTokPerSec: 0, efficiencyScore: 0 }),
            entry({ model: 'nan', avgTokPerSec: NaN, efficiencyScore: 90 }),
            entry({ model: 'infinite', avgTokPerSec: Infinity, efficiencyScore: 90 }),
            entry({ model: 'faster', avgQuality: 7, efficiencyScore: 70 })
        ];

        expect(evidence.rankableEfficiencyEntries(entries).map(item => item.model)).toEqual([
            'faster',
            'slower'
        ]);
    });

    it('does not award efficiency medals to quality-only rows', () => {
        const container = fakeContainer();

        hero.renderHeroPicks(container, [
            entry({ model: 'high-quality-unmeasured', avgQuality: 10, avgTokPerSec: null, efficiencyScore: null }),
            entry({ model: 'zero-throughput', avgQuality: 9, avgTokPerSec: 0, efficiencyScore: 0 })
        ]);

        expect(container.innerHTML).toContain('No valid throughput evidence');
        expect(container.innerHTML).not.toContain('eff-pick-medal');
        expect(container.innerHTML).not.toContain('high-quality-unmeasured');
    });

    it('awards the first medal to the highest efficiency score, not input or quality order', () => {
        const container = fakeContainer();

        hero.renderHeroPicks(container, [
            entry({ model: 'high-quality-unmeasured', avgQuality: 10, avgTokPerSec: null, efficiencyScore: null }),
            entry({ model: 'lower-efficiency', avgQuality: 9, avgTokPerSec: 10, efficiencyScore: 18 }),
            entry({ model: 'highest-efficiency', avgQuality: 7, avgTokPerSec: 80, efficiencyScore: 74 })
        ]);

        expect(container.innerHTML).not.toContain('high-quality-unmeasured');
        expect(container.innerHTML.indexOf('highest-efficiency')).toBeLessThan(
            container.innerHTML.indexOf('lower-efficiency')
        );
    });

    it('renders an honest scatter empty state for zero or non-finite throughput', () => {
        const container = fakeContainer();

        scatter.renderScatterPlot(container, [
            entry({ avgTokPerSec: null, efficiencyScore: null }),
            entry({ avgTokPerSec: 0, efficiencyScore: 0 }),
            entry({ avgTokPerSec: NaN, efficiencyScore: 50 }),
            entry({ avgTokPerSec: Infinity, efficiencyScore: 50 })
        ]);

        expect(container.innerHTML).toContain('No valid throughput evidence');
        expect(container.innerHTML).not.toMatch(/NaN|Infinity/);
        expect(container.innerHTML).not.toContain('<svg');
    });

    it('omits malformed points and never emits non-finite SVG coordinates', () => {
        const container = fakeContainer();

        scatter.renderScatterPlot(container, [
            entry({ model: 'valid', paretoOptimal: true }),
            entry({ model: 'missing', avgTokPerSec: null, efficiencyScore: null }),
            entry({ model: 'infinite', avgTokPerSec: Infinity, efficiencyScore: 90 })
        ]);

        expect(container.innerHTML).toContain('<svg');
        expect(container.innerHTML).toContain('valid@@http://host-a:11434');
        expect(container.innerHTML).not.toContain('missing@@');
        expect(container.innerHTML).not.toContain('infinite@@');
        expect(container.innerHTML).not.toMatch(/NaN|Infinity|undefined/);
    });

    it('keeps SVG coordinates finite at the largest representable measured speed', () => {
        const container = fakeContainer(Infinity);

        scatter.renderScatterPlot(container, [
            entry({ model: 'finite-extreme', avgTokPerSec: Number.MAX_VALUE, efficiencyScore: 90 })
        ]);

        expect(container.innerHTML).toContain('finite-extreme@@');
        expect(container.innerHTML).not.toMatch(/NaN|Infinity|undefined/);
    });

    it('does not render or export a ranking table without valid throughput evidence', () => {
        const container = fakeContainer();

        const api = table.renderRankedTable(container, [
            entry({ avgQuality: 10, avgTokPerSec: null, efficiencyScore: null })
        ]);

        expect(container.innerHTML).toContain('No valid throughput evidence');
        expect(container.innerHTML).not.toContain('<table');
        expect(() => api.highlightRow('anything')).not.toThrow();
    });
});
