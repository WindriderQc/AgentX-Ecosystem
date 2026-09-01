'use strict';

const crypto = require('crypto');
const { fingerprint } = require('../../../../shared/workerContract');
const {
    normalizeBenchmarkJudgeQualificationAttestation,
    verifyBenchmarkJudgeQualificationAttestation
} = require('../../../../shared/benchmarkJudgeQualificationAttestation');
const {
    normalizeBenchmarkVariancePilotAttestation,
    verifyBenchmarkVariancePilotAttestation
} = require('../../../../shared/benchmarkVariancePilotAttestation');

const TRUST_ROOTS_ENV = 'BENCHMARK_JUDGE_QUALIFICATION_TRUST_ROOTS_JSON';
const REVOCATIONS_ENV = 'BENCHMARK_JUDGE_QUALIFICATION_REVOCATIONS_JSON';
const MIN_REVOCATION_VERSION_ENV = 'BENCHMARK_JUDGE_QUALIFICATION_MIN_REVOCATION_VERSION';
const REVOCATION_SNAPSHOT_ID_ENV = 'BENCHMARK_JUDGE_QUALIFICATION_REVOCATION_SNAPSHOT_ID';
const TRUST_ROOTS_SCHEMA = 'agentx.benchmark-judge-qualification-trust-roots/v1';
const REVOCATIONS_SCHEMA = 'agentx.benchmark-judge-qualification-revocations/v1';
const QUALIFICATION_SCOPE = 'benchmark-judge-qualification-v1';
const VARIANCE_PILOT_SCOPE = 'benchmark-variance-pilot-v1';
const MAX_CLOCK_SKEW_MS = 300_000;

function authorityError(code, message, statusCode = 503) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function exactObject(value, keys, label) {
    if (!isPlainObject(value)
        || Object.keys(value).some(key => !keys.includes(key))
        || keys.some(key => !Object.prototype.hasOwnProperty.call(value, key))) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${label} has invalid keys`);
    }
    return value;
}

function identifier(value, label) {
    if (typeof value !== 'string' || value.length === 0 || value.length > 180
        || value !== value.trim() || !/^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/.test(value)) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${label} is invalid`);
    }
    return value;
}

function canonicalTimestamp(value, label) {
    const parsed = typeof value === 'string' ? new Date(value) : new Date(NaN);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${label} is invalid`);
    }
    return value;
}

function parseJsonEnvironment(env, name) {
    const raw = env?.[name];
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw authorityError(
            'BENCHMARK_JUDGE_QUALIFICATION_AUTHORITY_DISABLED',
            `strict judge qualification requires ${name}`
        );
    }
    try {
        return JSON.parse(raw);
    } catch (_error) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${name} is not valid JSON`);
    }
}

function uniqueIdentifiers(values, label) {
    if (!Array.isArray(values)) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${label} must be an array`);
    }
    const normalized = values.map((value, index) => identifier(value, `${label}[${index}]`));
    if (new Set(normalized).size !== normalized.length) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${label} contains duplicates`);
    }
    return new Set(normalized);
}

function uniqueFingerprints(values, label) {
    if (!Array.isArray(values)) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${label} must be an array`);
    }
    const normalized = values.map((value, index) => {
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
            throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${label}[${index}] is invalid`);
        }
        return value;
    });
    if (new Set(normalized).size !== normalized.length) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', `${label} contains duplicates`);
    }
    return new Set(normalized);
}

function revokedKeys(values) {
    if (!Array.isArray(values)) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', 'revokedKeys must be an array');
    }
    const normalized = values.map((raw, index) => {
        const value = exactObject(raw, ['issuerId', 'keyId'], `revokedKeys[${index}]`);
        return `${identifier(value.issuerId, `revokedKeys[${index}].issuerId`)}\u0000${identifier(
            value.keyId,
            `revokedKeys[${index}].keyId`
        )}`;
    });
    if (new Set(normalized).size !== normalized.length) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', 'revokedKeys contains duplicates');
    }
    return new Set(normalized);
}

