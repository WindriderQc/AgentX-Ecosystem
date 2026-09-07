/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  globalSetup: '<rootDir>/jest.globalSetup.js',
  setupFiles: ['<rootDir>/tests/setup/mongomsVersion.js'],
  setupFilesAfterEnv: ['<rootDir>/tests/setup/mongoTarget.js'],
  // Suites own their Mongo instances; bound resource use across concurrent agents.
  maxWorkers: 2,
  openHandlesTimeout: 1000,
  testPathIgnorePatterns: ['/node_modules/']
};
