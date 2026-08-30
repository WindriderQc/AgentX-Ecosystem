'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const nerveSource = fs.readFileSync(path.join(root, 'public/js/nerve-center-rag.js'), 'utf8');
const analyticsSource = fs.readFileSync(path.join(root, 'public/js/analytics-cost.js'), 'utf8');

describe('RAG health UI truthfulness', () => {
  test('renders Qdrant, query readiness, unknown and observation time separately', () => {
    expect(nerveSource).toContain('Query Readiness');
    expect(nerveSource).toContain("const qdrant = deps.qdrant");
    expect(nerveSource).toContain("'Unknown'");
    expect(nerveSource).toContain('observedAt');
    expect(nerveSource).not.toContain('dep.healthy !== false');
  });

  test('does not fabricate cache zeros when cache evidence is absent', () => {
    expect(nerveSource).toContain('cacheEvidenceKnown');
    expect(nerveSource).toContain("const metricText = value => value === null || value === undefined ? '—' : value");
    expect(nerveSource).not.toContain('cache.size ?? 0');
    expect(nerveSource).not.toContain('cache.hits ?? 0');
  });

  test('keeps unknown analytics metrics and health explicit', () => {
    expect(analyticsSource).toContain("stats.totalDocuments == null ? '—'");
    expect(analyticsSource).toContain("stats.totalChunks == null ? '—'");
    expect(analyticsSource).toContain("label: 'Unknown'");
    expect(analyticsSource).not.toContain('formatNumber(stats.totalDocuments || 0)');
  });
});
