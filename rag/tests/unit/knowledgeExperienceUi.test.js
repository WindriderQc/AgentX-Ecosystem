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
  const apiJs = read('public', 'js', 'api.js');
  const documentContext = read('public', 'js', 'document-context.js');
  const documentsJs = read('public', 'js', 'documents.js');
  const uploadJs = read('public', 'js', 'upload.js');
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

  test('gates search on the canonical overall and MongoDB readiness contract', () => {
    expect(searchJs).toContain('var overallOk = data.healthy === true');
    expect(searchJs).toContain('var mongoOk = !!(mongo && mongo.healthy)');
    expect(searchJs).toContain('if (!overallOk || !mongoOk || !vectorOk || !embeddingOk)');
    expect(searchJs).toContain('The document database is unavailable.');
  });

  test('communicates state with icons, labels and color-independent match names', () => {
    expect(dashboard).toContain('knowledge-home-readiness-label');
    expect(search).toContain('knowledge-search-readiness-label');
    expect(searchJs).toContain("label: 'Strong match'");
    expect(searchJs).toContain("label: 'Possible match'");
    expect(searchJs).toContain("label: 'Weak match'");
    expect(searchJs).not.toContain('scoreToColor');
  });

  test('reports idempotent ingestion as already indexed instead of adding a duplicate', () => {
    expect(uploadJs).toContain("d.unchanged === true");
    expect(uploadJs).toContain('Already indexed');
    expect(uploadJs).toContain('no duplicate was added');
  });

  test('rejects oversized text and invalid relational chunk overlap before ingestion', () => {
    expect(uploadJs).toContain('var MAX_TEXT_LENGTH = 2_000_000');
    expect(uploadJs).toContain('text.length > MAX_TEXT_LENGTH');
    expect(uploadJs).toContain('Number.isInteger(chunkSize)');
    expect(uploadJs).toContain('Number.isInteger(chunkOverlap)');
    expect(uploadJs).toContain('chunkOverlap > Math.floor(chunkSize / 2)');
    expect(uploadJs).toContain('Chunk overlap must not exceed half the chunk size');
  });

  test('hands exact bounded provenance from upload and search into the document browser', () => {
    expect(documentContext).toContain('MAX_CONTEXT_VALUE_LENGTH = 512');
    expect(uploadJs).toContain('documentContext.documentsHref');
    expect(searchJs).toContain('documentContext.documentsHref');
    expect(searchJs).toContain('Open exact source');
    expect(documentsJs).toContain('window.RAG.getDocument(context.docId)');
    expect(documentsJs).toContain('contextApi.matches(documentData, context)');
    expect(documentsJs).toContain("'Exact source filter active'");
  });

  test('focuses exact document hand-offs and exposes a recoverable not-found state', () => {
    expect(documents).toContain('id="context-not-found"');
    expect(documents).toContain('Browse all indexed documents');
    expect(documentsJs).toContain('await revealTargetDocument(context.docId)');
    expect(documentsJs).toContain("trigger.focus({ preventScroll: true })");
    expect(documentsJs).toContain("'Document not found'");
    expect(css).toContain('.doc-row.is-context-target');
  });

  test('names the inventory as documents while retaining source as provenance', () => {
    expect(documents).toContain('<h1 class="page-title">Indexed documents</h1>');
    expect(documents).toContain('documents shown</span>');
    expect(documents).toContain('passages shown</span>');
    expect(documents).toContain('<th>Source provenance</th>');
    expect(documents).not.toContain('<strong id="doc-count">--</strong> sources');
    expect(documentsJs).toContain("'Documents ready'");
    expect(documentsJs).toContain("' indexed document'");
  });

  test('requires an accessible exact full-ID confirmation before document deletion', () => {
    expect(documents).toContain('<dialog id="delete-document-dialog"');
    expect(documents).toContain('aria-labelledby="delete-document-title"');
    expect(documents).toContain('aria-describedby="delete-document-description"');
    expect(documents).toContain('id="delete-document-input"');
    expect(documents).toContain('id="delete-document-error"');
    expect(documents).toContain('id="delete-document-submit"');
    expect(documentsJs).toContain("return 'DELETE ' + documentId");
    expect(documentsJs).toContain('els.deleteDocumentId.textContent = documentData.documentId');
    expect(documentsJs).toContain("els.deleteSource.textContent = documentData.source || 'Unknown provenance'");
    expect(documentsJs).toContain('els.deleteInput.value === els.deleteExpected.textContent');
    expect(documentsJs).toContain('await window.RAG.deleteDocument(docId, confirmation)');
    expect(documentsJs).toContain('showDeleteReceipt(documentData)');
    expect(documentsJs).toContain('Other indexed documents may remain.');
    expect(documentsJs).toContain('showDeleteFailure(err, opener)');
    expect(documentsJs).toContain('The document remains indexed; use Delete to try again.');
    expect(documentsJs).not.toMatch(/\balert\s*\(/);
    expect(apiJs).toContain('body: JSON.stringify({ confirmation: confirmation })');
    expect(css).toContain('.delete-confirm-dialog::backdrop');
  });

  test('uses semantic buttons and expanded state for document chunk previews', () => {
    expect(documentsJs).toContain('<button type="button" class="chunk-text"');
    expect(documentsJs).toContain('aria-expanded="false"');
    expect(documentsJs).toContain("el.setAttribute('aria-expanded', expand ? 'true' : 'false')");
    expect(css).toMatch(/\.chunk-text\s*\{[^}]*display:\s*block;[^}]*width:\s*100%;[^}]*background:\s*transparent;/s);
  });

  test('labels ranked and reranked evidence without presenting every score as the same signal', () => {
    expect(searchJs).toContain("var judged = typeof result.llmScore === 'number'");
    expect(searchJs).toContain("'Judge relevance'");
    expect(searchJs).toContain("'Retrieval match'");
    expect(searchJs).toContain("Evidence ' + (index + 1) + ' of ' + results.length");
    expect(searchJs).toContain('Vector match');
  });

  test('preserves keyboard, narrow-screen and reduced-motion support', () => {
    expect(upload).toContain('role="tablist"');
    expect(upload).toContain('aria-selected="true"');
    expect(uploadJs).toContain("event.key === 'ArrowRight'");
    expect(search).toContain('aria-live="polite"');
    expect(searchJs).toContain("event.key === 'Enter'");
    expect(css).toContain('@media (max-width: 600px)');
    expect(css).toContain('@media (prefers-reduced-motion: reduce)');
    expect(css).toContain(':focus-visible');
  });
});
