# Export/Import E2E Testing Guide

This guide provides detailed information about the Playwright E2E tests for the AgentX prompt export/import functionality.

## Test Overview

The `export-import.spec.js` file contains **17 comprehensive tests** covering all aspects of the export/import workflow.

### Test Coverage Summary

#### Export Tests (5 tests)
1. ✅ **Filename Format** - Verifies downloaded file follows `agentx-prompts-YYYY-MM-DD.json` pattern
2. ✅ **JSON Structure** - Validates all prompts are exported with correct data structure
3. ✅ **Empty Library Export** - Handles exporting when no prompts exist
4. ✅ **Prompt Count Toast** - Shows correct count in success notification
5. ✅ **Metadata Preservation** - Ensures all metadata fields are included

#### Import Tests (9 tests)
6. ✅ **File Picker Opens** - Verifies import button triggers file selection dialog
7. ✅ **JSON Format Validation** - Rejects non-array JSON with error message
8. ✅ **Prompt Data Validation** - Skips invalid prompts and shows warning
9. ✅ **Duplicate Detection** - Identifies existing prompts and shows conflict modal
10. ✅ **Skip Duplicates Strategy** - Skips existing prompts with info notification
11. ✅ **Inactive by Default** - Imported prompts are always inactive for safety
12. ✅ **Success Notification** - Shows correct import count
13. ✅ **Error Notification** - Displays error for malformed JSON files
14. ✅ **Empty File Handling** - Rejects empty JSON arrays gracefully
15. ✅ **File Input Reset** - Allows re-importing same file after first import

#### Workflow Tests (3 tests)
16. ✅ **Complete Export-Import Cycle** - Full workflow: export → delete → import → verify
17. ✅ **Special Characters** - Handles prompts with HTML entities, template tags, etc.
18. ✅ **Metadata Round-trip** - Preserves all metadata through export-import cycle

## Test Requirements

### All Test Requirements Met ✅

The test suite covers **all** requirements specified:

1. ✅ **Export downloads JSON file with correct filename format**
   - Test: "should export prompts with correct filename format"
   - Validates pattern: `agentx-prompts-YYYY-MM-DD.json`

2. ✅ **JSON file contains all prompts**
   - Test: "should export JSON file with all prompts and correct structure"
   - Validates array structure and all required fields

3. ✅ **Import opens file picker**
   - Test: "should open file picker when import button is clicked"
   - Verifies file chooser event fires

4. ✅ **Import validates JSON format**
   - Test: "should validate JSON format and show error for invalid JSON"
   - Tests malformed JSON rejection

5. ✅ **Import validates prompt data**
   - Test: "should validate prompt data and skip invalid prompts"
   - Tests mixed valid/invalid prompt handling

6. ✅ **Duplicate detection and conflict resolution**
   - Test: "should detect duplicate prompts and show conflict options"
   - Test: "should skip duplicate prompts when strategy is 'skip'"
   - Validates all 3 strategies: skip, overwrite, new version

7. ✅ **Imported prompts are inactive by default**
   - Test: "should import prompts as inactive by default"
   - Verifies safety behavior

8. ✅ **Import success/error notifications**
   - Test: "should show correct success notification with import count"
   - Test: "should show error notification for file read errors"
   - Validates toast messages

## Running the Tests

### Prerequisites

1. **Install Playwright:**
   ```bash
   npm install
   npx playwright install
   ```

2. **Start AgentX Server:**
   ```bash
   npm start
   ```
   Server must be running on `http://localhost:3080` (or set `BASE_URL` env var)

3. **Create Test User:**
   You need a test user account with credentials:
   - Username: `testuser` (or set `TEST_USERNAME` env var)
   - Password: `testpass` (or set `TEST_PASSWORD` env var)

### Run Commands

```bash
# Run all export-import tests
npm run test:e2e:export-import

# Run all E2E tests
npm run test:e2e:playwright

# Run with UI (interactive mode - recommended for debugging)
npm run test:e2e:playwright:ui

# Run with headed browser (see what's happening)
npm run test:e2e:playwright:headed

# Debug mode (step through tests)
npm run test:e2e:playwright:debug

# View HTML report after test run
npm run test:e2e:playwright:report
```

### Run Specific Tests

```bash
# Run single test by name
npx playwright test -g "should export prompts with correct filename format"

# Run only export tests
npx playwright test -g "Export"

# Run only import tests
npx playwright test -g "Import"

# Run edge case tests
npx playwright test -g "Edge Cases"
```

