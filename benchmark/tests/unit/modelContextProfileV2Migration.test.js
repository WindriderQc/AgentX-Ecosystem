'use strict';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { migrationPipeline } = require('../../scripts/migrate-model-context-profile-v2');

const migrationFilter = { $or: [
  { maxVerifiedContext: { $exists: false } },
  { historicalMaxVerifiedContext: { $exists: false } },
  { recommendedInteractiveContext: { $exists: false } },
  { recommendedDocumentContext: { $exists: false } },
  { recommendationStatus: { $exists: false } },
  { revalidationRequired: { $exists: false } }
] };

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
        _id: 'mixed-v2',
        modelName: 'qwen',
        maxVerifiedContext: 262144,
        recommendedInteractiveContext: 32768,
        recommendedDocumentContext: 65536,
        recommendedContext: 65536,
        recommendationStatus: 'verified',
        revalidationRequired: false,
        stale: false
      }
    ]);

    const first = await collection.updateMany(migrationFilter, migrationPipeline());
    expect(first.modifiedCount).toBe(2);

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

    const v2 = await collection.findOne({ _id: 'mixed-v2' });
    expect(v2).toMatchObject({
      maxVerifiedContext: 262144,
      historicalMaxVerifiedContext: 262144,
      recommendedInteractiveContext: 32768,
      recommendedDocumentContext: 65536,
      recommendedContext: 65536,
      recommendationStatus: 'verified',
      revalidationRequired: false,
      stale: false
    });

    const second = await collection.updateMany(migrationFilter, migrationPipeline());
    expect(second.matchedCount).toBe(0);
    expect(second.modifiedCount).toBe(0);
  });
});
