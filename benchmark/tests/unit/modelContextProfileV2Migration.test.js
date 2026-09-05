'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const {
  migrationFilter,
  migrationPipeline
} = require('../../scripts/migrate-model-context-profile-v2');

describe('ModelContextProfile v2 migration', () => {
  let mongo;
  let connection;
  let collection;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    connection = await mongoose.createConnection(mongo.getUri()).asPromise();
    collection = connection.collection('modelcontextprofiles');
  }, 15_000);

  afterAll(async () => {
    await connection?.close();
    await mongo?.stop();
  });

  test('invalidates legacy 262K recommendations, preserves verified v2 recommendations, and is idempotent', async () => {
    await collection.insertMany([
      {
        _id: 'legacy',
        modelName: 'ornith',
        verifiedMaxContext: 262144,
        recommendedContext: 262144
      },
      {
        _id: 'current-v3',
        modelName: 'qwen',
        maxVerifiedContext: 262144,
        recommendedInteractiveContext: 32768,
        recommendedDocumentContext: 65536,
        recommendedContext: 65536,
        recommendationStatus: 'verified',
        recommendationEvidenceVersion: 'context-probe-degradation-v3',
        revalidationRequired: false,
        stale: false
      },
      {
        _id: 'legacy-filled-262k',
        modelName: 'legacy-filled',
        maxVerifiedContext: 262144,
        historicalMaxVerifiedContext: 262144,
        recommendedInteractiveContext: 262144,
        recommendedDocumentContext: 262144,
        recommendedContext: 262144,
        recommendationStatus: 'verified',
        recommendationEvidenceVersion: 'context-probe-degradation-v2',
        revalidationRequired: false,
        stale: false
      }
    ]);

    const first = await collection.updateMany(migrationFilter(), migrationPipeline());
    expect(first.modifiedCount).toBe(3);

    const legacy = await collection.findOne({ _id: 'legacy' });
    expect(legacy).toMatchObject({
      maxVerifiedContext: 262144,
      historicalMaxVerifiedContext: 262144,
      recommendedInteractiveContext: null,
      recommendedDocumentContext: null,
      recommendedContext: null,
      recommendationStatus: 'unknown',
      revalidationRequired: true,
      stale: true,
      staleReason: 'legacy_context_revalidation_required'
    });
    expect(legacy).toMatchObject({
      performanceKneeContext: null,
      performanceKneeDegradationPct: 15,
      qualityVerifiedContext: null,
      qualityContextStatus: 'unknown'
    });

    const current = await collection.findOne({ _id: 'current-v3' });
    expect(current).toMatchObject({
      maxVerifiedContext: 262144,
      historicalMaxVerifiedContext: 262144,
      recommendedInteractiveContext: 32768,
      recommendedDocumentContext: 65536,
      recommendedContext: 65536,
      recommendationStatus: 'verified',
      recommendationEvidenceVersion: 'context-probe-degradation-v3',
      revalidationRequired: false,
      stale: false
    });
    expect(current).toMatchObject({
      performanceKneeContext: null,
      qualityVerifiedContext: null,
      qualityContextStatus: 'unknown'
    });

    const filledLegacy = await collection.findOne({ _id: 'legacy-filled-262k' });
    expect(filledLegacy).toMatchObject({
      maxVerifiedContext: 262144,
      historicalMaxVerifiedContext: 262144,
      recommendedInteractiveContext: null,
      recommendedDocumentContext: null,
      recommendedContext: null,
      recommendationStatus: 'unknown',
      recommendationEvidenceVersion: 'legacy-unverified',
      revalidationRequired: true,
      stale: true
    });

    const second = await collection.updateMany(migrationFilter(), migrationPipeline());
    expect(second.matchedCount).toBe(0);
    expect(second.modifiedCount).toBe(0);
  });
});