function loadJudgeQualificationTrustState({ env = process.env, now = new Date() } = {}) {
    const verificationTime = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(verificationTime.getTime())) {
        throw authorityError('INVALID_JUDGE_QUALIFICATION_VERIFICATION_TIME', 'verification time is invalid', 400);
    }
    const roots = exactObject(
        parseJsonEnvironment(env, TRUST_ROOTS_ENV),
        ['schema', 'issuers'],
        'judge qualification trust roots'
    );
    if (roots.schema !== TRUST_ROOTS_SCHEMA || !Array.isArray(roots.issuers) || roots.issuers.length === 0) {
        throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', 'judge qualification trust roots are invalid');
    }
    const keyMap = new Map();
    for (const [issuerIndex, rawIssuer] of roots.issuers.entries()) {
        const issuer = exactObject(rawIssuer, ['issuerId', 'keys'], `issuers[${issuerIndex}]`);
        const issuerId = identifier(issuer.issuerId, `issuers[${issuerIndex}].issuerId`);
        if (!Array.isArray(issuer.keys) || issuer.keys.length === 0) {
            throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', 'every issuer requires keys');
        }
        for (const [keyIndex, rawKey] of issuer.keys.entries()) {
            const key = exactObject(
                rawKey,
                ['keyId', 'publicKeyPem', 'notBefore', 'notAfter', 'scopes'],
                `issuers[${issuerIndex}].keys[${keyIndex}]`
            );
            const keyId = identifier(key.keyId, `issuers[${issuerIndex}].keys[${keyIndex}].keyId`);
            const notBefore = canonicalTimestamp(key.notBefore, 'key.notBefore');
            const notAfter = canonicalTimestamp(key.notAfter, 'key.notAfter');
            if (Date.parse(notAfter) <= Date.parse(notBefore)
                || !Array.isArray(key.scopes)
                || key.scopes.length === 0
                || new Set(key.scopes).size !== key.scopes.length
                || key.scopes.some(scope => typeof scope !== 'string')) {
                throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', 'key validity or scopes are invalid');
            }
            let publicKey;
            try {
                publicKey = crypto.createPublicKey(key.publicKeyPem);
            } catch (_error) {
                throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', 'qualification public key is invalid');
            }
            if (publicKey.asymmetricKeyType !== 'ed25519') {
                throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', 'qualification keys must be Ed25519');
            }
            const mapKey = `${issuerId}\u0000${keyId}`;
            if (keyMap.has(mapKey)) {
                throw authorityError('JUDGE_QUALIFICATION_TRUST_CONFIG_INVALID', 'duplicate issuer/key trust root');
            }
            keyMap.set(mapKey, {
                publicKey,
                notBefore,
                notAfter,
                scopes: new Set(key.scopes)
            });
        }
    }

    const revocations = exactObject(
        parseJsonEnvironment(env, REVOCATIONS_ENV),
        [
            'schema', 'version', 'snapshotId', 'issuedAt', 'validUntil',
            'revokedIssuerIds', 'revokedKeys', 'revokedAttestationIds'
        ],
        'judge qualification revocations'
    );
    const snapshotBody = { ...revocations };
    delete snapshotBody.snapshotId;
    const minVersion = Number(env?.[MIN_REVOCATION_VERSION_ENV]);
    const pinnedSnapshotId = env?.[REVOCATION_SNAPSHOT_ID_ENV];
    if (revocations.schema !== REVOCATIONS_SCHEMA
        || !Number.isSafeInteger(revocations.version)
        || revocations.version < 1
        || typeof revocations.snapshotId !== 'string'
        || revocations.snapshotId !== fingerprint(snapshotBody)
        || typeof pinnedSnapshotId !== 'string'
        || !/^[0-9a-f]{64}$/.test(pinnedSnapshotId)
        || revocations.snapshotId !== pinnedSnapshotId
        || !Number.isSafeInteger(minVersion)
        || minVersion < 1
        || revocations.version < minVersion) {
        throw authorityError(
            'JUDGE_QUALIFICATION_REVOCATION_ROLLBACK',
            'judge qualification revocation snapshot is invalid or older than the pinned minimum'
        );
    }
    const issuedAt = canonicalTimestamp(revocations.issuedAt, 'revocations.issuedAt');
    const validUntil = canonicalTimestamp(revocations.validUntil, 'revocations.validUntil');
    if (Date.parse(validUntil) <= Date.parse(issuedAt)
        || Date.parse(issuedAt) > verificationTime.getTime() + MAX_CLOCK_SKEW_MS
        || Date.parse(validUntil) < verificationTime.getTime()) {
        throw authorityError('JUDGE_QUALIFICATION_REVOCATIONS_STALE', 'revocation snapshot is not currently valid');
    }
    return {
        verificationTime,
        keyMap,
        revokedIssuerIds: uniqueIdentifiers(revocations.revokedIssuerIds, 'revokedIssuerIds'),
        revokedKeys: revokedKeys(revocations.revokedKeys),
        revokedAttestationIds: uniqueFingerprints(revocations.revokedAttestationIds, 'revokedAttestationIds')
    };
}

