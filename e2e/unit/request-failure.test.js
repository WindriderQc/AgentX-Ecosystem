'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { describeRequestFailure } = require('../request-failure');

test('retains the URL, resource type, and Playwright failure reason', () => {
  const request = {
    url: () => 'http://127.0.0.1:3181/css/missing.css',
    resourceType: () => 'stylesheet',
    failure: () => ({ errorText: 'net::ERR_ABORTED' }),
  };

  assert.deepEqual(describeRequestFailure(request), {
    url: 'http://127.0.0.1:3181/css/missing.css',
    resourceType: 'stylesheet',
    failureReason: 'net::ERR_ABORTED',
  });
});

test('retains an explicit fallback when Playwright supplies no reason', () => {
  const request = {
    url: () => 'http://127.0.0.1:3181/js/missing.js',
    resourceType: () => 'script',
    failure: () => null,
  };

  assert.deepEqual(describeRequestFailure(request), {
    url: 'http://127.0.0.1:3181/js/missing.js',
    resourceType: 'script',
    failureReason: 'request failed without an error reason',
  });
});
