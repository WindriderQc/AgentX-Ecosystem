'use strict';

const { test, expect } = require('@playwright/test');
const { normalizedBaseUrl } = require('./support/product-surfaces');

/**
 * Navigation parity: Core, Benchmark and RAG render the same Product groups
 * and the same "External runtimes" launchers (or none), from the same
 * validated navigation projection. The check uses rendered pages and clicks,
 * not typed URLs.
 */
async function navShape(page) {
  return page.evaluate(() => {
    const groups = [...document.querySelectorAll('#nav-container .nav-item > button.nav-link')]
      .map((button) => button.id.replace('nav-trigger-', ''));
    const items = [...document.querySelectorAll('#nav-container .nav-dropdown .dropdown-item')]
      .map((item) => item.textContent.replace(/\s+/g, ' ').trim());
    const launchers = [...document.querySelectorAll('#nav-container .dropdown-item[data-nav-owner]')]
      .map((a) => ({ label: a.textContent.replace(/\s+/g, ' ').trim(), href: new URL(a.getAttribute('href'), location.href).href, owner: a.dataset.navOwner, target: a.target }));
    return { groups, items, launchers };
  });
}

test('Core, Benchmark and RAG expose the same navigation groups and launchers', async ({ page }) => {
  const shapes = {};
  for (const [service, path] of [['core', '/nerve-center'], ['benchmark', '/'], ['rag', '/']]) {
    await page.goto(`${normalizedBaseUrl(service)}${path}`, { waitUntil: 'domcontentloaded' });
    await expect(page.locator('#nav-container nav.top-nav')).toBeVisible();
    shapes[service] = await navShape(page);
  }
  expect(shapes.benchmark.groups).toEqual(shapes.core.groups);
  expect(shapes.rag.groups).toEqual(shapes.core.groups);
  expect(shapes.benchmark.items).toEqual(shapes.core.items);
  expect(shapes.rag.items).toEqual(shapes.core.items);
  expect(shapes.benchmark.launchers).toEqual(shapes.core.launchers);
  expect(shapes.rag.launchers).toEqual(shapes.core.launchers);
  for (const launcher of shapes.core.launchers) {
    expect(launcher.target).toBe('_blank');
    expect(launcher.owner).toBeTruthy();
  }
});

test('the Operate menu opens from a click on RAG and reaches Core without a typed URL', async ({ page }) => {
  await page.goto(`${normalizedBaseUrl('rag')}/`, { waitUntil: 'domcontentloaded' });
  await page.locator('#nav-trigger-operate-group').click();
  await expect(page.locator('#nav-menu-operate-group')).toBeVisible();
  await page.locator('#nav-menu-operate-group a.dropdown-item', { hasText: 'Nerve Center' }).click();
  await page.waitForLoadState('domcontentloaded');
  expect(new URL(page.url()).pathname).toBe('/nerve-center');
});
