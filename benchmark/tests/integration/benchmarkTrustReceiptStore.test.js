'use strict';

process.env.MONGOMS_VERSION = '7.0.24';
jest.setTimeout(30_000);

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkTimelineEntry = require('../../models/BenchmarkTimelineEntry');
const BenchmarkTrustReceipt = require('../../models/BenchmarkTrustReceipt');
const BenchmarkTrustEvidenceLock = require('../../models/BenchmarkTrustEvidenceLock');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
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
const {
    acquireBenchmarkTrustEvidenceLock,
    releaseBenchmarkTrustEvidenceLock,
    withBenchmarkTrustEvidenceLock
} = require('../../src/services/benchmark/benchmarkTrustEvidenceLock');

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

async function createLinkedBatch(
    sourceId = sourceBatchId(),
    overrides = {},
    { seedEvidence = true } = {}
) {
    const batch = await BenchmarkBatch.create({
        run_name: `trust-${sourceId}`,
        host: 'opaque-test-host',
        models: ['model-a', 'model-b'],
        levels: [1],
        total_tests: 8,
        completed: 8,
        status: 'completed',
        completed_at: new Date('2026-08-31T11:59:00.000Z'),
        trust_batch_id: sourceId,
        ...overrides
    });
    if (seedEvidence) {
        await BenchmarkResult.collection.insertMany(Array.from({ length: 8 }, (_, index) => ({
            batch_id: batch._id,
            model: index < 4 ? 'model-a' : 'model-b',
            host: 'opaque-test-host',
            prompt: `opaque-prompt-${index % 2}`,
            prompt_name: `prompt-${index % 2}`,
            success: index !== 0,
            repeat_index: index % 2,
            quality_score: 8,
            composite_score: 80,
            excluded_from_leaderboard: false
        })));
    }
    return batch;
}

function storeVerifiedReceipt(receipt, verifySourceEvidence = () => true) {
    return storeBenchmarkTrustReceipt(receipt, { verifySourceEvidence });
}

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongoServer.getUri(), { dbName: 'benchmark_trust_receipt_store_test' });
    await Promise.all([BenchmarkBatch.init(), BenchmarkTrustReceipt.init(), JudgeGroundTruth.init()]);
});

