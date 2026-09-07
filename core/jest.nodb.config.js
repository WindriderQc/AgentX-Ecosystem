'use strict';
const base = require('./jest.config');
module.exports = {
  ...base,
  globalSetup: undefined,
  globalTeardown: undefined,
  setupFilesAfterEnv: ['<rootDir>/../shared/testing/noDatabase.js'],
  // An explicit verified subset; the full suite remains authoritative.
  testMatch: ['costCalculator', 'tokenCounter', 'thinkingPolicy', 'modelNameNormalization',
    'typedConfirmation', 'endpointPathPolicy', 'browserPublicUrls', '*Ui'].map(name => `<rootDir>/tests/unit/${name}.test.js`)
};
