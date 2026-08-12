/**
 * No-DB Jest config for pure service/UI contract tests.
 *
 * The default jest.config.js spins up mongodb-memory-server via globalSetup +
 * setupFilesAfterEnv (tests/setup-env.js). That binary is blocked in the CI
 * sandbox, so pure unit tests that touch no database use this config instead:
 * no globalSetup/globalTeardown, no Mongo setup file. It only forces
 * NODE_ENV=test so modelRouterConfig skips its pin-cache interval.
 *
 *   node scripts/run-jest.js --config jest.nodb.config.js --ci
 */
process.env.NODE_ENV = 'test';

module.exports = {
  testEnvironment: 'node',
  testMatch: [
    '**/tests/unit/dataToolboxOps.test.js',
    '**/tests/unit/sharedDriveJanitorUi.test.js'
  ],
  verbose: true,
  testTimeout: 20000,
  // Deliberately NO globalSetup / globalTeardown / setupFilesAfterEnv:
  // these unit tests are pure (no MongoDB).
  setupFiles: ['<rootDir>/tests/setup-nodb.js']
};
