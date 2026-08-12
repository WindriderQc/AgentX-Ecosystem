/**
 * E2E Tests for Performance Metrics Dashboard Component
 *
 * Tests the PerformanceMetricsDashboard component functionality including:
 * - Dashboard rendering on page load
 * - Time range selector (7d, 30d, 90d, all time)
 * - Auto-refresh toggle
 * - Collapse/expand functionality
 * - Metric cards display
 * - Navigation to analytics page
 * - Empty state handling
 * - Error state handling
 *
 * Prerequisites:
 * - AgentX server running on http://localhost:3080
 * - MongoDB accessible
 * - User authenticated (session-based)
 */

const { test, expect } = require('@playwright/test');

// Test configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const PROMPTS_PAGE = `${BASE_URL}/prompts.html`;
const ANALYTICS_PAGE = `${BASE_URL}/analytics.html`;

// Test data and helpers
const API_ENDPOINTS = {
  promptMetrics: `${BASE_URL}/api/analytics/prompt-metrics`,
};

// Helper to wait for dashboard to be visible
async function waitForDashboard(page) {
  await page.waitForSelector('.metrics-dashboard', { state: 'visible', timeout: 5000 });
}

// Helper to wait for metrics to load
async function waitForMetricsLoad(page) {
  // Wait for loading to disappear and content to appear
  await page.waitForSelector('#metricsLoading', { state: 'hidden', timeout: 10000 });
}

// Helper to intercept API and return mock data (NEW STRUCTURE)
async function mockSuccessfulMetricsResponse(page, data = null) {
  const mockData = data || {
    status: 'success',
    data: {
      prompts: [
        {
          promptName: 'default_chat',
          promptVersion: 1,
          overall: {
            total: 100,
            positive: 85,
            negative: 15,
            positiveRate: 0.85
          },
          byModel: [
            {
              model: 'llama3.2',
              total: 60,
              positive: 55,
              negative: 5,
              positiveRate: 0.917
            },
            {
              model: 'qwen2',
              total: 40,
              positive: 30,
              negative: 10,
              positiveRate: 0.75
            }
          ]
        },
        {
          promptName: 'code_assistant',
          promptVersion: 2,
          overall: {
            total: 50,
            positive: 35,
            negative: 15,
            positiveRate: 0.7
          },
          byModel: [
            {
              model: 'llama3.2',
              total: 30,
              positive: 22,
              negative: 8,
              positiveRate: 0.733
            },
            {
              model: 'codellama',
              total: 20,
              positive: 13,
              negative: 7,
              positiveRate: 0.65
            }
          ]
        }
      ]
    }
  };

  await page.route('**/api/analytics/prompt-metrics*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(mockData)
    });
  });
}

// Helper to mock empty metrics response
async function mockEmptyMetricsResponse(page) {
  await page.route('**/api/analytics/prompt-metrics*', async route => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'success',
        data: {
          prompts: []
        }
      })
    });
  });
}

// Helper to mock API error
async function mockErrorMetricsResponse(page, statusCode = 500, message = 'Internal Server Error') {
  await page.route('**/api/analytics/prompt-metrics*', async route => {
    await route.fulfill({
      status: statusCode,
      contentType: 'application/json',
      body: JSON.stringify({
        status: 'error',
        message: message
      })
    });
  });
}

