'use strict';
const shared = require('../../../shared/testing/httpHarness');
const supertest = require('supertest');
module.exports = {
  ...shared,
  createTestHttpRequester: (server, options) => shared.createTestHttpRequester(server, supertest, options),
  startTestHttpHarness: (app, options) => shared.startTestHttpHarness(app, supertest, options)
};
