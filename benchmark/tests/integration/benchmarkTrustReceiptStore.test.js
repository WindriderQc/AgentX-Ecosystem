'use strict';

process.env.MONGOMS_VERSION = '7.0.24';

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkTimelineEntry = require('../../models/BenchmarkTimelineEntry');
const BenchmarkTrustReceipt = require('../../models/BenchmarkTrustReceipt');
const {
    BENCHMARK_TRUST_RECEIPT_SCHEMA,
    buildBenchmarkTrustReceipt,
    computeCandidateSetFingerprint,
    serializeBenchmarkTrustReceipt
} = require('../../../shared/benchmarkTrustReceipt');
const {
    MAX_BATCH_READ_LIMIT,
    storeBenchmarkTrustReceipt,
    getBenchmarkTrustReceiptById,
    listBenchmarkTrustReceiptsBySourceBatch
} = require('../../src/services/benchmark/benchmarkTrustReceiptStore');
const { archiveOldResults } = require('../../src/services/benchmark/dataRetention');
const { clearResults, clearFailedResults } = require('../../src/services/benchmark/batches');

const clone = (value) => JSON.parse(JSON.stringify(value));
const sourceBatchId = (character = 'd') => `batch_${character.repeat(32)}`;
const candidateId = (character) => `candidate_${character.repeat(32)}`;

function bodyFixture({ sourceId = sourceBatchId(), campaignCharacter = 'c' } = {}) {
    const candidates = [
        {
            candidateId: candidateId('a'),
            artifactFingerprint: '1'.repeat(64),
            runtimeFingerprint: '2'.repeat(64),
            environmentFingerprint: '3'.repeat(64),
            resultSetFingerprint: '4'.repeat(64)
        },
        {
            candidateId: candidateId('b'),
            artifactFingerprint: '5'.repeat(64),
            runtimeFingerprint: '6'.repeat(64),
            environmentFingerprint: '7'.repeat(64),
            resultSetFingerprint: '8'.repeat(64)
        }
    ];
    return {
        schema: BENCHMARK_TRUST_RECEIPT_SCHEMA,
        createdAt: '2026-08-31T12:00:00.000Z',
        validUntil: '2026-09-30T12:00:00.000Z',
        claimScope: 'capability',
        product: {
            revision: 'a'.repeat(40),
            coreImageDigest: `sha256:${'b'.repeat(64)}`,
            benchmarkImageDigest: `sha256:${'c'.repeat(64)}`,
            ragImageDigest: `sha256:${'d'.repeat(64)}`
        },
        execution: {
            campaignId: `campaign_${campaignCharacter.repeat(32)}`,
            sourceBatchId: sourceId,
            campaignFingerprint: 'e'.repeat(64),
            inferenceProfileFingerprint: 'f'.repeat(64),
            promptCatalogFingerprint: '0'.repeat(64),
            candidateSetFingerprint: computeCandidateSetFingerprint(candidates),
            cellInventory: {
                fingerprint: '3'.repeat(64),
                cellCount: 4,
                minimumRepeatCount: 2,
                maximumRepeatCount: 2
            },
            promptCount: 2,
            expectedResultCount: 8,
            observedResultCount: 8,
            excludedResultCount: 0,
            exclusionManifestFingerprint: null,
            candidates
        },
        judge: {
            qualificationReceiptId: '9'.repeat(64),
            identityFingerprint: 'a'.repeat(64),
            rubricFingerprint: 'b'.repeat(64),
            corpusFingerprint: 'c'.repeat(64),
            holdoutFingerprint: 'd'.repeat(64),
            qualificationStatus: 'qualified',
            validUntil: '2026-09-15T12:00:00.000Z'
        },
        statistics: {
            unit: 'prompt',
            method: 'paired-prompt-t-v1',
            alphaBasisPoints: 500,
            multiplicityCorrection: 'bonferroni',
            minimumEffectMicros: 25000,
            preregistration: {
                repeatCount: 2,
                analysisPlanFingerprint: '1'.repeat(64)
            },
            rankingPolicyFingerprint: '2'.repeat(64),
            decisionFingerprint: 'e'.repeat(64),
            winnerCandidateId: candidateId('a'),
            equivalenceCandidateIds: []
        },
        axes: {
            evidenceStatus: 'complete',
            decisionOutcome: 'winner',
            freshnessStatus: 'fresh'
        },
        privacy: {
            containsRawPrompts: false,
            containsRawResponses: false,
            containsPrivateEnvironmentIdentity: false,
            containsProviderPayloads: false,
            containsSecrets: false
        }
    };
}

