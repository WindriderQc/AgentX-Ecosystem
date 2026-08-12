/**
 * E2E tests for the inline Benchmark Judge Settings surface and response-caps modal.
 */

const { test, expect } = require('@playwright/test');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3081';
const TIMEOUT = 30_000;

async function openBenchmarkPage(page) {
    await page.goto(`${BASE_URL}/benchmark.html`, { waitUntil: 'networkidle', timeout: TIMEOUT });
    await page.waitForSelector('#settingsBtn', { timeout: TIMEOUT });
}

async function openSettingsModal(page) {
    await page.click('#settingsBtn');
    await page.waitForSelector('#settingsModal', { state: 'visible', timeout: 5000 });
}

async function saveModal(page) {
    await page.click('#saveSettingsBtn');
    await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });
}

test.describe('Benchmark Judge Settings Surface', () => {
    test.beforeEach(async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.removeItem('benchmarkJudgeConfig');
        });
        await openBenchmarkPage(page);
    });

    test('shows judge controls inline in the benchmark header', async ({ page }) => {
        await expect(page.locator('#judgeHost')).toBeVisible();
        await expect(page.locator('#judgeModel')).toBeVisible();
        await expect(page.locator('#judgeNumCtx')).toBeVisible();
        await expect(page.locator('#judgeCapacityPanel')).toBeVisible();
        await expect(page.locator('#executionModeHelp')).toBeVisible();
    });

    test('keeps deprecated auto judge controls absent', async ({ page }) => {
        await expect(page.locator('#judgeMode_auto')).toHaveCount(0);
        await expect(page.locator('#judgeMode_pinned')).toHaveCount(0);
        await expect(page.locator('#judgeHostPolicy')).toHaveCount(0);
        await expect(page.locator('#judgeAutoSection')).toHaveCount(0);
        await expect(page.locator('#judgeTierAutoUpgrade')).toHaveCount(0);
    });

    test('dead custom-judge-prompt textareas are absent', async ({ page }) => {
        for (const id of ['promptReasoning', 'promptCode', 'promptFactual', 'promptMath', 'promptCreative']) {
            await expect(page.locator(`#${id}`)).toHaveCount(0);
        }
    });

    test('dead judgeSameHost checkbox is absent', async ({ page }) => {
        await expect(page.locator('#judgeSameHost')).toHaveCount(0);
    });

    test('response-caps modal still has Save and Cancel buttons', async ({ page }) => {
        await openSettingsModal(page);
        await expect(page.locator('#saveSettingsBtn')).toBeVisible();
        await expect(page.locator('#cancelSettingsBtn')).toBeVisible();
    });

    test('inline timeout changes stay in the header without opening the modal', async ({ page }) => {
        await page.fill('#judgeTimeout', '99999');
        await page.locator('#judgeTimeout').dispatchEvent('change');
        await expect(page.locator('#settingsModal')).toBeHidden();
        await expect(page.locator('#judgeTimeout')).toHaveValue('99999');
    });

    test('response-caps modal save closes and keeps inline judge controls visible', async ({ page }) => {
        await openSettingsModal(page);
        await page.fill('#judgeMaxTokens', '260');
        await saveModal(page);
        await expect(page.locator('#judgeNumCtx')).toBeVisible();
        await expect(page.locator('#judgeCapacityPanel')).toBeVisible();
    });

    test('escape closes the advanced modal', async ({ page }) => {
        await openSettingsModal(page);
        await page.keyboard.press('Escape');
        await page.waitForSelector('#settingsModal', { state: 'hidden', timeout: 5000 });
    });

    test('stored config with host and model restores inline judge fields', async ({ page }) => {
        await page.addInitScript(() => {
            localStorage.setItem('benchmarkJudgeConfig', JSON.stringify({
                host: 'http://127.0.0.1:11434',
                model: 'llama3:latest',
                temperature: 0.2,
                num_ctx: 16384,
                concurrency: 3
            }));
        });
        await page.reload({ waitUntil: 'networkidle' });
        await page.waitForSelector('#settingsBtn', { timeout: TIMEOUT });

        await expect(page.locator('#judgeHost')).toBeVisible();
        await expect(page.locator('#judgeModel')).toBeVisible();
        await expect(page.locator('#judgeTemp')).toHaveValue('0.2');
        await expect(page.locator('#judgeNumCtx')).toHaveValue('16384');
        await expect(page.locator('#judgeConcurrency')).toHaveValue('3');
    });

    test('temperature and concurrency sliders remain visible', async ({ page }) => {
        await expect(page.locator('#judgeTemp')).toBeVisible();
        await expect(page.locator('#judgeConcurrency')).toBeVisible();
    });
});
