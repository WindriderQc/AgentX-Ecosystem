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
    expect(models).toContain("target?.mode === 'isolated_model'");
    expect(models).toContain('Cloud judges are disabled in this environment');
    expect(models).toContain('input type="radio" name="bv2-cloud-judge"');
    expect(models).toContain('optional · isolated targets only');
  });

  test('the unified picker searches all target evidence and groups dynamic sources', () => {
    const models = read('public/js/benchmark-v2/batch-config-models.js');
    const config = read('public/js/benchmark-v2/batch-config.js');
    const page = read('public/js/benchmark-v2/index.js');
    expect(models).toContain('Search model, provider, harness or capability');
    expect(models).toContain('data-source-filter="${esc(sourceKey(harness))}"');
    expect(models).toContain('target?.provider');
    expect(models).toContain('target?.capabilities?.judge');
    expect(config).toContain("card.dataset.filterText");
    expect(config).toContain("card.dataset.source === source");
    expect(page).toContain('harnessCatalogMeta');
    expect(page).toContain('observedAt: targetCatalog.observedAt');
  });

  test('paid cloud targets are locked by default and recipes cannot select them', () => {
    const models = read('public/js/benchmark-v2/batch-config-models.js');
    const config = read('public/js/benchmark-v2/batch-config.js');
    expect(models).toContain('id="bv2-allow-paid"');
    expect(models).toContain('data-paid-lock="${paid && ready}"');
    expect(models).toContain('Manual selection only · SpendGrant still required');
    expect(config).toContain("cb.dataset.paid !== 'true'");
    expect(config).toContain("preset === 'free-cloud'");
    expect(models).toContain('data-preset="recommended"');
    expect(models).toContain('data-preset="unbenchmarked"');
    expect(config).not.toContain("preset === 'all'");
    expect(config).toContain('Paid targets always require a manual click.');
  });

  test('cards expose context, pricing, judge capability and unavailable remediation', () => {
    const models = read('public/js/benchmark-v2/batch-config-models.js');
    expect(models).toContain('formatContextWindow(target.contextWindow)');
    expect(models).toContain('priceLabel(target)');
    expect(models).toContain('priceEvidenceLabel(target)');
    expect(models).toContain('Source: ${pricing.source}');
    expect(models).toContain('data-price-kind');
    expect(models).toContain('Refresh the catalog or verify the harness profile.');
    expect(models).toContain('mc-badge-judge');
  });

  test('review and run shows a dynamic manual paid ceiling before confirmation', () => {
    const summary = read('public/js/benchmark-v2/launch-summary.js');
    expect(summary).toContain('id="ls-est-cost"');
    expect(summary).toContain('inputTokensPerCall = 32_000');
    expect(summary).toContain('input.dataset.callNanodollars');
    expect(summary).toContain('Paid ceiling · ${maxCalls} calls');
    expect(summary).toContain('SpendGrant');
  });

  test('the picker and cloud judge collapse to one column on mobile', () => {
    const css = read('public/css/benchmark-v2-layout.css');
    expect(css).toMatch(/@media \(max-width: 700px\)[\s\S]*?\.mc-tier-cards,[\s\S]*?\.mc-judge-choice\s*\{\s*grid-template-columns: minmax\(0, 1fr\)/);
    expect(css).toContain('.model-checklist { overflow-x: clip; }');
  });

  test('native-agent campaigns have a separate Harnesses surface', () => {
    const view = read('views/pages/harnesses.ejs');
    const script = read('public/js/harnesses/index.js');
    const api = read('public/js/benchmark-v2/api.js');
    expect(view).toContain('Harnesses');
    expect(api).toContain("`${BASE}/harness-campaigns`");
    expect(view).toMatch(/portable|native-ceiling/);
  });

  test('native-agent controls fail closed when the broker or catalog is unavailable', () => {
    const view = read('views/pages/harnesses.ejs');
    const script = read('public/js/harnesses/index.js');
    expect(view).toContain('id="harness-run" class="r-nav-btn r-primary" disabled');
    expect(view).toContain('id="harness-target" disabled');
    expect(view).toContain('id="harness-prompt" rows="8" maxlength="200000"');
    expect(view).toMatch(/id="harness-prompt"[^>]+disabled/);
    expect(view).toContain('id="harness-confirm" disabled');
    expect(script).toContain('catalog?.enabled !== true');
    expect(script).toContain('No provider call is possible.');
    expect(script).toContain('Promise.allSettled');
  });

  test('cloud-only batches are represented as having a valid execution target', () => {
    const page = read('public/js/benchmark-v2/index.js');
    const config = read('public/js/benchmark-v2/batch-config.js');
    expect(page).toContain('localModelCount === 0 && cloudModelCount > 0');
    expect(page).toContain('state.executionTargetReady');
    expect(page).not.toContain('!state.host || state.modelCount === 0 ? \'locked\'');
    expect(config).toContain('via <strong style="color:var(--r-active)">Cloud harnesses</strong>');
    expect(config).toContain("cloudCandidateCount ? '' : _emptyMsg('Select an execution host above.')");
  });

  test('launch summary agrees that isolated cloud targets do not require an Ollama host', () => {
    const summary = read('public/js/benchmark-v2/launch-summary.js');
    const config = read('public/js/benchmark-v2/batch-config.js');
    expect(summary).toContain('localModelCount === 0 && cloudModelCount > 0');
    expect(summary).toContain('<strong>Cloud harnesses</strong>');
    expect(summary).toContain('attested harness targets');
    expect(summary).not.toContain('const ready = host &&');
    expect(config).toContain('Math.ceil(testCount * 30 / 60)');
    expect(summary).toContain('Math.ceil(testCount * 30 / 60)');
  });

  test('mixed local and cloud selections expose both targets without profiling cloud ids', () => {
    const page = read('public/js/benchmark-v2/index.js');
    const summary = read('public/js/benchmark-v2/launch-summary.js');
    expect(page).toContain('` + ${cloudModelCount} cloud`');
    expect(summary).toContain('isolated cloud target');
    expect(summary).toContain('const unprofiled = localModelNames.filter');
    expect(summary).toContain('check host reachability and revalidate the attested harness targets');
  });

  test('local selection summary ignores stale cloud target ids', () => {
    const models = read('public/js/benchmark-v2/batch-config-models.js');
    expect(models).toContain('saved.has(value) || saved.has(m)');
    expect(models).not.toContain('saved.size');
  });

  test('a failed launch restores the primary action for a safe retry', () => {
    const config = read('public/js/benchmark-v2/batch-config.js');
    expect(config).toContain('await onLaunch(batchConfig)');
    expect(config).toMatch(/finally\s*{[\s\S]*?_resetLaunchButton\(\)/);
  });
});
