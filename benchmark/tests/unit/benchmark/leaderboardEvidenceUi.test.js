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

    test('converts the detailed-row uncertainty from 0-100 to the visible 0-10 scale', () => {
        const { toGeneralistBoardEntry } = loadBrowserModule(
            'index.js',
            'toGeneralistBoardEntry'
        );

        const entry = toGeneralistBoardEntry({
            model: 'scaled-model',
            generalistScore: 80,
            confidenceMargin: 6,
            categoryAverages: { coding: 80 }
        });

        expect(entry.confidence).toBe(0.6);
    });

    test('defaults the page to Trusted unless the user explicitly stored Exploratory', () => {
        const source = fs.readFileSync(path.join(PUBLIC_ROOT, 'index.js'), 'utf8');
        const apiSource = fs.readFileSync(path.join(PUBLIC_ROOT, 'api.js'), 'utf8');
        expect(source).toContain("let _trustScope = 'trusted'");
        expect(source).toContain("=== 'exploratory' ? 'exploratory' : 'trusted'");
        expect(apiSource).toContain("params.set('trustScope', trustScope)");
        expect(apiSource).not.toContain("trustScope !== 'exploratory'");
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

        const reviewHtml = categoryBars([], { reasoning: 'review_pending' });
        expect(reviewHtml).toContain('Reasoning: pending human review; provisional score withheld');

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

    test('keeps missing provenance confidence neutral and separates needs-review from reviewed', () => {
        const { renderRow } = loadBrowserModule(
            'combined-board.js',
            'renderRow',
            {
                getBadgeHtml: () => '',
                speedometer: () => '',
                shortHost: () => 'host'
            }
        );

        const html = renderRow({
            model: 'legacy-judge-scored',
            score: 6.5,
            fullScopeEligible: false,
            evidenceConfidence: null,
            evidenceConfidencePenalty: 0,
            needsReviewCount: 8,
            categoryScores: { coding: 6.5 },
            dimensions: [],
            promptLevelCounts: { 2: 1 }
        }, 0, new Map(), {}, { provisional: true });

        expect(html).toContain('Legacy rows may still contain an LLM judge score');
        expect(html).toContain('<span class="cb-detail-stat-label">Evidence confidence</span>');
        expect(html).toContain('<strong class="cb-detail-stat-value ">—</strong>');
        expect(html).not.toContain('<strong class="cb-detail-stat-value good">—</strong>');
        expect(html).toContain('<span class="cb-detail-stat-label">Needs review</span>');
        expect(html).toContain('<strong class="cb-detail-stat-value watch">8</strong>');
    });

    test('renders a one-row graphic summary and preserves the complete evidence sheet', () => {
        const { renderRow } = loadBrowserModule(
            'combined-board.js',
            'renderRow',
            {
                getBadgeHtml: () => '<span>Ready</span>',
                speedometer: () => '<svg data-speedometer></svg>',
                formatMs: value => `${value}ms`,
                valColor: () => '#fff',
                shortHost: () => 'gpu-studio'
            }
        );
        const categoryScores = {
            coding: 8.8,
            reasoning: 8.1,
            math: 7.9,
            knowledge: 7.5,
            instruction: 8.4,
            creative: 7.1,
            translation: null
        };
        const html = renderRow({
            model: 'exact-model:q8',
            host: 'http://gpu-studio:11434',
            hostName: 'GPU Studio',
            provider: 'ollama',
            tier: 'local',
            score: 8.21,
            scoreAxis: 'quality',
            fullScopeEligible: false,
            evidenceTrustState: 'exploratory',
            categoryScores,
            dimensions: Object.entries(categoryScores)
                .filter(([, value]) => value != null)
                .map(([name, value]) => ({ name, yesRate: value / 10 })),
            categoryEvidence: { translation: 'review_pending' },
            promptLevelCounts: { 4: 6, 5: 5 },
            contextCounts: { 32768: 7, 65536: 4 },
            requiredPromptLevels: [4, 5],
            fullScopeMinLevel: 4,
            difficultyCoverage: 79,
            difficultyPenalty: 1.2,
            evidenceConfidence: 0.76,
            evidenceConfidenceTarget: 0.8,
            evidenceConfidencePenalty: 0.4,
            confidence: 0.61,
            confidenceMethod: 'weighted_category_prompt_means_t95',
            confidenceSampleSize: 11,
            confidenceRepeatCount: 22,
            testCount: 22,
            needsReviewCount: 3,
            lowConfidenceCount: 2,
            judgeModel: 'judge-model:q8',
            judgeCalibrated: true,
            tokPerSec: 41.2,
            avgLatency: 1320,
            p95Latency: 2210,
            benchmarkTtft: 420,
            hostTtft: 360,
            successRate: 95,
            perfCoeff: 0.95,
            qualityCohortFingerprint: 'sha256:cohort',
            harness: { name: 'native', version: '1.2' }
        }, 0, new Map(), {}, { provisional: true });

        expect(html).toContain('class="cb-row-open"');
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain('class="cb-summary-categories"');
        expect(html).toContain('data-cb-detail="model-detail-0"');
        expect(html).toContain('Complete model evidence');
        expect(html).toContain('sha256:cohort');
        expect(html).toContain('judge-model:q8');
        expect(html).toContain('data-speedometer');
        [
            'Capability profile', 'Speed & latency', 'Evidence ledger',
            'Tests', 'Levels', 'Contexts', 'Hard coverage', 'Evidence confidence',
            'Scope', 'Uncertainty', 'Calibration', 'Needs review', 'Low confidence',
            'Success', 'Provider cost', 'Performance coeff.',
            'Review in Courthouse', 'Efficiency Map'
        ].forEach(label => expect(html).toContain(label));
        expect(html).toContain('Translation: pending human review; provisional score withheld');
    });

    test('consolidates evidence warnings and keeps cohort visuals behind one disclosure', () => {
        const source = fs.readFileSync(path.join(PUBLIC_ROOT, 'index.js'), 'utf8');
        const leaderboard = source.indexOf('<div id="leaderboard"');
        const cohortDoor = source.indexOf('<details id="leaderboard-cohort-overview"');

        expect(source).toContain('function renderEvidenceNotice');
        expect(source).toContain('id = \'leaderboard-evidence-notice\'');
        expect(source).not.toContain("id = 'trust-onboard-banner'");
        expect(source).not.toContain("id = 'hard-coverage-banner'");
        expect(source).toContain('Hard L4–L5 judge evidence is exploratory.');
        expect(leaderboard).toBeGreaterThan(-1);
        expect(cohortDoor).toBeGreaterThan(leaderboard);
        expect(source).not.toContain('<details id="leaderboard-cohort-overview" class="r-cohort-lab" open>');
    });

    test('keeps the no-evidence experience on the primary list surface', () => {
        const source = fs.readFileSync(path.join(PUBLIC_ROOT, 'index.js'), 'utf8');
        const emptyState = source.slice(
            source.indexOf('if (!hasHistoricalEvidence)'),
            source.indexOf('// --- Step 3: podium')
        );

        expect(emptyState).toContain("const leaderboardEl = main.querySelector('#leaderboard')");
        expect(emptyState).toContain('<h1>No ranked models yet</h1>');
        expect(emptyState).not.toContain("['scoring-system', 'leaderboard', 'category-map']");
        expect(emptyState).toContain("hideInactiveSurface(main.querySelector('#leaderboard-cohort-overview'))");
    });

    test('keeps missing Courthouse calibration unknown and describes judge selection precisely', () => {
        const source = fs.readFileSync(
            path.join(PUBLIC_ROOT, '../courthouse-v2/the-bench.js'),
            'utf8'
        );

        expect(source).toContain('unknown agreement');
        expect(source).not.toContain('const pr = cal.pass_rate ?? 0');
        expect(source).not.toContain('const dv = cal.avg_deviation ?? 0');
        expect(source).not.toContain('cal.ground_truth_count || 0');
        expect(source).toContain('>set active</button>');
        expect(source).toContain('does not add load balancing or capacity');
        expect(source).not.toContain('>promote</button>');
    });

    test('renders partial-scope results as provisional evidence without a medal', () => {
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

        expect(container.innerHTML).toContain('Evidence observations');
        expect(container.innerHTML).toContain('Evidence 1');
        expect(container.innerHTML).not.toContain('>Champion<');
        expect(container.innerHTML).not.toContain('aria-label="Gold"');
        expect(container.innerHTML).toContain('Reasoning: not tested');
    });

    test('ignores forged Phase 0 qualification fields even for full-scope evidence', () => {
        const { renderPodium } = loadBrowserModule('podium.js', 'renderPodium');
        const container = { innerHTML: '' };

        renderPodium(container, [{
            model: 'full-model',
            generalistScore: 88,
            fullScopeEligible: true,
            evidenceStatus: 'full_scope',
            totalTests: 50,
            categoryAverages: { coding: 88, reasoning: 87 }
        }], {
            trustVerdict: {
                contract: 'agentx.benchmark-consumer-trust/v1',
                qualified: true,
                qualifiedWinner: { model: 'full-model', host: null },
                state: 'trusted'
            }
        });

        expect(container.innerHTML).toContain('No exact qualification receipt');
        expect(container.innerHTML).toContain('Evidence 1');
        expect(container.innerHTML).not.toContain('>Champion<');
        expect(container.innerHTML).not.toContain('aria-label="Gold"');
    });

    test('does not award Champion to full-scope evidence without a qualification receipt', () => {
        const { renderPodium } = loadBrowserModule('podium.js', 'renderPodium');
        const container = { innerHTML: '' };

        renderPodium(container, [{
            model: 'trusted-observation',
            generalistScore: 91,
            fullScopeEligible: true,
            evidenceStatus: 'full_scope',
            totalTests: 87,
            categoryAverages: { coding: 91, reasoning: 90 }
        }], {
            trustVerdict: { qualified: false, qualifiedWinner: null, state: 'trusted' }
        });

        expect(container.innerHTML).toContain('No exact qualification receipt');
        expect(container.innerHTML).toContain('Evidence 1');
        expect(container.innerHTML).not.toContain('>Champion<');
        expect(container.innerHTML).not.toContain('aria-label="Gold"');
    });

    test('does not award a table medal when every row is provisional', async () => {
        const { renderCombinedBoard } = loadBrowserModule(
            'combined-board.js',
            'renderCombinedBoard',
            {
                getReadinessMap: async () => ({}),
                getBadgeHtml: () => '',
                speedometer: () => '',
                shortHost: () => 'host'
            }
        );
        const container = { innerHTML: '', dataset: {}, querySelector: () => null };

        await renderCombinedBoard(container, [{
            model: 'partial-model',
            score: 7,
            fullScopeEligible: false,
            categoryScores: { coding: 7 },
            promptLevelCounts: { 4: 1 },
            dimensions: [],
            testCount: 1
        }]);

        expect(container.innerHTML).toContain('P1');
        expect(container.innerHTML).toContain('id="cb-model-dialog"');
        expect(container.innerHTML).not.toContain('🥇');
    });

    test('keeps the legacy generalist table fail-closed if it is reactivated', () => {
        const source = fs.readFileSync(path.join(PUBLIC_ROOT, 'generalist-board.js'), 'utf8');

        expect(source).toContain('Quality observations');
        expect(source).toContain('<th>Position</th>');
        expect(source).toContain('not a receipt-qualified comparison or promotion decision');
        expect(source).toContain('not Trust qualification');
        expect(source).not.toContain('stays apples-to-apples');
        expect(source).not.toContain('style="color:var(--r-good)">✓');
        expect(source).not.toContain('🥇');
        expect(source).not.toContain('Best in ${label}');
    });

    test('labels the simple category mean and disables comparative highlights across different scopes', () => {
        const { renderCategoryMap } = loadBrowserModule(
            'category-map.js',
            'renderCategoryMap',
            { heatCell: (score, opts = {}) => `<span data-best="${opts.best === true}">${score}</span>` }
        );
        const container = { innerHTML: '' };

        renderCategoryMap(container, [
            {
                model: 'wide',
                categoryScores: { coding: 8, reasoning: 7 },
                promptLevelCounts: { 4: 2, 5: 2 }
            },
            {
                model: 'narrow',
                categoryScores: { coding: 9, reasoning: null },
                promptLevelCounts: { 4: 1 }
            }
        ]);

        expect(container.innerHTML).toContain('Tested-lane avg');
        expect(container.innerHTML).toContain('data-comparable-scopes="false"');
        expect(container.innerHTML).toContain('cross-row comparison are disabled');
        expect(container.innerHTML).not.toContain('data-best="true"');
    });
});