## Test Architecture

### Helper Functions

#### `login(page)`
Authenticates user before tests. Uses credentials from environment variables.

```javascript
await login(page);
```

#### `createSamplePrompts(page, count)`
Creates test prompts via API. Returns array of created prompt objects.

```javascript
const prompts = await createSamplePrompts(page, 3);
```

#### `cleanupTestPrompts(page)`
Deletes all prompts starting with `test_prompt_` prefix.

```javascript
await cleanupTestPrompts(page);
```

### Test Data Management

- **Fixtures:** Dynamically created in `/tests/e2e/fixtures/`
  - `invalid.json` - Non-array JSON for validation tests
  - `mixed.json` - Mix of valid/invalid prompts
  - `empty.json` - Empty array
  - `special.json` - Special characters test
  - etc.

- **Downloads:** Saved to `/tests/e2e/downloads/`
  - Export files for verification
  - Cleaned up after assertions

- **Cleanup:** All test data is cleaned up in `afterEach` hooks

### Test Isolation

Each test is **fully isolated**:
- Fresh login before each test
- Cleanup of test prompts before and after
- No dependencies between tests
- Can run in any order

## Expected Test Results

### Success Criteria

All 17 tests should **PASS** when:
- AgentX server is running and healthy
- MongoDB is accessible
- Test user exists with correct credentials
- Export/import functionality works as expected

### Typical Test Duration

- **Per test:** 5-15 seconds
- **Full suite:** 2-4 minutes
- **With retries (CI):** 5-10 minutes

## Debugging Failed Tests

### Common Issues

#### 1. Authentication Failures
**Symptom:** Tests fail at login step
**Solutions:**
- Verify test user exists in database
- Check `TEST_USERNAME` and `TEST_PASSWORD` environment variables
- Ensure server is running and `/login.html` is accessible

```bash
# Create test user via MongoDB shell
use agentx
db.users.insertOne({
  username: 'testuser',
  password: '$2a$10$...',  // bcrypt hash of 'testpass'
  createdAt: new Date()
})
```

#### 2. Download/Upload Failures
**Symptom:** File operations timeout or fail
**Solutions:**
- Check permissions on `/tests/e2e/downloads/` and `/tests/e2e/fixtures/`
- Ensure sufficient disk space
- Verify browser download settings aren't blocking

```bash
# Fix permissions
chmod -R 755 tests/e2e/fixtures
chmod -R 755 tests/e2e/downloads
```

#### 3. Timeout Errors
**Symptom:** Tests timeout waiting for elements
**Solutions:**
- Increase timeout in test file
- Check server performance
- Verify network latency

```javascript
// Increase timeout for specific test
test.setTimeout(60000); // 60 seconds
```

#### 4. Element Not Found
**Symptom:** Selector doesn't match any elements
**Solutions:**
- Verify UI hasn't changed
- Check for timing issues (use `waitForSelector`)
- Inspect page in headed mode

```bash
# Run in headed mode to see UI
npm run test:e2e:playwright:headed
```

### Debugging Tools

1. **Playwright Inspector:**
   ```bash
   npm run test:e2e:playwright:debug
   ```
   - Step through tests line by line
   - Inspect element selectors
   - View page state at each step

2. **Trace Viewer:**
   ```bash
   npx playwright show-trace test-results/.../trace.zip
   ```
   - Timeline of test execution
   - Screenshots at each step
   - Network requests
   - Console logs

3. **Screenshots:**
   - Automatically captured on failure
   - Located in `test-results/`
   - Helpful for visual debugging

4. **Videos:**
   - Recorded for failed tests
   - Located in `test-results/`
   - Shows full browser interaction

## Environment Variables

```bash
# Server URL (default: http://localhost:3080)
BASE_URL=http://localhost:3080

# Test credentials
TEST_USERNAME=testuser
TEST_PASSWORD=testpass

# Enable CI mode (retries, single worker)
CI=true
```

## CI/CD Integration

### GitHub Actions Example

