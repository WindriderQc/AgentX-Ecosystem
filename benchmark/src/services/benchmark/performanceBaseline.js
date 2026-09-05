/**
 * Per-(model, host) performance baseline capture for a benchmark batch.
 *
 * Source priority:
 *   1. Exact-artifact profiler evidence                 — preferred
 * Missing/incompatible profiler evidence is a hard preflight failure. An ad
 * hoc host test is not equivalent to a statistically qualified baseline and
 * must never become trust/promotion evidence.
 *
 * The resolved baseline is appended to BenchmarkBatch.performance_baselines
 * and returned to the caller for inclusion in result documents.
 *
 * Hoisted out of batchOrchestrator.js — see audit
 * docs/audits/scan-2026-04-22/benchmark/summary.md (#batch-orchestrator-monolith).
 */

const logger = require('../../../config/logger');
const crypto = require('crypto');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const ModelProfile = require('../../../models/ModelProfile');
const { getConfiguredHosts, normalizeHostUrl } = require('../../helpers/ollamaHostConfig');
const { identitiesMatch, resolveArtifactIdentity } = require('../profiler/artifactIdentityService');
const { verifyProfilerAuthorityReceipt } = require('../profiler/profilerAuthorityReceipt');
const { toPerformanceBaseline } = require('./batchHelpers');

const PROFILE_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function resolveHostIdForUrl(hostUrl) {
    const normalizedHost = normalizeHostUrl(hostUrl);
    return getConfiguredHosts().find((host) => normalizeHostUrl(host.url) === normalizedHost)?.id || null;
}

async function getProfilePerformanceBaseline(model, hostUrl) {
    const hostId = resolveHostIdForUrl(hostUrl);
    if (!hostId) return null;

    const artifact = await resolveArtifactIdentity(model, hostId, hostUrl);
    const modelProfile = await ModelProfile.findOne({ name: artifact.model })
        .select('readiness')
        .lean()
        .catch(() => null);
    const readiness = modelProfile?.readiness instanceof Map
        ? modelProfile.readiness.get(hostId)
        : modelProfile?.readiness?.[hostId];
    if (readiness?.benchmarkQualified !== true
        || readiness?.stale === true
        || !['standard', 'full'].includes(readiness?.profileDepth)
        || !identitiesMatch(readiness?.artifact, artifact)
        || readiness?.artifact?.registryQualified !== true) {
        logger.warn('Profiler authority did not qualify the exact artifact', {
            model,
            hostId,
            profileDepth: readiness?.profileDepth || null,
            benchmarkQualified: readiness?.benchmarkQualified === true,
            authorityReceipt: false
        });
        return null;
    }

    const evidence = await ModelPerformanceProfile.findOne({
        _id: readiness.evidenceId,
        modelName: artifact.model,
        hostId,
        'artifact.digest': artifact.digest,
        'artifact.runtimeFingerprint': artifact.runtimeFingerprint,
        active: true,
        stale: { $ne: true },
        authorityState: { $nin: ['pending_reconciliation', 'authority_invalidated'] }
    })
        .select('profile artifact updatedAt')
        .lean()
        .catch(() => null);

    if (!evidence?.profile
        || !verifyProfilerAuthorityReceipt(readiness, evidence, { modelName: artifact.model, hostId })
        || evidence.artifact?.registryQualified !== true
        || !identitiesMatch(evidence.artifact, artifact)
        || !(Number(evidence.profile.recommendedInteractiveContext) > 0)) {
        return null;
    }

    const profiledAt = evidence.profile.profiledAt || evidence.updatedAt;
    if (profiledAt) {
        const ageMs = Date.now() - new Date(profiledAt).getTime();
        if (ageMs > PROFILE_TTL_MS) {
            logger.warn('Exact-artifact profile evidence is stale', {
                model,
                hostId,
                profiledAt,
                ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
                ttlDays: PROFILE_TTL_MS / (24 * 60 * 60 * 1000)
            });
            return null;
        }
    }

    return {
        hostId,
        status: 'profiled',
        source: 'exact_artifact_profile',
        tokensPerSec: evidence.profile.tokensPerSec ?? null,
        promptEvalTokensPerSec: evidence.profile.promptEvalTokensPerSec ?? null,
        latencyMs: evidence.profile.loadTiming?.hotLoadMs ?? null,
        timeToFirstTokenMs: evidence.profile.ttftMs ?? null,
        ttftMeasurement: evidence.profile.ttftMeasurement || undefined,
        vramUsedMiB: evidence.profile.vramUsedMiB ?? null,
        vramTotalMiB: null,
        numCtx: Number(evidence.profile.recommendedInteractiveContext),
        numCtxSource: 'exact_artifact_profile',
        testedAt: evidence.profile.profiledAt || evidence.updatedAt || null,
        error: null
    };
}

