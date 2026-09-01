'use strict';

const fs = require('fs');
const path = require('path');

const apiSource = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');
const searchSource = fs.readFileSync(path.join(__dirname, '../../public/js/search.js'), 'utf8');

describe('RAG dashboard status access', () => {
  test('polls observational status through GET', () => {
    expect(apiSource).toMatch(/async function getStatus\(\)\s*\{\s*return apiFetch\('\/api\/rag\/status'\);/);
    expect(dashboardSource).toContain('window.RAG.getStatus()');
  });

  test('keeps active refresh available only as a distinct operator action', () => {
    expect(apiSource).toContain('async function refreshStatus()');
    expect(apiSource).toContain("return apiFetch('/api/rag/status/refresh', { method: 'POST' });");
    expect(apiSource).toContain('refreshStatus: refreshStatus');
    expect(searchSource).toContain('window.RAG.refreshStatus()');
    expect(searchSource).not.toContain('window.RAG.getStatus()');
  });

  test('surfaces both standalone and Core proxy error envelopes', () => {
    expect(apiSource).toContain("!res.ok || body.ok === false || body.status === 'error'");
    expect(apiSource).toContain("body.error || body.message || ('Request failed (' + res.status + ')')");
  });

  test('shows the concrete search error only once', () => {
    expect(searchSource).toContain("els.error.textContent = 'Search failed: ' + (error.message || 'unknown error')");
    expect(searchSource).toContain("setSearchStatus('error', 'Search failed', 'Review the error above, then try again.')");
  });
});
