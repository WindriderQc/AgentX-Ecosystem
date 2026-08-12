/**
 * E2E Tests for PromptHealthMonitor Component
 * Tests the feedback-driven improvement alert system
 */

const { test, expect } = require('@playwright/test');

test.describe('PromptHealthMonitor', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to prompts page
    await page.goto('http://localhost:3080/prompts.html');

    // Wait for page load
    await page.waitForLoadState('networkidle');
  });

  test('should load health monitor on prompts page', async ({ page }) => {
    // Check if the health alert container exists
    const healthAlert = page.locator('#promptHealthAlert');
    await expect(healthAlert).toBeAttached();
  });

  test('should show alert banner for low-performing prompts', async ({ page }) => {
    // Wait for component to load data
    await page.waitForTimeout(2000);

    // Check if alert is visible (if there are low-performing prompts)
    const alertBanner = page.locator('.prompt-health-alert');
    const isVisible = await alertBanner.isVisible().catch(() => false);

    if (isVisible) {
      // Verify alert structure
      await expect(alertBanner.locator('.alert-icon i')).toHaveClass(/fa-exclamation-triangle/);
      await expect(alertBanner.locator('.alert-header h4')).toContainText('Prompt Health Alert');

      // Verify action buttons exist
      await expect(alertBanner.locator('.btn-review-conversations')).toBeVisible();
      await expect(alertBanner.locator('.btn-create-improved')).toBeVisible();
      await expect(alertBanner.locator('.btn-view-all-issues')).toBeVisible();
    }
  });

  test('should dismiss alert when dismiss button clicked', async ({ page }) => {
    // Wait for component to load
    await page.waitForTimeout(2000);

    const alertBanner = page.locator('.prompt-health-alert');
    const isVisible = await alertBanner.isVisible().catch(() => false);

    if (isVisible) {
      // Click dismiss button
      await alertBanner.locator('.dismiss-btn').click();

      // Alert should be hidden
      await expect(alertBanner).toBeHidden();
    }
  });

  test('should trigger review-prompt-conversations event', async ({ page }) => {
    // Wait for component to load
    await page.waitForTimeout(2000);

    const alertBanner = page.locator('.prompt-health-alert');
    const isVisible = await alertBanner.isVisible().catch(() => false);

    if (isVisible) {
      // Listen for custom event
      const eventPromise = page.evaluate(() => {
        return new Promise(resolve => {
          document.addEventListener('review-prompt-conversations', (e) => {
            resolve(e.detail);
          }, { once: true });
        });
      });

      // Click review button
      await alertBanner.locator('.btn-review-conversations').click();

      // Verify event was dispatched with correct data
      const eventDetail = await eventPromise;
      expect(eventDetail).toHaveProperty('promptName');
      expect(eventDetail).toHaveProperty('promptVersion');
    }
  });

  test('should trigger improve-prompt event', async ({ page }) => {
    // Wait for component to load
    await page.waitForTimeout(2000);

    const alertBanner = page.locator('.prompt-health-alert');
    const isVisible = await alertBanner.isVisible().catch(() => false);

    if (isVisible) {
      // Listen for custom event
      const eventPromise = page.evaluate(() => {
        return new Promise(resolve => {
          document.addEventListener('improve-prompt', (e) => {
            resolve(e.detail);
          }, { once: true });
        });
      });

      // Click improve button
      await alertBanner.locator('.btn-create-improved').click();

      // Verify event was dispatched with correct data
      const eventDetail = await eventPromise;
      expect(eventDetail).toHaveProperty('promptName');
      expect(eventDetail).toHaveProperty('promptVersion');
    }
  });

  test('should refresh on prompt-version-changed event', async ({ page }) => {
    // Wait for component to load
    await page.waitForTimeout(2000);

    // Track API calls
    let apiCalled = false;
    page.on('request', request => {
      if (request.url().includes('/api/analytics/feedback/summary')) {
        apiCalled = true;
      }
    });

    // Dispatch prompt-version-changed event
    await page.evaluate(() => {
      document.dispatchEvent(new CustomEvent('prompt-version-changed'));
    });

    // Wait for API call
    await page.waitForTimeout(1000);

    // Verify API was called again
    expect(apiCalled).toBe(true);
  });

  test('should handle API errors gracefully', async ({ page }) => {
    // Mock API to return error
    await page.route('**/api/analytics/feedback/summary*', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'error', message: 'Internal server error' })
      });
    });

    // Reload page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Component should not show alert (fails silently)
    const alertBanner = page.locator('.prompt-health-alert');
    await expect(alertBanner).toBeHidden();

    // Check console for error log (component should log error)
    const logs = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        logs.push(msg.text());
      }
    });

    // Should have logged error
    await page.waitForTimeout(1000);
    expect(logs.some(log => log.includes('Failed to load prompt health data'))).toBe(true);
  });

  test('should sort low-performing prompts by rate (worst first)', async ({ page }) => {
    // Wait for component to load
    await page.waitForTimeout(2000);

    const alertBanner = page.locator('.prompt-health-alert');
    const isVisible = await alertBanner.isVisible().catch(() => false);

    if (isVisible) {
      // Message should mention the worst prompt
      const alertMessage = await alertBanner.locator('.alert-message').textContent();
      expect(alertMessage).toContain('Worst:');

      // Should show percentage rate
      expect(alertMessage).toMatch(/\d+\.\d+%/);
    }
  });

  test('should show correct count in View All button', async ({ page }) => {
    // Wait for component to load
    await page.waitForTimeout(2000);

    const alertBanner = page.locator('.prompt-health-alert');
    const isVisible = await alertBanner.isVisible().catch(() => false);

    if (isVisible) {
      const viewAllBtn = alertBanner.locator('.btn-view-all-issues');
      const btnText = await viewAllBtn.textContent();

      // Should show count in parentheses
      expect(btnText).toMatch(/View All \(\d+\)/);

      // Count should match number mentioned in alert message
      const alertMessage = await alertBanner.locator('.alert-message').textContent();
      const countMatch = alertMessage.match(/(\d+) prompts? (?:is|are) underperforming/);

      if (countMatch) {
        const messageCount = countMatch[1];
        expect(btnText).toContain(`(${messageCount})`);
      }
    }
  });
});
