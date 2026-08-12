# Advanced Filtering E2E Tests - Comprehensive Guide

This document provides detailed information about the Advanced Filtering E2E test suite for AgentX Prompt Management.

## Overview

The `advanced-filtering.spec.js` test suite validates all filtering functionality on the Prompts Management page (`/prompts.html`), ensuring users can effectively search, filter, and manage their prompt library.

## Test Coverage Summary

| Test # | Feature | Status | Priority |
|--------|---------|--------|----------|
| 1 | Enhanced Search (name, description, author) | ✅ Complete | High |
| 2 | Toggle Advanced Filters Panel | ✅ Complete | High |
| 3 | Tag Multi-Select Filtering | ✅ Complete | High |
| 4 | Date Range Filtering | ✅ Complete | Medium |
| 5 | Author Filtering | ✅ Complete | Medium |
| 6 | Combined Filters (all together) | ✅ Complete | High |
| 7 | Clear All Filters Button | ✅ Complete | High |
| 8 | Filter Persistence | 📝 Documented | Low |
| 9 | Status Filter Integration | ✅ Complete | High |
| 10 | Sort Integration with Filters | ✅ Complete | Medium |
| 11 | Empty State Handling | ✅ Complete | Medium |
| 12 | Filter Count Badge/Indicator | ✅ Complete | Low |
| 13 | Keyboard Navigation Support | ✅ Complete | Low |
| 14 | Responsive Design - Mobile View | ✅ Complete | Medium |
| 15 | Performance - Response Time | ✅ Complete | High |

**Total: 15 test scenarios** covering all major filtering functionality

## Quick Start

### Run Tests

```bash
# Using npm scripts (recommended)
npm run test:e2e:filtering              # Run in headless mode
npm run test:e2e:filtering:headed       # Run with visible browser
npm run test:e2e:filtering:debug        # Run in debug mode

# Using shell script
./run-advanced-filtering-tests.sh              # Headless Chromium
./run-advanced-filtering-tests.sh --headed     # Headed mode
./run-advanced-filtering-tests.sh --ui         # Interactive UI mode
./run-advanced-filtering-tests.sh --debug      # Debug mode

# Using Playwright directly
npx playwright test advanced-filtering.spec.js
npx playwright test advanced-filtering.spec.js --headed
npx playwright test advanced-filtering.spec.js --debug
```

### View Results

```bash
# View HTML report
npx playwright show-report

# View specific test results
npx playwright test advanced-filtering.spec.js --reporter=list
```

## Test Data

The test suite automatically creates the following test prompts:

### Test Prompt: alpha
- **Name**: `test_prompt_alpha`
- **Author**: Alice Anderson
- **Tags**: testing, alpha, development
- **Description**: Test prompt for alpha testing
- **Status**: Active
- **System Prompt**: "You are a helpful alpha testing assistant."

### Test Prompt: beta
- **Name**: `test_prompt_beta`
- **Author**: Bob Builder
- **Tags**: testing, beta, qa
- **Description**: Test prompt for beta testing
- **Status**: Active
- **System Prompt**: "You are a helpful beta testing assistant."

### Test Prompt: gamma
- **Name**: `test_prompt_gamma`
- **Author**: Charlie Chen
- **Tags**: production, stable
- **Description**: Test prompt for production use
- **Status**: Inactive
- **System Prompt**: "You are a helpful production assistant."

### Test Prompt: delta
- **Name**: `test_prompt_delta`
- **Author**: Alice Anderson
- **Tags**: analytics, advanced
- **Description**: Advanced AI assistant for delta wave analysis
- **Status**: Active
- **System Prompt**: "You are a specialized delta wave analysis assistant."

### Test Prompt: epsilon
- **Name**: `test_prompt_epsilon`
- **Author**: Eve Everson
- **Tags**: customer-service, support
- **Description**: Customer service helper
- **Status**: Inactive
- **System Prompt**: "You are a customer service assistant."

## Detailed Test Descriptions

### Test 1: Enhanced Search

**Purpose**: Validate search functionality across name, description, and author fields

**Test Cases**:
- Search by prompt name (e.g., "alpha")
- Search by description text (e.g., "production use")
- Search by author name (e.g., "Alice Anderson")
- Search with no results (e.g., "nonexistent_search_term")

**Assertions**:
- Matching prompts are displayed
- Non-matching prompts are hidden
- Empty state shown when no results
- Search is case-insensitive
- Debounce delay (300ms) is respected

### Test 2: Toggle Advanced Filters Panel

**Purpose**: Ensure the advanced filters panel can be shown/hidden

**Test Cases**:
- Panel initially hidden
- Click button to show panel
- Button shows "Hide Filters" text when open
- Button has "active" class when open
- Click button to hide panel
- Button shows "More Filters" text when closed

