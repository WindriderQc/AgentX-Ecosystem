'use strict';

const { checkHost } = require('../hostTestService');
const hostProfileService = require('../profiler/hostProfileService');
const { identitiesMatch, resolveArtifactIdentity } = require('../profiler/artifactIdentityService');
const ModelPerformanceProfile = require('../../../models/ModelPerformanceProfile');
const ModelProfile = require('../../../models/ModelProfile');
const ModelContextProfile = require('../../../models/ModelContextProfile');
const { parseParameterCount, parseQuantization, estimateTotalVram } = require('../parameterDetection');
const { selectBestQuantForVram, parseActiveParams } = require('../modelFitEstimator');
const { normalizeModelTag } = require('../../../../shared/modelNames');

const READY_STAGES = new Set(['profiled', 'benchmarked']);
const ESTIMATE_NUM_CTX = 8192;

function normalizeModelName(name) {
    return normalizeModelTag(name);
}

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function resolveCandidate(raw) {
    const value = typeof raw === 'string' ? { model: raw } : (raw || {});
    const model = normalizeModelName(value.model || value.name);
    return {
        inputModel: model,
        model,
        label: value.label || model
    };
}

function profileReadinessForHost(profile, hostId) {
    const readiness = profile?.readiness;
    if (!readiness) return null;
    if (readiness instanceof Map) return readiness.get(hostId) || null;
    return readiness[hostId] || null;
}

function exactEvidenceMatches(readiness, evidence, artifact) {
    return Boolean(
        artifact
        && evidence?.artifact
        && readiness?.artifact
        && READY_STAGES.has(readiness.stage)
        && readiness.benchmarkQualified === true
        && readiness.stale !== true
        && evidence.active !== false
        && evidence.stale !== true
        && evidence.artifact.registryQualified === true
        && identitiesMatch(evidence.artifact, artifact)
        && identitiesMatch(readiness.artifact, artifact)
    );
}

