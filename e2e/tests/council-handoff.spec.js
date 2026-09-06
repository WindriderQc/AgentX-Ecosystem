'use strict';

const { test, expect } = require('@playwright/test');
const { normalizedBaseUrl } = require('./support/product-surfaces');

const QUESTION = 'Should we keep Planning frozen?';

test('Chat hands a question to Council explicitly, without sending it as a chat turn', async ({ page, context }) => {
  const core = normalizedBaseUrl('core');
  await page.goto(`${core}/playground`, { waitUntil: 'domcontentloaded' });

  const button = page.locator('#roundtableBtn');
  await expect(button).toHaveAttribute('aria-label', 'Open in Council');

  // Empty composer: the button asks for a question instead of opening anything.
  const pagesBefore = context.pages().length;
  await button.click();
  await expect(page.locator('#messageInput')).toHaveAttribute('placeholder', /Type a question first/);
  expect(context.pages().length).toBe(pagesBefore);

  await page.locator('#messageInput').fill(QUESTION);
  const messagesBefore = await page.locator('#chatWindow .message').count();

  // A real navigation (anchor), so the handoff cannot be swallowed silently.
  const [council] = await Promise.all([
    context.waitForEvent('page'),
    button.click(),
  ]);
  await council.waitForLoadState('domcontentloaded');

  const url = new URL(council.url());
  expect(url.pathname).toBe('/council');
  expect(url.searchParams.get('question')).toBe(QUESTION);
  expect(url.searchParams.get('source')).toBe('playground');

  await expect(council.locator('#formQuestion')).toHaveValue(QUESTION);
  // Nothing was convened: the live session card stays hidden and the
  // start button still requires an explicit action.
  await expect(council.locator('#liveSection')).toBeHidden();
  await expect(council.locator('#formStartBtn')).toBeVisible();

  // The Playground did not send the question as a chat turn.
  await expect(page.locator('#chatWindow .message')).toHaveCount(messagesBefore);
  await expect(page.locator('#feedback')).toContainText('Question handed to Council');
  await expect(page.locator('#messageInput')).toHaveValue(QUESTION);
});

test('the Council handoff is reachable from the keyboard', async ({ page, context }) => {
  const core = normalizedBaseUrl('core');
  await page.goto(`${core}/playground`, { waitUntil: 'domcontentloaded' });
  await page.locator('#messageInput').fill(QUESTION);
  const button = page.locator('#roundtableBtn');
  await button.focus();
  await expect(button).toBeFocused();
  const [council] = await Promise.all([
    context.waitForEvent('page'),
    page.keyboard.press('Enter'),
  ]);
  await council.waitForLoadState('domcontentloaded');
  expect(new URL(council.url()).pathname).toBe('/council');
});
