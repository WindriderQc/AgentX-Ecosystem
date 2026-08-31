'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { validateActionReceipt } = require('./action-receipt');

const repoRoot = path.resolve(__dirname, '..');
const profile = String(process.env.AGENTX_E2E_PROFILE || 'demo').toLowerCase() === 'full' ? 'full' : 'demo';
const configuredRagUrl = process.env.AGENTX_E2E_RAG_URL;
const defaultRagUrl = 'http://127.0.0.1:3182';
const outputPath = path.resolve(__dirname, 'test-results', `agentx-browser-actions-rag-${profile}.json`);
const documentId = 'bounded-guide-v2';
const source = 'action-journey';
const subjectHash = crypto.createHash('sha256').update(documentId).digest('hex').slice(0, 12);
const longChunk = 'Evidence-backed interfaces preserve the user\'s context through a failed action. '.repeat(5);
const PROJECTS = Object.freeze([
  { name: 'desktop-chromium', viewport: { width: 1440, height: 900 } },
  { name: 'mobile-chromium', viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
]);

function json(route, status, body) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function probeProfile(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    if (response.status !== 200) return false;
    const observed = response.headers.get('x-agentx-profile');
    if (observed) return observed === profile;
    return (await response.text()).includes(`data-agentx-profile="${profile}"`);
  } catch {
    return false;
  }
}

