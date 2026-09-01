'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('../../../../shared/artifactIdentity');
const {
    computeBenchmarkHumanEvidenceSourceResultFingerprint,
    normalizeBenchmarkHumanEvidenceAttestation,
    verifyBenchmarkHumanEvidenceAttestation
} = require('../../../../shared/benchmarkHumanEvidenceAttestation');
const { fingerprint, normalizeWorkerReceipt } = require('../../../../shared/workerContract');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../../models/JudgeGroundTruth');
const {
    buildBenchmarkTrustSourceProjection,
    computePromptSourceFingerprint
} = require('./benchmarkTrustSourceEvidence');
const {
    runWithVerifiedStrictTrustEvidenceRead
} = require('./publicReadPrivacy');

const TRUST_ROOTS_ENV = 'BENCHMARK_HUMAN_EVIDENCE_TRUST_ROOTS_JSON';
const REVOCATIONS_ENV = 'BENCHMARK_HUMAN_EVIDENCE_REVOCATIONS_JSON';
const MIN_REVOCATION_VERSION_ENV = 'BENCHMARK_HUMAN_EVIDENCE_MIN_REVOCATION_VERSION';
const REVOCATION_SNAPSHOT_ID_ENV = 'BENCHMARK_HUMAN_EVIDENCE_REVOCATION_SNAPSHOT_ID';
const TRUST_ROOTS_SCHEMA = 'agentx.benchmark-human-evidence-trust-roots/v1';
const REVOCATIONS_SCHEMA = 'agentx.benchmark-human-evidence-revocations/v1';
const HUMAN_EVIDENCE_SCOPE = 'benchmark-human-evidence-v1';
const ATTESTED_SOURCE_LABEL = 'attested-human-evidence-v1';
const MAX_TRUST_CLOCK_SKEW_MS = 300_000;

function importError(code, message, statusCode = 400) {
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

function requireExactKeys(value, expected, label) {
    if (!isPlainObject(value)) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} must be an object`, 503);
    }
    const actual = Object.keys(value);
    const missing = expected.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
    const extra = actual.filter(key => !expected.includes(key));
    if (missing.length || extra.length) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} has invalid keys`, 503);
    }
    return value;
}

function requireCanonicalTimestamp(value, label) {
    if (typeof value !== 'string') {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} is invalid`, 503);
    }
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} is invalid`, 503);
    }
    return value;
}

function requireIdentifier(value, label) {
    if (typeof value !== 'string'
        || value.length === 0
        || value.length > 180
        || value !== value.trim()
        || !/^[a-zA-Z0-9][a-zA-Z0-9._:@+\-]*$/.test(value)) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} is invalid`, 503);
    }
    return value;
}

function parseServerJson(environmentName) {
    const raw = process.env[environmentName];
    if (typeof raw !== 'string' || raw.trim().length === 0) {
        throw importError(
            'BENCHMARK_HUMAN_EVIDENCE_IMPORT_DISABLED',
            'attested human-evidence import has no configured server trust authority',
            503
        );
    }
    try {
        return JSON.parse(raw);
    } catch (_error) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${environmentName} is not valid JSON`, 503);
    }
}

function normalizeUniqueIdentifiers(values, label) {
    if (!Array.isArray(values)) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} must be an array`, 503);
    }
    const normalized = values.map((value, index) => requireIdentifier(value, `${label}[${index}]`));
    if (new Set(normalized).size !== normalized.length) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} contains duplicates`, 503);
    }
    return new Set(normalized);
}

function normalizeUniqueFingerprints(values, label) {
    if (!Array.isArray(values)) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} must be an array`, 503);
    }
    const normalized = values.map((value, index) => {
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
            throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label}[${index}] is invalid`, 503);
        }
        return value;
    });
    if (new Set(normalized).size !== normalized.length) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', `${label} contains duplicates`, 503);
    }
    return new Set(normalized);
}

