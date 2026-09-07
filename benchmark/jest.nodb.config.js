'use strict';
// Pure qualification suites. Mongo and executable repository fixtures remain
// covered by test:unit and npm test.
module.exports = {
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/unit/qualification/**/*.test.js'],
  setupFilesAfterEnv: ['<rootDir>/../shared/testing/noDatabase.js'],
  testPathIgnorePatterns: ['/node_modules/', 'toolCapabilityQualificationMongo.test.js',
    'repoQualificationRunner.test.js', 'executableRepoGrader.test.js', 'repoTaskFixtures.test.js']
};
