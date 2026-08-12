# E2E Tests for AgentX

This directory is the navigation hub for the AgentX Playwright test suite.

## Start Here

- [QUICKSTART.md](./QUICKSTART.md) - Fast setup and first run.
- [QUICK_REFERENCE.md](./QUICK_REFERENCE.md) - Command-oriented cheat sheet.
- [TESTING_GUIDE.md](./TESTING_GUIDE.md) - Deep-dive guide for the export/import E2E flow.
- [SETUP.md](./SETUP.md) - Environment and setup details.

## Suite-Specific Detail

- [ADVANCED_FILTERING_TESTS.md](./ADVANCED_FILTERING_TESTS.md) - Advanced filtering suite coverage and references.
- [PERFORMANCE_DASHBOARD_TESTS.md](./PERFORMANCE_DASHBOARD_TESTS.md) - Performance dashboard suite coverage and references.
- [TEST_CHECKLIST.md](./TEST_CHECKLIST.md) - Checklist-style validation reference.

## Core Commands

```bash
npm run test:e2e:playwright
npm run test:e2e:playwright:ui
npm run test:e2e:playwright:headed
npm run test:e2e:playwright:debug
npm run test:e2e:playwright:report
```

## Why This File Is Short

This README previously repeated suite coverage, setup steps, debugging notes, and best practices that already existed in the dedicated test documents. Keeping the detailed content in those per-topic files reduces drift and keeps this page focused on navigation.

Historical implementation and summary reports from the earlier E2E rollout were moved to the central docs archive.
