'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../public/js/analytics-cost.js'), 'utf8');
const renderer = source.slice(source.indexOf('function ragFreshnessView('), source.indexOf('async function refreshAll()'));

function page(metrics, health) {
  const elements = Object.fromEntries(['ragEmpty', 'ragTotalDocs', 'ragTotalChunks', 'ragAvgChunks',
    'ragHealth', 'ragLastIngest', 'ragSourcesBody', 'ragOldest', 'ragNewest'].map(key => [key,
    { style: {}, dataset: {}, textContent: '', innerHTML: '' }]));
  const fetchJSON = jest.fn(url => {
    const value = url.endsWith('/metrics') ? metrics : health;
    return value instanceof Error ? Promise.reject(value) : Promise.resolve({ data: value });
  });
  const refresh = vm.runInNewContext(`${renderer}\nrefreshRagMetrics`, { elements, fetchJSON,
    formatNumber: String, escapeHtml: String, console: { error: jest.fn() },
    document: { getElementById: () => null } });
  return { elements, refresh, fetchJSON };
}

test('renders owner totals above 200 while readiness can be unavailable', async () => {
  const p = page({ totals: { documents: 351, chunks: 1053 },
    bySource: [{ source: 'corpus', documents: 351, chunks: 1053 }] }, new Error('health unavailable'));
  await p.refresh();
  expect(p.elements.ragTotalDocs.textContent).toBe('351');
  expect(p.elements.ragSourcesBody.innerHTML).toContain('1053');
  expect(p.elements.ragHealth.innerHTML).toContain('Unknown');
  expect(p.fetchJSON.mock.calls.map(([url]) => url)).toEqual(['/api/rag/metrics', '/api/rag/status']);
});

test('a metrics failure does not overwrite independently observed readiness', async () => {
  const p = page(new Error('metrics unavailable'), { healthy: true });
  await p.refresh();
  expect(p.elements.ragTotalDocs.textContent).toBe('Error');
  expect(p.elements.ragHealth.innerHTML).toContain('Healthy');
});

test('unknown owner totals and chunk evidence remain unknown instead of zero', async () => {
  const p = page({ totals: { documents: null, chunks: null },
    bySource: [{ source: 'incomplete', documents: 1, chunks: null }] }, { healthy: false });
  await p.refresh();
  expect(p.elements.ragTotalDocs.textContent).toBe('—');
  expect(p.elements.ragAvgChunks.textContent).toBe('—');
  expect(p.elements.ragSourcesBody.innerHTML).not.toContain('NaN');
  expect(p.elements.ragHealth.innerHTML).toContain('Unhealthy');
});