beforeEach(async () => {
    // Raw collection cleanup is deliberately test-only. The receipt model API
    // rejects delete operations because production receipts are append-only.
    await BenchmarkTrustReceipt.collection.deleteMany({});
    await BenchmarkTrustEvidenceLock.collection.deleteMany({});
    await BenchmarkResult.collection.deleteMany({});
    await BenchmarkTimelineEntry.collection.deleteMany({});
    await BenchmarkBatch.collection.deleteMany({});
    await JudgeGroundTruth.collection.deleteMany({});
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('BenchmarkTrustReceipt append-only store', () => {
    test('rejects provenance update pipelines and provenance $setOnInsert bypasses', async () => {
        const row = await JudgeGroundTruth.create({
            name: 'blind-human-proof',
            prompt: 'opaque prompt',
            response: 'opaque response',
            category: 'reasoning',
            expert_scores: { overall: 7 },
            expert_rationale: 'blind review',
            provenance_class: 'independent_human_score',
            review_protocol: 'blind_independent'
        });

        await expect(JudgeGroundTruth.updateOne(
            { _id: row._id },
            [{ $set: { review_protocol: 'judge_visible_single_review' } }]
        )).rejects.toThrow(/update pipelines are not allowed/);
        await expect(JudgeGroundTruth.updateOne(
            { name: 'upserted-human-proof' },
            { $setOnInsert: {
                provenance_class: 'independent_human_score',
                review_protocol: 'judge_visible_single_review'
            } },
            { upsert: true }
        )).rejects.toThrow(/cannot be changed through \$setOnInsert/);
        await expect(JudgeGroundTruth.updateOne(
            { name: 'contradictory-human-proof' },
            { $set: {
                prompt: 'opaque prompt',
                response: 'opaque response',
                category: 'reasoning',
                expert_scores: { overall: 7 },
                expert_rationale: 'not actually blind',
                provenance_class: 'independent_human_score',
                review_protocol: 'judge_visible_single_review'
            } },
            { upsert: true }
        )).rejects.toThrow(/complete, internally consistent review pair/);
        await expect(JudgeGroundTruth.bulkWrite([{
            updateOne: {
                filter: { _id: row._id },
                update: { $set: { review_protocol: 'judge_visible_single_review' } }
            }
        }])).rejects.toThrow(/bulkWrite is not allowed/);

        const concurrent = await Promise.allSettled([
            JudgeGroundTruth.updateOne(
                { _id: row._id },
                { $set: { provenance_class: 'independent_human_score' } }
            ),
            JudgeGroundTruth.updateOne(
                { _id: row._id },
                { $set: { review_protocol: 'judge_visible_single_review' } }
            )
        ]);
        expect(concurrent.map(result => result.status)).toEqual(['rejected', 'rejected']);

        await expect(JudgeGroundTruth.findById(row._id).lean()).resolves.toMatchObject({
            provenance_class: 'independent_human_score',
            review_protocol: 'blind_independent'
        });
        await expect(JudgeGroundTruth.countDocuments({ name: 'upserted-human-proof' })).resolves.toBe(0);
        await expect(JudgeGroundTruth.countDocuments({ name: 'contradictory-human-proof' })).resolves.toBe(0);
    });

    test('mutex is owner-bound, fail-closed when busy, and released after task failure', async () => {
        const ownerToken = await acquireBenchmarkTrustEvidenceLock('integration-lock-owner');
        await expect(acquireBenchmarkTrustEvidenceLock('integration-lock-contender', { waitMs: 0 }))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_MUTATION_BUSY' });
        await expect(releaseBenchmarkTrustEvidenceLock('0'.repeat(64)))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_LOCK_LOST' });
        await expect(BenchmarkTrustEvidenceLock.countDocuments({})).resolves.toBe(1);
        await releaseBenchmarkTrustEvidenceLock(ownerToken);
        await expect(BenchmarkTrustEvidenceLock.countDocuments({})).resolves.toBe(0);

        const taskError = new Error('expected task failure');
        await expect(withBenchmarkTrustEvidenceLock(
            'integration-lock-error-release',
            async () => { throw taskError; }
        )).rejects.toBe(taskError);
        await expect(BenchmarkTrustEvidenceLock.countDocuments({})).resolves.toBe(0);

        await expect(withBenchmarkTrustEvidenceLock(
            'integration-lock-release-loss',
            async () => {
                await BenchmarkTrustEvidenceLock.collection.deleteMany({});
            }
        )).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_LOCK_LOST' });
    });

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
        const stored = await storeVerifiedReceipt(receipt);

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
        await expect(storeVerifiedReceipt(unlinked)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_BATCH_NOT_FOUND'
        });
    });

    test('keeps the opaque source-batch link immutable across query bypass surfaces', async () => {
        const sourceId = sourceBatchId('c');
        const batch = await createLinkedBatch(sourceId);
        const sealed = { code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE };

        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            [{ $set: { trust_batch_id: sourceBatchId('f') } }]
        )).rejects.toMatchObject(sealed);
        await expect(BenchmarkBatch.replaceOne(
            { _id: batch._id },
            { trust_batch_id: sourceBatchId('f'), status: 'completed' }
        )).rejects.toMatchObject(sealed);
        await expect(BenchmarkBatch.findById(batch._id).lean()).resolves.toMatchObject({
            trust_batch_id: sourceId
        });
    });

    test('requires terminal, complete source evidence and an explicit fingerprint verifier', async () => {
        const pendingSourceId = sourceBatchId('1');
        await createLinkedBatch(pendingSourceId, { status: 'pending', completed: 0 });
        const pendingReceipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: pendingSourceId,
            campaignCharacter: '1'
        }));
        await expect(storeVerifiedReceipt(pendingReceipt)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_BATCH_NOT_TERMINAL'
        });

        const incompleteSourceId = sourceBatchId('2');
        const incompleteBatch = await createLinkedBatch(
            incompleteSourceId,
            {},
            { seedEvidence: false }
        );
        await BenchmarkResult.collection.insertOne({
            batch_id: incompleteBatch._id,
            model: 'model-a',
            host: 'opaque-test-host',
            prompt: 'only-one-result',
            success: true
        });
        const incompleteReceipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: incompleteSourceId,
            campaignCharacter: '2'
        }));
        await expect(storeVerifiedReceipt(incompleteReceipt)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_RESULTS_MISMATCH'
        });

        const unverifiedSourceId = sourceBatchId('3');
        await createLinkedBatch(unverifiedSourceId);
        const unverifiedReceipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: unverifiedSourceId,
            campaignCharacter: '3'
        }));
        await expect(storeBenchmarkTrustReceipt(unverifiedReceipt)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_NOT_VERIFIED'
        });
        await expect(storeVerifiedReceipt(unverifiedReceipt, () => false)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_NOT_VERIFIED'
        });
        await expect(BenchmarkResult.countDocuments({
            batch_id: (await BenchmarkBatch.findOne({ trust_batch_id: unverifiedSourceId }))._id,
            trust_evidence_sealed: true
        })).resolves.toBe(0);
    });

    test('retains and seals excluded rows as part of the complete source inventory', async () => {
        const sourceId = sourceBatchId('a');
        const batch = await createLinkedBatch(sourceId);
        const body = bodyFixture({ sourceId, campaignCharacter: 'a' });
        body.execution.observedResultCount = 7;
        body.execution.excludedResultCount = 1;
        body.execution.exclusionManifestFingerprint = 'f'.repeat(64);
        body.axes.evidenceStatus = 'incomplete';
        body.axes.decisionOutcome = 'inconclusive';
        body.statistics.winnerCandidateId = null;
        const receipt = buildBenchmarkTrustReceipt(body);

        await expect(storeVerifiedReceipt(receipt)).resolves.toMatchObject({
            created: true,
            receipt: { receiptId: receipt.receiptId }
        });
        await expect(BenchmarkResult.countDocuments({
            batch_id: batch._id,
            trust_evidence_sealed: true
        })).resolves.toBe(8);
    });

    test('makes concurrent creation idempotent through insert then duplicate-read/compare', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        const attempts = await Promise.all(
            Array.from({ length: 12 }, () => storeVerifiedReceipt(clone(receipt)))
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
        await storeVerifiedReceipt(receipt);

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
        await storeVerifiedReceipt(receipt);

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
            await storeVerifiedReceipt(receipt);
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
        }, { seedEvidence: false });
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: protectedSourceId }));
        await storeVerifiedReceipt(receipt);

        await BenchmarkResult.collection.insertOne({
            batch_id: openBatch._id,
            model: 'model-a',
            marker: 'open'
        });
        await BenchmarkTimelineEntry.collection.insertMany([
            { batchId: protectedBatch._id, event: 'protected-event' },
            { batchId: openBatch._id, event: 'open-event' }
        ]);

        const result = await archiveOldResults(1, false);

        expect(result).toMatchObject({
            batchesProcessed: 1,
            resultsDeleted: 1,
            protectedBatches: 1,
            protectedResults: 8,
            protectedSourceBatchIds: [protectedSourceId]
        });
        await expect(BenchmarkResult.collection.countDocuments({ batch_id: protectedBatch._id }))
            .resolves.toBe(8);
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
        }, { seedEvidence: false });
        await storeVerifiedReceipt(buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: protectedSourceId
        })));
        await BenchmarkResult.collection.insertOne({
            batch_id: openBatch._id,
            model: 'open',
            success: false
        });

        await expect(clearFailedResults()).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(8);
        await expect(BenchmarkResult.countDocuments({ batch_id: openBatch._id })).resolves.toBe(0);

        await BenchmarkResult.collection.insertOne({
            batch_id: openBatch._id,
            model: 'open-success',
            success: true
        });
        await expect(clearResults()).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(8);
        await expect(BenchmarkResult.countDocuments({ batch_id: openBatch._id })).resolves.toBe(0);
    });

    test('global cleanup fails closed when a receipt is hidden by a tampered source projection', async () => {
        const protectedSourceId = sourceBatchId('d');
        const protectedBatch = await createLinkedBatch(protectedSourceId, {
            run_name: 'tampered-cleanup'
        });
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: protectedSourceId }));
        await storeVerifiedReceipt(receipt);
        await BenchmarkTrustReceipt.collection.updateOne(
            { receiptId: receipt.receiptId },
            { $set: { sourceBatchId: sourceBatchId('f') } }
        );

        const tampered = { code: BenchmarkTrustReceipt.TAMPER_ERROR_CODE };
        await expect(clearFailedResults()).rejects.toMatchObject(tampered);
        await expect(clearResults()).rejects.toMatchObject(tampered);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(8);
    });

    test('global cleanup preserves partially sealed crash-recovery states without a receipt', async () => {
        const batchSealed = await createLinkedBatch(sourceBatchId('2'));
        const resultsSealed = await createLinkedBatch(sourceBatchId('3'));
        await BenchmarkBatch.collection.updateOne(
            { _id: batchSealed._id },
            { $set: { trust_evidence_sealed: true } }
        );
        await BenchmarkResult.collection.updateMany(
            { batch_id: resultsSealed._id },
            { $set: { trust_evidence_sealed: true } }
        );

        await expect(clearResults()).resolves.toBe(0);
        await expect(BenchmarkResult.countDocuments({
            batch_id: { $in: [batchSealed._id, resultsSealed._id] }
        })).resolves.toBe(16);
    });

    test('sealed source results reject score, exclusion, delete, save and bulk-write mutations', async () => {
        const sourceId = sourceBatchId('4');
        const batch = await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            campaignCharacter: '4'
        }));
        await storeVerifiedReceipt(receipt);

        const original = await BenchmarkResult.findOne({ batch_id: batch._id }).lean();
        const sealed = { code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE };
        const sealedBatch = { code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE };
        await expect(BenchmarkResult.updateOne(
            { _id: original._id },
            { $set: { quality_score: 1, composite_score: 1, excluded_from_leaderboard: true } }
        )).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.deleteOne({ _id: original._id })).rejects.toMatchObject(sealed);

        const document = await BenchmarkResult.findById(original._id);
        document.quality_score = 1;
        await expect(document.save()).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.bulkWrite([{
            updateOne: { filter: { _id: original._id }, update: { $set: { quality_score: 1 } } }
        }])).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.create({
            batch_id: batch._id,
            model: 'late-model',
            host: 'opaque-test-host',
            prompt: 'late-result',
            success: true
        })).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.updateOne(
            { model: 'late-upsert-model' },
            {
                $set: { host: 'opaque-test-host', prompt: 'late-upsert-result', success: true },
                $setOnInsert: { batch_id: batch._id }
            },
            { upsert: true }
        )).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.countDocuments({ batch_id: batch._id })).resolves.toBe(8);

        const openBatch = await createLinkedBatch(sourceBatchId('e'));
        const openResult = await BenchmarkResult.findOne({ batch_id: openBatch._id });
        await expect(BenchmarkResult.updateOne(
            { _id: openResult._id },
            { $set: { batch_id: batch._id } }
        )).rejects.toMatchObject(sealed);
        openResult.batch_id = batch._id;
        await expect(openResult.save()).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.countDocuments({ batch_id: batch._id })).resolves.toBe(8);
        await expect(BenchmarkResult.findById(openResult._id).lean()).resolves.toMatchObject({
            batch_id: openBatch._id
        });
        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            { $set: { description: 'rewritten evidence' } }
        )).rejects.toMatchObject(sealedBatch);

        const after = await BenchmarkResult.findById(original._id).lean();
        expect(after).toMatchObject({
            quality_score: 8,
            excluded_from_leaderboard: false,
            trust_evidence_sealed: true
        });
        await expect(BenchmarkBatch.findById(batch._id).lean()).resolves.toMatchObject({
            description: '',
            trust_evidence_sealed: true
        });
    });

    test('concurrent receipt issuance and global cleanup never leave an orphaned receipt', async () => {
        for (const character of ['5', '6', '7', '8']) {
            const sourceId = sourceBatchId(character);
            const batch = await createLinkedBatch(sourceId);
            const receipt = buildBenchmarkTrustReceipt(bodyFixture({
                sourceId,
                campaignCharacter: character
            }));

            await Promise.allSettled([
                storeVerifiedReceipt(receipt),
                clearResults()
            ]);

            const [receiptCount, resultCount] = await Promise.all([
                BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId }),
                BenchmarkResult.countDocuments({ batch_id: batch._id })
            ]);
            expect([0, 1]).toContain(receiptCount);
            expect(resultCount).toBe(receiptCount === 1 ? 8 : 0);
        }
    });

    test('concurrent result save and issuance never produce a receipt over changed evidence', async () => {
        const sourceId = sourceBatchId('a');
        const batch = await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            campaignCharacter: 'a'
        }));
        const result = await BenchmarkResult.findOne({ batch_id: batch._id });
        result.quality_score = 1;

        await Promise.allSettled([
            storeBenchmarkTrustReceipt(receipt, {
                verifySourceEvidence: async () => {
                    const current = await BenchmarkResult.findById(result._id).lean();
                    return current.quality_score === 8;
                }
            }),
            result.save()
        ]);

        const [receiptCount, current] = await Promise.all([
            BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId }),
            BenchmarkResult.findById(result._id).lean()
        ]);
        if (receiptCount === 1) {
            expect(current).toMatchObject({ quality_score: 8, trust_evidence_sealed: true });
        } else {
            expect(receiptCount).toBe(0);
            expect(current).toMatchObject({ quality_score: 1, trust_evidence_sealed: false });
        }
    });

    test('concurrent result creation and issuance never add a row behind a receipt', async () => {
        const sourceId = sourceBatchId('b');
        const batch = await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            campaignCharacter: 'b'
        }));

        await Promise.allSettled([
            storeVerifiedReceipt(receipt),
            BenchmarkResult.create({
                batch_id: batch._id,
                model: 'concurrent-late-model',
                host: 'opaque-test-host',
                prompt: 'concurrent-late-result',
                success: true
            })
        ]);

        const [receiptCount, resultCount] = await Promise.all([
            BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId }),
            BenchmarkResult.countDocuments({ batch_id: batch._id })
        ]);
        if (receiptCount === 1) {
            expect(resultCount).toBe(8);
        } else {
            expect(receiptCount).toBe(0);
            expect(resultCount).toBe(9);
        }
    });

    test('cleanup-first ordering deletes evidence and makes later issuance fail closed', async () => {
        const sourceId = sourceBatchId('9');
        const batch = await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            campaignCharacter: '9'
        }));

        await expect(clearResults()).resolves.toBeGreaterThanOrEqual(8);
        await expect(storeVerifiedReceipt(receipt)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_RESULTS_MISMATCH'
        });
        await expect(BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId })).resolves.toBe(0);
        await expect(BenchmarkResult.countDocuments({ batch_id: batch._id })).resolves.toBe(0);
    });
});