function normalizeRevokedKeys(values) {
    if (!Array.isArray(values)) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', 'revokedKeys must be an array', 503);
    }
    const normalized = values.map((rawValue, index) => {
        const value = requireExactKeys(rawValue, ['issuerId', 'keyId'], `revokedKeys[${index}]`);
        return {
            issuerId: requireIdentifier(value.issuerId, `revokedKeys[${index}].issuerId`),
            keyId: requireIdentifier(value.keyId, `revokedKeys[${index}].keyId`)
        };
    });
    const keys = normalized.map(value => `${value.issuerId}\u0000${value.keyId}`);
    if (new Set(keys).size !== keys.length) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', 'revokedKeys contains duplicates', 503);
    }
    return new Set(keys);
}

function loadServerTrustState(now = new Date()) {
    const verificationTime = now instanceof Date ? now : new Date(now);
    if (!Number.isFinite(verificationTime.getTime())) {
        throw importError('INVALID_HUMAN_EVIDENCE_VERIFICATION_TIME', 'verification time is invalid');
    }
    const roots = requireExactKeys(
        parseServerJson(TRUST_ROOTS_ENV),
        ['schema', 'issuers'],
        'human-evidence trust roots'
    );
    if (roots.schema !== TRUST_ROOTS_SCHEMA || !Array.isArray(roots.issuers) || roots.issuers.length === 0) {
        throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', 'human-evidence trust roots are invalid', 503);
    }
    const keyMap = new Map();
    for (const [issuerIndex, rawIssuer] of roots.issuers.entries()) {
        const issuer = requireExactKeys(rawIssuer, ['issuerId', 'keys'], `issuers[${issuerIndex}]`);
        const issuerId = requireIdentifier(issuer.issuerId, `issuers[${issuerIndex}].issuerId`);
        if (!Array.isArray(issuer.keys) || issuer.keys.length === 0) {
            throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', 'every issuer requires at least one public key', 503);
        }
        for (const [keyIndex, rawKey] of issuer.keys.entries()) {
            const key = requireExactKeys(
                rawKey,
                ['keyId', 'publicKeyPem', 'notBefore', 'notAfter', 'scopes'],
                `issuers[${issuerIndex}].keys[${keyIndex}]`
            );
            const keyId = requireIdentifier(key.keyId, `issuers[${issuerIndex}].keys[${keyIndex}].keyId`);
            const notBefore = requireCanonicalTimestamp(key.notBefore, 'human-evidence key.notBefore');
            const notAfter = requireCanonicalTimestamp(key.notAfter, 'human-evidence key.notAfter');
            if (Date.parse(notAfter) <= Date.parse(notBefore)
                || !Array.isArray(key.scopes)
                || key.scopes.length === 0
                || new Set(key.scopes).size !== key.scopes.length
                || key.scopes.some(scope => typeof scope !== 'string')) {
                throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', 'key validity or scopes are invalid', 503);
            }
            const mapKey = `${issuerId}\u0000${keyId}`;
            if (keyMap.has(mapKey)) {
                throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', 'duplicate issuer/key trust root', 503);
            }
            let publicKey;
            try {
                publicKey = crypto.createPublicKey(key.publicKeyPem);
            } catch (_error) {
                throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', 'a human-evidence public key is invalid', 503);
            }
            if (publicKey.asymmetricKeyType !== 'ed25519') {
                throw importError('HUMAN_EVIDENCE_TRUST_CONFIG_INVALID', 'human-evidence public keys must be Ed25519', 503);
            }
            keyMap.set(mapKey, {
                publicKey,
                notBefore,
                notAfter,
                scopes: new Set(key.scopes)
            });
        }
    }

    const revocations = requireExactKeys(
        parseServerJson(REVOCATIONS_ENV),
        [
            'schema', 'version', 'snapshotId', 'issuedAt', 'validUntil',
            'revokedIssuerIds', 'revokedKeys', 'revokedAttestationIds'
        ],
        'human-evidence revocations'
    );
    const snapshotBody = { ...revocations };
    delete snapshotBody.snapshotId;
    const minVersion = Number(process.env[MIN_REVOCATION_VERSION_ENV]);
    const pinnedSnapshotId = process.env[REVOCATION_SNAPSHOT_ID_ENV];
    if (revocations.schema !== REVOCATIONS_SCHEMA
        || !Number.isSafeInteger(revocations.version)
        || revocations.version < 1
        || revocations.snapshotId !== fingerprint(snapshotBody)
        || typeof pinnedSnapshotId !== 'string'
        || !/^[0-9a-f]{64}$/.test(pinnedSnapshotId)
        || revocations.snapshotId !== pinnedSnapshotId
        || !Number.isSafeInteger(minVersion)
        || minVersion < 1
        || revocations.version < minVersion) {
        throw importError(
            'HUMAN_EVIDENCE_REVOCATION_ROLLBACK',
            'human-evidence revocation snapshot is invalid or older than the pinned minimum',
            503
        );
    }
    const issuedAt = requireCanonicalTimestamp(revocations.issuedAt, 'revocations.issuedAt');
    const validUntil = requireCanonicalTimestamp(revocations.validUntil, 'revocations.validUntil');
    if (Date.parse(validUntil) <= Date.parse(issuedAt)
        || Date.parse(issuedAt) > verificationTime.getTime() + MAX_TRUST_CLOCK_SKEW_MS
        || Date.parse(validUntil) < verificationTime.getTime()) {
        throw importError('HUMAN_EVIDENCE_REVOCATIONS_STALE', 'human-evidence revocation state is not currently valid', 503);
    }
    return {
        verificationTime,
        keyMap,
        revokedIssuerIds: normalizeUniqueIdentifiers(revocations.revokedIssuerIds, 'revokedIssuerIds'),
        revokedKeys: normalizeRevokedKeys(revocations.revokedKeys),
        revokedAttestationIds: normalizeUniqueFingerprints(revocations.revokedAttestationIds, 'revokedAttestationIds')
    };
}

