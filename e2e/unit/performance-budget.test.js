'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const test = require('node:test');

const {
  budgetViolations,
  createPerformanceCollector,
  createPerformanceRecord,
} = require('../tests/support/performance-budget');

class FakePage extends EventEmitter {
  async evaluate() {}

  locator(selector) {
    assert.equal(selector, '*');
    return { count: async () => 42 };
  }
}

function request(url, resourceType) {
  return { url: () => url, resourceType: () => resourceType };
}

function response(requestValue, body, ok = true) {
  return {
    request: () => requestValue,
    ok: () => ok,
    body: async () => Buffer.from(body),
  };
}

test('collector counts unique successful decoded first-party release assets only', async () => {
  const page = new FakePage();
  const collector = createPerformanceCollector(page, {
    allowedOrigins: ['http://127.0.0.1:3180'],
  });
  const documentRequest = request('http://127.0.0.1:3180/playground', 'document');
  const scriptRequest = request('http://127.0.0.1:3180/js/app.js', 'script');
  const externalRequest = request('https://cdn.example.test/app.js', 'script');
  const failedStyle = request('http://127.0.0.1:3180/css/missing.css', 'stylesheet');

  for (const entry of [documentRequest, scriptRequest, externalRequest, failedStyle]) {
    page.emit('request', entry);
  }
  page.emit('response', response(documentRequest, '12345'));
  page.emit('response', response(scriptRequest, '1234567'));
  page.emit('response', response(scriptRequest, 'duplicate-must-not-count'));
  page.emit('response', response(externalRequest, 'external-must-not-count'));
  page.emit('response', response(failedStyle, 'failed-must-not-count', false));
  for (const entry of [documentRequest, scriptRequest, externalRequest, failedStyle]) {
    page.emit('requestfinished', entry);
  }

  const metrics = await collector.settle();
  assert.deepEqual(metrics, {
    decodedBytes: 12,
    javaScriptBytes: 7,
    assetRequests: 2,
    domNodes: 42,
    byType: {
      document: { requests: 1, decodedBytes: 5 },
      script: { requests: 1, decodedBytes: 7 },
      stylesheet: { requests: 0, decodedBytes: 0 },
      font: { requests: 0, decodedBytes: 0 },
      image: { requests: 0, decodedBytes: 0 },
    },
  });
  assert.equal(page.listenerCount('response'), 0);
});

test('budget records stay address-free and expose exact violations', () => {
  const metrics = {
    decodedBytes: 101,
    javaScriptBytes: 50,
    assetRequests: 3,
    domNodes: 11,
    byType: {},
  };
  const budget = {
    id: 'standard',
    limits: {
      maxDecodedBytes: 100,
      maxJavaScriptBytes: 50,
      maxAssetRequests: 2,
      maxDomNodes: 20,
    },
  };
  const record = createPerformanceRecord({
    surface: { id: 'core-playground', service: 'core', path: '/playground' },
    profile: 'demo',
    project: 'desktop-chromium',
    viewport: { width: 1440, height: 900 },
    budget,
    metrics,
  });

  assert.deepEqual(budgetViolations(metrics, budget.limits), [
    { field: 'decodedBytes', label: 'decoded first-party bytes', observed: 101, limit: 100 },
    { field: 'assetRequests', label: 'unique first-party release-asset responses', observed: 3, limit: 2 },
  ]);
  assert.equal(JSON.stringify(record).includes('http://'), false);
  assert.deepEqual(record.surface, { id: 'core-playground', service: 'core' });
});