async function capturePerformanceBaseline({
    batchId,
    model,
    hostUrl,
    numCtx = null,
    claimIdentity = null,
    assertClaimActive = null,
    signal = null
}) {
    if (signal?.aborted) {
        if (signal.reason instanceof Error) throw signal.reason;
        throw new Error('Benchmark claim stopped before baseline resolution');
    }
    if (!claimIdentity?.claimBatchId || !claimIdentity?.claimGeneration) {
        const error = new Error('Exact benchmark claim proof is required for performance baseline resolution');
        error.code = 'BENCHMARK_CLAIM_IDENTITY_MISSING';
        throw error;
    }
    assertClaimActive?.();
    const explicitNumCtx = Number.isFinite(Number(numCtx)) && Number(numCtx) > 0
        ? Math.round(Number(numCtx))
        : null;

    try {
        const profileBaseline = await getProfilePerformanceBaseline(model, hostUrl);
        const profileNumCtx = Number(profileBaseline?.numCtx);
        const profileMatchesExecutionCtx = Number.isFinite(profileNumCtx)
            && profileNumCtx > 0
            && (!explicitNumCtx || profileNumCtx === explicitNumCtx);
        if (profileBaseline && profileMatchesExecutionCtx) {
            assertClaimActive?.();
            if (signal?.aborted) {
                if (signal.reason instanceof Error) throw signal.reason;
                throw new Error('Benchmark claim stopped before baseline persistence');
            }
            const baseline = toPerformanceBaseline(model, hostUrl, profileBaseline);
            baseline.persistenceReceipt = crypto.randomUUID();
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                {
                    $push: { performance_baselines: baseline },
                    $set: { last_activity_at: new Date() }
                },
                signal ? { signal } : undefined
            );
            try {
                assertClaimActive?.();
                if (signal?.aborted) {
                    if (signal.reason instanceof Error) throw signal.reason;
                    throw new Error('Benchmark claim stopped after baseline persistence');
                }
            } catch (authorityError) {
                try {
                    const compensation = await BenchmarkBatch.updateOne(
                        { _id: batchId },
                        { $pull: { performance_baselines: { persistenceReceipt: baseline.persistenceReceipt } } }
                    );
                    if (Number(compensation?.matchedCount) === 0) {
                        throw new Error(`Benchmark batch ${batchId} was not found during baseline compensation`);
                    }
                    authorityError.authorityCompensated = true;
                } catch (compensationError) {
                    authorityError.compensationError = compensationError;
                    try {
                        await BenchmarkBatch.updateOne(
                            { _id: batchId },
                            {
                                $set: {
                                    authority_state: 'pending_reconciliation',
                                    authority_reconciliation_reason: 'performance baseline compensation could not be verified'
                                }
                            }
                        );
                        authorityError.authorityInvalidated = true;
                    } catch (invalidationError) {
                        authorityError.invalidationError = invalidationError;
                        authorityError.retainAdmission = true;
                        authorityError.code = 'PERFORMANCE_BASELINE_RECONCILIATION_PENDING';
                    }
                }
                throw authorityError;
            }
            logger.info('Using profiler-derived performance baseline', {
                batchId,
                model,
                host: hostUrl,
                source: profileBaseline.source
            });
            return baseline;
        }
        const error = new Error(profileBaseline
            ? `Exact-artifact profiler baseline context ${profileNumCtx} does not match execution context ${explicitNumCtx}`
            : `Qualified exact-artifact profiler baseline required for ${model} on ${hostUrl}`);
        error.code = 'QUALIFIED_PROFILER_BASELINE_REQUIRED';
        throw error;
    } catch (err) {
        logger.warn('Performance baseline capture failed', {
            batchId,
            model,
            host: hostUrl,
            error: err.message
        });
        throw err;
    }
}

module.exports = {
    capturePerformanceBaseline,
    // exposed for tests / inspection
    _resolveHostIdForUrl: resolveHostIdForUrl,
    _getProfilePerformanceBaseline: getProfilePerformanceBaseline
};