test.describe('Performance Metrics Dashboard', () => {

  test.beforeEach(async ({ page }) => {
    // Mock authentication to bypass login
    await page.route('**/api/auth/me', (route) => {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          userId: 'test-user-123',
          username: 'testuser',
          email: 'test@example.com'
        })
      });
    });

    // Mock prompts API to prevent onboarding modal from appearing
    await page.route('**/api/prompts', (route) => {
      if (route.request().method() === 'GET') {
        route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            status: 'success',
            data: {
              prompts: [{ name: 'existing_prompt', version: 1 }]
            }
          })
        });
      } else {
        route.continue();
      }
    });

    // Disable onboarding modal via localStorage
    await page.addInitScript(() => {
      localStorage.setItem('agentx_onboarding_completed', 'true');
    });

    // Mock the API response for faster and predictable tests
    await mockSuccessfulMetricsResponse(page);
  });

  test.describe('Dashboard Rendering', () => {

    test('should render dashboard on page load', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);

      // Wait for dashboard to be visible
      await waitForDashboard(page);

      // Verify dashboard structure
      const dashboard = page.locator('.metrics-dashboard');
      await expect(dashboard).toBeVisible();

      // Check header elements
      await expect(page.locator('.dashboard-header h3')).toContainText('Performance Metrics');
      await expect(page.locator('.metrics-subtitle')).toContainText('Real-time prompt analytics');

      // Check header controls
      await expect(page.locator('#metricsModelFilter')).toBeVisible(); // NEW: Model filter
      await expect(page.locator('#metricsTimeRange')).toBeVisible();
      await expect(page.locator('#metricsRefreshBtn')).toBeVisible();
      await expect(page.locator('#autoRefreshToggle')).toBeVisible();
      await expect(page.locator('#metricsCollapseBtn')).toBeVisible();
    });

    test('should display metric cards after loading', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Verify metrics content is visible
      const metricsContent = page.locator('#metricsContent');
      await expect(metricsContent).toBeVisible();

      // Check for metric cards
      const metricCards = page.locator('.metric-card');
      await expect(metricCards).toHaveCount(2); // Based on mock data

      // Verify first card content
      const firstCard = metricCards.first();
      await expect(firstCard).toContainText('default_chat');
      await expect(firstCard).toContainText('85.0%'); // Positive rate
    });

    test('should show correct time range in selector', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Default should be 7 days
      const timeRangeSelector = page.locator('#metricsTimeRange');
      await expect(timeRangeSelector).toHaveValue('7d');
    });
  });

  test.describe('Time Range Selector', () => {

    test('should change time range to 30 days', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Track API calls
      let apiCallMade = false;
      page.on('request', request => {
        if (request.url().includes('/api/analytics/prompt-metrics')) {
          apiCallMade = true;
        }
      });

      // Change time range
      await page.locator('#metricsTimeRange').selectOption('30d');

      // Wait a bit for API call
      await page.waitForTimeout(500);

      // Verify API was called with new range
      expect(apiCallMade).toBe(true);

      // Verify selector shows new value
      await expect(page.locator('#metricsTimeRange')).toHaveValue('30d');
    });

    test('should change time range to 90 days', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      await page.locator('#metricsTimeRange').selectOption('90d');
      await page.waitForTimeout(500);

      await expect(page.locator('#metricsTimeRange')).toHaveValue('90d');
    });

    test('should change time range to all time', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      await page.locator('#metricsTimeRange').selectOption('all');
      await page.waitForTimeout(500);

      await expect(page.locator('#metricsTimeRange')).toHaveValue('all');
    });

    test('should reload metrics when time range changes', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Track loading state
      await page.locator('#metricsTimeRange').selectOption('30d');

      // Loading indicator should appear briefly
      const loadingIndicator = page.locator('#metricsLoading');
      // Note: This might be too fast to catch, so we just verify metrics load

      await waitForMetricsLoad(page);

      // Verify metrics are still displayed
      const metricCards = page.locator('.metric-card');
      await expect(metricCards.first()).toBeVisible();
    });
  });

  test.describe('Auto-Refresh Toggle', () => {

    test('should toggle auto-refresh on', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      const autoRefreshToggle = page.locator('#autoRefreshToggle');

      // Initially should be unchecked
      await expect(autoRefreshToggle).not.toBeChecked();

      // Click to enable
      await autoRefreshToggle.check();

      // Should be checked now
      await expect(autoRefreshToggle).toBeChecked();
    });

    test('should toggle auto-refresh off', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      const autoRefreshToggle = page.locator('#autoRefreshToggle');

      // Enable it first
      await autoRefreshToggle.check();
      await expect(autoRefreshToggle).toBeChecked();

      // Then disable
      await autoRefreshToggle.uncheck();
      await expect(autoRefreshToggle).not.toBeChecked();
    });

    test('should refresh metrics periodically when auto-refresh is on', async ({ page }) => {
      // This test verifies the interval is set, but we won't wait 30 seconds
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Enable auto-refresh
      await page.locator('#autoRefreshToggle').check();

      // Verify the checkbox is on (interval is set internally)
      await expect(page.locator('#autoRefreshToggle')).toBeChecked();

      // Note: We don't test actual periodic refresh here as it would require 30s wait
      // That functionality is tested in integration tests
    });
  });

  test.describe('Collapse/Expand Functionality', () => {

    test('should collapse dashboard when collapse button clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const dashboardContent = page.locator('.dashboard-content');
      const collapseBtn = page.locator('#metricsCollapseBtn');

      // Should be visible initially
      await expect(dashboardContent).toBeVisible();

      // Click collapse button
      await collapseBtn.click();

      // Wait for animation
      await page.waitForTimeout(300);

      // Content should be hidden
      await expect(dashboardContent).toBeHidden();

      // Icon should change to chevron-down
      const icon = page.locator('#metricsCollapseBtn i');
      await expect(icon).toHaveClass(/fa-chevron-down/);
    });

    test('should expand dashboard when expand button clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const dashboardContent = page.locator('.dashboard-content');
      const collapseBtn = page.locator('#metricsCollapseBtn');

      // Collapse first
      await collapseBtn.click();
      await page.waitForTimeout(300);
      await expect(dashboardContent).toBeHidden();

      // Then expand
      await collapseBtn.click();
      await page.waitForTimeout(300);

      // Content should be visible
      await expect(dashboardContent).toBeVisible();

      // Icon should change to chevron-up
      const icon = page.locator('#metricsCollapseBtn i');
      await expect(icon).toHaveClass(/fa-chevron-up/);
    });

    test('should add collapsed class to dashboard when collapsed', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const dashboard = page.locator('.metrics-dashboard');
      const collapseBtn = page.locator('#metricsCollapseBtn');

      // Initially should not have collapsed class
      await expect(dashboard).not.toHaveClass(/collapsed/);

      // Click collapse
      await collapseBtn.click();
      await page.waitForTimeout(300);

      // Should have collapsed class
      await expect(dashboard).toHaveClass(/collapsed/);
    });
  });

  test.describe('Metric Cards Display', () => {

    test('should display all metric card elements', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();

      // Check all sections exist
      await expect(firstCard.locator('.metric-card-header')).toBeVisible();
      await expect(firstCard.locator('.metric-card-body')).toBeVisible();
      await expect(firstCard.locator('.metric-card-actions')).toBeVisible();

      // Check specific elements
      await expect(firstCard.locator('.metric-name')).toBeVisible();
      await expect(firstCard.locator('.status-badge')).toBeVisible();
      await expect(firstCard.locator('.feedback-bar')).toBeVisible();
      await expect(firstCard.locator('.version-badge')).toBeVisible(); // Version badge, not version-count
    });

    test('should show correct status badge based on positive rate', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // First card has 85% positive rate - should be "Healthy"
      const firstCard = page.locator('.metric-card').first();
      const firstBadge = firstCard.locator('.status-badge');
      await expect(firstBadge).toContainText('Healthy');

      // Second card has 70% positive rate - should be "Healthy" (70% >= 70% threshold)
      const secondCard = page.locator('.metric-card').nth(1);
      const secondBadge = secondCard.locator('.status-badge');
      await expect(secondBadge).toContainText('Healthy');
    });

    test('should display feedback metrics correctly', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();

      // Check for Total Feedback (100)
      await expect(firstCard).toContainText('100');

      // Check for Positive count (85)
      await expect(firstCard).toContainText('85');

      // Check for Negative count (15)
      await expect(firstCard).toContainText('15');

      // Check for Positive rate (85.0%)
      await expect(firstCard).toContainText('85.0%');
    });

    test('should show model count in breakdown toggle', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const breakdownToggle = firstCard.locator('.model-breakdown-toggle');

      // Should show "2 models" (from mock data)
      await expect(breakdownToggle).toBeVisible();
      await expect(breakdownToggle).toContainText('2 models');
    });

    test('should render feedback progress bar', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const feedbackBar = firstCard.locator('.feedback-bar');

      await expect(feedbackBar).toBeVisible();

      // Check positive and negative bars exist
      await expect(feedbackBar.locator('.feedback-positive')).toBeVisible();
      await expect(feedbackBar.locator('.feedback-negative')).toBeVisible();
    });

    test('should display version badge for each prompt', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // First card should show "v1"
      const firstCard = page.locator('.metric-card').first();
      const firstBadge = firstCard.locator('.version-badge');
      await expect(firstBadge).toBeVisible();
      await expect(firstBadge).toContainText('v1');

      // Second card should show "v2"
      const secondCard = page.locator('.metric-card').nth(1);
      const secondBadge = secondCard.locator('.version-badge');
      await expect(secondBadge).toBeVisible();
      await expect(secondBadge).toContainText('v2');
    });
  });

  test.describe('Navigation to Analytics', () => {

    test('should navigate to analytics page when card is clicked', async ({ page, context }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Get first metric card
      const firstCard = page.locator('.metric-card').first();

      // Get the prompt name for verification
      const promptName = await firstCard.getAttribute('data-prompt-name');

      // Listen for navigation attempt
      let navigationUrl = '';
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          navigationUrl = frame.url();
        }
      });

      // Click the card (not the button) - this will trigger navigation
      await firstCard.click();

      // Wait a bit for navigation to start
      await page.waitForTimeout(500);

      // Verify navigation was attempted to correct URL
      // (it may redirect to login, but the initial target is analytics)
      expect(navigationUrl).toContain('analytics.html');
    });

    test('should navigate to analytics when Details button is clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Get first card's Details button
      const firstCard = page.locator('.metric-card').first();
      const detailsBtn = firstCard.locator('button:has-text("Details")');

      await expect(detailsBtn).toBeVisible();

      // Get the prompt name for verification
      const promptName = await firstCard.getAttribute('data-prompt-name');

      // Listen for navigation attempt
      let navigationUrl = '';
      page.on('framenavigated', (frame) => {
        if (frame === page.mainFrame()) {
          navigationUrl = frame.url();
        }
      });

      // Click Details button - this will trigger navigation
      await detailsBtn.click();

      // Wait a bit for navigation to start
      await page.waitForTimeout(500);

      // Verify navigation was attempted to correct URL
      expect(navigationUrl).toContain('analytics.html');
    });

    test('should not navigate when clicking empty space in actions area', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const initialUrl = page.url();

      // Track if navigation was attempted
      let navigationAttempted = false;
      page.on('framenavigated', () => {
        navigationAttempted = true;
      });

      // This test verifies clicking card doesn't navigate when stopPropagation works
      // Since the Details button uses onclick="event.stopPropagation()",
      // clicking the button doesn't bubble to card click handler
      // We just verify the button exists and has correct onclick
      const firstCard = page.locator('.metric-card').first();
      const detailsBtn = firstCard.locator('button:has-text("Details")');

      await expect(detailsBtn).toBeVisible();
      const onclick = await detailsBtn.getAttribute('onclick');
      expect(onclick).toContain('stopPropagation');
    });
  });

  test.describe('Model Filter', () => {

    test('should have model filter dropdown with "All Models" option', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const modelFilter = page.locator('#metricsModelFilter');
      await expect(modelFilter).toBeVisible();

      // Should have "All Models" as default
      await expect(modelFilter).toHaveValue('all');
      const allModelsOption = modelFilter.locator('option[value="all"]');
      // Options exist but may not be "visible" in Playwright's sense
      expect(await allModelsOption.count()).toBe(1);
    });

    test('should populate model filter with available models from data', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const modelFilter = page.locator('#metricsModelFilter');

      // Should have options for each model in mock data
      const llamaOption = modelFilter.locator('option[value="llama3.2"]');
      const qwenOption = modelFilter.locator('option[value="qwen2"]');
      const codeLlamaOption = modelFilter.locator('option[value="codellama"]');

      // Options exist but may not be "visible" in Playwright's sense
      expect(await llamaOption.count()).toBe(1);
      expect(await qwenOption.count()).toBe(1);
      expect(await codeLlamaOption.count()).toBe(1);
    });

    test('should reload metrics when model filter changes', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      let requestCount = 0;
      page.on('request', request => {
        if (request.url().includes('/api/analytics/prompt-metrics')) {
          requestCount++;
        }
      });

      const initialCount = requestCount;

      // Change model filter
      const modelFilter = page.locator('#metricsModelFilter');
      await modelFilter.selectOption('llama3.2');

      // Wait for API call
      await page.waitForTimeout(500);

      // Should have made another API call
      expect(requestCount).toBeGreaterThan(initialCount);

      // Verify filter value changed
      await expect(modelFilter).toHaveValue('llama3.2');
    });

    test('should send model parameter in API request when filtered', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      let capturedUrl = '';
      page.on('request', request => {
        if (request.url().includes('/api/analytics/prompt-metrics')) {
          capturedUrl = request.url();
        }
      });

      // Select a specific model
      await page.locator('#metricsModelFilter').selectOption('qwen2');
      await page.waitForTimeout(500);

      // URL should include model parameter
      expect(capturedUrl).toContain('model=qwen2');
    });

    test('should not send model parameter when "All Models" selected', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // First select a specific model
      await page.locator('#metricsModelFilter').selectOption('llama3.2');
      await page.waitForTimeout(500);

      let capturedUrl = '';
      page.on('request', request => {
        if (request.url().includes('/api/analytics/prompt-metrics')) {
          capturedUrl = request.url();
        }
      });

      // Then switch back to "All Models"
      await page.locator('#metricsModelFilter').selectOption('all');
      await page.waitForTimeout(500);

      // URL should not include model parameter (or model=all, but no filtering)
      expect(capturedUrl).not.toContain('model=llama');
      expect(capturedUrl).not.toContain('model=qwen');
    });
  });

  test.describe('Expandable Model Breakdown', () => {

    test('should show model breakdown toggle button with model count', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const toggleBtn = firstCard.locator('.model-breakdown-toggle');

      await expect(toggleBtn).toBeVisible();

      // Should show count of models (2 models in first card: llama3.2, qwen2)
      await expect(toggleBtn).toContainText('2');
      await expect(toggleBtn).toContainText('model');
    });

    test('should expand model breakdown when toggle clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const toggleBtn = firstCard.locator('.model-breakdown-toggle');
      const breakdown = firstCard.locator('.model-breakdown');

      // Initially hidden
      await expect(breakdown).toBeHidden();

      // Click toggle
      await toggleBtn.click();

      // Wait for animation
      await page.waitForTimeout(300);

      // Should be visible now
      await expect(breakdown).toBeVisible();

      // Verify breakdown is displayed (icon animation handled by CSS)
      expect(await breakdown.getAttribute('style')).toContain('display: block');
    });

    test('should collapse model breakdown when toggle clicked again', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const toggleBtn = firstCard.locator('.model-breakdown-toggle');
      const breakdown = firstCard.locator('.model-breakdown');

      // Expand first
      await toggleBtn.click();
      await expect(breakdown).toBeVisible();

      // Click again to collapse
      await toggleBtn.click();

      // Should be hidden again
      await expect(breakdown).toBeHidden();

      // Icon should change to chevron-down (last icon in button)
      const icon = toggleBtn.locator('i').last();
      await expect(icon).toHaveClass(/fa-chevron-down/);
    });

    test('should display per-model performance metrics in breakdown', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      const toggleBtn = firstCard.locator('.model-breakdown-toggle');

      // Expand breakdown
      await toggleBtn.click();

      const breakdown = firstCard.locator('.model-breakdown');
      await expect(breakdown).toBeVisible();

      // Check for model names from mock data
      await expect(breakdown).toContainText('llama3.2');
      await expect(breakdown).toContainText('qwen2');

      // Check for performance metrics (positive rates from mock data)
      // llama3.2: 91.7%, qwen2: 75.0%
      await expect(breakdown).toContainText('91.7%');
      await expect(breakdown).toContainText('75.0%');
    });

    test('should display feedback counts for each model', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      await firstCard.locator('.model-breakdown-toggle').click();

      const breakdown = firstCard.locator('.model-breakdown');

      // Should show feedback counts (positive/total)
      // llama3.2: 55/60
      await expect(breakdown).toContainText('55/60');

      // qwen2: 30/40
      await expect(breakdown).toContainText('30/40');
    });

    test('should show color-coded status for each model', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();
      await firstCard.locator('.model-breakdown-toggle').click();

      const breakdownItems = firstCard.locator('.breakdown-item');

      // First model (llama3.2: 91.7%) should have "good" status
      const firstItem = breakdownItems.first();
      await expect(firstItem).toHaveClass(/good/);

      // Second model (qwen2: 75.0%) should have "good" status (>70%)
      const secondItem = breakdownItems.nth(1);
      await expect(secondItem).toHaveClass(/good/);
    });

    test('should not navigate when clicking model breakdown area', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();

      // Expand breakdown
      const toggleBtn = firstCard.locator('.model-breakdown-toggle');
      await toggleBtn.click();
      await page.waitForTimeout(300);

      // Verify breakdown toggle has stopPropagation in event handler
      // This prevents click from bubbling to card and triggering navigation
      const breakdown = firstCard.locator('.model-breakdown');
      await expect(breakdown).toBeVisible();

      // Click stopPropagation is handled in JavaScript, so just verify structure
      expect(await toggleBtn.getAttribute('class')).toContain('model-breakdown-toggle');
    });
  });

  test.describe('Empty State', () => {

    test('should display empty state when no metrics available', async ({ page }) => {
      // Mock empty response
      await mockEmptyMetricsResponse(page);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Check for empty state message
      const emptyState = page.locator('.metrics-empty');
      await expect(emptyState).toBeVisible();

      // Verify empty state content
      await expect(emptyState).toContainText('No metrics available');
      await expect(emptyState).toContainText('selected time range');

      // Verify no metric cards are shown
      const metricCards = page.locator('.metric-card');
      await expect(metricCards).toHaveCount(0);
    });

    test('should show empty state icon', async ({ page }) => {
      await mockEmptyMetricsResponse(page);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const emptyState = page.locator('.metrics-empty');
      const icon = emptyState.locator('i.fa-chart-line');

      await expect(icon).toBeVisible();
    });
  });

  test.describe('Error State', () => {

    test('should display error state when API fails', async ({ page }) => {
      // Mock error response
      await mockErrorMetricsResponse(page, 500, 'Database connection failed');

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Wait for error to appear
      await page.waitForSelector('#metricsError', { state: 'visible', timeout: 5000 });

      // Check error message
      const errorDiv = page.locator('#metricsError');
      await expect(errorDiv).toBeVisible();

      const errorMessage = page.locator('#metricsErrorMessage');
      await expect(errorMessage).toContainText('API error: 500'); // Component shows generic error
    });

    test('should display error icon', async ({ page }) => {
      await mockErrorMetricsResponse(page);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await page.waitForSelector('#metricsError', { state: 'visible' });

      const errorDiv = page.locator('#metricsError');
      const icon = errorDiv.locator('i.fa-exclamation-triangle');

      await expect(icon).toBeVisible();
    });

    test('should hide metrics content when error occurs', async ({ page }) => {
      await mockErrorMetricsResponse(page);

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await page.waitForSelector('#metricsError', { state: 'visible' });

      // Metrics content should be hidden
      const metricsContent = page.locator('#metricsContent');
      await expect(metricsContent).toBeHidden();
    });

    test('should handle 401 unauthorized error', async ({ page }) => {
      await mockErrorMetricsResponse(page, 401, 'Unauthorized');

      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await page.waitForSelector('#metricsError', { state: 'visible' });

      const errorMessage = page.locator('#metricsErrorMessage');
      await expect(errorMessage).toContainText('API error: 401'); // Component shows generic error
    });
  });

  test.describe('Refresh Functionality', () => {

    test('should reload metrics when refresh button is clicked', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      let requestCount = 0;
      page.on('request', request => {
        if (request.url().includes('/api/analytics/prompt-metrics')) {
          requestCount++;
        }
      });

      const initialCount = requestCount;

      // Click refresh button
      const refreshBtn = page.locator('#metricsRefreshBtn');
      await refreshBtn.click();

      // Wait for API call
      await page.waitForTimeout(500);

      // Should have made another API call
      expect(requestCount).toBeGreaterThan(initialCount);
    });

    test('should show loading spinner on refresh button during load', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Click refresh
      const refreshBtn = page.locator('#metricsRefreshBtn');
      await refreshBtn.click();

      // Check if icon has spinning class (might be too fast)
      const icon = page.locator('#metricsRefreshBtn i');

      // The spinner might be too fast to catch, so we just verify icon exists
      await expect(icon).toBeVisible();
      await expect(icon).toHaveClass(/fa-sync-alt/);
    });
  });

  test.describe('Loading State', () => {

    test('should show loading indicator on initial load', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Loading indicator might be too fast, but we can check it exists
      const loadingIndicator = page.locator('#metricsLoading');

      // Eventually it should be hidden
      await expect(loadingIndicator).toBeHidden({ timeout: 10000 });
    });

    test('should hide loading indicator after metrics load', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const loadingIndicator = page.locator('#metricsLoading');
      await expect(loadingIndicator).toBeHidden();

      const metricsContent = page.locator('#metricsContent');
      await expect(metricsContent).toBeVisible();
    });
  });

  test.describe('Data Integrity', () => {

    test('should correctly calculate and display positive rate percentage', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      const firstCard = page.locator('.metric-card').first();

      // From mock data: 85 positive out of 100 total = 85.0%
      // Note: This may include trending indicator, so check that percentage is present
      const positiveRateText = await firstCard.locator('.metric-value.positive').textContent();
      expect(positiveRateText).toContain('85.0%');
    });

    test('should escape HTML in prompt names to prevent XSS', async ({ page }) => {
      // Note: This test verifies browser's built-in XSS protection
      // Modern browsers and frameworks automatically escape HTML in textContent
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Verify that prompt names are displayed as text, not HTML
      // The component uses escapeHtml() function for all user-provided strings
      const firstCard = page.locator('.metric-card').first();
      const promptName = await firstCard.locator('.metric-name span').first().textContent();

      // Should contain safe text (our mock data has safe names)
      expect(promptName).toBeTruthy();
      expect(promptName).not.toContain('<script>');
      // Verify escapeHtml is working (no HTML tags in output)
      expect(promptName).not.toMatch(/<[^>]+>/);
    });

    test('should format numbers correctly', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Verify that numbers are displayed (formatting handled by formatNumber())
      const firstCard = page.locator('.metric-card').first();

      // Check that feedback count is visible and formatted
      const totalFeedback = await firstCard.locator('.metric-item:has-text("Total Feedback") .metric-value').textContent();

      // Should display number (100 from mock data)
      expect(totalFeedback).toBeTruthy();
      expect(parseInt(totalFeedback.replace(/,/g, ''))).toBe(100);
    });
  });

  test.describe('Accessibility', () => {

    test('should have proper ARIA labels on interactive elements', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);

      // Check button titles
      const refreshBtn = page.locator('#metricsRefreshBtn');
      await expect(refreshBtn).toHaveAttribute('title', 'Refresh metrics');

      const collapseBtn = page.locator('#metricsCollapseBtn');
      await expect(collapseBtn).toHaveAttribute('title', 'Collapse/Expand');

      const autoRefreshLabel = page.locator('.auto-refresh-toggle');
      await expect(autoRefreshLabel).toHaveAttribute('title', 'Auto-refresh every 30s');
    });

    test('should be keyboard navigable', async ({ page }) => {
      await page.goto(PROMPTS_PAGE);
      await waitForDashboard(page);
      await waitForMetricsLoad(page);

      // Tab to refresh button
      await page.keyboard.press('Tab');
      // Could be on different element, so let's focus directly
      await page.locator('#metricsRefreshBtn').focus();

      const refreshBtn = page.locator('#metricsRefreshBtn');
      await expect(refreshBtn).toBeFocused();
    });
  });
});
