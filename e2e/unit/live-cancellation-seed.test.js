'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function evaluateSeed() {
  const documents = new Map();
  const collection = (name) => ({
    countDocuments: () => 0,
    insertOne: (value) => documents.set(name, [value]),
    insertMany: (values) => documents.set(name, values),
  });
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'fixtures', 'live-cancellation-seed.mongodb.js'),
    'utf8'
  );
  vm.runInNewContext(source, {
    db: { getCollection: collection, ...Object.fromEntries([
      'hostprofiles',
      'modelregistries',
      'modelprofiles',
      'modelcontextprofiles',
      'modelperformanceprofiles',
      'benchmarkprompts',
    ].map((name) => [name, collection(name)])) },
    ObjectId: (value) => ({ toString: () => value }),
    print: () => {},
  });
  return documents;
}

test('live cancellation seed provides fresh exact profiler authority and v2 context policy', () => {
  const documents = evaluateSeed();
  const modelProfile = documents.get('modelprofiles')[0];
  const performance = documents.get('modelperformanceprofiles')[0];
  const context = documents.get('modelcontextprofiles')[0];
  const readiness = modelProfile.readiness.primary;

  assert.equal(readiness.benchmarkQualified, true);
  assert.equal(readiness.profileDepth, 'standard');
  assert.equal(readiness.measurementReliability, 'medium');
  assert.equal(String(readiness.evidenceId), String(performance._id));
  assert.deepEqual(
    {
      version: readiness.authorityReceipt.version,
      source: readiness.authorityReceipt.source,
      evidenceId: readiness.authorityReceipt.evidenceId,
    },
    {
      version: 1,
      source: 'profiler_pipeline',
      evidenceId: String(performance._id),
    }
  );
  assert.match(readiness.authorityReceipt.digest, /^[a-f0-9]{64}$/);
  assert.equal(Number.isNaN(Date.parse(readiness.authorityReceipt.issuedAt)), false);
  assert.deepEqual(performance.artifact, readiness.artifact);
  assert.equal(performance.active, true);
  assert.equal(performance.stale, false);
  assert.equal(performance.profile.recommendedInteractiveContext, 4096);
  assert.equal(performance.profile.requiredRetainedSamples, 5);
  assert.equal(performance.profile.measurementQuality.passingSampleCount, 5);
  assert.equal(performance.profile.measurementQuality.reliability, 'medium');

  assert.equal(context.maxVerifiedContext, 4096);
  assert.equal(context.historicalMaxVerifiedContext, 4096);
  assert.equal(context.recommendedInteractiveContext, 4096);
  assert.equal(context.recommendedDocumentContext, 4096);
  assert.equal(context.recommendationStatus, 'verified');
  assert.equal(context.recommendationEvidenceVersion, 'context-probe-degradation-v3');
  assert.equal(context.revalidationRequired, false);
});
