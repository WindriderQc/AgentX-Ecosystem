const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const view = read('views/pages/memory-review.ejs');
const controller = read('public/js/memory-review.js');
const styles = read('public/css/memory-review.css');

describe('Dreaming Review UI contract', () => {
  test('explains the workflow, ownership boundary, and current health', () => {
    expect(view).toContain('Dreaming Review');
    expect(view).toContain('Raw sessions stay local');
    expect(view).toContain('You review');
    expect(view).toContain('Ecosystem health');
    expect(view).toContain('Dream Pulse');
    expect(view).toContain('Runtime constellation');
    expect(view).toContain('Quality Lab');
    expect(view).toContain('Memory Atlas');
    expect(view).toContain('How it works');
  });

  test('uses an accessible candidate-level action dialog', () => {
    expect(view).toContain('aria-modal="true"');
    expect(view).toContain('aria-live="polite"');
    expect(controller).not.toMatch(/window\.(confirm|prompt|alert)/);
    expect(controller).not.toMatch(/approve-all|review-all|bulk/i);
    expect(controller).toContain('AgentXUtils.showToast');
  });

  test('supports deep-linked runs, stable candidate numbers, and responsive layout', () => {
    expect(controller).toContain("URLSearchParams(window.location.search).get('run')");
    expect(controller).toContain('number: index + 1');
    expect(controller).toContain("run.status === 'completed'");
    expect(controller).toContain('Quiet night—nothing trustworthy new');
    expect(controller).toContain('Why AgentX trusts this');
    expect(controller).toContain('Rollback removes the working-memory document');
    expect(styles).toContain('.mr-empty[hidden] { display: none; }');
    expect(styles).toContain('@media (max-width: 560px)');
  });

  test('adds statement-free insight, navigation, and review accelerators', () => {
    expect(controller).toContain('/api/memory-review/insights?limit=30');
    expect(controller).toContain('safeDigest');
    expect(view).toContain('Copy digest');
    expect(view).toContain('Find a run');
    expect(view).toContain('<kbd>J</kbd>/<kbd>K</kbd>');
    expect(controller).toContain("a: 'approve', r: 'reject', d: 'defer', e: 'edit_approve'");
    expect(controller).toContain('Copy clarification question');
    expect(controller).toContain('Summary unavailable; derived from run history');
    expect(controller).toContain('Safe automation ·');
    expect(controller).toContain('Standing policy · shadow evaluation');
    expect(controller).toContain('No current collector errors');
    expect(controller).toContain('the review model was not called');
    expect(controller).toContain('No collectors');
    expect(controller).toContain('A Dreaming handoff is overdue');
    expect(controller).toContain('Waiting for reconciliation');
    expect(controller).toContain('No review candidates');
    expect(controller).toContain('Collector coverage is stale.');
    expect(controller).toContain('No measured denominator is available.');
    expect(controller).toContain('Collector coverage is incomplete');
    expect(controller).toContain("const current = evidence.state === 'current' && evidence.value != null");
    expect(controller).toContain('friendlyRunTitle');
    expect(view).toContain('id="mrCandidateFilters"');
    expect(styles).toContain('.mr-segmented[hidden] { display: none; }');
  });
});