function verifyJudgeQualificationAuthority(rawAttestation, options = {}) {
    const attestation = normalizeBenchmarkJudgeQualificationAttestation(rawAttestation);
    const trust = loadJudgeQualificationTrustState(options);
    const { issuerId, keyId } = attestation.issuer;
    if (trust.revokedIssuerIds.has(issuerId)
        || trust.revokedKeys.has(`${issuerId}\u0000${keyId}`)
        || trust.revokedAttestationIds.has(attestation.attestationId)) {
        throw authorityError('JUDGE_QUALIFICATION_REVOKED', 'judge qualification authority is revoked', 403);
    }
    const key = trust.keyMap.get(`${issuerId}\u0000${keyId}`);
    if (!key || !key.scopes.has(QUALIFICATION_SCOPE)) {
        throw authorityError('JUDGE_QUALIFICATION_ISSUER_NOT_TRUSTED', 'issuer/key lacks judge qualification authority', 403);
    }
    const issuedAt = Date.parse(attestation.issuedAt);
    const validUntil = Date.parse(attestation.validUntil);
    if (issuedAt < Date.parse(key.notBefore)
        || issuedAt > Date.parse(key.notAfter)
        || validUntil > Date.parse(key.notAfter)) {
        throw authorityError(
            'JUDGE_QUALIFICATION_KEY_OUTSIDE_VALIDITY',
            'qualification validity must remain inside key validity',
            403
        );
    }
    return verifyBenchmarkJudgeQualificationAttestation(attestation, {
        publicKey: key.publicKey,
        now: trust.verificationTime,
        maxClockSkewMs: MAX_CLOCK_SKEW_MS
    });
}

function verifyVariancePilotAuthority(rawAttestation, options = {}) {
    const attestation = normalizeBenchmarkVariancePilotAttestation(rawAttestation);
    const trust = loadJudgeQualificationTrustState(options);
    const { issuerId, keyId } = attestation.issuer;
    if (trust.revokedIssuerIds.has(issuerId)
        || trust.revokedKeys.has(`${issuerId}\u0000${keyId}`)
        || trust.revokedAttestationIds.has(attestation.attestationId)) {
        throw authorityError('VARIANCE_PILOT_REVOKED', 'variance pilot authority is revoked', 403);
    }
    const key = trust.keyMap.get(`${issuerId}\u0000${keyId}`);
    if (!key || !key.scopes.has(VARIANCE_PILOT_SCOPE)) {
        throw authorityError(
            'VARIANCE_PILOT_ISSUER_NOT_TRUSTED',
            'issuer/key lacks independent variance pilot authority',
            403
        );
    }
    const issuedAt = Date.parse(attestation.issuedAt);
    const validUntil = Date.parse(attestation.validUntil);
    if (issuedAt < Date.parse(key.notBefore)
        || issuedAt > Date.parse(key.notAfter)
        || validUntil > Date.parse(key.notAfter)) {
        throw authorityError(
            'VARIANCE_PILOT_KEY_OUTSIDE_VALIDITY',
            'variance pilot validity must remain inside key validity',
            403
        );
    }
    return verifyBenchmarkVariancePilotAttestation(attestation, {
        publicKey: key.publicKey,
        now: trust.verificationTime,
        maxClockSkewMs: MAX_CLOCK_SKEW_MS
    });
}

module.exports = {
    MIN_REVOCATION_VERSION_ENV,
    QUALIFICATION_SCOPE,
    VARIANCE_PILOT_SCOPE,
    REVOCATION_SNAPSHOT_ID_ENV,
    REVOCATIONS_ENV,
    REVOCATIONS_SCHEMA,
    TRUST_ROOTS_ENV,
    TRUST_ROOTS_SCHEMA,
    loadJudgeQualificationTrustState,
    verifyJudgeQualificationAuthority,
    verifyVariancePilotAuthority
};
