'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('../../../shared/artifactIdentity');

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../../shared/workerContract', () => {
    const cryptoModule = require('crypto');
    const { stableSerialize: serialize } = require('../../../shared/artifactIdentity');
    return {
        fingerprint: jest.fn(value => cryptoModule.createHash('sha256').update(serialize(value)).digest('hex')),
        normalizeWorkerReceipt: jest.fn(value => value)
    };
});

jest.mock('../../src/services/benchmark/benchmarkTrustSourceEvidence', () => ({
    buildBenchmarkTrustSourceProjection: jest.fn(() => ({ resultCount: 1 })),
    computePromptSourceFingerprint: jest.fn(() => '6'.repeat(64))
}));

function queryResult(value) {
    const query = {
        lean: jest.fn().mockResolvedValue(value),
        select: jest.fn()
    };
    query.select.mockReturnValue(query);
    return query;
}

jest.mock('../../models/BenchmarkResult', () => ({
    findOne: jest.fn(),
    find: jest.fn(),
    countDocuments: jest.fn()
}));

jest.mock('../../models/BenchmarkBatch', () => ({
    findOne: jest.fn()
}));

const collection = {
    insertOne: jest.fn(),
    findOne: jest.fn()
};
const findById = jest.fn();
class MockJudgeGroundTruth {
    constructor(document) {
        Object.assign(this, document);
        this._id = 'f'.repeat(24);
    }

    async validate() {}

    toObject() {
        return JSON.parse(JSON.stringify(this));
    }
}
MockJudgeGroundTruth.init = jest.fn().mockResolvedValue(undefined);
MockJudgeGroundTruth.collection = collection;
MockJudgeGroundTruth.findById = findById;

jest.mock('../../models/JudgeGroundTruth', () => MockJudgeGroundTruth);

const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const {
    BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA,
    computeBenchmarkHumanEvidenceAttestationId,
    computeBenchmarkHumanEvidenceSourceResultFingerprint,
    serializeBenchmarkHumanEvidenceAttestationSigningPayload
} = require('../../../shared/benchmarkHumanEvidenceAttestation');
const {
    HUMAN_EVIDENCE_SCOPE,
    MIN_REVOCATION_VERSION_ENV,
    REVOCATION_SNAPSHOT_ID_ENV,
    REVOCATIONS_ENV,
    REVOCATIONS_SCHEMA,
    TRUST_ROOTS_ENV,
    TRUST_ROOTS_SCHEMA,
    importAttestedHumanGroundTruth,
    verifyStoredAttestedHumanGroundTruth
} = require('../../src/services/benchmark/humanGroundTruthImport');

const NOW = new Date('2026-09-01T12:00:00.000Z');
const RESULT_ID = '1'.repeat(24);
const BATCH_OBJECT_ID = '2'.repeat(24);
const SOURCE_BATCH_ID = `batch_${'3'.repeat(32)}`;
const CANDIDATE_ID = `candidate_${'4'.repeat(32)}`;
const PROMPT_ID = `prompt_${'5'.repeat(32)}`;
const JUDGE_IDENTITY = { harness: { id: 'judge-harness' }, model: { name: 'judge-model' } };
const JUDGE_IDENTITY_FINGERPRINT = crypto
    .createHash('sha256')
    .update(stableSerialize(JUDGE_IDENTITY))
    .digest('hex');
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');

function resultFixture(overrides = {}) {
    return {
        _id: RESULT_ID,
        batch_id: BATCH_OBJECT_ID,
        trust_evidence_sealed: true,
        success: true,
        trust_candidate_id: CANDIDATE_ID,
        trust_prompt_id: PROMPT_ID,
        repeat_index: 0,
        repeat_total: 1,
        model: 'candidate-model',
        model_digest: `sha256:${'a'.repeat(64)}`,
        host: 'harness-target',
        prompt: 'Evaluate this exact prompt.',
        prompt_name: 'exact-prompt',
        prompt_category: 'reasoning',
        prompt_level: 3,
        response: 'Exact machine response.',
        quality_score: 7.25,
        judge_criteria: ['correctness'],
        trust_judge_receipt: {
            finalState: 'succeeded',
            result: { contractSatisfied: true },
            identity: JUDGE_IDENTITY,
            fingerprint: '9'.repeat(64)
        },
        trust_execution_receipt: { fingerprint: 'a'.repeat(64) },
        timestamp: new Date('2026-08-31T10:00:00.000Z'),
        updated_at: new Date('2026-08-31T10:00:00.000Z'),
        ...overrides
    };
}

