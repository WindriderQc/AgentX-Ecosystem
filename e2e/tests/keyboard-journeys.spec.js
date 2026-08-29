'use strict';

const { test, expect } = require('@playwright/test');
const { normalizedBaseUrl } = require('./support/product-surfaces');

test('Playground controls and shortcuts dialog work from the keyboard', async ({ page }) => {
  await page.goto(`${normalizedBaseUrl('core')}/playground`, { waitUntil: 'domcontentloaded' });

  const controlsButton = page.locator('#toggleConfigBtn');
  await controlsButton.focus();
  await expect(controlsButton).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(controlsButton).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#configDrawer')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(controlsButton).toHaveAttribute('aria-expanded', 'false');
  await expect(controlsButton).toBeFocused();

  await page.keyboard.press('Enter');
  await expect(controlsButton).toHaveAttribute('aria-expanded', 'true');

  const shortcutsButton = page.locator('#showShortcutsBtn');
  await shortcutsButton.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Keyboard Shortcuts' });
  await expect(dialog).toBeVisible();
  await expect(page.locator('#main-content')).toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(shortcutsButton).toBeFocused();
  await expect(page.locator('#main-content')).not.toHaveAttribute('inert', '');
});

test('Courthouse tabs implement the expected keyboard tab-list behavior', async ({ page }) => {
  await page.goto(`${normalizedBaseUrl('benchmark')}/courthouse`, { waitUntil: 'domcontentloaded' });

  const review = page.locator('#ch-tab-review');
  const config = page.locator('#ch-tab-config');
  await review.focus();
  await page.keyboard.press('End');
  await expect(config).toBeFocused();
  await expect(config).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ch-panel-config')).toBeVisible();

  await page.keyboard.press('Home');
  await expect(review).toBeFocused();
  await expect(review).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#ch-panel-review')).toBeVisible();
});