function verifyAgainstCurrentTrust(rawAttestation) {
    const normalized = normalizeBenchmarkHumanEvidenceAttestation(rawAttestation);
    const trust = loadServerTrustState(new Date());
    const { issuerId, keyId } = normalized.issuer;
    if (trust.revokedIssuerIds.has(issuerId)
        || trust.revokedKeys.has(`${issuerId}\u0000${keyId}`)
        || trust.revokedAttestationIds.has(normalized.attestationId)) {
        throw importError('HUMAN_EVIDENCE_ATTESTATION_REVOKED', 'human-evidence attestation authority is revoked', 403);
    }
    const key = trust.keyMap.get(`${issuerId}\u0000${keyId}`);
    if (!key || !key.scopes.has(HUMAN_EVIDENCE_SCOPE)) {
        throw importError('HUMAN_EVIDENCE_ISSUER_NOT_TRUSTED', 'human-evidence issuer/key is not trusted', 403);
    }
    const issuedAt = Date.parse(normalized.issuedAt);
    const validUntil = Date.parse(normalized.validUntil);
    if (issuedAt < Date.parse(key.notBefore)
        || issuedAt > Date.parse(key.notAfter)
        || validUntil > Date.parse(key.notAfter)) {
        throw importError(
            'HUMAN_EVIDENCE_KEY_OUTSIDE_VALIDITY',
            'attestation validity must remain inside key validity',
            403
        );
    }
    return verifyBenchmarkHumanEvidenceAttestation(normalized, {
        publicKey: key.publicKey,
        now: trust.verificationTime,
        maxClockSkewMs: MAX_TRUST_CLOCK_SKEW_MS
    });
}

function timestampMillis(value) {
    const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
    return Number.isFinite(parsed) ? parsed : NaN;
}

function scoreToMicros(value, label) {
    if (!Number.isFinite(value) || value < 0 || value > 10) {
        throw importError('HUMAN_EVIDENCE_SOURCE_INVALID', `${label} must be a finite score from 0 through 10`, 409);
    }
    const micros = Math.round(value * 1_000_000);
    if (!Number.isSafeInteger(micros)) {
        throw importError('HUMAN_EVIDENCE_SOURCE_INVALID', `${label} is not canonically representable`, 409);
    }
    return micros;
}

