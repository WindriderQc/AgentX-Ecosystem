/** @type {import('jest').Config} */
// No-DB config for pure unit suites (task 0296 capability grader/aggregator).
// Deliberately omits tests/setup/mongomsVersion.js so MongoMemoryServer never
// boots — these suites are pure functions with no DB or network.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/qualification/**/*.test.js'],
  testPathIgnorePatterns: ['/node_modules/', '/tests/e2e/']
};
