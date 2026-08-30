'use strict';

const { test, expect } = require('@playwright/test');
const { urlFor } = require('./support/product-surfaces');

const CAPTURE_SURFACES = [
  { id: 'benchmark-leaderboard', service: 'benchmark', path: '/leaderboard' },
  { id: 'benchmark-courthouse', service: 'benchmark', path: '/courthouse' },
];

for (const surface of CAPTURE_SURFACES) {
  test(`${surface.id} supports a bounded full-page capture`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop-chromium', 'Exact desktop compositor regression gate');
    await page.setViewportSize({ width: 2008, height: 1423 });
    const response = await page.goto(urlFor(surface), { waitUntil: 'domcontentloaded' });
    expect(response?.ok()).toBe(true);
    await expect(page.locator('body')).toHaveAttribute('data-agentx-ready', 'true');
    await page.evaluate(async () => {
      if (document.fonts?.ready) await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });

    const screenshot = await page.screenshot({
      fullPage: true,
      animations: 'disabled',
      timeout: 5_000,
    });
    expect(screenshot.byteLength).toBeGreaterThan(10_000);
  });
}
