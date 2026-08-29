'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..', '..');
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');

function loadExplorerHelpers() {
    const sourcePath = path.join(root, 'public', 'js', 'results-explorer.js');
    const source = `${fs.readFileSync(sourcePath, 'utf8')}
module.exports = { buildResultsParams, renderEvidenceAge, formatRecordedAt };`;
    const context = {
        module: { exports: {} },
        exports: {},
        console,
        URLSearchParams,
        location: { search: '', pathname: '/results-explorer' },
        history: { replaceState: jest.fn() },
        escapeHtml: value => String(value),
        document: {
            addEventListener: jest.fn(),
            querySelectorAll: jest.fn(() => []),
            getElementById: jest.fn(() => null)
        }
    };
    context.window = context;
    context.globalThis = context;
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

describe('Results Explorer trust surface', () => {
    const view = read('views', 'pages', 'results-explorer.ejs');
    const main = read('public', 'js', 'results-explorer.js');
    const charts = read('public', 'js', 'results-explorer-charts.js');
    const inspector = read('public', 'js', 'results-explorer-inspector.js');
    const route = read('routes', 'benchmark', 'results.js');
    const sharedLayout = read('..', 'core', 'views', 'layouts', 'main.ejs');

    test('states the age rule and never adds a stale demo evidence badge', () => {
        expect(view).toContain('Evidence age is based only on the recorded timestamp.');
        expect(view).toContain('Historical: more than 90 days.');
        expect(view).toContain('“Legacy scoring” appears only when that exact formula is stored');
        expect(`${view}\n${main}\n${inspector}`).not.toMatch(/demo[-_ ]?(?:data|result|evidence|badge)/i);
        expect(sharedLayout).toContain("locals.agentxProfile === 'demo'");
        expect(sharedLayout).not.toMatch(/<a class="demo-profile-home"[\s\S]*?<% if \(locals\.agentxProfile === 'demo'/);
    });

    test('renders age and explicit legacy scoring independently', () => {
        const { renderEvidenceAge, formatRecordedAt } = loadExplorerHelpers();
        const html = renderEvidenceAge({
            evidence_era: 'historical',
            evidence_age_days: 140,
            legacy_scoring: true
        });
        expect(html).toContain('Historical');
        expect(html).toContain('140 days old');
        expect(html).toContain('Legacy scoring');

        const recent = renderEvidenceAge({
            evidence_era: 'recent',
            evidence_age_days: 2,
            legacy_scoring: false
        });
        expect(recent).toContain('Recent');
        expect(recent).not.toContain('Legacy scoring');
        expect(renderEvidenceAge({
            evidence_era: 'undated',
            evidence_age_days: null
        })).toContain('age unavailable');
        expect(formatRecordedAt({ timestamp: null })).toContain('Not recorded');
    });

    test('requests one server-filtered page with newest-first ordering', () => {
        const { buildResultsParams } = loadExplorerHelpers();
        const params = buildResultsParams(2, {
            models: ['model-a'],
            categories: ['reasoning'],
            evidenceEra: 'historical',
            levelMin: '1',
            levelMax: '5',
            qualityMin: '0',
            qualityMax: '10'
        }, true);
        expect(params.get('offset')).toBe('50');
        expect(params.get('limit')).toBe('50');
        expect(params.get('sort')).toBe('timestamp');
        expect(params.get('sortDir')).toBe('desc');
        expect(params.get('includeEvidenceMeta')).toBe('true');
        expect(params.get('includeFacets')).toBe('true');
        expect(params.get('models')).toBe('model-a');
        expect(params.get('categories')).toBe('reasoning');
        expect(params.get('evidenceEra')).toBe('historical');
        expect(main).toContain('/api/benchmark/results/advanced?');
        expect(main).not.toContain('/api/benchmark/results?page=');
    });

    test('labels page-only aggregates and makes pagination stable and count-backed', () => {
        expect(view.match(/Visible page/g)?.length).toBeGreaterThanOrEqual(4);
        expect(charts).toContain('Matching Results');
        expect(charts).toContain('Models on Page');
        expect(charts).toContain('Page Avg Quality');
        expect(charts).toContain("'evidence_age_days', 'legacy_scoring', 'timestamp'");
        expect(charts).toContain('Showing ${start}–${end} of ${total} matching results');
        expect(charts).not.toContain("parent.innerHTML = '<div");
        expect(charts).toContain('setChartEmptyState(ctx, true');
        expect(route).toContain('sortSpec._id = sortDir');
        expect(route).toContain('totalPages');
        expect(route).toContain('returned: results.length');
        expect(inspector).toContain('Age band uses only this timestamp');
    });
});
