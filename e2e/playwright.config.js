'use strict';

const { defineConfig } = require('@playwright/test');

const standardReporters = process.env.CI
  ? [['line'], ['html', { open: 'never' }]]
  : [['line']];

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 30_000,
  expect: {
    timeout: 7_500,
  },
  forbidOnly: Boolean(process.env.CI),
  retries: 0,
  reporter: [
    ...standardReporters,
    ['./performance-reporter.js', { outputDir: 'test-results' }],
  ],
  outputDir: 'test-results',
  use: {
    browserName: 'chromium',
    colorScheme: 'dark',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'desktop-chromium',
      use: {
        viewport: { width: 1440, height: 900 },
      },
    },
    {
      name: 'mobile-chromium',
      use: {
        viewport: { width: 375, height: 667 },
        hasTouch: true,
        isMobile: true,
      },
    },
  ],
});
