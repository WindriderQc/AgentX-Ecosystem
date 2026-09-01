'use strict';

const crypto = require('crypto');
const { fingerprint } = require('../../../shared/workerContract');
const {
    BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
    computeBenchmarkJudgeQualificationAttestationId,
    serializeBenchmarkJudgeQualificationAttestationSigningPayload
} = require('../../../shared/benchmarkJudgeQualificationAttestation');
const {
    BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
    computeBenchmarkVariancePilotAttestationId,
    computeBenchmarkVariancePilotCohortFingerprint,
    serializeBenchmarkVariancePilotAttestationSigningPayload
} = require('../../../shared/benchmarkVariancePilotAttestation');
const {
    MIN_REVOCATION_VERSION_ENV,
    QUALIFICATION_SCOPE,
    VARIANCE_PILOT_SCOPE,
    REVOCATION_SNAPSHOT_ID_ENV,
    REVOCATIONS_ENV,
    REVOCATIONS_SCHEMA,
    TRUST_ROOTS_ENV,
    TRUST_ROOTS_SCHEMA,
    verifyJudgeQualificationAuthority,
    verifyVariancePilotAuthority
} = require('../../src/services/benchmark/benchmarkJudgeQualificationAuthority');

const NOW = new Date('2026-09-01T12:00:00.000Z');
const keyPair = crypto.generateKeyPairSync('ed25519');
const workerIdentity = {
    harness: { name: 'judge-harness', version: '1.0.0' },
    adapter: { name: 'judge-adapter', version: '1.0.0' },
    provider: { name: 'judge-provider', version: '1.0.0' },
    model: {
        name: 'judge-model',
        version: '1.0.0',
        digest: `sha256:${'1'.repeat(64)}`,
        runtimeFingerprint: '5'.repeat(64)
    },
    api: { name: 'judge-api', version: '1.0.0' },
    environment: { id: 'judge-env', version: '1', fingerprint: '6'.repeat(64) }
};

function attestationBody(overrides = {}) {
    return {
        schema: BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
        issuer: { issuerId: 'judge-review-board', keyId: 'judge-key-2026-09' },
        issuedAt: '2026-09-01T11:00:00.000Z',
        validUntil: '2026-09-30T00:00:00.000Z',
        nonce: 'judge-qualification-nonce-000000001',
        judge: {
            identityFingerprint: fingerprint(workerIdentity),
            rubricFingerprint: '2'.repeat(64),
            corpusFingerprint: '3'.repeat(64),
            holdoutFingerprint: '4'.repeat(64),
            workerIdentity
        },
        evidence: {
            status: 'qualified',
            validationSampleCount: 70,
            holdoutSampleCount: 105,
            overallMaeMicros: 900000,
            overallToleranceBasisPoints: 8600,
            reviewPrecisionBasisPoints: 8200,
            reviewRecallBasisPoints: 8300,
            spearmanBasisPoints: 8400,
            categoryMetrics: [
                'coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation'
            ].map(category => ({
                category,
                validationSampleCount: 10,
                holdoutSampleCount: 15,
                maeMicros: 900000,
                toleranceBasisPoints: 8600,
                difficultyMetrics: [1, 2, 3, 4, 5].map(difficulty => ({
                    difficulty,
                    validationSampleCount: 2,
                    holdoutSampleCount: 3,
                    maeMicros: 900000,
                    toleranceBasisPoints: 8600
                }))
            }))
        },
        ...overrides
    };
}

function signedAttestation(body = attestationBody()) {
    const attestationId = computeBenchmarkJudgeQualificationAttestationId(body);
    const payload = serializeBenchmarkJudgeQualificationAttestationSigningPayload(body, attestationId);
    return {
        ...body,
        attestationId,
        signature: crypto.sign(null, Buffer.from(payload), keyPair.privateKey).toString('base64url')
    };
}

function trustEnvironment(scopes = [QUALIFICATION_SCOPE]) {
    const revocations = {
        schema: REVOCATIONS_SCHEMA,
        version: 1,
        issuedAt: '2026-09-01T00:00:00.000Z',
        validUntil: '2026-09-02T00:00:00.000Z',
        revokedIssuerIds: [],
        revokedKeys: [],
        revokedAttestationIds: []
    };
    const snapshotId = fingerprint(revocations);
    return {
        [TRUST_ROOTS_ENV]: JSON.stringify({
            schema: TRUST_ROOTS_SCHEMA,
            issuers: [{
                issuerId: 'judge-review-board',
                keys: [{
                    keyId: 'judge-key-2026-09',
                    publicKeyPem: keyPair.publicKey.export({ type: 'spki', format: 'pem' }),
                    notBefore: '2026-01-01T00:00:00.000Z',
                    notAfter: '2026-10-01T00:00:00.000Z',
                    scopes
                }]
            }]
        }),
        [REVOCATIONS_ENV]: JSON.stringify({ ...revocations, snapshotId }),
        [MIN_REVOCATION_VERSION_ENV]: '1',
        [REVOCATION_SNAPSHOT_ID_ENV]: snapshotId
    };
}

