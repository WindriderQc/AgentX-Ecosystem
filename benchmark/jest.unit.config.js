/**
 * Fast unit-only Jest config (npm run test:unit).
 *
 * The base config forces maxWorkers: 1 because integration suites share one
 * real MongoDB. Unit suites either mock I/O or spawn their own
 * mongodb-memory-server instance, so they can run in parallel safely.
 *
 * NOTE: do not select unit tests by appending a positional pattern to
 * `npm test` — the script's trailing --testPathIgnorePatterns is a yargs
 * array option and swallows the pattern, silently running the integration
 * suites instead.
 */
const base = require('./jest.config');

module.exports = {
  ...base,
  roots: ['<rootDir>/tests/unit'],
  maxWorkers: '50%',
  testPathIgnorePatterns: [
    ...(base.testPathIgnorePatterns || [])
  ]
};
