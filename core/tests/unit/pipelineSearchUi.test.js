'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadSearch() {
  const source = fs.readFileSync(path.resolve(__dirname, '../../public/js/pipeline.js'), 'utf8');
  const input = source.match(/search\.addEventListener\('input', \(\) => \{([\s\S]*?)\n\s*\}\);/);
  if (!input) throw new Error('Pipeline search input handler is missing');
  const context = { window: { location: { search: '' } }, document: { addEventListener() {} }, URLSearchParams };
  const hook = `globalThis.searchTest = { state, matchesFilters, setQuery(value) { const search = { value }; ${input[1].replace(/renderAll\(\);?/g, '')} } };`;
  vm.runInNewContext(source.replace(/\}\)\(\);\s*$/, hook + '\n})();'), context);
  return context.searchTest;
}

describe('Pipeline search behavior', () => {
  let search;
  beforeEach(() => { search = loadSearch(); });

  test.each(['preparer', 'PRÉPARER', 'pre\u0301parer', ' préparer '])('finds composed and decomposed French titles with %s', query => {
    search.setQuery(query);
    expect(search.matchesFilters({ title: 'Préparer la crème brûlée' })).toBe(true);
    expect(search.matchesFilters({ title: 'Pre\u0301parer la suite' })).toBe(true);
    expect(search.matchesFilters({ title: 'Preparer un café' })).toBe(true);
  });

  test.each(['title', 'assignee', 'epic', 'service', 'source'])('searches accents in the existing %s field', field => {
    search.setQuery('ecole');
    expect(search.matchesFilters({ [field]: 'École' })).toBe(true);
  });

  test('preserves identifiers, literal punctuation, blank search and missing fields', () => {
    for (const [query, task, expected] of [
      ['0673', { pipelineId: '0673' }, true],
      ['[x]', { title: 'Vérifier [x]' }, true],
      ['[x]', { title: 'Vérifier x' }, false],
      ['!', { title: 'Vérifier ！' }, false],
      ['！', { title: 'Vérifier !' }, false],
      ['absent', {}, false],
      ['  ', {}, true]
    ]) {
      search.setQuery(query);
      expect(search.matchesFilters(task)).toBe(expected);
    }
  });

  test('keeps the other filters exact and does not change displayed task data', () => {
    const task = { pipelineId: '0673', title: 'Préparer', status: 'queued', service: 'core', source: 'manual', epic: 'École' };
    const before = JSON.stringify(task);
    search.setQuery('preparer');
    for (const [filter, value] of [['status', 'blocked'], ['service', 'rag'], ['lane', 'api'], ['epic', 'Ecole']]) {
      search.state.filters[filter] = value;
      expect(search.matchesFilters(task)).toBe(false);
      search.state.filters[filter] = '';
    }
    expect(search.matchesFilters(task)).toBe(true);
    expect(JSON.stringify(task)).toBe(before);
  });
});
