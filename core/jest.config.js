const JEST_TEST_TIMEOUT = Number(process.env.JEST_TEST_TIMEOUT || 60000);

module.exports = {
  testEnvironment: 'node',
  coverageDirectory: 'coverage',
  collectCoverageFrom: [
    'src/**/*.js',
    'routes/**/*.js',
    'models/**/*.js',
    '!**/node_modules/**',
    '!**/tests/**'
  ],
  testMatch: [
    '**/tests/**/*.test.js'
  ],
  verbose: true,
  testTimeout: Number.isFinite(JEST_TEST_TIMEOUT) && JEST_TEST_TIMEOUT > 0 ? JEST_TEST_TIMEOUT : 60000,
  setupFilesAfterEnv: ['./tests/setup-env.js'],
  globalSetup: './tests/jest.globalSetup.js',
  globalTeardown: './tests/jest.globalTeardown.js',
  // forceExit removed (2026-04-10): the setTimeout leak in
  // modelRouter.classifyQuery is fixed (clearTimeout now runs in finally),
  // so Jest exits cleanly on its own. Keep this off so any future leaks
  // surface as a hang + "open handle" warning instead of being masked.
  detectOpenHandles: false,
  openHandlesTimeout: 0,
  reporters: [
    'default',
    [
      '<rootDir>/tests/jestSuiteTimerReporter.js',
      {
        slowSuiteMs: 5000,
        showTopSlow: 10
      }
    ]
  ]
};
