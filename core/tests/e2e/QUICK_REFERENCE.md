# Export/Import E2E Tests - Quick Reference

## TL;DR

**17 comprehensive Playwright tests** covering all export/import functionality requirements.

**Location:** `/tests/e2e/export-import.spec.js`

**Status:** ✅ Ready to run

---

## Run Tests (3 Steps)

```bash
# 1. Install & setup (one time)
npm install && npx playwright install

# 2. Start server
npm start

# 3. Run tests
npm run test:e2e:export-import
```

---

## Requirements Checklist

| # | Requirement | ✓ |
|---|-------------|---|
| 1 | Export downloads JSON with correct filename format | ✅ |
| 2 | JSON file contains all prompts | ✅ |
| 3 | Import opens file picker | ✅ |
| 4 | Import validates JSON format | ✅ |
| 5 | Import validates prompt data | ✅ |
| 6 | Duplicate detection and conflict resolution | ✅ |
| 7 | Imported prompts are inactive by default | ✅ |
| 8 | Import success/error notifications | ✅ |

**Coverage: 8/8 (100%)**

---

## Test Commands

```bash
# Run export-import tests only
npm run test:e2e:export-import

# Run with interactive UI (best for debugging)
npm run test:e2e:playwright:ui

# Run with visible browser
npm run test:e2e:playwright:headed

# Debug mode (step through)
npm run test:e2e:playwright:debug

# View HTML report
npm run test:e2e:playwright:report

# Run all E2E tests
npm run test:e2e:playwright
```

---

## Test Suite Overview

### Export Tests (4 tests)
- ✅ Filename format validation (`agentx-prompts-YYYY-MM-DD.json`)
- ✅ JSON structure & content
- ✅ Export count in toast
- ✅ File input reset

### Import Tests (7 tests)
- ✅ File picker opens
- ✅ JSON format validation
- ✅ Prompt data validation
- ✅ Duplicate detection
- ✅ Skip duplicates strategy
- ✅ Inactive by default
- ✅ Success notification

### Error Handling (3 tests)
- ✅ Malformed JSON error
- ✅ Empty JSON array
- ✅ Complete workflow

### Edge Cases (3 tests)
- ✅ Empty library export
- ✅ Special characters
- ✅ Metadata preservation

---

## Prerequisites

```bash
# Test user credentials (set as env vars or use defaults)
TEST_USERNAME=testuser  # default
TEST_PASSWORD=testpass  # default

# Server URL (set as env var or use default)
BASE_URL=http://localhost:3080  # default
```

**Note:** Test user must exist in database.

---

## Expected Results

✅ **All 17 tests PASS** when:
- Server running on http://localhost:3080
- MongoDB accessible
- Test user exists
- Export/import UI working

⏱️ **Duration:**
- Per test: 5-15 seconds
- Full suite: 2-4 minutes

---

## Debug Failed Tests

### Quick Fixes

```bash
# 1. Authentication error → Check test user exists
mongosh agentx
db.users.findOne({ username: 'testuser' })

# 2. File operation error → Fix permissions
chmod -R 755 tests/e2e/fixtures
chmod -R 755 tests/e2e/downloads

# 3. Element not found → Run in headed mode
npm run test:e2e:playwright:headed

# 4. Timeout → Debug step by step
npm run test:e2e:playwright:debug
```

### Debug Tools

| Tool | Command | Use Case |
|------|---------|----------|
| **Inspector** | `npm run test:e2e:playwright:debug` | Step through line by line |
| **Headed Mode** | `npm run test:e2e:playwright:headed` | See browser actions |
| **Trace Viewer** | `npx playwright show-trace test-results/.../trace.zip` | Review timeline |
| **HTML Report** | `npm run test:e2e:playwright:report` | View all results |

---

## File Structure

```
tests/e2e/
├── export-import.spec.js          # 17 tests (843 lines)
├── fixtures/                      # Test data (runtime only)
├── downloads/                     # Downloaded files (runtime only)
├── TESTING_GUIDE.md              # Full guide (510 lines)
└── QUICK_REFERENCE.md            # This file
```

---

## Test Examples

