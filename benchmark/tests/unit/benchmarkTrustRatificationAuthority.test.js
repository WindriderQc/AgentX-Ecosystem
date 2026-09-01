'use strict';

const crypto = require('crypto');
const { fingerprint } = require('../../../shared/workerContract');
const {
    BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA,
    BENCHMARK_TRUST_RATIFICATION_SCHEMA,
    computeBenchmarkTrustRatificationAttestationId,
    computeBenchmarkTrustRatificationAuthorityFingerprint,
    serializeBenchmarkTrustRatificationAttestationSigningPayload
} = require('../../../shared/benchmarkTrustRatificationAttestation');
const {
    MIN_REVOCATION_VERSION_ENV,
    RATIFICATION_SCOPE,
    REVOCATION_SNAPSHOT_ID_ENV,
    REVOCATIONS_ENV,
    REVOCATIONS_SCHEMA,
    TRUST_ROOTS_ENV,
    TRUST_ROOTS_SCHEMA,
    verifyBenchmarkTrustRatificationAuthority
} = require('../../src/services/benchmark/benchmarkTrustRatificationAuthority');

const NOW = new Date('2026-09-01T12:00:00.000Z');
const keyPair = crypto.generateKeyPairSync('ed25519');
const issuer = { issuerId: 'human-review-board', keyId: 'ratification-key-2026-09' };

function attestationBody(overrides = {}) {
    return {
        schema: BENCHMARK_TRUST_RATIFICATION_ATTESTATION_SCHEMA,
        issuer,
        issuedAt: '2026-09-01T11:01:00.000Z',
        validUntil: '2026-09-30T00:00:00.000Z',
        nonce: 'benchmark-ratification-nonce-000000001',
        ratification: {
            schema: BENCHMARK_TRUST_RATIFICATION_SCHEMA,
            receiptId: '1'.repeat(64),
            status: 'ratified',
            ratifiedAt: '2026-09-01T11:00:00.000Z',
            authorityFingerprint: computeBenchmarkTrustRatificationAuthorityFingerprint(issuer),
            attestationFingerprint: '2'.repeat(64)
        },
        ...overrides
    };
}

function signedAttestation(body = attestationBody()) {
    const attestationId = computeBenchmarkTrustRatificationAttestationId(body);
    const payload = serializeBenchmarkTrustRatificationAttestationSigningPayload(body, attestationId);
    return {
        ...body,
        attestationId,
        signature: crypto.sign(null, Buffer.from(payload), keyPair.privateKey).toString('base64url')
    };
}

function trustEnvironment(scopes = [RATIFICATION_SCOPE]) {
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
                issuerId: issuer.issuerId,
                keys: [{
                    keyId: issuer.keyId,
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

test('verifies ratification only with the exact scoped root and pinned revocation snapshot', () => {
    const attestation = signedAttestation();
    expect(verifyBenchmarkTrustRatificationAuthority(attestation, {
        env: trustEnvironment(),
        now: NOW
    })).toEqual(attestation);

    expect(() => verifyBenchmarkTrustRatificationAuthority(attestation, {
        env: trustEnvironment(['some-other-scope']),
        now: NOW
    })).toThrow(expect.objectContaining({
        code: 'BENCHMARK_TRUST_RATIFICATION_ISSUER_NOT_TRUSTED',
        statusCode: 403
    }));
});

test('rejects issuer, key, and attestation revocations', () => {
    const attestation = signedAttestation();
    for (const mutate of [
        value => { value.revokedIssuerIds = [issuer.issuerId]; },
        value => { value.revokedKeys = [issuer]; },
        value => { value.revokedAttestationIds = [attestation.attestationId]; }
    ]) {
        const env = trustEnvironment();
        const revocations = JSON.parse(env[REVOCATIONS_ENV]);
        delete revocations.snapshotId;
        mutate(revocations);
        revocations.snapshotId = fingerprint(revocations);
        env[REVOCATIONS_ENV] = JSON.stringify(revocations);
        env[REVOCATION_SNAPSHOT_ID_ENV] = revocations.snapshotId;
        expect(() => verifyBenchmarkTrustRatificationAuthority(attestation, { env, now: NOW }))
            .toThrow(expect.objectContaining({
                code: 'BENCHMARK_TRUST_RATIFICATION_REVOKED',
                statusCode: 403
            }));
    }
});

test('requires attestation validity to remain inside the signing-key window', () => {
    const attestation = signedAttestation(attestationBody({
        validUntil: '2026-10-02T00:00:00.000Z'
    }));
    expect(() => verifyBenchmarkTrustRatificationAuthority(attestation, {
        env: trustEnvironment(),
        now: NOW
    })).toThrow(expect.objectContaining({
        code: 'BENCHMARK_TRUST_RATIFICATION_KEY_OUTSIDE_VALIDITY',
        statusCode: 403
    }));
});

test('fails closed without the exact revocation pin or after a same-version rewrite', () => {
    const attestation = signedAttestation();
    const missingPin = trustEnvironment();
    delete missingPin[REVOCATION_SNAPSHOT_ID_ENV];
    expect(() => verifyBenchmarkTrustRatificationAuthority(attestation, {
        env: missingPin,
        now: NOW
    })).toThrow(expect.objectContaining({
        code: 'BENCHMARK_TRUST_RATIFICATION_REVOCATION_ROLLBACK'
    }));

    const rewrittenEnv = trustEnvironment();
    const rewritten = JSON.parse(rewrittenEnv[REVOCATIONS_ENV]);
    rewritten.revokedIssuerIds = ['some-other-board'];
    delete rewritten.snapshotId;
    rewritten.snapshotId = fingerprint(rewritten);
    rewrittenEnv[REVOCATIONS_ENV] = JSON.stringify(rewritten);
    expect(() => verifyBenchmarkTrustRatificationAuthority(attestation, {
        env: rewrittenEnv,
        now: NOW
    })).toThrow(expect.objectContaining({
        code: 'BENCHMARK_TRUST_RATIFICATION_REVOCATION_ROLLBACK'
    }));
});
