'use strict';
const shared = require('../../../shared/testing/httpHarness');
const supertest = require('supertest');
module.exports = {
  ...shared,
  createTestHttpRequester: server => shared.createTestHttpRequester(server, supertest),
  startTestHttpHarness: app => shared.startTestHttpHarness(app, supertest)
};