function signedVariancePilot() {
    const promptFingerprints = Array.from({ length: 30 }, (_, index) => (
        crypto.createHash('sha256').update(`authority-pilot-${index}`).digest('hex')
    )).sort();
    const body = {
        schema: BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
        issuer: { issuerId: 'judge-review-board', keyId: 'judge-key-2026-09' },
        issuedAt: '2026-09-01T11:00:00.000Z',
        validUntil: '2026-09-30T00:00:00.000Z',
        nonce: 'variance-pilot-authority-000000001',
        evidence: {
            sourceReceiptId: '1'.repeat(64),
            resultInventoryFingerprint: '2'.repeat(64),
            varianceBasisFingerprint: '3'.repeat(64),
            cohortFingerprint: computeBenchmarkVariancePilotCohortFingerprint(promptFingerprints),
            promptFingerprints,
            repeatCount: 2,
            candidateInferenceContractFingerprint: '4'.repeat(64),
            promptSamplingPolicyFingerprint: '5'.repeat(64)
        }
    };
    const attestationId = computeBenchmarkVariancePilotAttestationId(body);
    return {
        ...body,
        attestationId,
        signature: crypto.sign(
            null,
            Buffer.from(serializeBenchmarkVariancePilotAttestationSigningPayload(body, attestationId)),
            keyPair.privateKey
        ).toString('base64url')
    };
}

test('verifies a qualification only under the exact pinned revocation snapshot', () => {
    const attestation = signedAttestation();
    expect(verifyJudgeQualificationAuthority(attestation, {
        env: trustEnvironment(),
        now: NOW
    })).toEqual(attestation);
});

test('requires a separately scoped and currently trusted variance-pilot authority', () => {
    const attestation = signedVariancePilot();
    expect(verifyVariancePilotAuthority(attestation, {
        env: trustEnvironment([QUALIFICATION_SCOPE, VARIANCE_PILOT_SCOPE]),
        now: NOW
    })).toEqual(attestation);
    expect(() => verifyVariancePilotAuthority(attestation, {
        env: trustEnvironment([QUALIFICATION_SCOPE]),
        now: NOW
    })).toThrow(expect.objectContaining({ code: 'VARIANCE_PILOT_ISSUER_NOT_TRUSTED' }));

    const revokedEnv = trustEnvironment([VARIANCE_PILOT_SCOPE]);
    const revoked = JSON.parse(revokedEnv[REVOCATIONS_ENV]);
    delete revoked.snapshotId;
    revoked.revokedAttestationIds = [attestation.attestationId];
    revoked.snapshotId = fingerprint(revoked);
    revokedEnv[REVOCATIONS_ENV] = JSON.stringify(revoked);
    revokedEnv[REVOCATION_SNAPSHOT_ID_ENV] = revoked.snapshotId;
    expect(() => verifyVariancePilotAuthority(attestation, { env: revokedEnv, now: NOW }))
        .toThrow(expect.objectContaining({ code: 'VARIANCE_PILOT_REVOKED' }));
});

test('requires qualification validity to end within the signing key window', () => {
    const attestation = signedAttestation(attestationBody({
        validUntil: '2026-10-02T00:00:00.000Z'
    }));
    expect(() => verifyJudgeQualificationAuthority(attestation, {
        env: trustEnvironment(),
        now: NOW
    })).toThrow(expect.objectContaining({
        code: 'JUDGE_QUALIFICATION_KEY_OUTSIDE_VALIDITY',
        statusCode: 403
    }));
});

test('fails closed without the exact pin or after a same-version snapshot rewrite', () => {
    const attestation = signedAttestation();
    const missingPin = trustEnvironment();
    delete missingPin[REVOCATION_SNAPSHOT_ID_ENV];
    expect(() => verifyJudgeQualificationAuthority(attestation, { env: missingPin, now: NOW }))
        .toThrow(expect.objectContaining({ code: 'JUDGE_QUALIFICATION_REVOCATION_ROLLBACK' }));

    const rewrittenEnv = trustEnvironment();
    const rewritten = JSON.parse(rewrittenEnv[REVOCATIONS_ENV]);
    rewritten.revokedIssuerIds = ['some-other-board'];
    delete rewritten.snapshotId;
    rewritten.snapshotId = fingerprint(rewritten);
    rewrittenEnv[REVOCATIONS_ENV] = JSON.stringify(rewritten);
    expect(() => verifyJudgeQualificationAuthority(attestation, { env: rewrittenEnv, now: NOW }))
        .toThrow(expect.objectContaining({ code: 'JUDGE_QUALIFICATION_REVOCATION_ROLLBACK' }));
});