function batchFixture(overrides = {}) {
    return {
        _id: BATCH_OBJECT_ID,
        trust_batch_id: SOURCE_BATCH_ID,
        status: 'completed',
        trust_evidence_sealed: true,
        trust_evidence_context: { schema: 'strict-context' },
        trust_evidence_committed_at: new Date('2026-08-31T09:00:00.000Z'),
        started_at: new Date('2026-08-31T09:05:00.000Z'),
        execution_started_at: new Date('2026-08-31T09:05:00.000Z'),
        completed_at: new Date('2026-08-31T11:00:00.000Z'),
        trust_evidence_finalized_at: new Date('2026-08-31T11:00:00.000Z'),
        updated_at: new Date('2026-08-31T11:00:00.000Z'),
        ...overrides
    };
}

function sourceProjection(result = resultFixture()) {
    return {
        sourceResultId: RESULT_ID,
        sourceBatchId: SOURCE_BATCH_ID,
        candidateId: CANDIDATE_ID,
        promptId: PROMPT_ID,
        repeatIndex: 0,
        repeatTotal: 1,
        model: result.model,
        host: result.host,
        modelDigest: result.model_digest,
        promptFingerprint: '6'.repeat(64),
        responseFingerprint: crypto.createHash('sha256').update(stableSerialize(result.response)).digest('hex'),
        category: result.prompt_category,
        judgeIdentityFingerprint: JUDGE_IDENTITY_FINGERPRINT,
        judgeScoreMicros: 7_250_000,
        judgeReceiptFingerprint: '9'.repeat(64),
        executionReceiptFingerprint: 'a'.repeat(64),
        sourceCreatedAt: '2026-08-31T10:00:00.000Z',
        sourceUpdatedAt: '2026-08-31T10:00:00.000Z'
    };
}

function attestationBody(overrides = {}) {
    const projection = sourceProjection();
    return {
        schema: BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA,
        issuer: { issuerId: 'human-review-board', keyId: 'review-key-2026-09' },
        issuedAt: '2026-09-01T11:00:00.000Z',
        validUntil: '2026-10-01T11:00:00.000Z',
        nonce: 'review-nonce-00000000000000000001',
        source: {
            sourceResultId: RESULT_ID,
            sourceBatchId: SOURCE_BATCH_ID,
            sourceResultFingerprint: computeBenchmarkHumanEvidenceSourceResultFingerprint(projection),
            promptFingerprint: projection.promptFingerprint,
            responseFingerprint: projection.responseFingerprint,
            category: projection.category,
            judgeIdentityFingerprint: projection.judgeIdentityFingerprint,
            judgeScoreMicros: projection.judgeScoreMicros
        },
        human: {
            provenanceClass: 'independent_human_score',
            reviewProtocol: 'blind_independent',
            expertScoreMicros: 8_000_000,
            dimensionScores: [{ dimension: 'correctness', scoreMicros: 8_000_000 }],
            expertRationale: 'Independent reviewers agreed on this score.',
            reviewerId: 'reviewer-pseudonym-17',
            reviewedAt: '2026-09-01T10:30:00.000Z'
        },
        ...overrides
    };
}

function signedAttestation(body = attestationBody(), signingKey = privateKey) {
    const attestationId = computeBenchmarkHumanEvidenceAttestationId(body);
    const payload = serializeBenchmarkHumanEvidenceAttestationSigningPayload(body, attestationId);
    return {
        ...body,
        attestationId,
        signature: crypto.sign(null, Buffer.from(payload), signingKey).toString('base64url')
    };
}

function configureTrust({ revokedIssuerIds = [], revokedKeys = [], revokedAttestationIds = [] } = {}) {
    process.env[TRUST_ROOTS_ENV] = JSON.stringify({
        schema: TRUST_ROOTS_SCHEMA,
        issuers: [{
            issuerId: 'human-review-board',
            keys: [{
                keyId: 'review-key-2026-09',
                publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
                notBefore: '2026-01-01T00:00:00.000Z',
                notAfter: '2027-01-01T00:00:00.000Z',
                scopes: [HUMAN_EVIDENCE_SCOPE]
            }]
        }]
    });
    const revocations = {
        schema: REVOCATIONS_SCHEMA,
        version: 1,
        issuedAt: '2026-09-01T00:00:00.000Z',
        validUntil: '2026-09-02T00:00:00.000Z',
        revokedIssuerIds,
        revokedKeys,
        revokedAttestationIds
    };
    const snapshotId = crypto.createHash('sha256').update(stableSerialize(revocations)).digest('hex');
    process.env[REVOCATIONS_ENV] = JSON.stringify({ ...revocations, snapshotId });
    process.env[MIN_REVOCATION_VERSION_ENV] = '1';
    process.env[REVOCATION_SNAPSHOT_ID_ENV] = snapshotId;
}

function configureSource(result = resultFixture(), batch = batchFixture()) {
    BenchmarkResult.findOne.mockReturnValue(queryResult(result));
    BenchmarkBatch.findOne.mockReturnValue(queryResult(batch));
    BenchmarkResult.find.mockReturnValue(queryResult([result]));
    BenchmarkResult.countDocuments.mockResolvedValue(1);
}

