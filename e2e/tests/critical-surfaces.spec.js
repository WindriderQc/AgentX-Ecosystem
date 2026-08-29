'use strict';

const AxeBuilder = require('@axe-core/playwright').default;
const { test, expect } = require('@playwright/test');
const {
  allowedOrigins,
  budgetFor,
  criticalSurfaces,
  profile,
  urlFor,
} = require('./support/product-surfaces');
const {
  PERFORMANCE_ATTACHMENT_NAME,
  RELEASE_ASSET_TYPES,
  budgetViolations,
  createPerformanceCollector,
  createPerformanceRecord,
} = require('./support/performance-budget');

const UNRESOLVED_RENDER_MARKERS = [
  { label: 'Handlebars token', pattern: /\{\{\s*[A-Za-z0-9_.-]+\s*\}\}/ },
  { label: 'EJS token', pattern: /<%[=-]?[^%]+%>/ },
  { label: 'Express missing-route response', pattern: /\bCannot GET\b/i },
  { label: 'internal-server-error response', pattern: /\bInternal Server Error\b/i },
];

function formatAxeViolations(violations) {
  return violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    help: violation.help,
    targets: violation.nodes.map((node) => node.target.join(' ')),
  }));
}

async function expectCanonicalIdentity(page, surface) {
  await expect(page.locator('body')).toHaveAttribute('data-agentx-surface', surface.id);
  await expect(page.locator('body')).toHaveAttribute('data-agentx-profile', profile);

  const main = page.getByRole('main');
  await expect(main, `${surface.id} needs one canonical main landmark`).toHaveCount(1);
  await expect(main).toBeVisible();

  if (surface.id === 'core-demo') {
    await expect(page.getByRole('link', { name: 'Agent X demo home' })).toHaveAttribute('href', '/demo');
    return;
  }

  if (surface.id === 'core-portal') {
    await expect(page.getByRole('heading', { name: /AgentX.*product portal/i })).toBeVisible();
    return;
  }

  const primaryNavigation = page.getByRole('navigation', { name: 'Primary' });
  if (await primaryNavigation.count()) {
    await expect(primaryNavigation, `${surface.id} needs one shared primary navigation`).toHaveCount(1);
    await expect(primaryNavigation).toBeVisible();
    await expect(
      primaryNavigation.locator('[aria-current="page"]'),
      `${surface.id} needs exactly one current item in the primary navigation`
    ).toHaveCount(1);
    return;
  }

  if (profile === 'demo') {
    await expect(
      page.getByRole('link', { name: 'Back to Agent X demo' }),
      `${surface.id} needs a demo-profile navigation identity when the full navigation is intentionally absent`
    ).toHaveAttribute('href', /\/demo$/);
    return;
  }

  expect(await primaryNavigation.count(), `${surface.id} has no explicit navigation identity`).toBe(1);
}

async function expectNoPageOverflow(page, surface) {
  const metrics = await page.evaluate(() => {
    const root = document.documentElement;
    const body = document.body;
    return {
      viewportWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth,
      bodyScrollWidth: body?.scrollWidth || 0,
    };
  });
  const scrollWidth = Math.max(metrics.rootScrollWidth, metrics.bodyScrollWidth);
  expect(
    scrollWidth - metrics.viewportWidth,
    `${surface.id} overflows the page horizontally: ${JSON.stringify(metrics)}`
  ).toBeLessThanOrEqual(1);
}

for (const surface of criticalSurfaces) {
  test(`${surface.id} renders a trustworthy product surface`, async ({ page }, testInfo) => {
    const expectedUrl = new URL(urlFor(surface)).href;
    const pageErrors = [];
    const failedAssets = [];
    const unexpectedOrigins = [];
    const releaseAssetTypes = new Set(RELEASE_ASSET_TYPES);
    const performanceCollector = createPerformanceCollector(page, { allowedOrigins });
    page.on('pageerror', (error) => pageErrors.push(error.message));
    page.on('request', (request) => {
      const requestUrl = request.url();
      if (!/^https?:/i.test(requestUrl)) return;
      const origin = new URL(requestUrl).origin;
      if (!allowedOrigins.includes(origin)) unexpectedOrigins.push(requestUrl);
    });
    page.on('requestfailed', (request) => {
      if (!releaseAssetTypes.has(request.resourceType())) return;
      failedAssets.push(`${request.resourceType()} ${request.url()}: ${request.failure()?.errorText || 'failed'}`);
    });
    page.on('response', (assetResponse) => {
      if (!releaseAssetTypes.has(assetResponse.request().resourceType()) || assetResponse.ok()) return;
      failedAssets.push(`${assetResponse.request().resourceType()} ${assetResponse.url()}: HTTP ${assetResponse.status()}`);
    });

    const response = await page.goto(expectedUrl, { waitUntil: 'domcontentloaded' });
    expect(response, `${surface.id} did not return a document response`).not.toBeNull();
    expect(response.ok(), `${surface.id} returned HTTP ${response.status()}`).toBe(true);
    expect(page.url(), `${surface.id} redirected away from its canonical URL`).toBe(expectedUrl);
    await expect(page.locator('body')).toHaveAttribute('data-agentx-ready', 'true');
    const markup = await page.content();
    for (const marker of UNRESOLVED_RENDER_MARKERS) {
      expect(markup, `${surface.id} rendered a ${marker.label}`).not.toMatch(marker.pattern);
    }

    await expectCanonicalIdentity(page, surface);
    await expectNoPageOverflow(page, surface);

    const budget = budgetFor(surface);
    const performanceMetrics = await performanceCollector.settle();
    const performanceRecord = createPerformanceRecord({
      surface,
      profile,
      project: testInfo.project.name,
      viewport: page.viewportSize(),
      budget,
      metrics: performanceMetrics,
    });
    await testInfo.attach(PERFORMANCE_ATTACHMENT_NAME, {
      body: Buffer.from(`${JSON.stringify(performanceRecord)}\n`, 'utf8'),
      contentType: 'application/json',
    });
    expect(
      budgetViolations(performanceMetrics, budget.limits),
      `${surface.id} exceeded its ${budget.id} performance budget: ${JSON.stringify(performanceRecord)}`
    ).toEqual([]);

    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
      .analyze();
    const blockers = accessibility.violations.filter(({ impact }) => (
      impact === 'serious' || impact === 'critical'
    ));
    expect(formatAxeViolations(blockers), `${surface.id} has serious or critical accessibility violations`).toEqual([]);
    expect(pageErrors, `${surface.id} raised uncaught page errors`).toEqual([]);
    expect(failedAssets, `${surface.id} has failed release assets`).toEqual([]);
    expect(unexpectedOrigins, `${surface.id} requested resources outside the product origins`).toEqual([]);
  });
}