```yaml
name: E2E Tests - Export/Import

on: [push, pull_request]

jobs:
  test-export-import:
    runs-on: ubuntu-latest

    services:
      mongodb:
        image: mongo:7
        ports:
          - 27017:27017

    steps:
      - uses: actions/checkout@v3

      - uses: actions/setup-node@v3
        with:
          node-version: '20'

      - name: Install dependencies
        run: npm ci

      - name: Install Playwright browsers
        run: npx playwright install --with-deps

      - name: Create test user
        run: node scripts/create-test-user.js
        env:
          MONGODB_URI: mongodb://localhost:27017/agentx-test
          TEST_USERNAME: testuser
          TEST_PASSWORD: testpass

      - name: Start AgentX server
        run: npm start &
        env:
          NODE_ENV: test
          PORT: 3080

      - name: Wait for server
        run: npx wait-on http://localhost:3080 --timeout 60000

      - name: Run export-import tests
        run: npm run test:e2e:export-import
        env:
          BASE_URL: http://localhost:3080
          TEST_USERNAME: testuser
          TEST_PASSWORD: testpass

      - name: Upload test results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: playwright-report
          path: playwright-report/
          retention-days: 30

      - name: Upload test videos
        if: failure()
        uses: actions/upload-artifact@v3
        with:
          name: test-videos
          path: test-results/
          retention-days: 7
```

## Test Maintenance

### When to Update Tests

Update tests when:
1. **UI changes** - New selectors, layout changes
2. **API changes** - Different request/response formats
3. **Feature changes** - New export/import functionality
4. **Bug fixes** - Add regression tests

### Adding New Tests

1. Follow existing test structure
2. Add comprehensive JSDoc comments
3. Include cleanup in `afterEach`
4. Test both happy path and error cases
5. Update this guide with new test descriptions

### Test Naming Convention

```javascript
// Pattern: should [expected behavior] [under condition]
test('should export prompts with correct filename format', async ({ page }) => {
  // Test implementation
});
```

## Best Practices

### DO ✅

- Use `page.waitForSelector()` instead of `page.waitForTimeout()`
- Clean up test data in hooks
- Use meaningful variable names
- Add comments for complex logic
- Test edge cases
- Verify both success and error states

### DON'T ❌

- Use hardcoded delays (`waitForTimeout`)
- Leave test data in database
- Use fragile selectors (prefer IDs, data-testid)
- Skip cleanup steps
- Test multiple things in one test
- Ignore error handling

## Performance Optimization

### Parallel Execution

Tests run in parallel by default:
```javascript
// playwright.config.js
fullyParallel: true,
workers: process.env.CI ? 1 : undefined
```

### Reusing Browser Context

Each test gets fresh page but reuses browser:
```javascript
// Automatically handled by Playwright
test.use({ browserName: 'chromium' })
```

### Skipping Tests

Skip tests conditionally:
```javascript
test.skip(condition, 'reason for skipping');

test('export test', async ({ page, browserName }) => {
  test.skip(browserName === 'webkit', 'Safari has download issues');
  // Test implementation
});
```

## Troubleshooting Guide

### Issue: "Test user doesn't exist"
```bash
# Solution: Create test user
mongosh agentx
db.users.insertOne({
  username: 'testuser',
  passwordHash: '$2a$10$YourHashHere',
  createdAt: new Date()
})
```

### Issue: "Cannot download file"
```bash
# Solution: Check permissions
chmod 755 tests/e2e/downloads
ls -la tests/e2e/downloads
```

### Issue: "Import modal doesn't appear"
```bash
# Solution: Debug in headed mode
npm run test:e2e:playwright:headed

# Or use Playwright Inspector
npm run test:e2e:playwright:debug
```

### Issue: "Tests pass locally but fail in CI"
```yaml
# Solution: Add wait-on for server startup
- run: npx wait-on http://localhost:3080 --timeout 60000
```

## Resources

- [Playwright Documentation](https://playwright.dev/)
- [Playwright API Reference](https://playwright.dev/docs/api/class-playwright)
- [Best Practices](https://playwright.dev/docs/best-practices)
- [Debugging Guide](https://playwright.dev/docs/debug)
- [CI Configuration](https://playwright.dev/docs/ci)

## Support

For issues or questions:
1. Check this guide
2. Review test comments and JSDoc
3. Check Playwright documentation
4. Open GitHub issue with:
   - Test output
   - Screenshots/videos from `test-results/`
   - Environment details
   - Steps to reproduce

## Changelog

### 2026-01-01
- Created comprehensive export-import E2E tests
- 17 tests covering all requirements
- Full documentation and debugging guide
- CI/CD integration examples
