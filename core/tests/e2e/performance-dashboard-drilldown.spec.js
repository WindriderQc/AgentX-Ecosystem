/**
 * End-to-End Test: Performance Dashboard Drill-Down
 * Tests the conversation samples modal functionality
 */

const { test, expect } = require('@playwright/test');

test.describe('Performance Dashboard Drill-Down', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to prompts page
    await page.goto('http://localhost:3080/prompts.html');

    // Wait for the page to load
    await page.waitForLoadState('networkidle');
  });

  test('should display Performance Metrics Dashboard', async ({ page }) => {
    // Check if metrics dashboard exists
    const dashboard = page.locator('.metrics-dashboard');
    await expect(dashboard).toBeVisible();

    // Check for header
    const header = page.locator('.dashboard-header h3');
    await expect(header).toContainText('Performance Metrics');
  });

  test('should show metric cards with View Samples buttons', async ({ page }) => {
    // Wait for metrics to load
    await page.waitForSelector('.metric-card', { timeout: 10000 });

    // Check if at least one metric card is present
    const metricCards = page.locator('.metric-card');
    const count = await metricCards.count();

    if (count > 0) {
      // Check if View Samples button exists on first card
      const viewSamplesBtn = metricCards.first().locator('.view-samples-btn');
      await expect(viewSamplesBtn).toBeVisible();
      await expect(viewSamplesBtn).toContainText('View Samples');
    } else {
      console.log('No metric cards found - skipping View Samples button test');
    }
  });

  test('should open conversation samples modal when clicking View Samples', async ({ page }) => {
    // Wait for metrics to load
    await page.waitForSelector('.metric-card', { timeout: 10000 });

    const metricCards = page.locator('.metric-card');
    const count = await metricCards.count();

    if (count > 0) {
      // Click the View Samples button on the first card
      const viewSamplesBtn = metricCards.first().locator('.view-samples-btn');
      await viewSamplesBtn.click();

      // Wait for modal to appear
      const modal = page.locator('#conversationSamplesModal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Check modal header
      const modalHeader = modal.locator('.modal-header h2');
      await expect(modalHeader).toContainText('Conversation Samples');

      // Check for modal content (either loading, error, or samples)
      const modalBody = modal.locator('.modal-body');
      await expect(modalBody).toBeVisible();

      // Modal should have filter tabs or loading state
      const hasTabs = await modal.locator('.samples-tabs').count() > 0;
      const hasLoading = await modal.locator('.samples-loading').count() > 0;
      const hasError = await modal.locator('.samples-error').count() > 0;
      const hasEmpty = await modal.locator('.samples-empty').count() > 0;

      expect(hasTabs || hasLoading || hasError || hasEmpty).toBeTruthy();
    } else {
      console.log('No metric cards found - skipping modal test');
    }
  });

  test('should close modal when clicking close button', async ({ page }) => {
    // Wait for metrics to load
    await page.waitForSelector('.metric-card', { timeout: 10000 });

    const metricCards = page.locator('.metric-card');
    const count = await metricCards.count();

    if (count > 0) {
      // Open modal
      const viewSamplesBtn = metricCards.first().locator('.view-samples-btn');
      await viewSamplesBtn.click();

      // Wait for modal to appear
      const modal = page.locator('#conversationSamplesModal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Click close button
      const closeBtn = modal.locator('#closeSamplesModal');
      await closeBtn.click();

      // Modal should disappear
      await expect(modal).not.toBeVisible({ timeout: 2000 });
    } else {
      console.log('No metric cards found - skipping close modal test');
    }
  });

  test('should filter samples by feedback type', async ({ page }) => {
    // Wait for metrics to load
    await page.waitForSelector('.metric-card', { timeout: 10000 });

    const metricCards = page.locator('.metric-card');
    const count = await metricCards.count();

    if (count > 0) {
      // Open modal
      const viewSamplesBtn = metricCards.first().locator('.view-samples-btn');
      await viewSamplesBtn.click();

      // Wait for modal to appear
      const modal = page.locator('#conversationSamplesModal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Check if tabs are present (samples exist)
      const tabs = modal.locator('.samples-tabs');
      const tabsVisible = await tabs.isVisible().catch(() => false);

      if (tabsVisible) {
        // Click on Positive tab
        const positiveTab = tabs.locator('[data-filter="positive"]');
        if (await positiveTab.isVisible()) {
          await positiveTab.click();

          // Tab should become active
          await expect(positiveTab).toHaveClass(/active/);

          // Click on Negative tab
          const negativeTab = tabs.locator('[data-filter="negative"]');
          if (await negativeTab.isVisible()) {
            await negativeTab.click();

            // Tab should become active
            await expect(negativeTab).toHaveClass(/active/);
          }

          // Click back to All tab
          const allTab = tabs.locator('[data-filter="all"]');
          if (await allTab.isVisible()) {
            await allTab.click();

            // Tab should become active
            await expect(allTab).toHaveClass(/active/);
          }
        }
      } else {
        console.log('No samples tabs found - likely empty dataset');
      }

      // Close modal
      const closeBtn = modal.locator('#closeSamplesModalBtn');
      await closeBtn.click();
    } else {
      console.log('No metric cards found - skipping filter test');
    }
  });

  test('should display sample cards with metadata', async ({ page }) => {
    // Wait for metrics to load
    await page.waitForSelector('.metric-card', { timeout: 10000 });

    const metricCards = page.locator('.metric-card');
    const count = await metricCards.count();

    if (count > 0) {
      // Open modal
      const viewSamplesBtn = metricCards.first().locator('.view-samples-btn');
      await viewSamplesBtn.click();

      // Wait for modal to appear
      const modal = page.locator('#conversationSamplesModal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Check if sample cards exist
      const sampleCards = modal.locator('.sample-card');
      const sampleCount = await sampleCards.count();

      if (sampleCount > 0) {
        // Verify first sample card has required elements
        const firstCard = sampleCards.first();

        // Should have header with metadata
        const sampleHeader = firstCard.locator('.sample-header');
        await expect(sampleHeader).toBeVisible();

        // Should have model info
        const sampleModel = firstCard.locator('.sample-model');
        await expect(sampleModel).toBeVisible();

        // Should have timestamp
        const sampleTimestamp = firstCard.locator('.sample-timestamp');
        await expect(sampleTimestamp).toBeVisible();

        // Should have feedback indicator
        const sampleFeedback = firstCard.locator('.sample-feedback');
        await expect(sampleFeedback).toBeVisible();

        // Should have conversation messages
        const userMessage = firstCard.locator('.sample-message.user');
        await expect(userMessage).toBeVisible();

        const assistantMessage = firstCard.locator('.sample-message.assistant');
        await expect(assistantMessage).toBeVisible();

        console.log(`Found ${sampleCount} conversation samples`);
      } else {
        console.log('No sample cards found - dataset may be empty');
      }

      // Close modal
      const closeBtn = modal.locator('#closeSamplesModalBtn');
      await closeBtn.click();
    } else {
      console.log('No metric cards found - skipping sample cards test');
    }
  });

  test('should have export functionality', async ({ page }) => {
    // Wait for metrics to load
    await page.waitForSelector('.metric-card', { timeout: 10000 });

    const metricCards = page.locator('.metric-card');
    const count = await metricCards.count();

    if (count > 0) {
      // Open modal
      const viewSamplesBtn = metricCards.first().locator('.view-samples-btn');
      await viewSamplesBtn.click();

      // Wait for modal to appear
      const modal = page.locator('#conversationSamplesModal');
      await expect(modal).toBeVisible({ timeout: 5000 });

      // Check for export button in footer
      const exportBtn = modal.locator('#exportSamplesBtn');
      await expect(exportBtn).toBeVisible();
      await expect(exportBtn).toContainText('Export JSON');

      // Export button should be enabled if samples exist
      const sampleCards = modal.locator('.sample-card');
      const sampleCount = await sampleCards.count();

      if (sampleCount > 0) {
        const isDisabled = await exportBtn.isDisabled();
        expect(isDisabled).toBe(false);
      } else {
        console.log('No samples - export button may be disabled');
      }

      // Close modal
      const closeBtn = modal.locator('#closeSamplesModalBtn');
      await closeBtn.click();
    } else {
      console.log('No metric cards found - skipping export test');
    }
  });
});
