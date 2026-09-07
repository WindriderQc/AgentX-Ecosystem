'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const documentContext = require('../../public/js/document-context');

// Event-level controller tests. Actual layout and keyboard behavior are checked
// in a browser; this small DOM stand-in exercises requests and state transitions.
class Element {
  constructor() {
    Object.assign(this, { value: '', hidden: false, disabled: false, dataset: {}, children: [], listeners: {}, selectors: {} });
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  set innerHTML(value) { this.html = value; this.children = []; }
  get innerHTML() { return this.html || ''; }
  get options() { return this.children; }
  addEventListener(event, fn) { this.listeners[event] = fn; }
  fire(event, data = {}) { return this.listeners[event]?.({ currentTarget: this, target: this, preventDefault() {}, stopPropagation() {}, ...data }); }
  appendChild(child) { child.parent = this; this.children.push(child); return child; }
  querySelector(selector) { return this.selectors[selector] ||= new Element(); }
  querySelectorAll(selector) { return this.children.filter(child => child.className === selector.slice(1)); }
  setAttribute(name, value) { this[name] = value; }
  focus() { this.focused = true; }
  scrollIntoView() {}
  remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
}

function loadPage(script, api) {
  const elements = new Map();
  let initialize;
  const document = {
    addEventListener: (_event, fn) => { initialize = fn; },
    getElementById: id => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id);
    },
    querySelectorAll: () => [],
    createElement: () => new Element(),
    contains: () => true
  };
  const window = {
    RAG: { getStatus: async () => ({ data: { documentCount: 205 } }), ...api },
    RAGDocumentContext: documentContext,
    location: { search: '' }, history: { replaceState() {} },
    prompt: () => 'DELETE doc-0'
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../public/js', script), 'utf8'), {
    window, document, URLSearchParams, performance, Event
  });
  initialize();
  return { el: id => document.getElementById(id), window };
}

const flush = () => new Promise(setImmediate);
const docs = (count, start = 0) => Array.from({ length: count }, (_, n) => ({ documentId: 'doc-' + (start + n), source: 'guide', chunkCount: 1 }));
const ready = { data: { healthy: true, documentCount: 1, vectorStore: { healthy: true }, dependencies: { mongodb: { healthy: true }, embedding: { healthy: true } } } };

test('readiness can recover in place while preserving the question and filters', async () => {
  const refreshStatus = jest.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(ready);
  const search = jest.fn().mockResolvedValue({ data: { results: [] } });
  const { el } = loadPage('search.js', { refreshStatus, search });
  await flush();
  expect(el('btn-recheck-search').hidden).toBe(false);
  expect(el('search-query').disabled).toBe(false);
  el('search-query').value = 'Who owns the checklist?';
  el('search-source').value = 'guide';
  el('search-tags').value = 'launch';
  el('topk-slider').value = '5';
  el('minscore-slider').value = '0';
  await el('btn-recheck-search').fire('click');
  expect(el('search-query').value).toBe('Who owns the checklist?');
  expect(el('search-source').value).toBe('guide');
  expect(el('btn-search').disabled).toBe(false);
  await el('btn-search').fire('click');
  expect(search).toHaveBeenCalledWith('Who owns the checklist?', 5, 0, { source: 'guide', tags: ['launch'] }, expect.any(Object));
});

test('waiting for a question is idle, and editing during a search cannot enable duplicate submission', async () => {
  let completeSearch;
  const search = jest.fn(() => new Promise(resolve => { completeSearch = resolve; }));
  const { el } = loadPage('search.js', { refreshStatus: async () => ready, search });
  await flush();
  expect(el('search-status').className).toBe('flow-status is-idle');
  el('search-query').value = 'First question';
  el('search-query').fire('input');
  const running = el('btn-search').fire('click');
  el('search-query').value = 'Edited question';
  el('search-query').fire('input');
  expect(el('btn-search').disabled).toBe(true);
  await el('btn-search').fire('click');
  expect(search).toHaveBeenCalledTimes(1);
  completeSearch({ data: { results: [] } });
  await running;
  expect(el('btn-search').disabled).toBe(false);
});

test('load more reaches documents after the first 200 and retries the same offset after failure', async () => {
  const getDocuments = jest.fn()
    .mockResolvedValueOnce({ data: { documents: docs(200), total: 205 } })
    .mockRejectedValueOnce(new Error('Temporary failure'))
    .mockResolvedValueOnce({ data: { documents: docs(5, 200), total: 205 } });
  const { el } = loadPage('documents.js', { getDocuments });
  await flush();
  expect(el('documents-page-summary').textContent).toBe('200 of 205 documents loaded');
  el('btn-more-documents').fire('click');
  await flush();
  expect(el('doc-tbody').children).toHaveLength(200);
  expect(el('doc-table').hidden).toBe(false);
  expect(el('btn-more-documents').disabled).toBe(false);
  el('btn-more-documents').fire('click');
  await flush();
  expect(getDocuments.mock.calls.slice(1).map(([params]) => params.offset)).toEqual([200, 200]);
  expect(el('doc-tbody').children).toHaveLength(205);
  expect(el('doc-tbody').children[200].querySelector('.source-expand').focused).toBe(true);
  expect(el('documents-pagination').hidden).toBe(true);
});

test('filter changes discard a late previous page and keep filters on subsequent requests', async () => {
  let completeOldPage;
  const getDocuments = jest.fn()
    .mockResolvedValueOnce({ data: { documents: docs(200), total: 205 } })
    .mockImplementationOnce(() => new Promise(resolve => { completeOldPage = resolve; }))
    .mockResolvedValueOnce({ data: { documents: docs(200, 500), total: 201 } })
    .mockResolvedValueOnce({ data: { documents: docs(1, 700), total: 201 } });
  const { el } = loadPage('documents.js', { getDocuments });
  await flush();
  el('btn-more-documents').fire('click');
  el('filter-source').value = 'guide';
  el('filter-tags').value = 'launch';
  el('btn-apply').fire('click');
  await flush();
  completeOldPage({ data: { documents: docs(5, 200), total: 205 } });
  await flush();
  expect(el('doc-tbody').children[0].dataset.id).toBe('doc-500');
  expect(el('doc-tbody').children).toHaveLength(200);
  el('btn-more-documents').fire('click');
  await flush();
  expect(getDocuments).toHaveBeenLastCalledWith({ limit: 200, offset: 200, source: 'guide', tags: 'launch' });
  expect(el('doc-tbody').children).toHaveLength(201);
});

test('deleting a loaded document adjusts the next offset so the following document is not skipped', async () => {
  const getDocuments = jest.fn()
    .mockResolvedValueOnce({ data: { documents: docs(200), total: 201 } })
    .mockResolvedValueOnce({ data: { documents: docs(1, 200), total: 200 } });
  const deleteDocument = jest.fn().mockResolvedValue({ ok: true });
  const { el } = loadPage('documents.js', { getDocuments, deleteDocument });
  await flush();
  el('doc-tbody').children[0].querySelector('.btn-delete').fire('click');
  await flush();
  expect(deleteDocument).toHaveBeenCalledWith('doc-0', 'DELETE doc-0');
  el('btn-more-documents').fire('click');
  await flush();
  expect(getDocuments).toHaveBeenLastCalledWith({ limit: 200, offset: 199 });
  expect(el('doc-tbody').children.at(-1).dataset.id).toBe('doc-200');
});
