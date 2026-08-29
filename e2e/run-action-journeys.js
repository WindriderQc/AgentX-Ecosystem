'use strict';

const assert = require('assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');
const { validateActionReceipt } = require('./action-receipt');
const { describeRequestFailure } = require('./request-failure');

const repoRoot = path.resolve(__dirname, '..');
const profile = String(process.env.AGENTX_E2E_PROFILE || 'demo').toLowerCase() === 'full' ? 'full' : 'demo';
const configuredBenchmarkUrl = process.env.AGENTX_E2E_BENCHMARK_URL;
const defaultBenchmarkUrl = 'http://127.0.0.1:3181';
const outputPath = path.resolve(__dirname, 'test-results', `agentx-browser-actions-${profile}.json`);
const batchId = '68b1f9cfe59a1f0112345678';
const subjectHash = crypto.createHash('sha256').update(batchId).digest('hex').slice(0, 12);
const ACTIVE = Object.freeze({
  _id: batchId,
  status: 'running',
  run_name: 'Bounded stop fixture',
  started_at: '2026-08-28T00:00:00.000Z',
  host_name: 'Fixture host',
  models: ['fixture-model:7b'],
  levels: [1],
  total_tests: 2,
  completed: 1,
  current_test: {
    stage: 'executing',
    phase: 'executing',
    phase_detail: 'Generating fixture test 2 of 2',
  },
  judge_config: { model: 'fixture-judge:7b' },
  judge_stats: { completed: 1, total: 2, pending: 1 },
  results: [],
});
const PROJECTS = Object.freeze([
  { name: 'desktop-chromium', viewport: { width: 1440, height: 900 } },
  { name: 'mobile-chromium', viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
]);

function json(route, status, body, headers = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  });
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
  process.env.OLLAMA_HOST = process.env.OLLAMA_HOST || 'http://127.0.0.1:11434';
  const app = require('../benchmark/server');
  const server = await new Promise((resolve, reject) => {
    const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
    candidate.once('error', reject);
  });
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function resolveBenchmarkTarget() {
  const requested = configuredBenchmarkUrl || defaultBenchmarkUrl;
  if (await probeProfile(requested)) return { url: requested, close: async () => {} };
  if (configuredBenchmarkUrl) throw new Error('Configured Benchmark surface is unavailable or has the wrong profile');
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
  let stopAttempts = 0;
  let active = true;

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedResources.push(describeRequestFailure(request)));
  await page.addInitScript(() => {
    Object.defineProperty(window, 'EventSource', { configurable: true, value: undefined });
    localStorage.clear();
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const parsed = new URL(request.url());
    const pathname = parsed.pathname;

    if (method === 'GET' && pathname === '/api/config') return json(route, 200, {});
    if (method === 'GET' && pathname === '/api/ollama-hosts') {
      return json(route, 200, {
        hosts: [{ name: 'Fixture host', available: true, models: ['fixture-model:7b'] }],
        judgeConfig: { model: 'fixture-judge:7b' },
      });
    }
    if (method === 'GET' && pathname === '/api/profiler/hosts') {
      return json(route, 200, { status: 'success', data: [{
        hostId: 'fixture-host',
        hostUrl: 'http://fixture.invalid:11434',
        displayName: 'Fixture host',
        status: 'online',
        baseline: { testedAt: '2026-08-28T00:00:00.000Z' },
        models: ['fixture-model:7b'],
      }] });
    }
    if (method === 'GET' && pathname === '/api/profiler/models') {
      return json(route, 200, { status: 'success', data: [] });
    }
    if (method === 'GET' && pathname === '/api/profiler/dashboard') {
      return json(route, 200, { status: 'success', data: { benchmarkedModels: [] } });
    }
    if (method === 'GET' && (pathname === '/api/profiler/pipeline/profile/active'
        || pathname === '/api/profiler/pipeline/profile-host/active')) {
      return json(route, 200, { status: 'success', data: { active: [] } });
    }
    if (method === 'POST' && /^\/api\/profiler\/hosts\/[^/]+\/status\/refresh$/.test(pathname)) {
      return json(route, 200, { status: 'success', data: { status: 'online', models: ['fixture-model:7b'] } });
    }
    if (method === 'GET' && pathname === '/api/benchmark/batches/active') {
      return json(route, 200, { status: 'success', data: active ? [ACTIVE] : [] });
    }
    if (method === 'GET' && pathname === `/api/benchmark/batch/${batchId}`) {
      return json(route, 200, { status: 'success', data: ACTIVE });
    }
    if (method === 'GET' && pathname === `/api/benchmark/batch/${batchId}/timeline`) {
      return json(route, 200, { status: 'success', data: { batch_id: batchId, timeline: [], summary: { total_events: 0 } } });
    }
    if (method === 'POST' && pathname === `/api/benchmark/batch/${batchId}/stop`) {
      stopAttempts += 1;
      if (stopAttempts === 1) {
        return json(route, 500, { status: 'error', error: 'Fixture stop acknowledgement unavailable' });
      }
      active = false;
      return json(route, 200, {
        status: 'success',
        message: 'Batch stopped',
        data: {
          batch_id: batchId,
          status: 'stopped',
          already_stopped: false,
          claim_release_started: false,
          claim_release_hosts: [],
        },
      });
    }
    if (method === 'GET' && pathname === '/api/benchmark/judge/readiness') {
      return json(route, 200, { status: 'success', data: { ready: true, summary: 'Fixture judge ready' } });
    }
    if (method === 'GET' && pathname === '/api/benchmark/judge-roster') {
      return json(route, 200, { status: 'success', data: { judges: [] } });
    }
    if (method === 'GET' && pathname === '/api/benchmark/prompts') {
      return json(route, 200, { status: 'success', data: { prompts: [] } });
    }
    if (method === 'GET' && pathname === '/api/benchmark/config') {
      return json(route, 200, { status: 'success', data: { judge_config: { model: 'fixture-judge:7b' } } });
    }
    if (method === 'GET' && pathname === '/api/benchmark/batches') {
      return json(route, 200, { status: 'success', data: { batches: [], total: 0 } });
    }

    unexpectedApi.push(`${method} ${pathname}`);
    return json(route, 501, { status: 'error', code: 'UNEXPECTED_ACTION_FIXTURE_REQUEST' });
  });

  try {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.body.classList.contains('state-live'));
    await page.waitForFunction(() => document.getElementById('benchmark-cockpit')?.open === true);
    await page.locator('#az-live').waitFor({ state: 'visible' });
    await page.locator('#live-sections').waitFor({ state: 'visible' });
    await waitForExactText(page, '#prompt-counter', '1 / 2 tests');
    await waitForExactText(page, '#evaluation-readiness-label', 'Comparison in progress');
    await waitForExactText(page, '#evaluation-primary-label', 'View live comparison');
    assert.equal(await page.locator('body').getAttribute('data-agentx-profile'), profile);
    assert.equal(await page.locator('#btn-stop').isEnabled(), true);

    const phases = [{
      id: 'active_observed',
      control: { selector: '#btn-stop', accessibleName: 'Stop' },
      request: { method: 'GET', pathTemplate: '/api/benchmark/batches/active', httpStatus: 200 },
      semanticBatchStatus: 'running',
      uiMode: 'live',
      invariants: { cockpitOpen: true, progressVisible: true, heroAgrees: true },
      outcome: 'pass',
    }];

    await page.locator('#btn-stop').click();
    await page.waitForFunction(() => document.getElementById('btn-stop')?.dataset.stopState === 'failed');
    const failureBanner = page.locator('.r-fatal-error[role="alert"]');
    await failureBanner.waitFor({ state: 'visible' });
    assert.match(await failureBanner.textContent(), /Fixture stop acknowledgement unavailable/);
    assert.equal(stopAttempts, 1);
    assert.equal(await page.locator('body').evaluate((body) => body.classList.contains('state-live')), true);
    assert.equal(await page.locator('#live-sections').isVisible(), true);
    assert.equal(await page.locator('#btn-stop').isEnabled(), true);
    assert.equal((await page.locator('#btn-stop').textContent()).trim(), 'Retry stop');
    phases.push({
      id: 'stop_failed',
      control: { selector: '#btn-stop', accessibleName: 'Stop' },
      request: { method: 'POST', pathTemplate: '/api/benchmark/batch/:id/stop', attempt: 1, httpStatus: 500 },
      semanticBatchStatus: 'running',
      uiMode: 'live-retryable-error',
      invariants: { pollingPreserved: true, liveContextPreserved: true, retryEnabled: true },
      outcome: 'pass',
    });

    await page.locator('#btn-stop').click();
    await page.waitForFunction(() => !document.body.classList.contains('state-live'));
    await page.locator('.ax-toast--success').waitFor({ state: 'visible' });
    assert.equal(stopAttempts, 2);
    assert.match(await page.locator('.ax-toast--success').textContent(), /Batch stopped/);
    phases.push({
      id: 'stop_acknowledged',
      control: { selector: '#btn-stop', accessibleName: 'Retry stop' },
      request: { method: 'POST', pathTemplate: '/api/benchmark/batch/:id/stop', attempt: 2, httpStatus: 200 },
      semanticBatchStatus: 'stopped',
      uiMode: 'transitioning-to-idle',
      invariants: { acknowledgementVisible: true, exactlyTwoAttempts: true },
      outcome: 'pass',
    });

    await page.locator('#az-idle').waitFor({ state: 'visible' });
    await page.locator('#live-sections').waitFor({ state: 'hidden' });
    await page.locator('#evaluation-refresh').click();
    await waitForExactText(page, '#evaluation-readiness-label', 'Ready to compare');
    phases.push({
      id: 'idle_recovered',
      control: { selector: '#evaluation-refresh', accessibleName: 'Refresh evaluation readiness' },
      request: { method: 'GET', pathTemplate: '/api/benchmark/batches/active', httpStatus: 200 },
      semanticBatchStatus: 'none-active',
      uiMode: 'idle-ready',
      invariants: { liveSurfaceHidden: true, idleSurfaceVisible: true, heroAgrees: true },
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
  const target = await resolveBenchmarkTarget();
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
      serviceIdentity: { service: 'benchmark', version: require('../benchmark/package.json').version, surface: 'benchmark-home' },
      journeyId: 'benchmark.stop-failure-recovery',
      evidenceMode: 'deterministic-contract',
      fixtureContract: 'benchmark-stop-v1',
      subjectHash,
      dependencies: { ollama: 'not-used', mongodb: 'not-used', docker: 'not-required' },
      observations,
      summary: {
        expectedSteps: observations.length * 4,
        passed: observations.length * 4,
        failed: 0,
        missing: 0,
      },
      limitations: ['Proves browser and API-contract behavior; does not measure live worker cancellation latency.'],
      privacy: {
        addressesIncluded: false,
        rawResponsesIncluded: false,
        subjectIdentifiersIncluded: false,
        secretsIncluded: false,
      },
    };
    const validationErrors = validateActionReceipt(receipt);
    assert.deepEqual(validationErrors, []);
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
