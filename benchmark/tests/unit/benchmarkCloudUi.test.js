'use strict';

const fs = require('fs');
const path = require('path');

const benchmarkRoot = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(benchmarkRoot, relative), 'utf8');

describe('cloud benchmark UI contracts', () => {
  test('leaderboard defaults to cloud-visible and sends server-side includeCloud filtering', () => {
    const page = read('public/js/leaderboard-v2/index.js');
    const api = read('public/js/leaderboard-v2/api.js');
    expect(page).toContain("localStorage.getItem('leaderboardIncludeCloud')");
    expect(page).toContain('cloudToggle.checked = _includeCloud');
    expect(api).toContain('includeCloud');
    expect(api).toContain("params.set('includeCloud'");
    expect((api.match(/params\.set\('includeCloud'/g) || [])).toHaveLength(2);
  });

  test('harness rows cannot offer Manual Chat and unranked evidence stays explicit', () => {
    const board = read('public/js/leaderboard-v2/combined-board.js');
    expect(board).toContain("entry?.executionTarget?.executionKind === 'harness'");
    expect(board).toContain('Use in Chat');
    expect(board).toContain('cb-use-model-proof');
    expect(board).toContain('UNRANKED');
  });

  test('benchmark groups harness targets and exposes only isolated judges', () => {
    const models = read('public/js/benchmark-v2/batch-config-models.js');
    const config = read('public/js/benchmark-v2/batch-config.js');
    expect(models).toContain('${esc(harness)} Cloud');
    expect(models).toContain('data-execution-kind="harness"');
    expect(config).toContain('paid_approval');
    expect(config).toContain("target?.mode === 'isolated_model'");
  });

  test('native-agent campaigns have a separate Harnesses surface', () => {
    const view = read('views/pages/harnesses.ejs');
    const script = read('public/js/harnesses/index.js');
    const api = read('public/js/benchmark-v2/api.js');
    expect(view).toContain('Harnesses');
    expect(api).toContain("`${BASE}/harness-campaigns`");
    expect(view).toMatch(/portable|native-ceiling/);
  });
});
