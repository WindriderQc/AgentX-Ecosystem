# E2E Test Validation Checklist

This checklist helps validate that the E2E tests are properly set up and ready to run.

## Pre-Test Setup

### 1. Dependencies

- [ ] Node.js installed (v18.14.0 or higher)
- [ ] npm packages installed (`npm install`)
- [ ] Playwright installed (`npx playwright install chromium`)
- [ ] MongoDB running (or using in-memory test server)

**Verify**:
```bash
node --version
npm list @playwright/test
npx playwright --version
```

### 2. Server Status

- [ ] AgentX server is running on port 3080 (or configured `BASE_URL`)
- [ ] Server health endpoint responds

**Verify**:
```bash
curl http://localhost:3080/health
# Expected: {"status":"ok",...}
```

### 3. Environment Configuration

- [ ] `.env` file exists with required variables
- [ ] `BASE_URL` configured (or using default)
- [ ] Test credentials configured (if auth enabled)

**Verify**:
```bash
cat .env | grep BASE_URL
cat .env | grep TEST_USERNAME
```

## Test File Validation

### Advanced Filtering Tests (`advanced-filtering.spec.js`)

- [ ] Test file exists at `tests/e2e/advanced-filtering.spec.js`
- [ ] No syntax errors (`node -c tests/e2e/advanced-filtering.spec.js`)
- [ ] All imports resolve correctly
- [ ] Test data structure is valid

**Verify**:
```bash
ls -l tests/e2e/advanced-filtering.spec.js
node -c tests/e2e/advanced-filtering.spec.js
```

### Configuration

- [ ] Playwright config exists (`playwright.config.js`)
- [ ] Test directory configured correctly
- [ ] Timeout values are appropriate
- [ ] Reporter configured

**Verify**:
```bash
cat playwright.config.js | grep testDir
cat playwright.config.js | grep timeout
```

## Test Execution Validation

### Dry Run

- [ ] Tests can be listed without running

**Verify**:
```bash
npx playwright test --list advanced-filtering.spec.js
# Expected: List of 15 tests
```

### Single Test Run

- [ ] Can run a single test successfully

**Verify**:
```bash
npx playwright test advanced-filtering.spec.js -g "should toggle advanced filters" --project=chromium
```

### Full Suite Run

- [ ] All tests can run sequentially
- [ ] Tests create and cleanup data properly
- [ ] No test pollution/interference

**Verify**:
```bash
npm run test:e2e:filtering
```

## Post-Test Validation

### Artifacts

- [ ] Test report generated (`playwright-report/`)
- [ ] Screenshots captured on failure (if any)
- [ ] Videos recorded on failure (if any)
- [ ] Traces captured on failure (if any)

**Verify**:
```bash
ls -l playwright-report/
ls -l test-results/
```

### Database Cleanup

- [ ] Test prompts are removed
- [ ] No leftover test data in database

**Verify**:
```bash
# Via MongoDB shell or API
curl http://localhost:3080/api/prompts | grep test_prompt
# Expected: No results
```

## Common Issues Checklist

### Server Issues

- [ ] Server starts without errors
- [ ] All required services available (MongoDB, Ollama)
- [ ] Correct port exposed (3080)
- [ ] CORS configured for test origin

### Authentication Issues

- [ ] Login endpoint available (`/login.html`)
- [ ] Test credentials valid
- [ ] Session persists across requests
- [ ] API key auth works (if applicable)

### Test Data Issues

- [ ] Prompt creation API works (`POST /api/prompts`)
- [ ] Prompt deletion API works (`DELETE /api/prompts/:id`)
- [ ] Prompt listing API works (`GET /api/prompts`)
- [ ] API returns expected data structure

### UI/Selector Issues

- [ ] All test selectors exist in DOM
- [ ] Elements are visible when expected
- [ ] Click events trigger properly
- [ ] Form inputs accept values

### Performance Issues

- [ ] Tests complete within timeout (30s default)
- [ ] No memory leaks during test run
- [ ] Server responds quickly to API calls
- [ ] Browser automation is responsive

## Debugging Checklist

If tests fail, check:

1. [ ] Read the error message carefully
2. [ ] Check server logs for API errors
3. [ ] View screenshot/video of failure
4. [ ] Inspect trace file in Playwright Trace Viewer
5. [ ] Run test in headed mode to observe
6. [ ] Add console logging to test
7. [ ] Add `page.pause()` to debug interactively
8. [ ] Verify selector still exists in updated UI
9. [ ] Check timing issues (add waits if needed)
10. [ ] Verify test data setup completed successfully

## CI/CD Checklist

For running in CI environment:

- [ ] CI environment variable set (`CI=true`)
- [ ] Playwright installed with dependencies (`--with-deps`)
- [ ] Server started before tests
- [ ] Sufficient timeout configured
- [ ] Artifacts uploaded on failure
- [ ] Test results reported properly

## Quick Validation Script

Run this to validate setup:

```bash
#!/bin/bash
echo "Validating E2E Test Setup..."

# Check Node.js
node --version || echo "ERROR: Node.js not installed"

# Check Playwright
npx playwright --version || echo "ERROR: Playwright not installed"

# Check server
curl -s http://localhost:3080/health > /dev/null && echo "✓ Server running" || echo "✗ Server not running"

# Check test file
[ -f tests/e2e/advanced-filtering.spec.js ] && echo "✓ Test file exists" || echo "✗ Test file missing"

# Syntax check
node -c tests/e2e/advanced-filtering.spec.js && echo "✓ Test file valid" || echo "✗ Syntax errors"

# List tests
TEST_COUNT=$(npx playwright test --list advanced-filtering.spec.js 2>&1 | grep "test" | wc -l)
echo "✓ Found $TEST_COUNT tests"

echo ""
echo "Setup validation complete!"
```

## Test Coverage Verification

Ensure all requirements are tested:

### Required Features

- [x] Enhanced search (name, description, author)
- [x] Toggle advanced filters panel
- [x] Tag multi-select filtering
- [x] Date range filtering
- [x] Author filtering
- [x] Combined filters (all together)
- [x] Clear all filters button
- [x] Filter persistence (documented)
- [x] Status filter integration
- [x] Sort integration
- [x] Empty state handling
- [x] Filter count indicators
- [x] Keyboard navigation
- [x] Responsive design (mobile)
- [x] Performance validation

**Total: 15/15 requirements covered**

## Sign-off

Before marking tests as complete:

- [ ] All tests pass locally
- [ ] All tests pass in CI (if configured)
- [ ] Documentation is complete
- [ ] Edge cases are tested
- [ ] Error handling is tested
- [ ] Performance benchmarks met
- [ ] Code review completed
- [ ] Tests added to main test suite

## Notes

Add any environment-specific notes or gotchas here:

-
-
-
