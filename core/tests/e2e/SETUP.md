# Playwright E2E Tests Setup Guide

This guide will help you set up and run Playwright E2E tests for the AgentX Performance Metrics Dashboard.

## Installation Steps

### 1. Verify Playwright Installation

Playwright is already installed as a transitive dependency via Artillery. Verify it:

```bash
npm list @playwright/test
```

You should see:
```
agentx@1.3.2
└─┬ artillery@2.0.27
  └─┬ artillery-engine-playwright@1.24.0
    └── @playwright/test@1.56.1
```

### 2. Install Playwright Browsers

The Playwright package comes without browsers. Install them:

```bash
npx playwright install
```

This downloads Chromium, Firefox, and WebKit browsers. Expected output:
```
Downloading Chromium 122.0.6261.39 (playwright build)
Downloading Firefox 122.0 (playwright build)
Downloading WebKit 17.4 (playwright build)
```

**Optional**: Install only specific browsers:
```bash
npx playwright install chromium  # Only Chrome
npx playwright install firefox   # Only Firefox
npx playwright install webkit    # Only Safari
```

### 3. Install System Dependencies (Linux only)

On Linux, you may need additional system libraries:

```bash
npx playwright install-deps
```

Or for specific browsers:
```bash
npx playwright install-deps chromium
```

### 4. Verify Installation

Run a test check:

```bash
npx playwright --version
```

Expected output: `Version 1.40.0` (or similar)

## Running the Tests

### Start AgentX Server

Before running tests, ensure the server is running:

```bash
npm start
```

The server should be accessible at `http://localhost:3080`

### Run All E2E Tests

```bash
npm run test:e2e:playwright
```

### Run Only Performance Metrics Dashboard Tests

```bash
npm run test:e2e:dashboard
```

### Run in Interactive UI Mode

Best for development and debugging:

```bash
npm run test:e2e:playwright:ui
```

This opens the Playwright Test UI where you can:
- Select specific tests to run
- Watch tests execute in real-time
- See detailed logs and network activity
- Time travel through test execution

### Run in Headed Mode (See Browser)

```bash
npm run test:e2e:playwright:headed
```

This runs tests with the browser visible - useful for debugging.

### Debug Specific Test

```bash
npm run test:e2e:playwright:debug
```

This opens Playwright Inspector for step-by-step debugging:
- Pause execution
- Step through test actions
- Inspect page state
- Evaluate expressions in console

## Test Results and Reports

### View HTML Report

After running tests, view the interactive HTML report:

```bash
npm run test:e2e:playwright:report
```

This opens a browser with:
- Test results (pass/fail)
- Execution timeline
- Screenshots on failure
- Videos of failed tests
- Detailed error messages
- Network activity logs

Report location: `playwright-report/index.html`

### Screenshots and Videos

On test failure, Playwright automatically captures:

**Screenshots**: `test-results/[test-name]/test-failed-1.png`
**Videos**: `test-results/[test-name]/video.webm`

## Configuration

### Environment Variables

Set custom base URL:

```bash
export BASE_URL=http://localhost:8080
npm run test:e2e:playwright
```

### Run Tests on Specific Browser

```bash
npx playwright test --project=chromium   # Chrome
npx playwright test --project=firefox    # Firefox
npx playwright test --project=webkit     # Safari
```

### Run Single Test File

```bash
npx playwright test tests/e2e/performance-metrics-dashboard.spec.js
```

### Run Single Test by Name

```bash
npx playwright test -g "should render dashboard on page load"
```

### Run Tests Matching Pattern

```bash
npx playwright test -g "empty state"  # All tests with "empty state" in name
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Tests

on: [push, pull_request]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      - name: Setup Node.js
        uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright Browsers
        run: npx playwright install --with-deps

      - name: Start AgentX Server
        run: |
          npm start &
          npx wait-on http://localhost:3080

      - name: Run E2E Tests
        run: npm run test:e2e:playwright
        env:
          CI: true

      - name: Upload Test Report
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-report
          path: playwright-report/

      - name: Upload Test Results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: test-results
          path: test-results/
```