function getProfileVramMiB(evidence) {
    const n = Number(evidence?.profile?.vramUsedMiB);
    return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * B2 (llmfit-derived) — advisory analytical VRAM/quant fit for a candidate.
 * This is a PLANNING HINT, not a gate: the empirical profiled-VRAM drop above
 * stays authoritative. Most useful for unprofiled candidates (e.g. new
 * challengers) — predicts whether the model fits as-named and, if not, which
 * quant would fit, so an operator can pull the right artifact before spending a
 * profile run. Returns null when params/VRAM can't be determined.
 */
function estimateCandidateFit(candidate, vramLimitMiB, numCtx = ESTIMATE_NUM_CTX) {
    if (!vramLimitMiB || !Number.isFinite(Number(numCtx)) || Number(numCtx) <= 0) return null;
    const paramB = parseParameterCount(candidate.model)
        // Fall back to the MoE/effective active-param tag (e.g. gemma4:e4b → 4)
        // when no total-param count is encoded in the name.
        || parseActiveParams(candidate.model);
    if (!paramB) return null;

    const namedQuant = parseQuantization(candidate.model);
    const budgetBytes = vramLimitMiB * 1024 * 1024;
    const asNamedBytes = namedQuant ? estimateTotalVram(paramB, namedQuant, numCtx) : null;
    const walk = selectBestQuantForVram({ paramBillions: paramB, hostVramMiB: vramLimitMiB, numCtx, utilization: 1 });
    const fitsAsNamed = Number.isFinite(asNamedBytes) ? asNamedBytes <= budgetBytes : null;
    let note;
    if (!walk.fits) {
        note = `analytically unlikely to fit ${paramB}B @ ${numCtx} ctx in ${vramLimitMiB} MiB`;
    } else if (namedQuant && Number.isFinite(asNamedBytes) && asNamedBytes > budgetBytes) {
        note = `named ${namedQuant} ≈ ${Math.round(asNamedBytes / 1024 / 1024)} MiB won't fit; `
            + `${walk.quantization} @ ${walk.num_ctx} ctx would (~${walk.estVramMiB} MiB)`;
    } else {
        note = `analytical fit OK (${walk.quantization} @ ${walk.num_ctx} ctx ~${walk.estVramMiB} MiB)`;
    }
    return {
        paramBillions: paramB,
        numCtx,
        namedQuant: namedQuant || null,
        estVramAsNamedMiB: Number.isFinite(asNamedBytes) ? Math.round(asNamedBytes / 1024 / 1024) : null,
        fitsAsNamed,
        bestFittingQuant: walk.fits ? walk.quantization : null,
        bestFittingNumCtx: walk.fits ? walk.num_ctx : null,
        bestFittingVramMiB: walk.fits ? walk.estVramMiB : null,
        note
    };
}

function classifyCandidate({ candidate, inventory, hostVramMiB, maxVramFraction, requestedNumCtx, evidence = {}, identityError = null }) {
    const onHost = { exact: inventory.has(candidate.model) };
    const vramUsedMiB = getProfileVramMiB(evidence.performance);
    const vramLimitMiB = hostVramMiB && maxVramFraction
        ? Math.floor(Number(hostVramMiB) * Number(maxVramFraction))
        : Number(hostVramMiB) || null;
    const measuredNumCtx = Number(evidence.context?.verifiedMaxContext || evidence.context?.recommendedContext) || null;
    const estimate = estimateCandidateFit(candidate, vramLimitMiB, requestedNumCtx || measuredNumCtx || ESTIMATE_NUM_CTX);

    if (vramLimitMiB && vramUsedMiB && vramUsedMiB > vramLimitMiB) {
        return {
            ...candidate, onHost, vramUsedMiB, vramLimitMiB, estimate,
            filterStatus: 'dropped', reason: `profiled VRAM ${vramUsedMiB} MiB exceeds host limit ${vramLimitMiB} MiB`,
            readiness: 'filtered_vram', actions: []
        };
    }

    const readiness = profileReadinessForHost(evidence.profile, evidence.artifact?.hostId);
    const exactProfile = exactEvidenceMatches(readiness, evidence.performance, evidence.artifact);
    const contextValidated = Boolean(
        exactProfile
        && Number(evidence.context?.recommendedContext) > 0
        && evidence.context?.stale !== true
        && evidence.context.artifactDigest === evidence.artifact.digest
        && evidence.context.runtimeFingerprint === evidence.artifact.runtimeFingerprint
    );
    const actions = [];
    let status = 'ready';
    let reason = null;

    if (!onHost.exact) {
        status = 'not_on_host';
        reason = 'the exact requested model tag is not installed on this host';
    } else if (identityError) {
        status = 'identity_unqualified';
        reason = identityError;
    } else if (!exactProfile || !contextValidated) {
        status = readiness?.stale ? 'stale_profile' : 'needs_profile';
        reason = !exactProfile
            ? 'exact digest/runtime profile evidence is missing or stale'
            : 'exact digest/runtime context evidence is missing or stale';
        actions.push({ type: 'profile', model: candidate.model, reason: !exactProfile ? 'artifact_evidence' : 'context_validation' });
    }

    return {
        ...candidate,
        onHost,
        artifact: evidence.artifact || null,
        vramUsedMiB,
        vramLimitMiB,
        estimate,
        filterStatus: 'included',
        reason,
        readiness: status,
        profileStage: readiness?.stage || null,
        contextValidated,
        stale: readiness?.stale === true || evidence.performance?.stale === true || evidence.context?.stale === true,
        actions
    };
}

async function loadCandidateEvidence(candidate, hostId, hostUrl, deps) {
    let artifact = null;
    let identityError = null;
    try {
        artifact = await deps.resolveArtifactIdentity(candidate.model, hostId, hostUrl);
    } catch (err) {
        identityError = err.message;
    }

    const profilePromise = deps.ModelProfile.findOne({ name: candidate.model }).select('readiness').lean();
    if (!artifact) return { profile: await profilePromise, artifact, performance: null, context: null, identityError };

    const [profile, performance, context] = await Promise.all([
        profilePromise,
        deps.ModelPerformanceProfile.findOne({
            modelName: candidate.model,
            hostId,
            'artifact.digest': artifact.digest,
            'artifact.runtimeFingerprint': artifact.runtimeFingerprint,
            active: true,
            stale: { $ne: true }
        }).lean(),
        deps.ModelContextProfile.findOne({
            modelName: candidate.model,
            hostId,
            hostUrl: artifact.hostUrl,
            artifactDigest: artifact.digest,
            runtimeFingerprint: artifact.runtimeFingerprint,
            stale: { $ne: true }
        }).lean()
    ]);
    return { profile, performance, context, artifact, identityError };
}

function buildPayloads({ host, levels, promptIds, judgeConfig, executionConfig, runName, tags, description, profileDepth, candidates }) {
    const readyModels = candidates
        .filter((candidate) => candidate.filterStatus === 'included' && candidate.readiness === 'ready' && candidate.onHost.exact)
        .map((candidate) => candidate.model);
    const profileModels = unique(candidates
        .filter((candidate) => candidate.filterStatus === 'included')
        .flatMap((candidate) => candidate.actions.filter((action) => action.type === 'profile').map((action) => action.model)));
    return {
        readyModels,
        payloads: {
            profileQueue: profileModels.length ? {
                hostId: host.hostId,
                depth: profileDepth,
                skipRecentDays: 0,
                modelNames: profileModels
            } : null,
            benchmark: readyModels.length ? {
                host: host.hostUrl,
                models: readyModels,
                levels,
                ...(promptIds?.length ? { prompt_ids: promptIds } : {}),
                ...(runName ? { run_name: runName } : {}),
                ...(judgeConfig ? { judge_config: judgeConfig } : {}),
                ...(executionConfig ? { execution_config: executionConfig } : {}),
                execution_mode: 'latency',
                ...(tags?.length ? { tags } : {}),
                ...(description ? { description } : {})
            } : null
        }
    };
}

async function buildSweepPlan(input = {}, deps = {}) {
    const services = {
        checkHost,
        hostProfileService,
        identitiesMatch,
        resolveArtifactIdentity,
        ModelPerformanceProfile,
        ModelProfile,
        ModelContextProfile,
        ...deps
    };
    const hostRef = String(input.hostId || input.host || '').trim();
    if (!hostRef) throw new Error('hostId or host is required');
    const host = /^https?:\/\//i.test(hostRef)
        ? await services.hostProfileService.getByUrl(hostRef)
        : await services.hostProfileService.getById(hostRef);
    if (!host) throw new Error(`Host not found: ${hostRef}`);
    const candidatesInput = Array.isArray(input.candidates) ? input.candidates : [];
    if (!candidatesInput.length) throw new Error('candidates[] is required');

    const probe = await services.checkHost(host.hostUrl);
    if (!probe.available) throw new Error(`Host unreachable: ${probe.error || host.hostUrl}`);
    const inventory = new Set((probe.models || []).map(normalizeModelName));
    const hostVramMiB = Number(input.vramLimitMiB || host.vramMb || host.vramMiB || host.gpu?.vramTotalMiB || 0) || null;
    const maxVramFraction = Number(input.maxVramFraction || 1);
    const levels = Array.isArray(input.levels) && input.levels.length ? input.levels.map(Number) : [1, 2, 3];
    const promptIds = Array.isArray(input.prompt_ids) ? input.prompt_ids.map(String) : null;
    const profileDepth = input.profileDepth || 'standard';
    const requestedNumCtx = Number(
        input.execution_config?.force_num_ctx || input.execution_config?.num_ctx || 0
    ) || null;

    const candidates = [];
    for (const candidate of candidatesInput.map(resolveCandidate)) {
        const evidence = await loadCandidateEvidence(candidate, host.hostId, host.hostUrl, services);
        candidates.push(classifyCandidate({
            candidate,
            inventory,
            hostVramMiB,
            maxVramFraction,
            requestedNumCtx,
            evidence,
            identityError: evidence.identityError
        }));
    }
    const { readyModels, payloads } = buildPayloads({
        host, levels, promptIds,
        judgeConfig: input.judge_config || null,
        executionConfig: input.execution_config || null,
        runName: input.run_name || null,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : null,
        description: input.description || null,
        profileDepth,
        candidates
    });
    return {
        host: { hostId: host.hostId, hostUrl: host.hostUrl, displayName: host.displayName || host.name || host.hostId, vramMiB: hostVramMiB },
        lane: input.lane || null,
        levels,
        prompt_ids: promptIds,
        profileDepth,
        inventoryCount: inventory.size,
        candidates,
        summary: {
            total: candidates.length,
            ready: candidates.filter((candidate) => candidate.readiness === 'ready').length,
            needsProfile: candidates.filter((candidate) => candidate.readiness === 'needs_profile' || candidate.readiness === 'stale_profile').length,
            identityUnqualified: candidates.filter((candidate) => candidate.readiness === 'identity_unqualified').length,
            notOnHost: candidates.filter((candidate) => candidate.readiness === 'not_on_host').length,
            droppedVram: candidates.filter((candidate) => candidate.readiness === 'filtered_vram').length,
            analyticalUnlikelyFit: candidates.filter((candidate) => candidate.estimate && candidate.estimate.bestFittingQuant === null).length,
            benchmarkReadyModels: readyModels.length
        },
        payloads
    };
}

module.exports = {
    buildSweepPlan,
    _internal: { classifyCandidate, resolveCandidate, buildPayloads, estimateCandidateFit, exactEvidenceMatches }
};
