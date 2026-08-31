'use strict';

const fs = require('fs');
const path = require('path');

const apiSource = fs.readFileSync(path.join(__dirname, '../../public/js/api.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(__dirname, '../../public/js/dashboard.js'), 'utf8');

describe('RAG dashboard status access', () => {
  test('polls observational status through GET', () => {
    expect(apiSource).toContain("async function getStatus() {\n    return apiFetch('/api/rag/status');");
    expect(dashboardSource).toContain('window.RAG.getStatus()');
  });

  test('keeps active refresh available only as a distinct operator action', () => {
    expect(apiSource).toContain('async function refreshStatus()');
    expect(apiSource).toContain("return apiFetch('/api/rag/status/refresh', { method: 'POST' });");
    expect(apiSource).toContain('refreshStatus: refreshStatus');
  });
});