### Export Test Example
```javascript
test('should export prompts with correct filename format', async ({ page }) => {
  await createSamplePrompts(page, 2);
  await page.reload();

  const downloadPromise = page.waitForEvent('download');
  await page.click('#exportPromptsBtn');
  const download = await downloadPromise;

  const filename = download.suggestedFilename();
  expect(filename).toMatch(/^agentx-prompts-\d{4}-\d{2}-\d{2}\.json$/);
});
```

### Import Test Example
```javascript
test('should validate JSON format and show error for invalid JSON', async ({ page }) => {
  const invalidJson = { invalid: 'format' };
  await fs.writeFile('fixtures/invalid.json', JSON.stringify(invalidJson));

  const fileChooserPromise = page.waitForEvent('filechooser');
  await page.click('#importPromptsBtn');
  const fileChooser = await fileChooserPromise;
  await fileChooser.setFiles('fixtures/invalid.json');

  const errorToast = page.locator('.toast.error');
  await expect(errorToast).toContainText(/Invalid format.*Expected array/i);
});
```

---

## CI/CD Integration

### GitHub Actions
```yaml
- name: Run E2E Tests
  run: npm run test:e2e:export-import
  env:
    BASE_URL: http://localhost:3080
    TEST_USERNAME: testuser
    TEST_PASSWORD: testpass
```

### Artifacts
- ✅ HTML report
- ✅ Screenshots (failures)
- ✅ Videos (failures)
- ✅ Traces (retries)

---

## Key Behaviors Tested

### Export
- ✅ Filename: `agentx-prompts-YYYY-MM-DD.json`
- ✅ Format: JSON array
- ✅ Content: All prompts with metadata
- ✅ Toast: "Exported N prompt(s)"

### Import
- ✅ Validation: JSON array with valid prompts
- ✅ Duplicates: Modal with 3 strategies
- ✅ Status: Always imported as inactive
- ✅ Toast: "Imported N prompt(s)" or errors

### Error Cases
- ✅ Invalid JSON → "Invalid format...Expected array"
- ✅ Malformed JSON → "Import failed"
- ✅ Empty array → "No valid prompts found"
- ✅ Invalid prompts → "N invalid...will be skipped"

---

## Browser Support

Tested on:
- ✅ Chromium (Chrome)
- ✅ Firefox
- ✅ WebKit (Safari)
- ✅ Mobile Chrome
- ✅ Mobile Safari

---

## Links

- **Full Testing Guide:** [TESTING_GUIDE.md](./TESTING_GUIDE.md)
- **Test File:** [export-import.spec.js](./export-import.spec.js)
- **Playwright Docs:** https://playwright.dev/

---

## Troubleshooting One-Liners

```bash
# Test user doesn't exist
mongosh agentx -eval "db.users.insertOne({username:'testuser',password:'$2a$10$...',createdAt:new Date()})"

# Permission denied on files
chmod -R 755 tests/e2e/fixtures tests/e2e/downloads

# Can't connect to server
curl http://localhost:3080/health || npm start &

# Tests hang
pkill -f playwright && npm run test:e2e:export-import

# Browsers not installed
npx playwright install --with-deps

# Clear test artifacts
rm -rf test-results playwright-report tests/e2e/fixtures/* tests/e2e/downloads/*
```

---

## Success Indicators

✅ **17/17 tests passing**
✅ **All green checkmarks in report**
✅ **No timeout errors**
✅ **Clean test-results directory**
✅ **Toast notifications verified**
✅ **File downloads successful**

---

## Common Patterns

### Before Each Test
1. Login with test credentials
2. Cleanup existing test prompts
3. Navigate to /prompts.html
4. Wait for page load

### After Each Test
1. Cleanup test prompts
2. Delete test files
3. Reset browser state

### Test Structure
1. **Arrange:** Create test data
2. **Act:** Perform action (export/import)
3. **Assert:** Verify outcome
4. **Cleanup:** Remove artifacts

---

## Next Steps

1. ✅ Review test file: `export-import.spec.js`
2. ✅ Read full guide: `TESTING_GUIDE.md`
3. ✅ Run tests: `npm run test:e2e:export-import`
4. ✅ Check results: `npm run test:e2e:playwright:report`

---

**Need Help?** Check [TESTING_GUIDE.md](./TESTING_GUIDE.md) for detailed documentation.