async function startLocalFallback() {
  process.env.NODE_ENV = 'test';
  process.env.AGENTX_PROFILE = profile;
  process.env.VECTOR_STORE_TYPE = 'memory';
  const app = require('../rag/app');
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function resolveRagTarget() {
  const requested = configuredRagUrl || defaultRagUrl;
  if (await probeProfile(`${requested}/upload`)) return { url: requested, close: async () => {} };
  if (configuredRagUrl) throw new Error('Configured RAG surface is unavailable or has the wrong profile');
  return startLocalFallback();
}

async function waitForExactText(page, selector, expected) {
  await page.waitForFunction(
    ({ selector: target, expected: text }) => document.querySelector(target)?.textContent?.trim() === text,
    { selector, expected },
  );
}

async function observeProject(browser, targetUrl, project) {
  const context = await browser.newContext({
    viewport: project.viewport,
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    isMobile: project.isMobile || false,
    hasTouch: project.hasTouch || false,
  });
  const page = await context.newPage();
  const unexpectedApi = [];
  const pageErrors = [];
  const failedResources = [];
  let ingestAttempts = 0;
  let deleteAttempts = 0;
  let statusReads = 0;
  let documentPresent = false;

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedResources.push(request.resourceType()));
  await page.addInitScript(() => localStorage.clear());

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const parsed = new URL(request.url());
    const pathname = parsed.pathname;

    if (method === 'GET' && pathname === '/api/config') return json(route, 200, {});
    if (method === 'GET' && pathname === '/api/models/all') {
      return json(route, 200, { status: 'success', data: { models: [] } });
    }
    if (method === 'GET' && pathname === '/api/rag/status') {
      statusReads += 1;
      return json(route, 200, {
        ok: true,
        data: {
          healthy: true,
          documentCount: documentPresent ? 1 : 0,
          mongodb: { healthy: true },
          vectorStore: { healthy: true },
          embedding: { healthy: true },
        },
      });
    }
    if (method === 'POST' && pathname === '/api/rag/ingest') {
      ingestAttempts += 1;
      if (ingestAttempts === 1) {
        return json(route, 503, {
          ok: false,
          error: 'Embedding service is temporarily unavailable.',
          detail: 'No document was written.',
        });
      }
      documentPresent = true;
      return json(route, 201, {
        ok: true,
        data: { documentId, chunkCount: 1, status: 'created', unchanged: false },
      });
    }
    if (method === 'GET' && pathname === `/api/rag/documents/${documentId}`) {
      if (!documentPresent) return json(route, 404, { ok: false, error: 'Document not found' });
      return json(route, 200, {
        ok: true,
        data: { documentId, source, chunkCount: 1, metadata: { tags: ['bounded'] } },
      });
    }
    if (method === 'GET' && pathname === `/api/rag/documents/${documentId}/chunks`) {
      return json(route, 200, {
        ok: true,
        data: { chunks: [{ chunkIndex: 0, text: longChunk }] },
      });
    }
    if (method === 'GET' && pathname === '/api/rag/documents') {
      return json(route, 200, {
        ok: true,
        data: {
          documents: documentPresent ? [{ documentId, source, chunkCount: 1, tags: ['bounded'] }] : [],
          total: documentPresent ? 1 : 0,
          limit: 200,
          offset: 0,
        },
      });
    }
    if (method === 'DELETE' && pathname === `/api/rag/documents/${documentId}`) {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        return json(route, 503, {
          ok: false,
          error: 'Vector store acknowledgement is unavailable.',
          detail: 'The document remains indexed.',
        });
      }
      documentPresent = false;
      return json(route, 200, { ok: true, data: { documentId } });
    }

    unexpectedApi.push(`${method} ${pathname}`);
    return json(route, 501, { ok: false, error: 'Unexpected action fixture request' });
  });

  try {
    await page.goto(`${targetUrl}/upload`, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('body').getAttribute('data-agentx-profile'), profile);
    await page.locator('#paste-text').fill('A bounded source used to verify recoverable RAG actions.');
    await page.locator('#ingest-controls summary').click();
    await page.locator('#chunk-size').fill('100');
    await page.locator('#chunk-overlap').fill('100');
    await page.locator('#btn-ingest').click();
    await waitForExactText(page, '#ingest-status strong', 'Chunk overlap invalid');
    assert.equal(ingestAttempts, 0);
    assert.equal(await page.locator('#btn-ingest').isEnabled(), true);

    const phases = [{
      id: 'ingest_validation_rejected',
      control: { selector: '#btn-ingest', accessibleName: 'Add to Agent X' },
      request: null,
      uiMode: 'invalid-recoverable',
      invariants: { requestSuppressed: true, controlsPreserved: true },
      outcome: 'pass',
    }];

    await page.locator('#chunk-overlap').fill('50');
    await page.locator('#meta-source').fill(source);
    await page.locator('#meta-docid').fill(documentId);
    await page.locator('#btn-ingest').click();
    await waitForExactText(page, '#ingest-status strong', 'Ingestion failed');
    assert.equal(ingestAttempts, 1);
    assert.equal(await page.locator('#btn-ingest').isEnabled(), true);
    assert.match(await page.locator('#result-area').textContent(), /No document was written/);
    phases.push({
      id: 'ingest_failed',
      control: { selector: '#btn-ingest', accessibleName: 'Add to Agent X' },
      request: { method: 'POST', pathTemplate: '/api/rag/ingest', attempt: 1, httpStatus: 503 },
      uiMode: 'ingest-retryable-error',
      invariants: { retryEnabled: true, noWriteExplained: true },
      outcome: 'pass',
    });

    await page.locator('#btn-ingest').click();
    await waitForExactText(page, '#ingest-status strong', 'Knowledge added');
    assert.equal(ingestAttempts, 2);
    const sourceLink = page.locator('#result-area a', { hasText: 'View source' });
    await sourceLink.waitFor({ state: 'visible' });
    phases.push({
      id: 'ingest_acknowledged',
      control: { selector: '#btn-ingest', accessibleName: 'Add to Agent X' },
      request: { method: 'POST', pathTemplate: '/api/rag/ingest', attempt: 2, httpStatus: 201 },
      uiMode: 'ingest-complete',
      invariants: { exactSourceLinkVisible: true, exactlyTwoAttempts: true },
      outcome: 'pass',
    });

    await Promise.all([
      page.waitForURL(/\/documents\?/),
      sourceLink.click(),
    ]);
    await page.locator(`tr.doc-row[data-id="${documentId}"]`).waitFor({ state: 'visible' });
    const sourceTrigger = page.locator('.source-expand');
    await page.waitForFunction(() => document.querySelector('.source-expand')?.getAttribute('aria-expanded') === 'true');
    assert.equal(await sourceTrigger.getAttribute('aria-expanded'), 'true');
    phases.push({
      id: 'source_opened',
      control: { selector: '#result-area a', accessibleName: 'View source' },
      request: { method: 'GET', pathTemplate: '/api/rag/documents/:documentId', httpStatus: 200 },
      uiMode: 'exact-source-open',
      invariants: { exactIdentityMatched: true, chunksExpanded: true },
      outcome: 'pass',
    });

    const chunkButton = page.locator('button.chunk-text');
    await chunkButton.waitFor({ state: 'visible' });
    assert.equal(await chunkButton.getAttribute('aria-expanded'), 'false');
    await chunkButton.press('Space');
    assert.equal(await chunkButton.getAttribute('aria-expanded'), 'true');
    assert.equal((await chunkButton.textContent()).trim(), longChunk.trim());
    await chunkButton.press('Enter');
    assert.equal(await chunkButton.getAttribute('aria-expanded'), 'false');
    phases.push({
      id: 'chunk_keyboard_toggled',
      control: { selector: 'button.chunk-text', accessibleName: 'Chunk preview' },
      request: { method: 'GET', pathTemplate: '/api/rag/documents/:documentId/chunks', httpStatus: 200 },
      uiMode: 'chunk-preview',
      invariants: { nativeButton: true, enterAndSpaceWork: true, ariaSynchronized: true },
      outcome: 'pass',
    });

    const deleteButton = page.locator('.btn-delete');
    await deleteButton.click();
    await page.locator('#delete-document-input').fill(`DELETE ${documentId}`);
    await page.locator('#delete-document-submit').click();
    const deleteError = page.locator('#error-state');
    await deleteError.waitFor({ state: 'visible' });
    assert.match(await deleteError.textContent(), /document remains indexed; use Delete to try again/i);
    assert.equal(await page.locator(`tr.doc-row[data-id="${documentId}"]`).count(), 1);
    assert.equal(await page.evaluate(() => document.activeElement?.classList.contains('btn-delete')), true);
    phases.push({
      id: 'delete_failed',
      control: { selector: '.btn-delete', accessibleName: 'Delete' },
      request: { method: 'DELETE', pathTemplate: '/api/rag/documents/:documentId', attempt: 1, httpStatus: 503 },
      uiMode: 'delete-retryable-error',
      invariants: { rowPreserved: true, inlineAlertVisible: true, retryFocusRestored: true },
      outcome: 'pass',
    });

    await deleteButton.click();
    await page.locator('#delete-document-input').fill(`DELETE ${documentId}`);
    await page.locator('#delete-document-submit').click();
    await page.locator(`tr.doc-row[data-id="${documentId}"]`).waitFor({ state: 'detached' });
    await waitForExactText(page, '#documents-status strong', 'Document deleted');
    assert.equal(deleteAttempts, 2);
    phases.push({
      id: 'delete_acknowledged',
      control: { selector: '.btn-delete', accessibleName: 'Delete' },
      request: { method: 'DELETE', pathTemplate: '/api/rag/documents/:documentId', attempt: 2, httpStatus: 200 },
      uiMode: 'delete-complete',
      invariants: { rowRemoved: true, acknowledgementVisible: true, exactlyTwoAttempts: true },
      outcome: 'pass',
    });

    assert.deepEqual(unexpectedApi, []);
    assert.ok(statusReads >= 1, 'the dashboard must obtain RAG health through the read-only status route');
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(failedResources, []);
    return { project: project.name, viewport: project.viewport, phases };
  } finally {
    await context.close();
  }
}

