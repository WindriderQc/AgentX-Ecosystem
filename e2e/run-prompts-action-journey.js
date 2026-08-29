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
const configuredCoreUrl = process.env.AGENTX_E2E_CORE_URL;
const defaultCoreUrl = 'http://127.0.0.1:3180';
const outputPath = path.resolve(__dirname, 'test-results', `agentx-browser-actions-prompts-${profile}.json`);
const promptName = 'quality_review';
const subjectHash = crypto.createHash('sha256').update(promptName).digest('hex').slice(0, 12);
const updatedSystemPrompt = 'Review the supplied evidence, identify uncertainty, and return a bounded recommendation.';
const PROJECTS = Object.freeze([
  { name: 'desktop-chromium', viewport: { width: 1440, height: 900 } },
  { name: 'mobile-chromium', viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
]);

function prompt(version, overrides = {}) {
  return {
    _id: `fixture-prompt-${version}`,
    name: promptName,
    version,
    systemPrompt: version === 1 ? 'Review the evidence and report material gaps.' : updatedSystemPrompt,
    description: 'Evidence quality reviewer',
    isActive: version === 1,
    trafficWeight: 100,
    stats: { impressions: 4, positiveCount: 2, negativeCount: 0 },
    disposition: { selectable: true },
    ...overrides,
  };
}

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
  const { app } = require('../core/src/app');
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  try {
    const warmup = await fetch(`${url}/prompts`, { signal: AbortSignal.timeout(10_000) });
    if (!warmup.ok) throw new Error(`HTTP ${warmup.status}`);
    await warmup.arrayBuffer();
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error(`Local Core action surface did not become ready: ${error.message}`);
  }
  return {
    url,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function resolveCoreTarget() {
  const requested = configuredCoreUrl || defaultCoreUrl;
  if (await probeProfile(`${requested}/prompts`)) return { url: requested, close: async () => {} };
  if (configuredCoreUrl) throw new Error('Configured Core surface is unavailable or has the wrong profile');
  return startLocalFallback();
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
  const postBodies = [];
  let saveAttempts = 0;
  let versions = [prompt(1)];

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedResources.push(request.resourceType()));
  await page.addInitScript(() => localStorage.clear());

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const pathname = new URL(request.url()).pathname;

    if (method === 'GET' && pathname === '/api/config') return json(route, 200, {});
    if (method === 'GET' && pathname === '/api/models/all') {
      return json(route, 200, { status: 'success', data: { models: [] } });
    }
    if (method === 'GET' && pathname === '/api/prompts') {
      return json(route, 200, { status: 'success', data: { [promptName]: versions } });
    }
    if (method === 'POST' && pathname === '/api/prompts') {
      saveAttempts += 1;
      postBodies.push(request.postDataJSON());
      if (saveAttempts === 1) {
        return json(route, 409, {
          status: 'error',
          message: 'Could not allocate a prompt version because of concurrent updates. Please retry.',
        });
      }
      const created = prompt(2, {
        systemPrompt: postBodies[1].systemPrompt,
        description: postBodies[1].description,
        isActive: postBodies[1].isActive,
        trafficWeight: postBodies[1].trafficWeight,
      });
      versions = [created, versions[0]];
      return json(route, 201, { status: 'success', data: created });
    }

    unexpectedApi.push(`${method} ${pathname}`);
    return json(route, 501, { status: 'error', message: 'Unexpected action fixture request' });
  });

  try {
    await page.goto(`${targetUrl}/prompts`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(await page.locator('body').getAttribute('data-agentx-profile'), profile);
    await page.locator('.prompt-card').waitFor({ state: 'visible' });
    assert.equal((await page.locator('.prompt-name').textContent()).trim(), promptName);
    assert.equal((await page.locator('.version-number').first().textContent()).trim(), 'v1');

    const phases = [{
      id: 'revision_loaded',
      request: { method: 'GET', pathTemplate: '/api/prompts', httpStatus: 200 },
      uiMode: 'library-ready',
      invariants: { exactNameVisible: true, exactVersionVisible: true },
      outcome: 'pass',
    }];

    await page.locator(`[data-action="new-version"][data-prompt-name="${promptName}"]`).first().click();
    const modal = page.locator('#promptEditorModal');
    await modal.waitFor({ state: 'visible' });
    assert.equal((await page.locator('#promptEditorTitle').textContent()).trim(), `Create ${promptName} v2`);
    await page.locator('#systemPromptInput').fill('   ');
    await page.locator('#promptEditorSaveBtn').click();
    const editorError = page.locator('#promptEditorError');
    await editorError.waitFor({ state: 'visible' });
    assert.equal((await editorError.textContent()).trim(), 'System prompt text is required.');
    assert.equal(saveAttempts, 0);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'systemPromptInput');
    phases.push({
      id: 'validation_rejected',
      control: { selector: '#promptEditorSaveBtn', accessibleName: 'Save new version' },
      request: null,
      uiMode: 'editor-validation-error',
      invariants: { requestSuppressed: true, editorPreserved: true, invalidFieldFocused: true },
      outcome: 'pass',
    });

    await page.locator('#systemPromptInput').fill(updatedSystemPrompt);
    await page.locator('#promptEditorSaveBtn').click();
    await editorError.waitFor({ state: 'visible' });
    await page.waitForFunction(() => (
      document.getElementById('promptEditorError')?.textContent?.includes('concurrent updates')
    ));
    assert.equal(saveAttempts, 1);
    assert.equal(await modal.isVisible(), true);
    assert.equal(await page.locator('#promptEditorSaveBtn').isEnabled(), true);
    phases.push({
      id: 'save_conflict',
      control: { selector: '#promptEditorSaveBtn', accessibleName: 'Save new version' },
      request: { method: 'POST', pathTemplate: '/api/prompts', attempt: 1, httpStatus: 409 },
      uiMode: 'save-retryable-conflict',
      invariants: { editorPreserved: true, recoveryMessageVisible: true, retryEnabled: true },
      outcome: 'pass',
    });

    await page.locator('#promptEditorSaveBtn').click();
    await modal.waitFor({ state: 'hidden' });
    assert.equal(saveAttempts, 2);
    assert.deepEqual(postBodies[1], {
      name: promptName,
      systemPrompt: updatedSystemPrompt,
      description: 'Evidence quality reviewer',
      isActive: false,
      trafficWeight: 100,
    });
    phases.push({
      id: 'save_acknowledged',
      control: { selector: '#promptEditorSaveBtn', accessibleName: 'Save new version' },
      request: { method: 'POST', pathTemplate: '/api/prompts', attempt: 2, httpStatus: 201 },
      uiMode: 'save-complete',
      invariants: { exactPayloadSubmitted: true, exactlyTwoAttempts: true },
      outcome: 'pass',
    });

    await page.waitForFunction(() => document.querySelector('.version-number')?.textContent?.trim() === 'v2');
    const versionNumbers = await page.locator('.version-number').allTextContents();
    assert.deepEqual(versionNumbers.map((value) => value.trim()), ['v2', 'v1']);
    const exactRunHref = await page.locator('.prompt-version-run').first().getAttribute('href');
    assert.equal(exactRunHref, `/playground?persona=${promptName}&promptVersion=2`);
    phases.push({
      id: 'revision_reloaded',
      request: { method: 'GET', pathTemplate: '/api/prompts', httpStatus: 200 },
      uiMode: 'library-reloaded',
      invariants: { serverAssignedVersionFirst: true, priorVersionPreserved: true, exactRunLinkUpdated: true },
      outcome: 'pass',
    });

    assert.deepEqual(unexpectedApi, []);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(failedResources, []);
    return { project: project.name, viewport: project.viewport, phases };
  } finally {
    await context.close();
  }
}

async function main() {
  const target = await resolveCoreTarget();
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
      serviceIdentity: { service: 'agentx-core', version: require('../core/package.json').version, surface: 'core-prompts' },
      journeyId: 'prompts.validation-save-reload',
      evidenceMode: 'deterministic-contract',
      fixtureContract: 'prompt-version-write-v1',
      subjectHash,
      dependencies: { mongodb: 'contract-fixture', ollama: 'not-used', docker: 'not-required' },
      observations,
      summary: {
        expectedSteps: observations.length * 5,
        passed: observations.length * 5,
        failed: 0,
        missing: 0,
      },
      limitations: ['Proves browser and API-contract behavior; the server race algorithm is exercised separately with deterministic route tests.'],
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