function buildSourceProjection(result, batch) {
    let judgeReceipt;
    try {
        judgeReceipt = normalizeWorkerReceipt(result.trust_judge_receipt);
    } catch (_error) {
        throw importError('HUMAN_EVIDENCE_SOURCE_INVALID', 'sealed source judge receipt is invalid', 409);
    }
    if (judgeReceipt.finalState !== 'succeeded' || judgeReceipt.result.contractSatisfied !== true) {
        throw importError('HUMAN_EVIDENCE_SOURCE_INVALID', 'sealed source judge receipt is not successful', 409);
    }
    const sourceCreatedAt = new Date(result.timestamp);
    const sourceUpdatedAt = new Date(result.updated_at);
    if (!Number.isFinite(sourceCreatedAt.getTime()) || !Number.isFinite(sourceUpdatedAt.getTime())) {
        throw importError('HUMAN_EVIDENCE_SOURCE_INVALID', 'sealed source timestamps are invalid', 409);
    }
    const projection = {
        sourceResultId: String(result._id),
        sourceBatchId: batch.trust_batch_id,
        candidateId: result.trust_candidate_id,
        promptId: result.trust_prompt_id,
        repeatIndex: result.repeat_index,
        repeatTotal: result.repeat_total,
        model: result.model,
        host: result.host,
        modelDigest: result.model_digest ?? null,
        promptFingerprint: computePromptSourceFingerprint(result),
        responseFingerprint: fingerprint(String(result.response ?? '')),
        category: result.prompt_category,
        judgeIdentityFingerprint: fingerprint(judgeReceipt.identity),
        judgeScoreMicros: scoreToMicros(result.quality_score, 'sealed source quality_score'),
        judgeReceiptFingerprint: judgeReceipt.fingerprint,
        executionReceiptFingerprint: result.trust_execution_receipt?.fingerprint ?? null,
        sourceCreatedAt: sourceCreatedAt.toISOString(),
        sourceUpdatedAt: sourceUpdatedAt.toISOString()
    };
    return {
        projection,
        binding: {
            sourceResultId: projection.sourceResultId,
            sourceBatchId: projection.sourceBatchId,
            sourceResultFingerprint: computeBenchmarkHumanEvidenceSourceResultFingerprint(projection),
            promptFingerprint: projection.promptFingerprint,
            responseFingerprint: projection.responseFingerprint,
            category: projection.category,
            judgeIdentityFingerprint: projection.judgeIdentityFingerprint,
            judgeScoreMicros: projection.judgeScoreMicros
        }
    };
}

async function loadVerifiedSealedSourceWithinAuthority(attestation, verificationTime) {
    const result = await BenchmarkResult.findOne({
        _id: attestation.source.sourceResultId,
        trust_evidence_sealed: true
    }).select('+trust_execution_receipt +trust_judge_receipt').lean();
    if (!result || result.success !== true || !result.batch_id) {
        throw importError('HUMAN_EVIDENCE_SOURCE_NOT_VERIFIED', 'source result is absent, unsuccessful, or unsealed', 409);
    }
    const batch = await BenchmarkBatch.findOne({
        _id: result.batch_id,
        status: 'completed',
        trust_evidence_sealed: true
    }).select('+trust_evidence_context +trust_evidence_committed_at +trust_evidence_finalized_at').lean();
    if (!batch?.trust_evidence_context) {
        throw importError('HUMAN_EVIDENCE_SOURCE_NOT_VERIFIED', 'source batch is not a finalized Trust batch', 409);
    }
    const nowMs = timestampMillis(verificationTime);
    const committedAt = timestampMillis(batch.trust_evidence_committed_at);
    const startedAt = timestampMillis(batch.started_at);
    const executionStartedAt = timestampMillis(batch.execution_started_at);
    const completedAt = timestampMillis(batch.completed_at);
    const finalizedAt = timestampMillis(batch.trust_evidence_finalized_at);
    const updatedAt = timestampMillis(batch.updated_at);
    if ([nowMs, committedAt, startedAt, executionStartedAt, completedAt, finalizedAt, updatedAt]
        .some(value => !Number.isFinite(value))
        || committedAt > startedAt
        || committedAt > executionStartedAt
        || completedAt < startedAt
        || completedAt < executionStartedAt
        || completedAt > nowMs
        || finalizedAt !== completedAt
        || updatedAt !== completedAt) {
        throw importError('HUMAN_EVIDENCE_SOURCE_NOT_VERIFIED', 'source batch finalization chronology is invalid', 409);
    }
    const [allResults, resultCount] = await Promise.all([
        BenchmarkResult.find({ batch_id: batch._id, trust_evidence_sealed: true })
            .select('+trust_execution_receipt +trust_judge_receipt')
            .lean(),
        BenchmarkResult.countDocuments({ batch_id: batch._id })
    ]);
    if (allResults.length !== resultCount || !allResults.some(row => String(row._id) === String(result._id))) {
        throw importError('HUMAN_EVIDENCE_SOURCE_NOT_VERIFIED', 'source batch inventory is not completely sealed', 409);
    }
    try {
        buildBenchmarkTrustSourceProjection({
            context: batch.trust_evidence_context,
            results: allResults,
            sourceBatchId: batch.trust_batch_id
        });
    } catch (_error) {
        throw importError('HUMAN_EVIDENCE_SOURCE_NOT_VERIFIED', 'source batch evidence does not verify canonically', 409);
    }
    const derived = buildSourceProjection(result, batch);
    if (stableSerialize(derived.binding) !== stableSerialize(attestation.source)) {
        throw importError('HUMAN_EVIDENCE_SOURCE_BINDING_MISMATCH', 'attestation does not bind the sealed source result', 409);
    }
    return { result, batch, ...derived };
}