## Troubleshooting

### Issue: Browser not found

**Error:**
```
Executable doesn't exist at /home/user/.cache/ms-playwright/chromium-1097/chrome-linux/chrome
```

**Solution:**
```bash
npx playwright install chromium
```

### Issue: System dependencies missing (Linux)

**Error:**
```
Host system is missing dependencies to run browsers
```

**Solution:**
```bash
npx playwright install-deps
```

### Issue: Connection refused

**Error:**
```
page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3080
```

**Solutions:**
1. Check if AgentX server is running: `npm start`
2. Verify server port: Check `.env` for `PORT` setting
3. Check if port is already in use: `lsof -i :3080`
4. Set correct `BASE_URL`: `export BASE_URL=http://localhost:3080`

### Issue: Test timeout

**Error:**
```
Test timeout of 30000ms exceeded
```

**Solutions:**
1. Increase timeout in test:
   ```javascript
   test('slow test', async ({ page }) => {
     test.setTimeout(60000); // 60 seconds
     // ... test code
   });
   ```
2. Check if API responses are slow
3. Verify MongoDB connection is working
4. Check network conditions

### Issue: Element not found

**Error:**
```
waiting for locator('.metric-card') failed: timeout 5000ms exceeded
```

**Solutions:**
1. Run in headed mode to see what's happening: `npm run test:e2e:playwright:headed`
2. Check if element selector changed in code
3. Add explicit wait: `await page.waitForSelector('.metric-card', { timeout: 10000 })`
4. Verify API mocking is working correctly

### Issue: Flaky tests

**Symptoms:** Tests pass sometimes, fail other times

**Solutions:**
1. Replace `waitForTimeout()` with specific condition waits:
   ```javascript
   // Bad
   await page.waitForTimeout(1000);

   // Good
   await page.waitForSelector('.element', { state: 'visible' });
   ```
2. Use `expect().toBeVisible()` with proper timeout
3. Wait for network idle: `await page.waitForLoadState('networkidle')`
4. Enable retries in config for specific tests

## Best Practices

### 1. Always wait for elements properly

```javascript
// Good
await page.waitForSelector('.element', { state: 'visible' });
await expect(page.locator('.element')).toBeVisible();

// Bad
await page.waitForTimeout(2000);
```

### 2. Use data attributes for test selectors

```html
<button data-testid="refresh-metrics">Refresh</button>
```

```javascript
await page.getByTestId('refresh-metrics').click();
```

### 3. Mock external APIs

```javascript
await page.route('**/api/analytics/feedback*', async route => {
  await route.fulfill({
    status: 200,
    body: JSON.stringify(mockData)
  });
});
```

### 4. Clean up state between tests

```javascript
test.beforeEach(async ({ page }) => {
  await page.evaluate(() => localStorage.clear());
  await page.evaluate(() => sessionStorage.clear());
});
```

### 5. Use descriptive test names

```javascript
// Good
test('should display error message when API returns 500', async ({ page }) => {

// Bad
test('error test', async ({ page }) => {
```

## Additional Resources

- [Playwright Documentation](https://playwright.dev/docs/intro)
- [API Reference](https://playwright.dev/docs/api/class-test)
- [Best Practices](https://playwright.dev/docs/best-practices)
- [Debugging Guide](https://playwright.dev/docs/debug)
- [Selectors Guide](https://playwright.dev/docs/selectors)
- [Assertions](https://playwright.dev/docs/test-assertions)

## Getting Help

If you encounter issues:

1. Check this troubleshooting guide
2. Run in debug mode: `npm run test:e2e:playwright:debug`
3. Check test results and screenshots in `test-results/`
4. Review Playwright documentation
5. Check existing GitHub issues: https://github.com/microsoft/playwright/issues

## Next Steps

After successful setup:

1. Run all tests to ensure everything works: `npm run test:e2e:playwright`
2. Try interactive mode: `npm run test:e2e:playwright:ui`
3. Review test report: `npm run test:e2e:playwright:report`
4. Write new tests for other components
5. Integrate into CI/CD pipeline
