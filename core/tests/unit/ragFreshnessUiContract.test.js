'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '../..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const nerveSource = read('public/js/nerve-center-rag.js');
const analyticsSource = read('public/js/analytics-cost.js');
const proxy = read('routes/rag.js');
const view = read('views/pages/analytics.ejs');

describe('RAG corpus freshness is a separate fact from readiness', () => {
  test('Activity names the scope of Healthy and renders freshness from the service rule', () => {
    expect(analyticsSource).toContain('function ragFreshnessView(freshness)');
    expect(analyticsSource).toContain('readiness · corpus ${freshness.text}');
    expect(analyticsSource).toContain("text: 'freshness unknown'");
    expect(analyticsSource).toContain('elements.ragLastIngest.textContent = freshness.lastIngestText');
    // Freshness is never derived from the healthy flag.
    expect(analyticsSource).not.toMatch(/freshness[^\n]*data\.healthy === true/);
  });

  test('Nerve Center shows a Corpus Freshness card that is Unknown without ingest evidence', () => {
    expect(nerveSource).toContain('Corpus Freshness');
    expect(nerveSource).toContain("['fresh', 'stale', 'unknown'].includes(raw.state)");
    expect(nerveSource).toContain("return { state: 'unknown', label: 'Unknown'");
    expect(nerveSource).toContain('data-rag-freshness=');
  });

  test('metrics stay RAG-owned and freshness is read separately from status', () => {
    expect(proxy).toContain('data: await ragClient.getMetrics()');
    expect(analyticsSource).toContain("fetchJSON('/api/rag/status')");
    expect(proxy).not.toContain('sourceBreakdown');
  });

  test('the Activity view carries the last-ingest row and the two-fact tooltip', () => {
    expect(view).toContain('id="ragLastIngest"');
    expect(view).toContain('A healthy service never implies a fresh corpus');
  });
});
