'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const AgentXPerformanceReporter = require('../performance-reporter');
const {
  PERFORMANCE_ATTACHMENT_NAME,
  createPerformanceRecord,
} = require('../tests/support/performance-budget');

function recordFor(surfaceId, project, decodedBytes = 10) {
  return createPerformanceRecord({
    surface: { id: surfaceId, service: surfaceId.split('-')[0] },
    profile: 'demo',
    project,
    viewport: { width: 375, height: 667 },
    budget: {
      id: 'standard',
      limits: {
        maxDecodedBytes: 100,
        maxJavaScriptBytes: 100,
        maxAssetRequests: 10,
        maxDomNodes: 100,
      },
    },
    metrics: {
      decodedBytes,
      javaScriptBytes: 5,
      assetRequests: 2,
      domNodes: 20,
      byType: {},
    },
  });
}

test('custom reporter writes a deterministic, sorted, address-free receipt', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-performance-reporter-'));
  const outputFile = path.join(temporaryRoot, 'receipt.json');
  const reporter = new AgentXPerformanceReporter({
    outputFile,
    now: () => new Date('2026-08-28T12:00:00.000Z'),
  });
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  reporter.onBegin();
  for (const record of [
    recordFor('rag-home', 'mobile-chromium'),
    recordFor('core-playground', 'desktop-chromium'),
  ]) {
    reporter.onTestEnd(null, {
      attachments: [{
        name: PERFORMANCE_ATTACHMENT_NAME,
        contentType: 'application/json',
        body: Buffer.from(JSON.stringify(record)),
      }],
    });
  }
  const override = reporter.onEnd({ status: 'passed' });

  const receipt = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(receipt.kind, 'agentx.browser-performance');
  assert.equal(receipt.generatedAt, '2026-08-28T12:00:00.000Z');
  assert.equal(receipt.profile, 'demo');
  assert.equal(receipt.status, 'pass');
  assert.deepEqual(receipt.summary, {
    observations: 2,
    expected: 2,
    missing: 0,
    passed: 2,
    failed: 0,
    malformedAttachments: 0,
  });
  assert.deepEqual(receipt.observations.map((entry) => entry.surface.id), [
    'core-playground',
    'rag-home',
  ]);
  assert.doesNotMatch(JSON.stringify(receipt), /https?:\/\//);
  assert.equal(override, undefined);
});

test('custom reporter overrides the Playwright result when observations are missing', (t) => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-performance-reporter-'));
  const outputFile = path.join(temporaryRoot, 'receipt.json');
  const reporter = new AgentXPerformanceReporter({ outputFile });
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));

  reporter.onBegin(null, {
    allTests: () => [{ location: { file: 'critical-surfaces.spec.js' } }],
  });

  assert.deepEqual(reporter.onEnd({ status: 'passed' }), { status: 'failed' });
  const receipt = JSON.parse(fs.readFileSync(outputFile, 'utf8'));
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.summary.missing, 1);
});

test('receipt fails closed on malformed attachments or exceeded limits', () => {
  const receipt = AgentXPerformanceReporter.createReceipt([
    recordFor('core-playground', 'desktop-chromium', 101),
  ], 'passed', {
    now: () => new Date('2026-08-28T12:00:00.000Z'),
    errors: ['malformed-performance-attachment'],
  });

  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.summary.failed, 1);
  assert.equal(receipt.summary.malformedAttachments, 1);
  assert.deepEqual(receipt.observations[0].violations, [
    { field: 'decodedBytes', label: 'decoded first-party bytes', observed: 101, limit: 100 },
  ]);
});

test('receipt cannot claim success without a performance observation', () => {
  const receipt = AgentXPerformanceReporter.createReceipt([], 'passed', {
    now: () => new Date('2026-08-28T12:00:00.000Z'),
  });
  assert.equal(receipt.status, 'fail');
  assert.equal(receipt.summary.observations, 0);
  assert.equal(receipt.summary.expected, 1);
  assert.equal(receipt.summary.missing, 1);
});
