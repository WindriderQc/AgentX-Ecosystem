/**
 * Per-(model, host) performance baseline capture for a benchmark batch.
 *
 * Source priority:
 *   1. Profiler adaptation (ModelAdaptation collection)  — preferred
 *   2. Live host test (testModelOnHost)                  — fallback
 *   3. Synthesized error baseline                        — never crashes the batch
 *
 * The resolved baseline is appended to BenchmarkBatch.performance_baselines
 * and returned to the caller for inclusion in result documents.
 *
 * Hoisted out of batchOrchestrator.js — see audit
 * docs/audits/scan-2026-04-22/benchmark/summary.md (#batch-orchestrator-monolith).
 */

const logger = require('../../../config/logger');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const ModelAdaptation = require('../../../models/ModelAdaptation');
const { testModelOnHost } = require('../hostTestService');
const { getConfiguredHosts, normalizeHostUrl } = require('../../helpers/ollamaHostConfig');
const { modelNameCandidates } = require('../modelContextResolver');
const { toPerformanceBaseline } = require('./batchHelpers');

const ADAPTATION_TTL_MS = 14 * 24 * 60 * 60 * 1000;

function resolveHostIdForUrl(hostUrl) {
    const normalizedHost = normalizeHostUrl(hostUrl);
    return getConfiguredHosts().find((host) => host.url === normalizedHost)?.id || null;
}

async function getProfilePerformanceBaseline(model, hostUrl) {
    const hostId = resolveHostIdForUrl(hostUrl);
    if (!hostId) return null;

    // Exact model names win, with namespace-stripped names as a compatibility
    // fallback. Current profiler writes ax/* records under the ax name; older
    // adaptation records may exist under the stripped parent name.
    const lookupNames = modelNameCandidates(model);
    const adaptation = await ModelAdaptation.findOne({ modelName: { $in: lookupNames }, hostId })
        .select('profile config staleness updatedAt')
        .lean()
        .catch(() => null);

    if (!adaptation?.profile) {
        return null;
    }

    if (adaptation.staleness?.stale) {
        logger.warn('ModelAdaptation profile is marked stale, falling through to live host test', {
            model,
            hostId,
            reason: adaptation.staleness.reason || null
        });
        return null;
    }

    const profiledAt = adaptation.profile.profiledAt || adaptation.updatedAt;
    if (profiledAt) {
        const ageMs = Date.now() - new Date(profiledAt).getTime();
        if (ageMs > ADAPTATION_TTL_MS) {
            logger.warn('ModelAdaptation profile is stale, falling through to live host test', {
                model,
                hostId,
                profiledAt,
                ageDays: Math.floor(ageMs / (24 * 60 * 60 * 1000)),
                ttlDays: ADAPTATION_TTL_MS / (24 * 60 * 60 * 1000)
            });
            return null;
        }
    }

    return {
        hostId,
        status: 'profiled',
        source: 'profiler_adaptation',
        tokensPerSec: adaptation.profile.tokensPerSec ?? null,
        promptEvalTokensPerSec: adaptation.profile.promptEvalTokensPerSec ?? null,
        latencyMs: adaptation.profile.loadTiming?.hotLoadMs ?? null,
        timeToFirstTokenMs: adaptation.profile.ttftMs ?? null,
        vramUsedMiB: adaptation.profile.vramUsedMiB ?? null,
        vramTotalMiB: null,
        numCtx: adaptation.config?.num_ctx ?? adaptation.profile.optimalNumCtx ?? null,
        numCtxSource: 'profiler_adaptation',
        testedAt: adaptation.profile.profiledAt || adaptation.updatedAt || null,
        error: null
    };
}

async function capturePerformanceBaseline({ batchId, model, hostUrl, numCtx = null }) {
    const explicitNumCtx = Number.isFinite(Number(numCtx)) && Number(numCtx) > 0
        ? Math.round(Number(numCtx))
        : null;

    try {
        const profileBaseline = await getProfilePerformanceBaseline(model, hostUrl);
        const profileNumCtx = Number(profileBaseline?.numCtx);
        const profileMatchesExecutionCtx = !explicitNumCtx
            || !Number.isFinite(profileNumCtx)
            || profileNumCtx === explicitNumCtx;
        if (profileBaseline && profileMatchesExecutionCtx) {
            const baseline = toPerformanceBaseline(model, hostUrl, profileBaseline);
            await BenchmarkBatch.updateOne(
                { _id: batchId },
                {
                    $push: { performance_baselines: baseline },
                    $set: { last_activity_at: new Date() }
                }
            ).catch((err) => logger.warn('Failed to persist profiler-derived performance baseline on batch', {
                batchId,
                model,
                host: hostUrl,
                error: err.message
            }));
            logger.info('Using profiler-derived performance baseline', {
                batchId,
                model,
                host: hostUrl,
                source: profileBaseline.source
            });
            return baseline;
        }
        if (profileBaseline && !profileMatchesExecutionCtx) {
            logger.info('Profiler-derived baseline context differs from execution context; running live baseline', {
                batchId,
                model,
                host: hostUrl,
                profileNumCtx,
                executionNumCtx: explicitNumCtx
            });
        }

        const snapshot = await testModelOnHost(model, hostUrl, {
            _skipHostCheck: false,
            ...(explicitNumCtx ? { numCtx: explicitNumCtx } : {})
        });
        const baseline = toPerformanceBaseline(model, hostUrl, snapshot);
        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $push: { performance_baselines: baseline },
                $set: { last_activity_at: new Date() }
            }
        ).catch((err) => logger.warn('Failed to persist performance baseline on batch', {
            batchId,
            model,
            host: hostUrl,
            error: err.message
        }));
        return baseline;
    } catch (err) {
        const baseline = toPerformanceBaseline(model, hostUrl, {
            status: 'error',
            testedAt: new Date(),
            error: err.message
        });
        await BenchmarkBatch.updateOne(
            { _id: batchId },
            {
                $push: { performance_baselines: baseline },
                $set: { last_activity_at: new Date() }
            }
        ).catch(() => {});
        logger.warn('Performance baseline capture failed', {
            batchId,
            model,
            host: hostUrl,
            error: err.message
        });
        return baseline;
    }
}

module.exports = {
    capturePerformanceBaseline,
    // exposed for tests / inspection
    _resolveHostIdForUrl: resolveHostIdForUrl,
    _getProfilePerformanceBaseline: getProfilePerformanceBaseline
};
