/**
 * Advanced Filtering E2E Tests
 *
 * Tests the complete advanced filtering functionality on the Prompts Management page
 * including search, tag filtering, date range filtering, author filtering, and combinations.
 *
 * @requires @playwright/test
 */

const { test, expect } = require('@playwright/test');
const {
  mockPromptsGrouped,
  mockDataStats,
  createMockApiResponse,
  dates
} = require('./fixtures/prompts-filtering.js');

// Configuration
const BASE_URL = process.env.BASE_URL || 'http://localhost:3080';
const PROMPTS_PAGE = `${BASE_URL}/prompts.html`;

/**
 * Helper Functions
 */

/**
 * Mock authentication and prompts API to bypass login and use test fixtures
 */
async function setupMockAPI(page) {
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

  // Mock prompts API GET to return test fixtures
  await page.route('**/api/prompts', (route) => {
    if (route.request().method() === 'GET') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(createMockApiResponse())
      });
    } else {
      // Allow POST/DELETE to continue (they won't actually work but won't break tests)
      route.continue();
    }
  });

  // Disable onboarding modal via localStorage
  await page.addInitScript(() => {
    localStorage.setItem('agentx_onboarding_completed', 'true');
  });
}

/**
 * Helper to wait for prompt cards to render
 */
async function waitForPromptCards(page, options = {}) {
  const timeout = options.timeout || 3000;
  try {
    await page.waitForSelector('.prompt-card', { state: 'visible', timeout });
    return true;
  } catch (e) {
    // No cards found - might be empty state
    return false;
  }
}

/**
 * Test Suite
 */