beforeEach(() => {
    jest.useFakeTimers({
        doNotFake: ['hrtime', 'nextTick', 'performance', 'queueMicrotask', 'setImmediate', 'setInterval', 'setTimeout']
    }).setSystemTime(NOW);
    jest.clearAllMocks();
    delete process.env[TRUST_ROOTS_ENV];
    delete process.env[REVOCATIONS_ENV];
    delete process.env[MIN_REVOCATION_VERSION_ENV];
    delete process.env[REVOCATION_SNAPSHOT_ID_ENV];
    collection.insertOne.mockResolvedValue({ insertedId: 'f'.repeat(24) });
    findById.mockReturnValue(queryResult({ human_attestation_fingerprint: 'stored' }));
});

afterEach(() => {
    jest.useRealTimers();
});

afterAll(() => {
    delete process.env[TRUST_ROOTS_ENV];
    delete process.env[REVOCATIONS_ENV];
    delete process.env[MIN_REVOCATION_VERSION_ENV];
    delete process.env[REVOCATION_SNAPSHOT_ID_ENV];
});

test('is disabled by default and rejects self-asserted verified state', async () => {
    await expect(importAttestedHumanGroundTruth(signedAttestation()))
        .rejects.toMatchObject({ code: 'BENCHMARK_HUMAN_EVIDENCE_IMPORT_DISABLED', statusCode: 503 });
    configureTrust();
    await expect(importAttestedHumanGroundTruth({ ...signedAttestation(), verified: true }))
        .rejects.toMatchObject({ code: 'INVALID_HUMAN_EVIDENCE_ATTESTATION' });
    expect(BenchmarkResult.findOne).not.toHaveBeenCalled();
});

test('verifies the sealed batch, derives machine fields, and performs one controlled insert', async () => {
    configureTrust();
    configureSource();

    await importAttestedHumanGroundTruth(signedAttestation());

    expect(collection.insertOne).toHaveBeenCalledTimes(1);
    const inserted = collection.insertOne.mock.calls[0][0];
    expect(inserted).toMatchObject({
        source: 'attested-human-evidence-v1',
        prompt: 'Evaluate this exact prompt.',
        response: 'Exact machine response.',
        category: 'reasoning',
        expert_scores: { overall: 8 },
        judge_score_at_review: 7.25,
        judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
        source_result_id: RESULT_ID,
        provenance_class: 'independent_human_score',
        review_protocol: 'blind_independent'
    });
    expect(inserted.human_attestation_fingerprint).toBe(inserted.human_attestation.attestationId);
});

test('rejects unsealed or source-mismatched evidence before insertion', async () => {
    configureTrust();
    BenchmarkResult.findOne.mockReturnValue(queryResult(null));
    await expect(importAttestedHumanGroundTruth(signedAttestation()))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_SOURCE_NOT_VERIFIED' });

    configureSource(resultFixture({ response: 'different immutable response' }));
    await expect(importAttestedHumanGroundTruth(signedAttestation()))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_SOURCE_BINDING_MISMATCH' });
    expect(collection.insertOne).not.toHaveBeenCalled();
});

test('rejects a human review timestamp that predates sealed source finalization', async () => {
    configureTrust();
    configureSource();
    const body = attestationBody({
        human: {
            ...attestationBody().human,
            reviewedAt: '2026-08-31T10:30:00.000Z'
        }
    });

    await expect(importAttestedHumanGroundTruth(signedAttestation(body)))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_REVIEW_PRECEDES_SOURCE_FINALIZATION' });
    expect(collection.insertOne).not.toHaveBeenCalled();
});

test('rejects tamper, untrusted issuer, expiry, and current revocation', async () => {
    configureTrust();
    configureSource();
    const valid = signedAttestation();
    await expect(importAttestedHumanGroundTruth({
        ...valid,
        human: { ...valid.human, expertScoreMicros: 1_000_000 }
    })).rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_ATTESTATION_ID_MISMATCH' });

    const unknownIssuer = signedAttestation(attestationBody({
        issuer: { issuerId: 'unknown-board', keyId: 'review-key-2026-09' }
    }));
    await expect(importAttestedHumanGroundTruth(unknownIssuer))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_ISSUER_NOT_TRUSTED' });

    const expired = signedAttestation(attestationBody({ validUntil: '2026-09-01T11:30:00.000Z' }));
    await expect(importAttestedHumanGroundTruth(expired))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_ATTESTATION_EXPIRED' });

    configureTrust({ revokedAttestationIds: [valid.attestationId] });
    await expect(importAttestedHumanGroundTruth(valid))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_ATTESTATION_REVOKED' });

    configureTrust({
        revokedKeys: [{ issuerId: 'human-review-board', keyId: 'review-key-2026-09' }]
    });
    await expect(importAttestedHumanGroundTruth(valid))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_ATTESTATION_REVOKED' });

    configureTrust();
    const staleRevocations = JSON.parse(process.env[REVOCATIONS_ENV]);
    staleRevocations.validUntil = '2026-09-01T11:30:00.000Z';
    delete staleRevocations.snapshotId;
    staleRevocations.snapshotId = crypto.createHash('sha256')
        .update(stableSerialize(staleRevocations))
        .digest('hex');
    process.env[REVOCATIONS_ENV] = JSON.stringify(staleRevocations);
    process.env[REVOCATION_SNAPSHOT_ID_ENV] = staleRevocations.snapshotId;
    await expect(importAttestedHumanGroundTruth(valid))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_REVOCATIONS_STALE', statusCode: 503 });
    expect(collection.insertOne).not.toHaveBeenCalled();
});

