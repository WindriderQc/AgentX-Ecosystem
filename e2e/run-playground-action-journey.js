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
const outputPath = path.resolve(
  __dirname,
  'test-results',
  `agentx-browser-actions-playground-${profile}.json`,
);
const conversationId = 'conversation-exact-turn';
const olderUserId = 'user-older';
const olderAssistantId = 'assistant-older';
const newerUserId = 'user-newer';
const newerAssistantId = 'assistant-newer';
const recoveredAssistantId = 'assistant-recovered';
const duplicatePrompt = 'Repeat this exact prompt.';
const recoveredAnswer = 'The exact failed turn recovered without another user bubble.';
const fixtureTimestamp = '2026-08-28T00:00:00.000Z';
const subjectHash = crypto.createHash('sha256').update(conversationId).digest('hex').slice(0, 12);
const PROJECTS = Object.freeze([
  { name: 'desktop-chromium', viewport: { width: 1440, height: 900 } },
  { name: 'mobile-chromium', viewport: { width: 375, height: 667 }, isMobile: true, hasTouch: true },
]);

const initialMessages = Object.freeze([
  Object.freeze({ _id: olderUserId, role: 'user', content: duplicatePrompt, createdAt: fixtureTimestamp }),
  Object.freeze({
    _id: olderAssistantId,
    role: 'assistant',
    content: 'Older answer bound to the first prompt identity.',
    createdAt: fixtureTimestamp,
  }),
  Object.freeze({ _id: newerUserId, role: 'user', content: duplicatePrompt, createdAt: fixtureTimestamp }),
  Object.freeze({
    _id: newerAssistantId,
    role: 'assistant',
    content: 'Newer answer bound to the second prompt identity.',
    createdAt: fixtureTimestamp,
  }),
]);

function json(route, status, body, headers = {}) {
  return route.fulfill({
    status,
    contentType: 'application/json',
    headers,
    body: JSON.stringify(body),
  });
}

function cloneMessages(messages) {
  return messages.map((message) => ({ ...message }));
}

async function probeProfile(url) {
  try {
    const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(1500) });
    if (response.status !== 200) return false;
    const observed = response.headers.get('x-agentx-profile');
    const body = await response.text();
    if (observed) return observed === profile;
    return body.includes(`data-agentx-profile="${profile}"`);
  } catch {
    return false;
  }
}

async function startLocalFallback() {
  process.env.NODE_ENV = 'test';
  process.env.AGENTX_PROFILE = profile;
  const { app } = require('../core/src/app');
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const server = await new Promise((resolve, reject) => {
      const candidate = app.listen(0, '127.0.0.1', () => resolve(candidate));
      candidate.once('error', reject);
    });
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      const warmup = await fetch(`${url}/playground`, { signal: AbortSignal.timeout(15_000) });
      if (!warmup.ok) throw new Error(`HTTP ${warmup.status}`);
      await warmup.arrayBuffer();
      return {
        url,
        close: () => new Promise((resolve) => server.close(resolve)),
      };
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => server.close(resolve));
    }
  }
  const cause = lastError?.cause?.message ? ` (${lastError.cause.message})` : '';
  throw new Error(`Local Core Playground action surface did not become ready: ${lastError?.message || 'unknown error'}${cause}`);
}

async function resolveCoreTarget() {
  const requested = configuredCoreUrl || defaultCoreUrl;
  if (await probeProfile(`${requested}/playground`)) return { url: requested, close: async () => {} };
  if (configuredCoreUrl) throw new Error('Configured Core Playground surface is unavailable or has the wrong profile');
  return startLocalFallback();
}

function promptFixture() {
  return {
    _id: 'prompt-default-v1',
    name: 'default_chat',
    version: 1,
    systemPrompt: 'Answer with bounded, evidence-backed claims.',
    description: 'Default action receipt prompt',
    isActive: true,
    trafficWeight: 100,
    disposition: { selectable: true, launchable: false },
  };
}

function historySummary() {
  return [{
    id: conversationId,
    title: 'Exact turn action fixture',
    date: fixtureTimestamp,
  }];
}