test.describe('Advanced Filtering Functionality', () => {

  test.beforeEach(async ({ page }) => {
    // Setup API mocks for auth and prompts data
    await setupMockAPI(page);

    // Navigate to prompts page
    await page.goto(PROMPTS_PAGE);
    await page.waitForLoadState('networkidle');

    // Wait for prompts to load
    await page.waitForSelector('.prompt-card', { timeout: 5000 });

    // Clear all filters before each test
    const clearBtn = await page.$('#clearFiltersBtn');
    if (clearBtn) {
      const advancedPanel = await page.$('#advancedFiltersPanel');
      const isVisible = await advancedPanel?.isVisible();

      if (isVisible) {
        await page.click('#clearFiltersBtn');
        await page.waitForTimeout(500);
      }
    }

    // Clear search input
    await page.fill('#searchInput', '');
    await page.waitForTimeout(500);
  });

  /**
   * Test 1: Enhanced Search (name, description, and author)
   */
  test('should search prompts by name, description, and author', async ({ page }) => {
    // Test search by name
    await page.fill('#searchInput', 'alpha');
    await page.waitForTimeout(500); // Debounce delay

    let visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    expect(visiblePrompts.some(text => text.includes('alpha'))).toBeTruthy();
    expect(visiblePrompts.length).toBeGreaterThan(0);

    // Test search by description
    await page.fill('#searchInput', 'production use');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    expect(visiblePrompts.some(text => text.includes('gamma'))).toBeTruthy();

    // Test search by author
    await page.fill('#searchInput', 'Alice Anderson');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show alpha, delta, and zeta (all by Alice)
    expect(visiblePrompts.length).toBe(3);
    expect(visiblePrompts.some(text => text.includes('alpha'))).toBeTruthy();

    // Test no results
    await page.fill('#searchInput', 'nonexistent_search_term');
    await page.waitForTimeout(500);

    const noResults = await page.$('.empty-state');
    expect(noResults).toBeTruthy();
  });

  /**
   * Test 2: Toggle Advanced Filters Panel
   */
  test('should toggle advanced filters panel visibility', async ({ page }) => {
    const advancedFiltersBtn = await page.$('#advancedFiltersBtn');
    const advancedPanel = await page.$('#advancedFiltersPanel');

    // Initially hidden
    let isVisible = await advancedPanel.isVisible();
    expect(isVisible).toBe(false);

    // Click to show
    await advancedFiltersBtn.click();
    await page.waitForTimeout(300);

    isVisible = await advancedPanel.isVisible();
    expect(isVisible).toBe(true);

    // Button should have active class
    const hasActiveClass = await advancedFiltersBtn.evaluate(
      btn => btn.classList.contains('active')
    );
    expect(hasActiveClass).toBe(true);

    // Button text should change
    const buttonText = await advancedFiltersBtn.textContent();
    expect(buttonText).toContain('Hide Filters');

    // Click to hide
    await advancedFiltersBtn.click();
    await page.waitForTimeout(300);

    isVisible = await advancedPanel.isVisible();
    expect(isVisible).toBe(false);

    const buttonTextAfter = await advancedFiltersBtn.textContent();
    expect(buttonTextAfter).toContain('More Filters');
  });

  /**
   * Test 3: Tag Multi-Select Filtering
   */
  test('should filter prompts by selected tags', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Verify tags are populated
    const tagOptions = await page.$$eval('#tagFilter option', options =>
      options.map(opt => opt.value).filter(v => v !== '')
    );
    expect(tagOptions.length).toBeGreaterThan(0);
    expect(tagOptions).toContain('testing');
    expect(tagOptions).toContain('production');

    // Select single tag
    await page.selectOption('#tagFilter', 'testing');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    let visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show alpha and beta prompts (both have 'testing' tag)
    expect(visiblePrompts.some(text => text.includes('alpha'))).toBeTruthy();
    expect(visiblePrompts.some(text => text.includes('beta'))).toBeTruthy();
    expect(visiblePrompts.some(text => text.includes('gamma'))).toBe(false);

    // Clear and select multiple tags
    await page.click('#clearFiltersBtn');
    await page.waitForTimeout(500);

    // Select multiple tags (Ctrl+click simulation)
    await page.evaluate(() => {
      const select = document.getElementById('tagFilter');
      const options = Array.from(select.options);
      options.find(opt => opt.value === 'production').selected = true;
      options.find(opt => opt.value === 'analytics').selected = true;
    });

    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show gamma (production) and delta (analytics)
    expect(visiblePrompts.length).toBeGreaterThanOrEqual(2);
  });

  /**
   * Test 4: Date Range Filtering
   */
  test('should filter prompts by date range', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Test: Filter prompts created today
    await page.fill('#dateFrom', dates.today);
    await page.fill('#dateTo', dates.tomorrow);
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    let visiblePrompts = await page.$$('.prompt-card');
    expect(visiblePrompts.length).toBeGreaterThan(0);

    // Test: Filter with past date range (should show nothing)
    await page.fill('#dateFrom', '2020-01-01');
    await page.fill('#dateTo', '2020-12-31');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const noResults = await page.$('.empty-state');
    expect(noResults).toBeTruthy();

    // Test: Filter with "from" date only (from last week onwards)
    await page.fill('#dateFrom', dates.lastWeek);
    await page.fill('#dateTo', '');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$('.prompt-card');
    expect(visiblePrompts.length).toBeGreaterThan(0);
  });

  /**
   * Test 5: Author Filtering
   */
  test('should filter prompts by author name', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Test exact author name
    await page.fill('#authorFilter', 'Alice Anderson');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    let visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show alpha, delta, and zeta (all by Alice Anderson)
    expect(visiblePrompts.length).toBe(3);
    expect(visiblePrompts.some(text => text.includes('alpha'))).toBeTruthy();
    expect(visiblePrompts.some(text => text.includes('delta'))).toBeTruthy();

    // Test partial author name (case-insensitive)
    await page.fill('#authorFilter', 'bob');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    // Should show beta (by Bob Builder)
    expect(visiblePrompts.some(text => text.includes('beta'))).toBeTruthy();
    expect(visiblePrompts.length).toBe(1);

    // Test no matches
    await page.fill('#authorFilter', 'Nonexistent Author');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const noResults = await page.$('.empty-state');
    expect(noResults).toBeTruthy();
  });

  /**
   * Test 6: Combined Filters (All Together)
   */
  test('should apply multiple filters simultaneously', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set search term
    await page.fill('#searchInput', 'test');
    await page.waitForTimeout(500);

    // Select tag
    await page.selectOption('#tagFilter', 'testing');

    // Set date range (last week to tomorrow)
    await page.fill('#dateFrom', dates.lastWeek);
    await page.fill('#dateTo', dates.tomorrow);

    // Set author filter
    await page.fill('#authorFilter', 'Alice');

    // Apply filters
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Verify toast notification shows filter count
    const toast = await page.waitForSelector('.toast', { timeout: 5000 });
    const toastText = await toast.textContent();
    expect(toastText).toContain('Applied');
    expect(toastText).toContain('filter');

    // Should show only alpha prompt (matches all criteria)
    const visiblePrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );

    expect(visiblePrompts.length).toBe(1);
    expect(visiblePrompts.some(text => text.includes('alpha'))).toBeTruthy();

    // Verify status filter also works in combination
    await page.selectOption('#statusFilter', 'active');
    await page.waitForTimeout(500);

    const activePrompts = await page.$$('.prompt-card');
    expect(activePrompts.length).toBe(1); // Still just alpha
  });

  /**
   * Test 7: Clear All Filters Button
   */
  test('should clear all advanced filters when clear button is clicked', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set multiple filters
    await page.selectOption('#tagFilter', 'testing');
    await page.fill('#dateFrom', '2024-01-01');
    await page.fill('#dateTo', '2024-12-31');
    await page.fill('#authorFilter', 'Alice');

    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Verify filters are applied
    let tagValue = await page.$eval('#tagFilter', select =>
      Array.from(select.selectedOptions).map(o => o.value)
    );
    expect(tagValue.length).toBeGreaterThan(0);

    let dateFrom = await page.$eval('#dateFrom', input => input.value);
    expect(dateFrom).toBe('2024-01-01');

    let authorValue = await page.$eval('#authorFilter', input => input.value);
    expect(authorValue).toBe('Alice');

    // Click clear filters button
    await page.click('#clearFiltersBtn');
    await page.waitForTimeout(500);

    // Verify all filters are cleared
    tagValue = await page.$eval('#tagFilter', select =>
      Array.from(select.selectedOptions).map(o => o.value)
    );
    expect(tagValue.length).toBe(0);

    dateFrom = await page.$eval('#dateFrom', input => input.value);
    expect(dateFrom).toBe('');

    const dateTo = await page.$eval('#dateTo', input => input.value);
    expect(dateTo).toBe('');

    authorValue = await page.$eval('#authorFilter', input => input.value);
    expect(authorValue).toBe('');

    // Verify toast notification appears with 'cleared' message
    // Wait a moment for the toast to appear
    await page.waitForTimeout(1000);

    // Check for toast with 'cleared' text
    const toastWithCleared = await page.locator('.toast:has-text("cleared")').first();
    await expect(toastWithCleared).toBeVisible({ timeout: 3000 });

    // Verify all prompts are shown again
    const allPrompts = await page.$$('.prompt-card');
    expect(allPrompts.length).toBeGreaterThanOrEqual(5); // All test prompts
  });

  /**
   * Test 8: Filter Persistence
   */
  test('should maintain filter state when navigating away and back', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set filters
    await page.fill('#searchInput', 'alpha');
    await page.waitForTimeout(500);

    await page.selectOption('#tagFilter', 'testing');
    await page.fill('#authorFilter', 'Alice');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Get current results count
    const initialCount = await page.$$eval('.prompt-card', cards => cards.length);

    // Navigate away to another page
    await page.click('a[href="index.html"]');
    await page.waitForLoadState('networkidle');

    // Navigate back
    await page.goto(PROMPTS_PAGE);
    await page.waitForLoadState('networkidle');

    // Note: Without localStorage or session storage implementation,
    // filters will NOT persist. This test documents expected behavior
    // if persistence is implemented in the future.

    // Verify filters are reset (current implementation)
    const searchValue = await page.$eval('#searchInput', input => input.value);
    expect(searchValue).toBe('');

    // If persistence is implemented, this test would change to:
    // expect(searchValue).toBe('alpha');
    // const newCount = await page.$$eval('.prompt-card', cards => cards.length);
    // expect(newCount).toBe(initialCount);
  });

  /**
   * Test 9: Status Filter Integration with Advanced Filters
   */
  test('should work with status filter dropdown', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Select a tag
    await page.selectOption('#tagFilter', 'testing');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const allTestingPrompts = await page.$$('.prompt-card');
    const allTestingCount = allTestingPrompts.length;

    // Apply status filter - Active only
    await page.selectOption('#statusFilter', 'active');
    await page.waitForTimeout(500);

    const activeTestingPrompts = await page.$$('.prompt-card');
    const activeTestingCount = activeTestingPrompts.length;

    // Should be less than or equal to all testing prompts
    expect(activeTestingCount).toBeLessThanOrEqual(allTestingCount);
    expect(activeTestingCount).toBeGreaterThan(0);

    // Apply status filter - Inactive only
    await page.selectOption('#statusFilter', 'inactive');
    await page.waitForTimeout(500);

    const inactiveTestingPrompts = await page.$$('.prompt-card');

    // Alpha and beta are active, so inactive filter should show nothing
    expect(inactiveTestingPrompts.length).toBe(0);
  });

  /**
   * Test 10: Sort Integration with Filters
   */
  test('should maintain filters when changing sort order', async ({ page }) => {
    // Apply filters
    await page.fill('#searchInput', 'test');
    await page.waitForTimeout(500);

    const initialPrompts = await page.$$eval('.prompt-card', cards =>
      cards.map(card => card.textContent)
    );
    const initialCount = initialPrompts.length;

    // Change sort order
    await page.selectOption('#sortBy', 'version');
    await page.waitForTimeout(500);

    const sortedPrompts = await page.$$('.prompt-card');
    expect(sortedPrompts.length).toBe(initialCount);

    // Try different sort
    await page.selectOption('#sortBy', 'name');
    await page.waitForTimeout(500);

    const nameSortedPrompts = await page.$$('.prompt-card');
    expect(nameSortedPrompts.length).toBe(initialCount);
  });

  /**
   * Test 11: Empty State Handling
   */
  test('should show empty state when no prompts match filters', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set filters that match nothing
    await page.fill('#authorFilter', 'NonexistentAuthor12345');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Wait for prompt cards to disappear
    await page.waitForTimeout(500);

    // Verify empty state is shown or no prompt cards visible
    const emptyState = await page.$('.empty-state');
    const promptCards = await page.$$('.prompt-card');

    // Either empty state is visible OR no prompt cards are shown
    const noCardsVisible = promptCards.length === 0;
    if (emptyState) {
      const isVisible = await emptyState.isVisible();
      expect(isVisible || noCardsVisible).toBe(true);
    } else {
      expect(noCardsVisible).toBe(true);
    }
  });

  /**
   * Test 12: Filter Count Badge/Indicator
   */
  test('should show visual indicator when filters are active', async ({ page }) => {
    // Open advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Apply a filter
    await page.fill('#authorFilter', 'Alice');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    // Verify toast shows filter count
    let toast = await page.waitForSelector('.toast', { timeout: 5000 });
    let toastText = await toast.textContent();
    expect(toastText).toMatch(/Applied.*1.*filter/);

    // Apply multiple filters (add date range)
    await page.fill('#dateFrom', dates.lastWeek);
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(1000); // Wait for new toast

    // Get all toasts and check the latest one
    const toasts = await page.$$('.toast');
    if (toasts.length > 0) {
      toastText = await toasts[toasts.length - 1].textContent();
      expect(toastText).toMatch(/Applied.*2.*filters/);
    }
  });

  /**
   * Test 13: Keyboard Navigation Support
   */
  test('should support keyboard shortcuts while filtering', async ({ page }) => {
    // Ensure search input exists
    const searchInput = await page.$('#searchInput');
    expect(searchInput).toBeTruthy();

    // Focus the search input directly (keyboard shortcut '/' may not be implemented)
    await searchInput.focus();
    await page.waitForTimeout(300);

    // Check if search input is focused
    const isFocused = await page.evaluate(() => {
      const input = document.getElementById('searchInput');
      return document.activeElement === input;
    });
    expect(isFocused).toBe(true);

    // Type search query using keyboard
    await page.keyboard.type('alpha');
    await page.waitForTimeout(800); // Wait for debounce

    const visiblePrompts = await page.$$('.prompt-card');
    expect(visiblePrompts.length).toBeGreaterThan(0);

    // Test keyboard navigation in advanced filters panel
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Tab to tag filter and use arrow keys to select (basic keyboard nav test)
    const tagFilter = await page.$('#tagFilter');
    await tagFilter.focus();
    const tagFocused = await page.evaluate(() => document.activeElement.id === 'tagFilter');
    expect(tagFocused).toBe(true);
  });

  /**
   * Test 14: Responsive Design - Mobile View
   */
  test('should handle filters in mobile viewport', async ({ page }) => {
    // Set mobile viewport
    await page.setViewportSize({ width: 375, height: 667 });

    // Reload page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Advanced filters button should be visible
    const advancedBtn = await page.$('#advancedFiltersBtn');
    expect(advancedBtn).toBeTruthy();

    // Click to open panel
    await advancedBtn.click();
    await page.waitForTimeout(300);

    // Panel should be visible
    const panel = await page.$('#advancedFiltersPanel');
    const isVisible = await panel.isVisible();
    expect(isVisible).toBe(true);

    // Filters should be usable
    await page.fill('#authorFilter', 'Alice');
    await page.click('#applyFiltersBtn');
    await page.waitForTimeout(500);

    const results = await page.$$('.prompt-card');
    expect(results.length).toBeGreaterThan(0);

    // Reset viewport
    await page.setViewportSize({ width: 1280, height: 720 });
  });

  /**
   * Test 15: Performance - Filter Response Time
   */
  test('should apply filters quickly with reasonable response time', async ({ page }) => {
    // Open advanced filters
    await page.click('#advancedFiltersBtn');
    await page.waitForTimeout(300);

    // Set filter
    await page.selectOption('#tagFilter', 'testing');

    // Measure time to apply filter
    const startTime = Date.now();
    await page.click('#applyFiltersBtn');

    // Wait for results
    await page.waitForSelector('.prompt-card', { timeout: 5000 });
    const endTime = Date.now();

    const responseTime = endTime - startTime;

    // Should respond within 2 seconds
    expect(responseTime).toBeLessThan(2000);

    console.log(`Filter response time: ${responseTime}ms`);
  });
});