async function loadVerifiedSealedSource(attestation, verificationTime) {
    return runWithVerifiedStrictTrustEvidenceRead(
        () => loadVerifiedSealedSourceWithinAuthority(attestation, verificationTime)
    );
}

function dimensionScoresObject(entries) {
    return Object.fromEntries(entries.map(entry => [entry.dimension, entry.scoreMicros / 1_000_000]));
}

function buildGroundTruthCandidate(attestation, source, importedAt) {
    return {
        name: `attested-human-${attestation.attestationId}`,
        prompt: source.result.prompt,
        response: source.result.response,
        category: source.binding.category,
        expected_answer: source.result.expected_answer ?? source.result.reference_answer ?? null,
        expert_scores: {
            overall: attestation.human.expertScoreMicros / 1_000_000,
            dimensions: dimensionScoresObject(attestation.human.dimensionScores)
        },
        expert_rationale: attestation.human.expertRationale,
        created_by: `attested:${attestation.issuer.issuerId}`,
        source: ATTESTED_SOURCE_LABEL,
        provenance_class: attestation.human.provenanceClass,
        review_protocol: attestation.human.reviewProtocol,
        reviewer: attestation.human.reviewerId,
        reviewed_at: new Date(attestation.human.reviewedAt),
        source_result_id: source.result._id,
        judge_score_at_review: source.binding.judgeScoreMicros / 1_000_000,
        judge_identity_fingerprint: source.binding.judgeIdentityFingerprint,
        difficulty: source.result.prompt_level ?? 3,
        judge_criteria: Array.isArray(source.result.judge_criteria) ? [...source.result.judge_criteria] : [],
        tags: [ATTESTED_SOURCE_LABEL],
        active: true,
        human_attestation_fingerprint: attestation.attestationId,
        human_attestation_issuer_id: attestation.issuer.issuerId,
        human_attestation_key_id: attestation.issuer.keyId,
        human_attestation_nonce: attestation.nonce,
        human_attestation_issued_at: new Date(attestation.issuedAt),
        human_attestation_valid_until: new Date(attestation.validUntil),
        human_attestation_source_fingerprint: attestation.source.sourceResultFingerprint,
        human_attestation: attestation,
        validation_history: [],
        validation_stats: {
            total_runs: 0,
            avg_deviation: null,
            max_deviation: null,
            min_deviation: null,
            last_validated: null
        },
        createdAt: importedAt,
        updatedAt: importedAt,
        __v: 0
    };
}

function assertReviewFollowsSourceFinalization(attestation, source) {
    const reviewedAt = timestampMillis(attestation.human.reviewedAt);
    const sourceUpdatedAt = timestampMillis(source.projection.sourceUpdatedAt);
    const batchFinalizedAt = timestampMillis(source.batch.trust_evidence_finalized_at);
    if ([reviewedAt, sourceUpdatedAt, batchFinalizedAt].some(value => !Number.isFinite(value))
        || reviewedAt < sourceUpdatedAt
        || reviewedAt < batchFinalizedAt) {
        throw importError(
            'HUMAN_EVIDENCE_REVIEW_PRECEDES_SOURCE_FINALIZATION',
            'human review must follow finalization of the exact sealed source evidence',
            409
        );
    }
}