function conversationFixture(messages) {
  return {
    _id: conversationId,
    title: 'Exact turn action fixture',
    model: 'fixture-model:7b',
    createdAt: fixtureTimestamp,
    messages: cloneMessages(messages),
    usage: { totalTokens: 42, estimatedCost: 0 },
  };
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
  const chatBodies = [];
  let conversationMessages = cloneMessages(initialMessages);
  let currentUserId = null;

  page.on('pageerror', (error) => pageErrors.push(error.message));
  page.on('requestfailed', (request) => failedResources.push(request.resourceType()));
  await page.addInitScript(() => {
    localStorage.clear();
    localStorage.setItem('agentx-settings', JSON.stringify({
      settingsVersion: 8,
      routingMode: 'standard',
      stream: false,
      useRag: false,
    }));
  });

  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const method = request.method();
    const parsed = new URL(request.url());
    const pathname = parsed.pathname;

    if (method === 'GET' && pathname === '/api/config') return json(route, 200, {});
    if (method === 'GET' && pathname === '/api/ollama-hosts') {
      return json(route, 200, {
        status: 'success',
        data: {
          hosts: [{
            id: 'fixture-host',
            name: 'Fixture host',
            url: 'http://fixture.invalid:11434',
            available: true,
            models: ['fixture-model:7b'],
            installedModels: ['fixture-model:7b'],
          }],
        },
      });
    }
    if (method === 'GET' && pathname === '/api/models/all') {
      return json(route, 200, {
        status: 'success',
        data: {
          models: [{
            name: 'fixture-model:7b',
            displayName: 'Fixture model',
            readiness: { stage: 'available', evidenceState: 'deferred' },
          }],
        },
      }, { 'x-model-evidence': 'deferred', 'x-require-profiled-models': 'false' });
    }
    if (method === 'GET' && pathname === '/api/models/routing') {
      return json(route, 200, { status: 'success', data: { taskModels: {}, hosts: {} } });
    }
    if (method === 'GET' && pathname === '/api/nerve-center/host-preferences') {
      return json(route, 200, { status: 'success', data: [] });
    }
    if (method === 'GET' && pathname === '/api/profile') {
      return json(route, 200, { status: 'success', data: { about: '', preferences: {} } });
    }
    if (method === 'GET' && pathname === '/api/prompts') {
      return json(route, 200, { status: 'success', data: { default_chat: [promptFixture()] } });
    }
    if (method === 'GET' && pathname === '/api/prompts/default_chat') {
      return json(route, 200, { status: 'success', data: [promptFixture()] });
    }
    if (method === 'GET' && pathname === '/api/rag/status') {
      return json(route, 200, {
        status: 'success',
        data: {
          documentCount: 0,
          chunkCount: 0,
          vectorStore: { healthy: true, type: 'memory' },
        },
      });
    }
    if (method === 'GET' && pathname === '/api/portal/health') {
      return json(route, 200, {
        status: 'ok',
        services: [{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }],
        summary: { total: 3, healthy: 3, status: 'ok' },
        consistency: { status: 'ok' },
      });
    }
    if (method === 'GET' && pathname === '/api/nerve-center/ecosystem') {
      return json(route, 200, {
        status: 'success',
        data: {
          services: [{ status: 'ok' }, { status: 'ok' }, { status: 'ok' }],
          serviceHealth: { total: 3, healthy: 3, status: 'ok' },
          identityConsistency: { status: 'ok' },
          health: { status: 'ok', configuredHosts: 1, onlineHosts: 1, observedModels: 1 },
        },
      });
    }
    if (method === 'GET' && pathname === '/api/history') {
      return json(route, 200, { status: 'success', data: historySummary() });
    }
    if (method === 'GET' && pathname === `/api/history/${conversationId}`) {
      return json(route, 200, { status: 'success', data: conversationFixture(conversationMessages) });
    }
    if (method === 'POST' && pathname === '/api/chat') {
      const body = request.postDataJSON();
      chatBodies.push(body);
      if (chatBodies.length === 1) {
        return json(route, 503, {
          status: 'error',
          code: 'FIXTURE_RESPONSE_UNAVAILABLE',
          message: 'The bounded fixture response is unavailable. Retry this exact turn.',
        });
      }
      if (chatBodies.length === 2) {
        conversationMessages = [
          ...cloneMessages(initialMessages),
          { _id: currentUserId, role: 'user', content: duplicatePrompt, createdAt: fixtureTimestamp },
          {
            _id: recoveredAssistantId,
            role: 'assistant',
            content: recoveredAnswer,
            createdAt: fixtureTimestamp,
          },
        ];
        return json(route, 200, {
          status: 'success',
          data: {
            response: recoveredAnswer,
            messageId: recoveredAssistantId,
            conversationId,
            model: 'fixture-model:7b',
            turnAction: body.turnAction,
          },
          model: 'fixture-model:7b',
          turnAction: body.turnAction,
        });
      }
      unexpectedApi.push(`${method} ${pathname} attempt-${chatBodies.length}`);
      return json(route, 501, { status: 'error', message: 'Unexpected extra chat attempt' });
    }

    unexpectedApi.push(`${method} ${pathname}`);
    return json(route, 501, { status: 'error', message: 'Unexpected action fixture request' });
  });

  try {
    await page.goto(`${targetUrl}/playground`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    assert.equal(await page.locator('body').getAttribute('data-agentx-profile'), profile);
    await page.waitForFunction(() => document.body.dataset.agentxReady === 'true');
    await page.locator(`.bubble[data-id="${newerAssistantId}"]`).waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.getElementById('sendBtn')?.disabled === false);
    assert.equal(await page.locator('#streamToggle').isChecked(), false);

    const initialUserBubbles = page.locator('.bubble.user');
    const initialAssistantBubbles = page.locator('.bubble.assistant');
    assert.equal(await initialUserBubbles.count(), 2);
    assert.equal(await initialAssistantBubbles.count(), 2);
    assert.deepEqual(
      (await initialUserBubbles.locator('.message-body').allTextContents()).map((value) => value.trim()),
      [duplicatePrompt, duplicatePrompt],
    );
    assert.equal(await page.locator(`.bubble[data-id="${olderUserId}"]`).count(), 1);
    assert.equal(await page.locator(`.bubble[data-id="${newerUserId}"]`).count(), 1);
    assert.equal(
      await page.locator(`.bubble[data-id="${olderAssistantId}"] [data-turn-action="ask-again"]`).getAttribute('aria-label'),
      'Ask again this turn',
    );

    const phases = [{
      id: 'duplicate_history_loaded',
      request: { method: 'GET', pathTemplate: '/api/history/:conversationId', httpStatus: 200 },
      uiMode: 'persisted-history-ready',
      invariants: {
        twoExactDuplicatePromptsVisible: true,
        distinctUserIdentitiesPreserved: true,
        persistedRepliesUseAskAgain: true,
      },
      outcome: 'pass',
    }];

    let firstResponse;
    try {
      const olderAssistantBubble = page.locator(`.bubble[data-id="${olderAssistantId}"]`);
      await olderAssistantBubble.hover();
      [firstResponse] = await Promise.all([
        page.waitForResponse((response) => {
          const request = response.request();
          return request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat';
        }, { timeout: 10_000 }),
        olderAssistantBubble.locator('[data-turn-action="ask-again"]').click(),
      ]);
    } catch (error) {
      const diagnostic = {
        status: (await page.locator('#statusChip').textContent()).trim(),
        feedback: (await page.locator('#feedback').textContent()).trim(),
        sendDisabled: await page.locator('#sendBtn').isDisabled(),
        retryButtons: await page.locator('[data-turn-action="retry"]').count(),
        chatAttempts: chatBodies.length,
        unexpectedApi,
        pageErrors,
      };
      throw new Error(`Ask again did not dispatch: ${JSON.stringify(diagnostic)}; ${error.message}`);
    }
    assert.equal(firstResponse.status(), 503);
    const failureEnvelope = await firstResponse.json();
    assert.deepEqual(failureEnvelope, {
      status: 'error',
      code: 'FIXTURE_RESPONSE_UNAVAILABLE',
      message: 'The bounded fixture response is unavailable. Retry this exact turn.',
    });
    assert.equal(chatBodies.length, 1);
    assert.equal(chatBodies[0].message, duplicatePrompt);
    assert.equal(chatBodies[0].conversationId, conversationId);
    assert.equal(chatBodies[0].stream, false);
    assert.deepEqual(chatBodies[0].turnAction, {
      kind: 'ask-again',
      sourceUserMessageId: olderUserId,
      sourceAssistantMessageId: olderAssistantId,
    });
    assert.notEqual(chatBodies[0].turnAction.sourceUserMessageId, newerUserId);
    assert.notEqual(chatBodies[0].turnAction.sourceAssistantMessageId, newerAssistantId);
    phases.push({
      id: 'ask_again_provenance_submitted',
      control: { selector: '.bubble.assistant [data-turn-action="ask-again"]', accessibleName: 'Ask again this turn' },
      request: { method: 'POST', pathTemplate: '/api/chat', attempt: 1, httpStatus: 503 },
      uiMode: 'exact-persisted-turn-action',
      invariants: {
        olderSourceUserIdSubmitted: true,
        olderSourceAssistantIdSubmitted: true,
        duplicateTextDidNotSelectNewerPair: true,
      },
      outcome: 'pass',
    });

    const retryButton = page.locator('[data-turn-action="retry"]');
    await retryButton.waitFor({ state: 'visible' });
    assert.equal(await retryButton.getAttribute('aria-label'), 'Retry this turn');
    assert.match(await page.locator('#feedback').textContent(), /Retry this exact turn/);
    assert.match(
      await retryButton.locator('xpath=../..').locator('.message-body').textContent(),
      /bounded fixture response is unavailable\. Retry this exact turn\./,
    );
    assert.equal(await page.locator('.bubble.user').count(), 3);
    const currentUserBubble = page.locator('.bubble.user').last();
    currentUserId = await currentUserBubble.getAttribute('data-id');
    assert.match(currentUserId || '', /^u-\d+$/);
    assert.equal((await currentUserBubble.locator('.message-body').textContent()).trim(), duplicatePrompt);
    phases.push({
      id: 'retry_exposed',
      control: { selector: '.bubble.assistant [data-turn-action="retry"]', accessibleName: 'Retry this turn' },
      request: null,
      uiMode: 'stable-retryable-failure',
      invariants: {
        stableFailureVisible: true,
        exactlyOneNewUserBubble: true,
        failedAssistantWasNotPersisted: true,
      },
      outcome: 'pass',
    });

    const userCountBeforeRetry = await page.locator('.bubble.user').count();
    await retryButton.locator('xpath=../..').hover();
    const [secondResponse] = await Promise.all([
      page.waitForResponse((response) => {
        const request = response.request();
        return request.method() === 'POST' && new URL(request.url()).pathname === '/api/chat';
      }),
      retryButton.click(),
    ]);
    assert.equal(secondResponse.status(), 200);
    const successEnvelope = await secondResponse.json();
    const expectedRetryAction = {
      kind: 'retry',
      sourceUserMessageId: currentUserId,
      sourceAssistantMessageId: null,
    };
    assert.equal(chatBodies.length, 2);
    assert.equal(chatBodies[1].message, duplicatePrompt);
    assert.equal(chatBodies[1].stream, false);
    assert.deepEqual(chatBodies[1].turnAction, expectedRetryAction);
    assert.deepEqual(successEnvelope.data.turnAction, expectedRetryAction);
    assert.deepEqual(successEnvelope.turnAction, expectedRetryAction);
    assert.equal(chatBodies[1].messages.length, initialMessages.length);
    assert.deepEqual(
      chatBodies[1].messages.map((message) => String(message.id || message._id || '')),
      [olderUserId, olderAssistantId, newerUserId, newerAssistantId],
    );
    assert.equal(chatBodies[1].messages.some((message) => (
      String(message.id || message._id || '') === currentUserId
    )), false);

    await page.locator(`.bubble[data-id="${recoveredAssistantId}"]`).waitFor({ state: 'visible' });
    await page.waitForFunction(
      ({ expectedCount, expectedId }) => {
        const users = [...document.querySelectorAll('.bubble.user')];
        return users.length === expectedCount && users.at(-1)?.dataset.id === expectedId;
      },
      { expectedCount: userCountBeforeRetry, expectedId: currentUserId },
    );
    assert.equal(await page.locator('.bubble.user').count(), userCountBeforeRetry);
    assert.equal(
      (await page.locator(`.bubble[data-id="${recoveredAssistantId}"] .message-body`).textContent()).trim(),
      recoveredAnswer,
    );
    phases.push({
      id: 'retry_acknowledged',
      control: { selector: '.bubble.assistant [data-turn-action="retry"]', accessibleName: 'Retry this turn' },
      request: { method: 'POST', pathTemplate: '/api/chat', attempt: 2, httpStatus: 200 },
      uiMode: 'exact-unpersisted-turn-recovered',
      invariants: {
        currentUserIdentityReused: true,
        noDuplicateUserBubble: true,
        turnActionEchoMatched: true,
        recoveredAssistantVisible: true,
      },
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
      serviceIdentity: {
        service: 'agentx-core',
        version: require('../core/package.json').version,
        surface: 'core-playground',
      },
      journeyId: 'playground.exact-turn-actions',
      evidenceMode: 'deterministic-contract',
      fixtureContract: 'playground-exact-turn-v1',
      subjectHash,
      dependencies: { mongodb: 'contract-fixture', ollama: 'not-used', docker: 'not-required' },
      observations,
      summary: {
        expectedSteps: observations.length * 4,
        passed: observations.length * 4,
        failed: 0,
        missing: 0,
      },
      limitations: [
        'Proves rendered-browser and strict turn-action provenance behavior; it does not execute live model inference.',
      ],
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