**Assertions**:
- Panel visibility toggles correctly
- Button UI updates appropriately
- Animation/transition completes

### Test 3: Tag Multi-Select Filtering

**Purpose**: Validate tag filtering with single and multiple selections

**Test Cases**:
- Tag dropdown is populated from prompts
- Select single tag (e.g., "testing")
- Results show only prompts with that tag
- Select multiple tags (Ctrl+click)
- Results show prompts with ANY selected tag (OR logic)
- Clear tag selections

**Assertions**:
- All unique tags appear in dropdown
- Filtering logic is correct
- Multi-select works properly
- Results update on apply

### Test 4: Date Range Filtering

**Purpose**: Validate date range filtering for prompt creation dates

**Test Cases**:
- Filter with both from and to dates
- Filter with only from date (open-ended)
- Filter with only to date
- Filter with impossible date range (no results)
- Date range includes end of day (23:59:59)

**Assertions**:
- Prompts within range are shown
- Prompts outside range are hidden
- Empty state for no matches
- Date parsing handles edge cases

### Test 5: Author Filtering

**Purpose**: Validate author name filtering

**Test Cases**:
- Filter by exact author name (e.g., "Alice Anderson")
- Filter by partial author name (e.g., "bob")
- Case-insensitive matching
- Filter with no matches

**Assertions**:
- Matching prompts are shown
- Filtering is case-insensitive
- Partial matches work
- Empty state for no results

### Test 6: Combined Filters

**Purpose**: Ensure all filters work together simultaneously

**Test Cases**:
- Apply search + tag + date + author filters
- Verify toast notification shows filter count
- Results match ALL criteria (AND logic)
- Status filter also works with advanced filters

**Assertions**:
- All filters applied correctly
- Results meet all criteria
- Toast shows correct filter count
- UI remains responsive

### Test 7: Clear All Filters

**Purpose**: Validate clear filters functionality

**Test Cases**:
- Set multiple filters (tags, dates, author)
- Click "Clear All Filters" button
- Verify all inputs are reset
- Verify all prompts are shown again
- Toast notification confirms clearing

**Assertions**:
- Tag selections cleared
- Date inputs cleared
- Author input cleared
- All prompts visible
- Toast message displayed

### Test 8: Filter Persistence

**Purpose**: Document expected behavior for filter state persistence

**Current Implementation**: Filters do NOT persist across navigation

**Test Documents**:
- Current behavior (filters reset)
- Expected behavior if implemented
- Implementation approach (localStorage)

**Note**: This test currently passes by validating the reset behavior. If persistence is implemented, the test will need updating.

### Test 9: Status Filter Integration

**Purpose**: Ensure status filter works with advanced filters

**Test Cases**:
- Apply tag filter + active status filter
- Apply tag filter + inactive status filter
- Verify status filter respects other filters

**Assertions**:
- Status filter narrows results correctly
- Combination with tags works properly
- Active/Inactive filtering is accurate

### Test 10: Sort Integration

**Purpose**: Ensure sorting maintains active filters

**Test Cases**:
- Apply search filter
- Change sort order (name, version, usage, performance)
- Verify filtered results remain
- Verify sort order changes

**Assertions**:
- Filter results maintained
- Sort order updates correctly
- Result count unchanged

### Test 11: Empty State Handling

**Purpose**: Validate UI feedback when no results match

**Test Cases**:
- Apply filter with no matches
- Verify empty state is visible
- Verify prompt list is hidden

**Assertions**:
- Empty state component shown
- Appropriate message displayed
- Prompt list container hidden

### Test 12: Filter Count Badge

**Purpose**: Validate visual feedback for active filters

**Test Cases**:
- Apply 1 filter, verify toast shows "1 filter"
- Apply 2 filters, verify toast shows "2 filters"
- Apply 3+ filters, verify correct count

**Assertions**:
- Toast notification displays
- Filter count is accurate
- Singular/plural grammar correct

### Test 13: Keyboard Navigation

**Purpose**: Ensure keyboard shortcuts work while filtering

**Test Cases**:
- Press "/" to focus search input
- Type search query
- Press Escape (if implemented)

**Assertions**:
- "/" focuses search input
- Search input receives keyboard input
- Shortcut doesn't interfere with typing

### Test 14: Responsive Design

**Purpose**: Validate mobile viewport compatibility

**Test Cases**:
- Set mobile viewport (375x667)
- Open advanced filters panel
- Apply filters
- Verify results display correctly

**Assertions**:
- Panel opens on mobile
- Filters are usable
- Results display properly
- Touch interactions work

### Test 15: Performance

**Purpose**: Ensure filtering is responsive

**Test Cases**:
- Measure time to apply filters
- Target: < 2000ms response time

**Assertions**:
- Filter application completes quickly
- UI remains responsive
- No visible lag

## Environment Configuration

### Required Environment Variables