function canonicalImportedProjection(row) {
    const plain = row?.toObject
        ? row.toObject({ depopulate: true, flattenMaps: true, versionKey: true })
        : row;
    const date = value => value == null ? null : new Date(value).toISOString();
    const dimensions = plain?.expert_scores?.dimensions instanceof Map
        ? Object.fromEntries(plain.expert_scores.dimensions)
        : { ...(plain?.expert_scores?.dimensions || {}) };
    return {
        name: plain.name,
        prompt: plain.prompt,
        response: plain.response,
        category: plain.category,
        expected_answer: plain.expected_answer ?? null,
        expert_scores: { overall: plain.expert_scores?.overall, dimensions },
        expert_rationale: plain.expert_rationale,
        created_by: plain.created_by,
        source: plain.source,
        provenance_class: plain.provenance_class,
        review_protocol: plain.review_protocol,
        reviewer: plain.reviewer,
        reviewed_at: date(plain.reviewed_at),
        source_result_id: String(plain.source_result_id),
        judge_score_at_review: plain.judge_score_at_review,
        judge_identity_fingerprint: plain.judge_identity_fingerprint,
        difficulty: plain.difficulty,
        judge_criteria: [...(plain.judge_criteria || [])],
        tags: [...(plain.tags || [])],
        active: plain.active,
        human_attestation_fingerprint: plain.human_attestation_fingerprint,
        human_attestation_issuer_id: plain.human_attestation_issuer_id,
        human_attestation_key_id: plain.human_attestation_key_id,
        human_attestation_nonce: plain.human_attestation_nonce,
        human_attestation_issued_at: date(plain.human_attestation_issued_at),
        human_attestation_valid_until: date(plain.human_attestation_valid_until),
        human_attestation_source_fingerprint: plain.human_attestation_source_fingerprint,
        human_attestation: normalizeBenchmarkHumanEvidenceAttestation(plain.human_attestation)
    };
}

function assertStoredRowMatchesAttestation(row, attestation) {
    const expected = {
        provenance_class: attestation.human.provenanceClass,
        review_protocol: attestation.human.reviewProtocol,
        expert_overall: attestation.human.expertScoreMicros / 1_000_000,
        expert_dimensions: dimensionScoresObject(attestation.human.dimensionScores),
        expert_rationale: attestation.human.expertRationale,
        reviewer: attestation.human.reviewerId,
        reviewed_at: attestation.human.reviewedAt,
        source_result_id: attestation.source.sourceResultId,
        judge_score_at_review: attestation.source.judgeScoreMicros / 1_000_000,
        judge_identity_fingerprint: attestation.source.judgeIdentityFingerprint,
        category: attestation.source.category,
        active: true,
        attestation_fingerprint: attestation.attestationId,
        attestation_issuer_id: attestation.issuer.issuerId,
        attestation_key_id: attestation.issuer.keyId,
        attestation_nonce: attestation.nonce,
        attestation_issued_at: attestation.issuedAt,
        attestation_valid_until: attestation.validUntil,
        attestation_source_fingerprint: attestation.source.sourceResultFingerprint
    };
    const dimensions = row.expert_scores?.dimensions instanceof Map
        ? Object.fromEntries(row.expert_scores.dimensions)
        : { ...(row.expert_scores?.dimensions || {}) };
    const actual = {
        provenance_class: row.provenance_class,
        review_protocol: row.review_protocol,
        expert_overall: row.expert_scores?.overall,
        expert_dimensions: dimensions,
        expert_rationale: row.expert_rationale,
        reviewer: row.reviewer,
        reviewed_at: new Date(row.reviewed_at).toISOString(),
        source_result_id: String(row.source_result_id),
        judge_score_at_review: row.judge_score_at_review,
        judge_identity_fingerprint: row.judge_identity_fingerprint,
        category: row.category,
        active: row.active,
        attestation_fingerprint: row.human_attestation_fingerprint,
        attestation_issuer_id: row.human_attestation_issuer_id,
        attestation_key_id: row.human_attestation_key_id,
        attestation_nonce: row.human_attestation_nonce,
        attestation_issued_at: new Date(row.human_attestation_issued_at).toISOString(),
        attestation_valid_until: new Date(row.human_attestation_valid_until).toISOString(),
        attestation_source_fingerprint: row.human_attestation_source_fingerprint
    };
    if (stableSerialize(actual) !== stableSerialize(expected)) {
        throw importError('HUMAN_EVIDENCE_STORED_ROW_MISMATCH', 'stored ground truth no longer matches its signed attestation', 409);
    }
}

