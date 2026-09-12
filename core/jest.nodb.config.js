'use strict';
const base = require('./jest.config');
module.exports = {
  ...base,
  globalSetup: undefined,
  globalTeardown: undefined,
  setupFilesAfterEnv: ['<rootDir>/../shared/testing/noDatabase.js'],
  // An explicit verified subset; the full suite remains authoritative.
  testMatch: ['costCalculator', 'tokenCounter', 'thinkingPolicy', 'modelNameNormalization',
    'typedConfirmation', 'endpointPathPolicy', 'browserPublicUrls', 'pipelineLaunchController', '*Ui'].map(name => `**/tests/unit/${name}.test.js`)
};