test('requires attestation validity to end within the signing key window', async () => {
    configureTrust();
    const beyondKeyValidity = signedAttestation(attestationBody({
        validUntil: '2027-01-02T00:00:00.000Z'
    }));

    await expect(importAttestedHumanGroundTruth(beyondKeyValidity))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_KEY_OUTSIDE_VALIDITY', statusCode: 403 });
    expect(BenchmarkResult.findOne).not.toHaveBeenCalled();
    expect(collection.insertOne).not.toHaveBeenCalled();
});

test('fails closed without the exact revocation snapshot pin or after a same-version rewrite', async () => {
    configureTrust();
    const valid = signedAttestation();
    delete process.env[REVOCATION_SNAPSHOT_ID_ENV];
    await expect(importAttestedHumanGroundTruth(valid))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_REVOCATION_ROLLBACK', statusCode: 503 });

    configureTrust();
    const rewritten = JSON.parse(process.env[REVOCATIONS_ENV]);
    rewritten.revokedIssuerIds = ['some-other-board'];
    delete rewritten.snapshotId;
    rewritten.snapshotId = crypto.createHash('sha256')
        .update(stableSerialize(rewritten))
        .digest('hex');
    process.env[REVOCATIONS_ENV] = JSON.stringify(rewritten);
    await expect(importAttestedHumanGroundTruth(valid))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_REVOCATION_ROLLBACK', statusCode: 503 });
    expect(BenchmarkResult.findOne).not.toHaveBeenCalled();
    expect(collection.insertOne).not.toHaveBeenCalled();
});

test('treats exact replay as idempotent but conflicts on changed stored bytes or nonce reuse', async () => {
    configureTrust();
    configureSource();
    const attestation = signedAttestation();
    await importAttestedHumanGroundTruth(attestation);
    const exactStored = collection.insertOne.mock.calls[0][0];

    collection.insertOne.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 }));
    collection.findOne.mockResolvedValue(exactStored);
    await expect(importAttestedHumanGroundTruth(attestation))
        .resolves.toMatchObject({ imported: false });

    collection.findOne.mockResolvedValue({ ...exactStored, expert_rationale: 'tampered bytes' });
    await expect(importAttestedHumanGroundTruth(attestation))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_ATTESTATION_REPLAY_CONFLICT' });

    collection.findOne.mockResolvedValue(null);
    const nonceReuse = signedAttestation(attestationBody({
        human: { ...attestationBody().human, expertScoreMicros: 7_900_000 }
    }));
    await expect(importAttestedHumanGroundTruth(nonceReuse))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_ATTESTATION_REPLAY_CONFLICT' });
});

test('re-verifies stored signature, sealed source, calibration inputs, freshness, and revocation', async () => {
    configureTrust();
    configureSource();
    const attestation = signedAttestation();
    await importAttestedHumanGroundTruth(attestation);
    const row = collection.insertOne.mock.calls[0][0];
    await expect(verifyStoredAttestedHumanGroundTruth(row)).resolves.toEqual(attestation);
    for (const tampered of [
        { ...row, prompt: 'tampered prompt' },
        { ...row, response: 'tampered response' },
        { ...row, expected_answer: 'tampered reference' },
        { ...row, judge_criteria: ['tampered criterion'] },
        { ...row, difficulty: 5 },
        { ...row, expert_rationale: 'tampered rationale' }
    ]) {
        await expect(verifyStoredAttestedHumanGroundTruth(tampered))
            .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_STORED_ROW_MISMATCH' });
    }

    configureTrust({ revokedAttestationIds: [attestation.attestationId] });
    await expect(verifyStoredAttestedHumanGroundTruth(row))
        .rejects.toMatchObject({ code: 'HUMAN_EVIDENCE_ATTESTATION_REVOKED' });
});