```bash
# Base URL for tests (default: http://localhost:3080)
BASE_URL=http://localhost:3080

# Test user credentials (if authentication required)
TEST_USERNAME=testuser
TEST_PASSWORD=testpass
```

### Optional Configuration

```bash
# Run in CI mode (affects retry logic)
CI=true

# Specific browser
PROJECT=chromium  # or firefox, webkit
```

## Troubleshooting

### Common Issues

#### 1. Server Not Running

**Error**: `Error: connect ECONNREFUSED`

**Solution**:
```bash
# Start AgentX server
npm start

# Or use test server
node tests/test-server.js
```

#### 2. Authentication Failures

**Error**: Redirects to login page

**Solution**:
- Ensure `TEST_USERNAME` and `TEST_PASSWORD` are set
- Check authentication is enabled
- Update `login()` helper if using different auth

#### 3. Test Data Conflicts

**Error**: Unexpected number of prompts in results

**Solution**:
```bash
# Cleanup existing test prompts manually via UI
# Or modify cleanup function to be more thorough
```

#### 4. Timeout Errors

**Error**: `Timeout 30000ms exceeded`

**Solution**:
- Increase timeout in test: `test.setTimeout(60000)`
- Check server performance
- Verify network stability

#### 5. Selector Not Found

**Error**: `Selector "#someElement" not found`

**Solution**:
- Check element exists in DOM
- Wait for element: `await page.waitForSelector('#someElement')`
- Verify correct page loaded

### Debug Mode

Run tests in debug mode to step through execution:

```bash
# Open Playwright Inspector
npx playwright test advanced-filtering.spec.js --debug

# Or use UI mode
npx playwright test advanced-filtering.spec.js --ui
```

### Inspecting Failures

After test failure, check artifacts:

```bash
# View trace
npx playwright show-trace test-results/*/trace.zip

# View screenshot
open test-results/*/test-failed-*.png

# View video
open test-results/*/video.webm
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Advanced Filtering E2E Tests

on:
  push:
    branches: [main, develop]
  pull_request:
    paths:
      - 'public/js/prompts.js'
      - 'public/prompts.html'
      - 'tests/e2e/advanced-filtering.spec.js'

jobs:
  e2e-filtering:
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright
        run: npx playwright install --with-deps chromium

      - name: Start test server
        run: |
          node tests/test-server.js &
          sleep 10

      - name: Run Advanced Filtering tests
        run: npm run test:e2e:filtering

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-filtering-report
          path: playwright-report/

      - name: Upload test artifacts
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: test-artifacts
          path: test-results/
```

## Performance Benchmarks

Expected performance metrics:

| Operation | Target | Typical |
|-----------|--------|---------|
| Search debounce | 300ms | 300ms |
| Filter application | < 2000ms | 500-800ms |
| Panel toggle | < 300ms | 100-150ms |
| Clear filters | < 500ms | 200-300ms |
| Page load | < 3000ms | 1000-2000ms |

## Maintenance

### Adding New Tests

When adding new filter functionality:

1. **Update test data** in `setupTestPrompts()` if needed
2. **Add test case** following existing pattern
3. **Update this documentation**
4. **Run full test suite** to ensure no regressions

### Updating Selectors

If UI changes require selector updates:

1. Use `data-testid` attributes for stability
2. Update selectors in test file
3. Document changes in commit message
4. Verify all related tests pass

## Known Limitations

### Filter Persistence (Test 8)

**Current Behavior**: Filters are reset when navigating away from the page

**Rationale**: No localStorage or session storage implementation currently exists

**Future Enhancement**: Could implement filter state persistence using:
```javascript
// Save state
localStorage.setItem('promptFilters', JSON.stringify(state.filters));

// Restore state
const savedFilters = localStorage.getItem('promptFilters');
if (savedFilters) {
  state.filters = JSON.parse(savedFilters);
  applyFilters();
}
```

### Authentication Variability

Tests assume either no authentication or session-based auth. If using different auth mechanism (OAuth, JWT, etc.), update the `login()` helper function.

### Test Isolation

Tests share the same database. While cleanup is performed, there's a small risk of test interference if tests run in parallel. Current configuration runs sequentially to mitigate this.

## References

- [Playwright Documentation](https://playwright.dev/)
- Historical prompt-management page: `core/public/prompts.html` (removed)
- Historical SBQC prompts API reference (removed)
- [CLAUDE.md Testing Guide](../../CLAUDE.md#testing)

## Contributing

When contributing to this test suite:

1. Follow existing naming conventions
2. Add comprehensive assertions
3. Test both positive and negative cases
4. Update documentation
5. Ensure tests pass in all configured browsers
6. Keep tests isolated and independent

## Support

For issues or questions:

1. Check this documentation first
2. Review Playwright docs
3. Check existing GitHub issues
4. Create new issue with reproduction steps
