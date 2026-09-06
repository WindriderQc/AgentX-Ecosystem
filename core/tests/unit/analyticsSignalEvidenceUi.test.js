'use strict';

/**
 * Activity page renderers honour the Signal Evidence Contract.
 *
 * The page scripts are browser ES modules, so this suite protects the wiring
 * by source contract (the repository convention for UI modules) while the
 * behaviour itself is covered by shared/signalEvidence.test.js and the
 * analytics API suites.
 */

const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

const view = read('views/pages/analytics.ejs');
const inference = read('public/js/analytics-inference.js');
const cost = read('public/js/analytics-cost.js');
const product = read('public/js/analytics.js');
const experience = read('public/js/analytics-experience.js');
const esbuildConfig = read('esbuild.config.mjs');
const bundleEntry = read('src/frontend/signal-evidence.js');

describe('Signal Evidence bundle', () => {
  test('is built from the shared contract and served from /dist', () => {
    expect(esbuildConfig).toContain("'src/frontend/signal-evidence.js'");
    expect(bundleEntry).toContain("from '../../../shared/signalEvidence.js'");
    for (const source of [inference, cost, product]) {
      expect(source).toContain("from '/dist/signal-evidence.js'");
    }
  });
});

describe('Avg Classifier Time tile', () => {
  test('renders the contract signal instead of formatting a raw 0', () => {
    expect(inference).not.toContain("setText('infAvgClassification', ms(t.avgClassificationMs))");
    expect(inference).not.toContain("(t.classificationOverheadPct ?? 0).toFixed(1)");
    expect(inference).toContain("renderSignal('infAvgClassification', classifier.avg, 'infAvgClassificationNote')");
    expect(inference).toContain("renderSignal('infClassificationPct', classifier.overhead, 'infClassificationPctNote')");
    expect(inference).toContain('parseSignal(signals.avgClassificationMs) || averageSignal(');
  });

  test('exposes the evidence state on the tile and a note for the label', () => {
    expect(inference).toContain('el.dataset.signalState = view.state');
    expect(inference).toContain('el.title = view.detail');
    expect(view).toContain('id="infAvgClassificationNote"');
    expect(view).toContain('id="infClassificationPctNote"');
    expect(view).toContain('reads Not observed rather than 0ms');
  });
});

describe('Cost Efficiency table', () => {
  test('names Best only from the contract ranking and reads the real message field', () => {
    expect(cost).not.toContain("idx === 0 ? 'Best ★'");
    expect(cost).not.toContain('formatNumber(row.messages || 0)');
    expect(cost).toContain('row.messageCount ?? row.messages ?? null');
    expect(cost).toContain('parseSignal(data?.signals?.costEfficiencyRanking)');
    expect(cost).toContain('comparison.state === COMPARISON_STATES.RANKED');
    expect(cost).toContain("entry.key === comparison.best) return { ...BADGES.best");
    expect(cost).toContain("label: 'No price'");
    expect(cost).toContain("label: 'Only priced model'");
    expect(cost).toContain("label: 'Tied'");
  });

  test('explains the ranking rule to the operator', () => {
    expect(view).toContain('id="efficiencyRankingNote"');
    expect(view).toContain('Best ★ needs at least two priced models and no tie');
    expect(view).not.toContain('Cost efficiency indicator: higher is better');
  });
});

describe('RAG adoption and RAG-vs-non-RAG delta', () => {
  test('render contract signals with their sample instead of bare percentages', () => {
    expect(product).not.toContain('elements.ragUsage.textContent = formatPercent(rag.ragUsageRate)');
    expect(product).not.toContain('const delta = ragPositiveRate - noRagPositiveRate');
    expect(product).toContain('renderSignal(elements.ragUsage, signals.usage)');
    expect(product).toContain('renderSignal(elements.ragDelta, signals.delta)');
    expect(product).toContain("sampleNote(signals.usage, 'conversations', 'using retrieval')");
    expect(product).toContain('parseSignal(attested.ragFeedbackDelta) || differenceSignal(');
    expect(product).toContain('const RAG_MIN_SAMPLE = 5');
  });

  test('the donut centre and the empty state share the same signal', () => {
    expect(product).not.toContain('elements.ragDonutLabel.textContent = formatPercent(data.ragUsageRate)');
    expect(product).toContain('renderSignal(elements.ragDonutLabel, ragSignals(data).usage)');
    expect(product).toContain('renderSignal(elements.ragDonutLabel, ragSignals(rag || {}).usage)');
  });

  test('the view carries note elements and explains the rules', () => {
    expect(view).toContain('id="ragUsageNote"');
    expect(view).toContain('id="ragDeltaNote"');
    expect(view).toContain('fewer than 5 conversations is flagged as a low sample');
    expect(view).toContain('Needs feedback in both cohorts');
  });

  test('the cockpit summary reads the evidence state rather than parsing the percentage alone', () => {
    expect(experience).toContain("knowledgeUsagePhrase(text('ragUsage'), ragUsageElement?.dataset.signalState, ragUsageElement?.dataset.signalSample)");
    expect(experience).toContain("attributeFilter: ['data-signal-state', 'data-signal-sample']");
    expect(experience).not.toContain("ragUsage + ' of conversations used knowledge · '");
  });
});
