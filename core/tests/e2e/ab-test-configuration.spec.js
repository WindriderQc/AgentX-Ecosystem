/**
 * End-to-End Tests for A/B Test Configuration UI
 * Tests the complete flow of configuring A/B tests through the UI
 */

const { test, expect } = require('@playwright/test');

// Test configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const TEST_TIMEOUT = 30000;

test.describe('A/B Test Configuration UI', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to prompts page
    await page.goto(`${BASE_URL}/prompts.html`);

    // Wait for page to load
    await page.waitForSelector('#promptListContainer', { timeout: TEST_TIMEOUT });
  });

  test('should display Configure A/B Test button for prompt groups', async ({ page }) => {
    // Wait for prompt list to render
    await page.waitForSelector('.prompt-group-card', { timeout: TEST_TIMEOUT });

    // Find the first prompt group with multiple versions
    const promptCard = page.locator('.prompt-group-card').first();

    // Check if Configure A/B Test button exists
    const abTestButton = promptCard.locator('button[data-action="ab-test"]');
    await expect(abTestButton).toBeVisible();

    // Verify button text
    await expect(abTestButton).toHaveText(/Configure A\/B Test/i);
  });

  test('should open A/B Test Configuration modal when button clicked', async ({ page }) => {
    // Click the first Configure A/B Test button
    const abTestButton = page.locator('button[data-action="ab-test"]').first();
    await abTestButton.click();

    // Wait for modal to appear
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible({ timeout: 5000 });

    // Verify modal header
    const modalTitle = modal.locator('#abTestModalTitle');
    await expect(modalTitle).toContainText('Configure A/B Test');

    // Verify modal has prompt name displayed
    const promptName = modal.locator('#abTestPromptName');
    await expect(promptName).not.toHaveText('-');
  });

  test('should display all versions in A/B test configuration panel', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Check if version weights list is populated
    const versionsList = modal.locator('#versionWeightsList');
    const versionItems = versionsList.locator('.version-weight-item');

    // Should have at least one version
    await expect(versionItems).toHaveCount(expect.any(Number));
    await expect(versionItems.first()).toBeVisible();
  });

  test('should update traffic weight when slider is moved', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Find first active version's slider
    const firstSlider = modal.locator('.weight-slider').first();
    const firstInput = modal.locator('.weight-input').first();

    // Get initial value
    const initialValue = await firstInput.inputValue();

    // Move slider to 75%
    await firstSlider.fill('75');

    // Verify input updated
    await expect(firstInput).toHaveValue('75');

    // Verify total weight display updated
    const totalWeight = modal.locator('#abTestTotalWeight');
    await expect(totalWeight).toContainText('%');
  });

  test('should validate weights sum to 100%', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Activate all versions
    await modal.locator('#activateAllBtn').click();

    // Set weights that don't sum to 100
    const firstInput = modal.locator('.weight-input').first();
    await firstInput.fill('30');
    await firstInput.blur();

    // Validation warning should appear
    const warning = modal.locator('#validationWarning');
    await expect(warning).toBeVisible();

    // Save button should be disabled
    const saveBtn = modal.locator('#abTestSaveBtn');
    await expect(saveBtn).toBeDisabled();
  });

  test('should enable save button when weights sum to 100%', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Use equal distribution button
    await modal.locator('#equalDistributeBtn').click();

    // Validation warning should be hidden
    const warning = modal.locator('#validationWarning');
    await expect(warning).toBeHidden();

    // Save button should be enabled
    const saveBtn = modal.locator('#abTestSaveBtn');
    await expect(saveBtn).toBeEnabled();
  });

  test('should display traffic distribution chart', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Check if distribution chart exists
    const chart = modal.locator('#distributionChart');
    await expect(chart).toBeVisible();

    // Check if legend exists
    const legend = modal.locator('#distributionLegend');
    await expect(legend).toBeVisible();

    // Should have distribution bars for active versions
    const bars = chart.locator('.distribution-bar');
    const legendItems = legend.locator('.legend-item');

    // Number of bars should match legend items
    const barsCount = await bars.count();
    const legendCount = await legendItems.count();
    expect(barsCount).toBe(legendCount);
  });

  test('should support bulk actions - Activate All', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Click Activate All button
    await modal.locator('#activateAllBtn').click();

    // All checkboxes should be checked
    const checkboxes = modal.locator('.version-active-toggle');
    const count = await checkboxes.count();

    for (let i = 0; i < count; i++) {
      await expect(checkboxes.nth(i)).toBeChecked();
    }

    // Active count should update
    const activeCount = modal.locator('#abTestActiveCount');
    await expect(activeCount).toHaveText(count.toString());
  });

  test('should support bulk actions - Equal Distribution', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Activate all versions first
    await modal.locator('#activateAllBtn').click();

    // Click Equal Distribution button
    await modal.locator('#equalDistributeBtn').click();

    // Check that weights are distributed equally
    const inputs = modal.locator('.weight-input:not([disabled])');
    const count = await inputs.count();

    if (count > 0) {
      const expectedWeight = Math.floor(100 / count);

      // First input might have remainder
      const firstValue = parseInt(await inputs.first().inputValue());
      expect(firstValue).toBeGreaterThanOrEqual(expectedWeight);
      expect(firstValue).toBeLessThanOrEqual(expectedWeight + (100 % count));
    }

    // Total should be 100%
    const totalWeight = modal.locator('#abTestTotalWeight');
    await expect(totalWeight).toHaveText('100%');
  });

  test('should support bulk actions - Reset', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Get original values
    const firstInput = modal.locator('.weight-input').first();
    const originalValue = await firstInput.inputValue();

    // Make changes
    await firstInput.fill('50');
    await firstInput.blur();

    // Click Reset button
    await modal.locator('#resetWeightsBtn').click();

    // Should restore original value
    await expect(firstInput).toHaveValue(originalValue);
  });

  test('should toggle Show Inactive Versions', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Count initial versions shown
    const versionsList = modal.locator('#versionWeightsList');
    const initialCount = await versionsList.locator('.version-weight-item').count();

    // Toggle show inactive
    const toggle = modal.locator('#showInactiveToggle');
    await toggle.check();

    // Count should potentially change (if there are inactive versions)
    const newCount = await versionsList.locator('.version-weight-item').count();
    expect(newCount).toBeGreaterThanOrEqual(initialCount);
  });

  test('should close modal on Cancel button click', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Click Cancel button
    await modal.locator('#abTestCancelBtn').click();

    // Modal should be hidden
    await expect(modal).toBeHidden();
  });

  test('should close modal on close button (X) click', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Click close button
    await modal.locator('#abTestModalClose').click();

    // Modal should be hidden
    await expect(modal).toBeHidden();
  });

  test('should close modal on ESC key press', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Press ESC key
    await page.keyboard.press('Escape');

    // Modal should be hidden
    await expect(modal).toBeHidden();
  });

  test('should display version statistics in configuration panel', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Check if first version has stats displayed
    const firstVersion = modal.locator('.version-weight-item').first();
    const stats = firstVersion.locator('.version-stats-mini');

    // Should show impressions and positive rate icons
    await expect(stats).toBeVisible();
    await expect(stats).toContainText('fa-eye'); // Impressions icon
    await expect(stats).toContainText('fa-thumbs-up'); // Positive rate icon
  });

  test('should prevent saving when no versions are active', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Deactivate all versions
    await modal.locator('#deactivateAllBtn').click();

    // Validation warning should appear
    const warning = modal.locator('#validationWarning');
    await expect(warning).toBeVisible();
    await expect(warning).toContainText('At least one version must be active');

    // Save button should be disabled
    const saveBtn = modal.locator('#abTestSaveBtn');
    await expect(saveBtn).toBeDisabled();
  });

  test('should update active count when versions are toggled', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Get initial active count
    const activeCountElement = modal.locator('#abTestActiveCount');
    const initialCount = parseInt(await activeCountElement.textContent());

    // Find first checkbox and toggle it
    const firstCheckbox = modal.locator('.version-active-toggle').first();
    const isChecked = await firstCheckbox.isChecked();

    await firstCheckbox.click();

    // Active count should change
    const newCount = parseInt(await activeCountElement.textContent());
    expect(newCount).toBe(isChecked ? initialCount - 1 : initialCount + 1);
  });

  test('should disable weight controls for inactive versions', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Deactivate all versions
    await modal.locator('#deactivateAllBtn').click();

    // All sliders and inputs should be disabled
    const sliders = modal.locator('.weight-slider');
    const inputs = modal.locator('.weight-input');

    const sliderCount = await sliders.count();
    for (let i = 0; i < sliderCount; i++) {
      await expect(sliders.nth(i)).toBeDisabled();
      await expect(inputs.nth(i)).toBeDisabled();
    }
  });

  test('should handle keyboard navigation in weight inputs', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Focus first weight input
    const firstInput = modal.locator('.weight-input').first();
    await firstInput.click();

    // Clear and type new value
    await firstInput.fill('');
    await page.keyboard.type('65');

    // Verify value updated
    await expect(firstInput).toHaveValue('65');
  });

  test('should clamp weight input values to 0-100 range', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Try to set value above 100
    const firstInput = modal.locator('.weight-input').first();
    await firstInput.fill('150');
    await firstInput.blur();

    // Should be clamped to 100
    await expect(firstInput).toHaveValue('100');

    // Try to set negative value
    await firstInput.fill('-10');
    await firstInput.blur();

    // Should be clamped to 0
    await expect(firstInput).toHaveValue('0');
  });

  test('should display color-coded distribution bars', async ({ page }) => {
    // Open A/B test modal
    await page.locator('button[data-action="ab-test"]').first().click();
    const modal = page.locator('#abTestConfigOverlay');
    await expect(modal).toBeVisible();

    // Check distribution bars have background colors
    const bars = modal.locator('.distribution-bar');
    const count = await bars.count();

    if (count > 0) {
      const firstBar = bars.first();
      const backgroundColor = await firstBar.evaluate(el =>
        window.getComputedStyle(el).backgroundColor
      );

      // Should have a color set (not empty or transparent)
      expect(backgroundColor).not.toBe('');
      expect(backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
    }
  });
});
