'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
function load() {
  const document = { addEventListener() {}, activeElement: null };
  const context = { document, window: { location: { search: '' } }, URLSearchParams };
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, 'globalThis.drawerTest = { preserveDrawerDraft, restoreDrawerDraft, latestTeamUpdate };\n})();'), context);
  return { ...context.drawerTest, document };
}
function field(value) {
  return { name: 'answer', value, selectionStart: 2, selectionEnd: 5, closest: () => ({ dataset: { drawerAction: 'reply-resume' } }), focus: jest.fn(), setSelectionRange: jest.fn() };
}
test('background rebuild retains an unsent answer, selection, focus, open details and scroll', () => {
  const api = load(); const original = field('Une réponse non envoyée'); api.document.activeElement = original;
  const before = { scrollTop: 218, querySelectorAll: query => query === 'details' ? [{ open: true }] : [original] };
  const draft = api.preserveDrawerDraft(before);
  const rebuilt = field(''); const detail = { open: false };
  const after = { scrollTop: 0, querySelectorAll: query => query === 'details' ? [detail] : [rebuilt] };
  api.restoreDrawerDraft(after, draft);
  expect(rebuilt.value).toBe(original.value);
  expect(rebuilt.focus).toHaveBeenCalledWith({ preventScroll: true });
  expect(rebuilt.setSelectionRange).toHaveBeenCalledWith(2, 5);
  expect(detail.open).toBe(true); expect(after.scrollTop).toBe(218);
});
test('blocked ticket presents the actual worker question even after an operator note', () => {
  const { latestTeamUpdate } = load();
  expect(latestTeamUpdate({ status: 'blocked', assignee: 'worker', feedback: [
    { by: 'guarded-dispatch', text: 'Guard failed\nWorker question or problem (not verification evidence):\nWhich layout?\n\nThe worker feedback is rejected.' },
    { by: 'operator', text: 'Investigating.' }
  ] })).toBe('Which layout?');
});

test('review leads with the decision to make instead of the raw verifier JSON', () => {
  const { latestTeamUpdate } = load();
  const text = latestTeamUpdate({ status: 'review', feedback: [{ by: 'worker', text: 'Dispatcher independent verification: PASS\n```json\n{"worker_criteria": []}\n```' }] });
  expect(text).toContain('independent verification command passed');
  expect(text).toContain('Review the implementation and its behavior');
  expect(text).not.toContain('worker_criteria');
});