function projectImportedGroundTruth(row) {
    return {
        id: String(row._id),
        name: row.name,
        category: row.category,
        source: row.source,
        provenance_class: row.provenance_class,
        review_protocol: row.review_protocol,
        reviewed_at: row.reviewed_at,
        judge_identity_fingerprint: row.judge_identity_fingerprint,
        human_attestation_fingerprint: row.human_attestation_fingerprint,
        human_attestation_valid_until: row.human_attestation_valid_until,
        active: row.active
    };
}

async function importAttestedHumanGroundTruth(rawAttestation) {
    const verificationTime = new Date();
    const attestation = verifyAgainstCurrentTrust(rawAttestation);
    const source = await loadVerifiedSealedSource(attestation, verificationTime);
    assertReviewFollowsSourceFinalization(attestation, source);
    const importedAt = new Date();
    const candidate = new JudgeGroundTruth(buildGroundTruthCandidate(attestation, source, importedAt));
    await candidate.validate();
    const insertDocument = candidate.toObject({ depopulate: true, flattenMaps: true, versionKey: true });
    await JudgeGroundTruth.init();
    try {
        const inserted = await JudgeGroundTruth.collection.insertOne(insertDocument);
        const stored = await JudgeGroundTruth.findById(inserted.insertedId).lean();
        return { imported: true, groundTruth: projectImportedGroundTruth(stored) };
    } catch (error) {
        if (error?.code !== 11000) throw error;
        const existing = await JudgeGroundTruth.collection.findOne({
            human_attestation_fingerprint: attestation.attestationId
        });
        if (!existing
            || stableSerialize(canonicalImportedProjection(existing))
                !== stableSerialize(canonicalImportedProjection(insertDocument))) {
            throw importError('HUMAN_EVIDENCE_ATTESTATION_REPLAY_CONFLICT', 'attestation nonce or identity was already used for different bytes', 409);
        }
        return { imported: false, groundTruth: projectImportedGroundTruth(existing) };
    }
}

async function verifyStoredAttestedHumanGroundTruth(row) {
    if (!row?.human_attestation) {
        throw importError('HUMAN_EVIDENCE_ATTESTATION_MISSING', 'qualified ground truth lacks its signed attestation', 409);
    }
    const attestation = verifyAgainstCurrentTrust(row.human_attestation);
    assertStoredRowMatchesAttestation(row, attestation);
    const source = await loadVerifiedSealedSource(attestation, new Date());
    assertReviewFollowsSourceFinalization(attestation, source);
    const expected = buildGroundTruthCandidate(attestation, source, new Date());
    if (stableSerialize(canonicalImportedProjection(row))
        !== stableSerialize(canonicalImportedProjection(expected))) {
        throw importError(
            'HUMAN_EVIDENCE_STORED_ROW_MISMATCH',
            'stored ground truth no longer matches its sealed source and signed attestation',
            409
        );
    }
    return attestation;
}

module.exports = {
    HUMAN_EVIDENCE_SCOPE,
    MIN_REVOCATION_VERSION_ENV,
    REVOCATION_SNAPSHOT_ID_ENV,
    ATTESTED_SOURCE_LABEL,
    REVOCATIONS_ENV,
    REVOCATIONS_SCHEMA,
    TRUST_ROOTS_ENV,
    TRUST_ROOTS_SCHEMA,
    importAttestedHumanGroundTruth,
    verifyStoredAttestedHumanGroundTruth
};
