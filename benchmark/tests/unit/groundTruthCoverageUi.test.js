const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '../..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

describe('ground-truth coverage honesty', () => {
    test('separates occupied cells from target-ready human coverage', () => {
        const route = read('routes', 'benchmark', 'diagnostics.js');

        expect(route).toContain("coverage_basis: 'occupied_cells'");
        expect(route).toContain('target_coverage_pct');
        expect(route).toContain('hard_scope: {');
        expect(route).toContain('ready: hardCellsMeetingTarget === hardTotalCells');
    });

    test('warns that hard rankings remain exploratory until L4-L5 coverage is ready', () => {
        const ui = read('public', 'js', 'courthouse-v2', 'gap-analysis.js');
        const leaderboard = read('public', 'js', 'leaderboard-v2', 'index.js');

        expect(ui).toContain('Hard L4–L5 calibration coverage is not ready.');
        expect(ui).toContain('Hard rankings remain exploratory');
        expect(ui).toContain("statCard('Occupied Cells'");
        expect(ui).toContain("statCard('Target Ready'");
        expect(leaderboard).toContain('Hard L4–L5 judge evidence is exploratory.');
        expect(leaderboard).toContain('fetchGroundTruthGaps().catch(() => null)');
    });
});
