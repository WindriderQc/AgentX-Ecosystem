/** @type {import('jest').Config} */
module.exports = {
  testEnvironmentOptions: {},
  // Pin MongoMemoryServer to the working binary version (8.2.1 seg-faults on this host)
  testEnvironment: 'node',
  // Sweep stale mongo-mem-* temp dirs left by hard-killed runs (best-effort).
  globalSetup: '<rootDir>/jest.globalSetup.js',
  // Inject MONGOMS_VERSION before any test file is loaded
  setupFiles: ['<rootDir>/tests/setup/mongomsVersion.js'],
  // Integration tests share a single real MongoDB (agentx_test). Several suites
  // (benchmark.test.js, batchPipeline.test.js, …) issue collection-wide
  // deleteMany({}) in their hooks, which corrupts mid-flight docs from any
  // parallel suite. Force serial execution so the shared DB stays consistent.
  maxWorkers: 1,
  // tests/e2e are Playwright specs and require @playwright/test, which is not
  // a Jest dependency. Keep them out of Jest's run.
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/']
};