async function createLinkedBatch(sourceId = sourceBatchId(), overrides = {}) {
    return BenchmarkBatch.create({
        run_name: `trust-${sourceId}`,
        host: 'opaque-test-host',
        models: ['model-a', 'model-b'],
        levels: [1],
        total_tests: 8,
        trust_batch_id: sourceId,
        ...overrides
    });
}

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongoServer.getUri(), { dbName: 'benchmark_trust_receipt_store_test' });
    await Promise.all([BenchmarkBatch.init(), BenchmarkTrustReceipt.init()]);
});

beforeEach(async () => {
    // Raw collection cleanup is deliberately test-only. The receipt model API
    // rejects delete operations because production receipts are append-only.
    await BenchmarkTrustReceipt.collection.deleteMany({});
    await BenchmarkResult.collection.deleteMany({});
    await BenchmarkTimelineEntry.collection.deleteMany({});
    await BenchmarkBatch.deleteMany({});
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('BenchmarkTrustReceipt append-only store', () => {
    test('creates durable source-batch and append-only receipt indexes', async () => {
        const [receiptIndexes, batchIndexes] = await Promise.all([
            BenchmarkTrustReceipt.collection.indexes(),
            BenchmarkBatch.collection.indexes()
        ]);
        const receipts = new Map(receiptIndexes.map((index) => [index.name, index]));
        const batches = new Map(batchIndexes.map((index) => [index.name, index]));

        expect(receipts.get('uniq_benchmark_trust_receipt_id')).toMatchObject({
            key: { receiptId: 1 },
            unique: true
        });
        expect(receipts.get('benchmark_trust_receipt_source_batch_read').key)
            .toEqual({ sourceBatchId: 1, issuedAt: -1, receiptId: 1 });
        expect(receipts.get('benchmark_trust_receipt_decision_read').key)
            .toEqual({ decisionFingerprint: 1, issuedAt: -1 });
        expect(receipts.get('benchmark_trust_receipt_status_read').key).toEqual({
            evidenceStatus: 1,
            freshnessStatus: 1,
            decisionOutcome: 1,
            issuedAt: -1
        });
        expect(batches.get('uniq_benchmark_batch_trust_batch_id')).toMatchObject({
            key: { trust_batch_id: 1 },
            unique: true
        });
    });

    test('stores only a strictly verified payload linked to a durable opaque batch', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        const stored = await storeBenchmarkTrustReceipt(receipt);

        expect(stored).toEqual({ created: true, receipt });
        const raw = await BenchmarkTrustReceipt.findOne({ receiptId: receipt.receiptId }).lean();
        expect(raw.canonicalPayload).toBe(serializeBenchmarkTrustReceipt(receipt));
        expect(raw.sourceBatchId).toBe(sourceId);
        expect(raw).not.toHaveProperty('batchId');
        await expect(getBenchmarkTrustReceiptById(receipt.receiptId)).resolves.toEqual(receipt);

        const unlinked = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: sourceBatchId('e'),
            campaignCharacter: 'e'
        }));
        await expect(storeBenchmarkTrustReceipt(unlinked)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_BATCH_NOT_FOUND'
        });
    });

    test('makes concurrent creation idempotent through insert then duplicate-read/compare', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        const attempts = await Promise.all(
            Array.from({ length: 12 }, () => storeBenchmarkTrustReceipt(clone(receipt)))
        );

        expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
        expect(attempts.filter((attempt) => !attempt.created)).toHaveLength(11);
        expect(attempts.every((attempt) => attempt.receipt.receiptId === receipt.receiptId)).toBe(true);
        await expect(BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId })).resolves.toBe(1);
    });

    test('fails closed when stored payload, projections, or canonical content are tampered', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        await storeBenchmarkTrustReceipt(receipt);

        await BenchmarkTrustReceipt.collection.updateOne(
            { receiptId: receipt.receiptId },
            { $set: { 'payload.statistics.minimumEffectMicros': 1 } }
        );
        await expect(getBenchmarkTrustReceiptById(receipt.receiptId)).rejects.toMatchObject({
            code: BenchmarkTrustReceipt.TAMPER_ERROR_CODE
        });

        await BenchmarkTrustReceipt.collection.updateOne(
            { receiptId: receipt.receiptId },
            {
                $set: {
                    payload: clone(receipt),
                    sourceBatchId: sourceBatchId('f'),
                    canonicalPayload: serializeBenchmarkTrustReceipt(receipt)
                }
            }
        );
        await expect(getBenchmarkTrustReceiptById(receipt.receiptId)).rejects.toMatchObject({
            code: BenchmarkTrustReceipt.TAMPER_ERROR_CODE
        });
    });

    test('rejects update, replace and delete operations at the model boundary', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        await storeBenchmarkTrustReceipt(receipt);

        const immutable = { code: BenchmarkTrustReceipt.IMMUTABLE_ERROR_CODE };
        await expect(BenchmarkTrustReceipt.updateOne(
            { receiptId: receipt.receiptId },
            { $set: { evidenceStatus: 'invalid' } }
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkTrustReceipt.replaceOne(
            { receiptId: receipt.receiptId },
            BenchmarkTrustReceipt.buildStoredRecord(receipt)
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkTrustReceipt.deleteOne({ receiptId: receipt.receiptId }))
            .rejects.toMatchObject(immutable);
        await expect(BenchmarkTrustReceipt.deleteMany({ sourceBatchId: sourceId }))
            .rejects.toMatchObject(immutable);
        await expect(BenchmarkTrustReceipt.bulkWrite([{
            deleteOne: { filter: { receiptId: receipt.receiptId } }
        }])).rejects.toMatchObject(immutable);

        const document = await BenchmarkTrustReceipt.findOne({ receiptId: receipt.receiptId });
        document.campaignId = `campaign_${'f'.repeat(32)}`;
        await expect(document.save()).rejects.toThrow(/immutable/);
        await expect(document.deleteOne()).rejects.toMatchObject(immutable);
    });

    test('bounds exact receipt and source-batch reads without exposing Mongo ids', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipts = await Promise.all(['a', 'b', 'c'].map(async (character) => {
            const receipt = buildBenchmarkTrustReceipt(bodyFixture({
                sourceId,
                campaignCharacter: character
            }));
            await storeBenchmarkTrustReceipt(receipt);
            return receipt;
        }));

        const listed = await listBenchmarkTrustReceiptsBySourceBatch(sourceId, { limit: 2 });
        expect(listed).toHaveLength(2);
        expect(listed.every((receipt) => receipts.some((expected) => expected.receiptId === receipt.receiptId)))
            .toBe(true);
        await expect(getBenchmarkTrustReceiptById('not-a-receipt')).rejects.toMatchObject({
            code: 'INVALID_RECEIPT_ID'
        });
        await expect(listBenchmarkTrustReceiptsBySourceBatch(sourceId, {
            limit: MAX_BATCH_READ_LIMIT + 1
        })).rejects.toMatchObject({ code: 'INVALID_READ_LIMIT' });
        await expect(listBenchmarkTrustReceiptsBySourceBatch('507f1f77bcf86cd799439011'))
            .rejects.toMatchObject({ code: 'INVALID_SOURCE_BATCH_ID' });
    });

    test('resolves opaque receipt ids back to exact Mongo evidence during retention', async () => {
        const old = new Date('2025-01-01T00:00:00.000Z');
        const protectedSourceId = sourceBatchId('d');
        const protectedBatch = await createLinkedBatch(protectedSourceId, {
            run_name: 'protected-batch',
            status: 'completed',
            completed_at: old,
            description: 'protected'
        });
        const openBatch = await createLinkedBatch(sourceBatchId('e'), {
            run_name: 'open-batch',
            status: 'completed',
            completed_at: old,
            description: 'open'
        });
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: protectedSourceId }));
        await storeBenchmarkTrustReceipt(receipt);

        await BenchmarkResult.collection.insertMany([
            { batch_id: protectedBatch._id, model: 'model-a', marker: 'protected' },
            { batch_id: openBatch._id, model: 'model-a', marker: 'open' }
        ]);
        await BenchmarkTimelineEntry.collection.insertMany([
            { batchId: protectedBatch._id, event: 'protected-event' },
            { batchId: openBatch._id, event: 'open-event' }
        ]);

        const result = await archiveOldResults(1, false);

        expect(result).toMatchObject({
            batchesProcessed: 1,
            resultsDeleted: 1,
            protectedBatches: 1,
            protectedResults: 1,
            protectedSourceBatchIds: [protectedSourceId]
        });
        await expect(BenchmarkResult.collection.countDocuments({ batch_id: protectedBatch._id }))
            .resolves.toBe(1);
        await expect(BenchmarkResult.collection.countDocuments({ batch_id: openBatch._id }))
            .resolves.toBe(0);
        await expect(BenchmarkTimelineEntry.collection.countDocuments({ batchId: protectedBatch._id }))
            .resolves.toBe(1);
        await expect(BenchmarkTimelineEntry.collection.countDocuments({ batchId: openBatch._id }))
            .resolves.toBe(0);
        const [protectedAfter, openAfter] = await Promise.all([
            BenchmarkBatch.findById(protectedBatch._id).lean(),
            BenchmarkBatch.findById(openBatch._id).lean()
        ]);
        expect(protectedAfter.description).toBe('protected');
        expect(openAfter.description).toBe('open [archived]');
    });

    test('global and failed-result cleanup preserve exactly receipted batches', async () => {
        const protectedSourceId = sourceBatchId('d');
        const protectedBatch = await createLinkedBatch(protectedSourceId, {
            run_name: 'protected-cleanup'
        });
        const openBatch = await createLinkedBatch(sourceBatchId('e'), {
            run_name: 'open-cleanup'
        });
        await storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: protectedSourceId
        })));
        await BenchmarkResult.collection.insertMany([
            { batch_id: protectedBatch._id, model: 'protected', success: false },
            { batch_id: openBatch._id, model: 'open', success: false }
        ]);

        await expect(clearFailedResults()).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: openBatch._id })).resolves.toBe(0);

        await BenchmarkResult.collection.insertOne({
            batch_id: openBatch._id,
            model: 'open-success',
            success: true
        });
        await expect(clearResults()).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: openBatch._id })).resolves.toBe(0);
    });

    test('global cleanup fails closed when a receipt is hidden by a tampered source projection', async () => {
        const protectedSourceId = sourceBatchId('d');
        const protectedBatch = await createLinkedBatch(protectedSourceId, {
            run_name: 'tampered-cleanup'
        });
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: protectedSourceId }));
        await storeBenchmarkTrustReceipt(receipt);
        await BenchmarkResult.collection.insertOne({
            batch_id: protectedBatch._id,
            model: 'protected',
            success: false
        });
        await BenchmarkTrustReceipt.collection.updateOne(
            { receiptId: receipt.receiptId },
            { $set: { sourceBatchId: sourceBatchId('f') } }
        );

        const tampered = { code: BenchmarkTrustReceipt.TAMPER_ERROR_CODE };
        await expect(clearFailedResults()).rejects.toMatchObject(tampered);
        await expect(clearResults()).rejects.toMatchObject(tampered);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(1);
    });
});
