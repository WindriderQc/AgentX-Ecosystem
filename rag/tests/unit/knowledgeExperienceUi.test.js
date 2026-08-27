const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..', '..');
const read = (...segments) => fs.readFileSync(path.join(root, ...segments), 'utf8');

describe('Agent X Knowledge progressive-disclosure experience', () => {
  const workflow = read('views', 'partials', 'workflow-map.ejs');
  const dashboard = read('views', 'pages', 'dashboard.ejs');
  const upload = read('views', 'pages', 'upload.ejs');
  const search = read('views', 'pages', 'search.ejs');
  const documents = read('views', 'pages', 'documents.ejs');
  const css = read('public', 'css', 'style.css');
  const searchJs = read('public', 'js', 'search.js');

  test('presents one stable human journey across every knowledge page', () => {
    expect(workflow).toContain('Add knowledge');
    expect(workflow).toContain('Ask your knowledge');
    expect(workflow).toContain('Browse sources');
    expect(workflow).toContain('aria-label="Knowledge journey"');
    expect([dashboard, upload, search, documents].every(page => page.includes("include('../partials/workflow-map')"))).toBe(true);
  });

  test('keeps operator depth behind a consistent cockpit door', () => {
    expect(workflow).toContain('Open instruments');
    expect(dashboard).toContain('<strong>Take the controls</strong>');
    expect(upload).toContain('id="ingest-controls"');
    expect(search).toContain('id="retrieval-controls"');
    expect(dashboard).toMatch(/<details class="expert-cockpit"/);
    expect(upload).toMatch(/<details class="expert-cockpit compact-cockpit"/);
    expect(search).toMatch(/<details class="expert-cockpit compact-cockpit"/);
  });

  test('keeps technical ingestion and retrieval parameters off the simple surface', () => {
    const simpleUpload = upload.split('id="ingest-controls"')[0];
    const simpleSearch = search.split('id="retrieval-controls"')[0];
    expect(simpleUpload).not.toMatch(/chunk-size|chunk-overlap|Document ID/);
    expect(simpleSearch).not.toMatch(/topk-slider|minscore-slider|Query expansion/);
  });

  test('makes empty and blocked states actionable in plain language', () => {
    const empty = read('views', 'partials', 'empty-index-banner.ejs');
    expect(empty).toContain('Your knowledge is empty');
    expect(empty).toContain('href="/upload"');
    expect(search).toContain('id="search-prerequisite-action"');
    expect(searchJs).toContain("setReadiness('warn', 'Add a source first'");
    expect(searchJs).toContain("setReadiness('error', 'Search needs attention'");
  });

  test('communicates state with icons, labels and color-independent match names', () => {
    expect(dashboard).toContain('knowledge-home-readiness-label');
    expect(search).toContain('knowledge-search-readiness-label');
    expect(searchJs).toContain("label: 'Strong match'");
    expect(searchJs).toContain("label: 'Possible match'");
    expect(searchJs).toContain("label: 'Weak match'");
    expect(searchJs).not.toContain('scoreToColor');
  });

  test('preserves keyboard, narrow-screen and reduced-motion support', () => {
    expect(upload).toContain('role="tablist"');
    expect(upload).toContain('aria-selected="true"');
    expect(read('public', 'js', 'upload.js')).toContain("event.key === 'ArrowRight'");
    expect(search).toContain('aria-live="polite"');
    expect(searchJs).toContain("event.key === 'Enter'");
    expect(css).toContain('@media (max-width: 600px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
  });
});
