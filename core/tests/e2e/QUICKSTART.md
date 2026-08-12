# Quick Start Guide - E2E Tests

## Setup (First Time Only)

1. **Install Playwright browsers**:
   ```bash
   npx playwright install
   ```

2. **Verify server is running**:
   ```bash
   npm start
   ```
   Server should be available at `http://localhost:3080`

## Run Tests

### Quick Run (All Tests)
```bash
npm run test:e2e:playwright
```

### Run Only Onboarding Tests
```bash
npm run test:e2e:onboarding
```

### Interactive UI Mode (Recommended for Development)
```bash
npm run test:e2e:playwright:ui
```
- Best for debugging
- Step through tests visually
- See browser state at each step
- Pick and choose which tests to run

### See Browser While Testing (Headed Mode)
```bash
npm run test:e2e:playwright:headed
```

### Debug Mode (Inspector)
```bash
npm run test:e2e:playwright:debug
```
- Pauses at each step
- Allows inspection of page state
- Great for troubleshooting failures

## View Test Report

After running tests:
```bash
npm run test:e2e:playwright:report
```

Opens an HTML report with:
- Test results summary
- Screenshots of failures
- Videos of failed tests
- Detailed error messages

## Common Issues

### Issue: Connection refused
```
Error: page.goto: net::ERR_CONNECTION_REFUSED
```
**Fix**: Start the server with `npm start`

### Issue: Browser not found
```
Error: Executable doesn't exist
```
**Fix**: Install browsers with `npx playwright install`

### Issue: Tests timing out
**Fix**: Increase timeout or check if server is slow to respond

## Test Coverage

The onboarding wizard tests cover:
1. ✅ Auto-trigger on first visit
2. ✅ Manual trigger via button
3. ✅ Navigation through 5 steps
4. ✅ Form validation (6 scenarios)
5. ✅ Skip with confirmation
6. ✅ Prompt creation API
7. ✅ localStorage persistence
8. ✅ "Don't show again" checkbox
9. ✅ Slider/input synchronization
10. ✅ Progress bar updates

## Next Steps

- Read the full [README.md](./README.md) for detailed documentation
- Check [Playwright docs](https://playwright.dev) for advanced features
- Add new tests following existing patterns