async function main() {
  const target = await resolveRagTarget();
  const browser = await chromium.launch({ headless: true });
  try {
    const observations = [];
    for (const project of PROJECTS) observations.push(await observeProject(browser, target.url, project));
    const buildRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoRoot, encoding: 'utf8' }).trim();
    const receipt = {
      schemaVersion: 1,
      kind: 'agentx.browser-action-observation',
      generatedAt: new Date().toISOString(),
      status: 'pass',
      profile,
      buildRevision,
      serviceIdentity: { service: 'agentx-rag', version: require('../rag/package.json').version, surface: 'rag-upload' },
      journeyId: 'rag.ingest-delete-recovery',
      evidenceMode: 'deterministic-contract',
      fixtureContract: 'rag-ingest-delete-v1',
      subjectHash,
      dependencies: { embedding: 'contract-fixture', mongodb: 'not-used', qdrant: 'not-used', docker: 'not-required' },
      observations,
      summary: {
        expectedSteps: observations.length * 7,
        passed: observations.length * 7,
        failed: 0,
        missing: 0,
      },
      limitations: ['Proves browser and API-contract behavior; it does not exercise a live embedding or vector-store process.'],
      privacy: {
        addressesIncluded: false,
        rawResponsesIncluded: false,
        subjectIdentifiersIncluded: false,
        secretsIncluded: false,
      },
    };
    assert.deepEqual(validateActionReceipt(receipt), []);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
    process.stdout.write(`Action journey passed: ${receipt.journeyId} (${observations.length} projects)\n`);
    process.stdout.write(`Receipt: ${path.relative(repoRoot, outputPath)}\n`);
  } finally {
    await browser.close();
    await target.close();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
