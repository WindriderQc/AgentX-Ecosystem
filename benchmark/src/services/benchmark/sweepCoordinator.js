'use strict';

const { checkHost } = require('../hostTestService');
const hostProfileService = require('../profiler/hostProfileService');
const ModelAdaptation = require('../../../models/ModelAdaptation');
const ModelProfile = require('../../../models/ModelProfile');
const ModelContextProfile = require('../../../models/ModelContextProfile');
const { buildAdaptedName } = require('../profiler/namingConvention');
const { modelNameCandidates } = require('../modelContextResolver');
const { parseParameterCount, parseQuantization, estimateTotalVram } = require('../parameterDetection');
const { selectBestQuantForVram, parseActiveParams } = require('../modelFitEstimator');
const { normalizeModelTag: normalizeModelName } = require('../../../../shared/modelNames');

const READY_STAGES = new Set(['profiled', 'adapted', 'benchmarked']);

function unique(values) {
    return [...new Set(values.filter(Boolean))];
}

function resolveCandidate(raw) {
    const value = typeof raw === 'string' ? { model: raw } : (raw || {});
    const inputModel = normalizeModelName(value.model || value.name || value.rawModel || value.adaptedModel);
    const rawModel = normalizeModelName(value.rawModel || (inputModel.startsWith('ax/') ? inputModel.slice(3) : inputModel));
    const adaptedModel = normalizeModelName(value.adaptedModel || (inputModel.startsWith('ax/') ? inputModel : buildAdaptedName(inputModel)));

    return {
        inputModel,
        rawModel,
        adaptedModel,
        label: value.label || inputModel
    };
}

function profileReadinessForHost(profile, hostId) {
    const readiness = profile?.readiness;
    if (!readiness) return null;
    if (readiness instanceof Map) return readiness.get(hostId) || null;
    return readiness[hostId] || null;
}

function getProfileVramMiB(adaptation) {
    const n = Number(adaptation?.profile?.vramUsedMiB);
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
function estimateCandidateFit(candidate, vramLimitMiB, numCtx) {
    if (!vramLimitMiB || !Number.isFinite(Number(numCtx)) || Number(numCtx) <= 0) return null;
    const paramB = parseParameterCount(candidate.adaptedModel)
        || parseParameterCount(candidate.rawModel)
        || parseParameterCount(candidate.inputModel)
        // Fall back to the MoE/effective active-param tag (e.g. gemma4:e4b → 4)
        // when no total-param count is encoded in the name.
        || parseActiveParams(candidate.adaptedModel)
        || parseActiveParams(candidate.rawModel);
    if (!paramB) return null;

    const namedQuant = parseQuantization(candidate.adaptedModel) || parseQuantization(candidate.rawModel);
    const budgetBytes = vramLimitMiB * 1024 * 1024;
    const asNamedBytes = namedQuant ? estimateTotalVram(paramB, namedQuant, numCtx) : null;
    // vramLimitMiB already folds in maxVramFraction, so use utilization=1 here.
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

function classifyCandidate({ candidate, inventory, hostId, hostVramMiB, maxVramFraction, profile, adaptation, contextProfile, requestedNumCtx }) {
    const onHost = {
        raw: inventory.has(candidate.rawModel),
        adapted: inventory.has(candidate.adaptedModel)
    };
    const vramUsedMiB = getProfileVramMiB(adaptation);
    const vramLimitMiB = hostVramMiB && maxVramFraction
        ? Math.floor(Number(hostVramMiB) * Number(maxVramFraction))
        : Number(hostVramMiB) || null;
    const measuredNumCtx = Number(contextProfile?.verifiedMaxContext || contextProfile?.recommendedContext) || null;
    const estimate = estimateCandidateFit(candidate, vramLimitMiB, requestedNumCtx || measuredNumCtx);

    if (vramLimitMiB && vramUsedMiB && vramUsedMiB > vramLimitMiB) {
        return {
            ...candidate,
            onHost,
            vramUsedMiB,
            vramLimitMiB,
            estimate,
            filterStatus: 'dropped',
            reason: `profiled VRAM ${vramUsedMiB} MiB exceeds host limit ${vramLimitMiB} MiB`,
            readiness: 'filtered_vram',
            actions: []
        };
    }

    const readiness = profileReadinessForHost(profile, hostId);
    const stage = readiness?.stage || null;
    const hasProfile = stage && READY_STAGES.has(stage);
    const deployed = adaptation?.deployment?.status === 'deployed';
    const stale = !!(readiness?.stale || adaptation?.staleness?.stale);
    const contextValidated = Number(contextProfile?.verifiedMaxContext || contextProfile?.recommendedContext) > 0
        && contextProfile?.stale !== true;

    const actions = [];
    let status = 'ready';
    let reason = null;

    if (!onHost.raw && !onHost.adapted) {
        status = 'not_on_host';
        reason = 'neither raw nor adapted model is present on host';
    } else if (!hasProfile) {
        status = 'needs_profile';
        actions.push({ type: 'profile', model: onHost.raw ? candidate.rawModel : candidate.adaptedModel });
    } else if (!deployed || !onHost.adapted) {
        status = 'needs_adaptation';
        actions.push({ type: 'adapt', model: candidate.rawModel, target: candidate.adaptedModel });
    } else if (!contextValidated) {
        // The campaign contract fails closed without a measured host/artifact
        // context window. Treating an adapted-only profile as benchmark-ready
        // makes /plan succeed only for /run to crash before test one.
        status = 'needs_profile';
        reason = contextProfile?.stale
            ? 'validated host/artifact context profile is stale'
            : 'validated host/artifact context profile is missing';
        actions.push({ type: 'profile', model: candidate.adaptedModel, reason: 'context_validation' });
    }

    if (stale) {
        actions.unshift({ type: 'profile', model: onHost.raw ? candidate.rawModel : candidate.adaptedModel, reason: 'stale' });
        status = status === 'ready' ? 'stale_profile' : status;
    }

    return {
        ...candidate,
        onHost,
        vramUsedMiB,
        vramLimitMiB,
        estimate,
        filterStatus: 'included',
        reason,
        readiness: status,
        profileStage: stage,
        deployed,
        contextValidated,
        stale,
        actions
    };
}

async function loadCandidateEvidence(candidate, hostId, hostUrl, deps) {
    const lookupNames = unique([
        ...modelNameCandidates(candidate.inputModel),
        ...modelNameCandidates(candidate.rawModel),
        ...modelNameCandidates(candidate.adaptedModel)
    ]);

    const [profile, adaptation, contextProfile] = await Promise.all([
        deps.ModelProfile.findOne({ name: { $in: lookupNames } }).select('readiness').lean(),
        deps.ModelAdaptation.findOne({ modelName: { $in: lookupNames }, hostId }).lean(),
        deps.ModelContextProfile.findOne({
            modelName: { $in: lookupNames },
            $or: [{ hostId }, { hostUrl }]
        }).lean()
    ]);

    return { profile, adaptation, contextProfile };
}

function buildPayloads({ host, levels, promptIds, judgeConfig, executionConfig, runName, tags, description, profileDepth, candidates }) {
    const readyModels = candidates
        .filter(c => c.filterStatus === 'included' && c.readiness === 'ready' && c.onHost.adapted)
        .map(c => c.adaptedModel);

    const profileModels = unique(candidates
        .filter(c => c.filterStatus === 'included')
        .flatMap(c => c.actions.filter(a => a.type === 'profile').map(a => a.model)));

    const payloads = {
        profileQueue: profileModels.length ? {
            hostId: host.hostId,
            depth: profileDepth,
            skipRecentDays: 0,
            includeAdapted: true,
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
    };

    return { readyModels, payloads };
}

async function buildSweepPlan(input = {}, deps = {}) {
    const services = {
        checkHost,
        hostProfileService,
        ModelAdaptation,
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
    const hostVramMiB = Number(
        input.vramLimitMiB
        || host.vramMb
        || host.vramMiB
        || host.gpu?.vramTotalMiB
        || 0
    ) || null;
    const maxVramFraction = Number(input.maxVramFraction || 1);
    const levels = Array.isArray(input.levels) && input.levels.length ? input.levels.map(Number) : [1, 2, 3];
    const promptIds = Array.isArray(input.prompt_ids) ? input.prompt_ids.map(String) : null;
    // Standard includes the context probe required by the immutable campaign
    // contract. Quick profiling cannot make a candidate benchmark-ready.
    const profileDepth = input.profileDepth || 'standard';
    const requestedNumCtx = Number(
        input.execution_config?.force_num_ctx || input.execution_config?.num_ctx || 0
    ) || null;

    const resolvedCandidates = candidatesInput.map(resolveCandidate);
    const candidates = [];
    for (const candidate of resolvedCandidates) {
        const evidence = await loadCandidateEvidence(candidate, host.hostId, host.hostUrl, services);
        candidates.push(classifyCandidate({
            candidate,
            inventory,
            hostId: host.hostId,
            hostVramMiB,
            maxVramFraction,
            profile: evidence.profile,
            adaptation: evidence.adaptation,
            contextProfile: evidence.contextProfile,
            requestedNumCtx
        }));
    }

    const { readyModels, payloads } = buildPayloads({
        host,
        levels,
        promptIds,
        judgeConfig: input.judge_config || null,
        executionConfig: input.execution_config || null,
        runName: input.run_name || null,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : null,
        description: input.description || null,
        profileDepth,
        candidates
    });

    return {
        host: {
            hostId: host.hostId,
            hostUrl: host.hostUrl,
            displayName: host.displayName || host.name || host.hostId,
            vramMiB: hostVramMiB
        },
        lane: input.lane || null,
        levels,
        prompt_ids: promptIds,
        profileDepth,
        inventoryCount: inventory.size,
        candidates,
        summary: {
            total: candidates.length,
            ready: candidates.filter(c => c.readiness === 'ready').length,
            needsProfile: candidates.filter(c => c.readiness === 'needs_profile' || c.readiness === 'stale_profile').length,
            needsAdaptation: candidates.filter(c => c.readiness === 'needs_adaptation').length,
            notOnHost: candidates.filter(c => c.readiness === 'not_on_host').length,
            droppedVram: candidates.filter(c => c.readiness === 'filtered_vram').length,
            analyticalUnlikelyFit: candidates.filter(c => c.estimate && c.estimate.bestFittingQuant === null).length,
            benchmarkReadyModels: readyModels.length
        },
        payloads
    };
}

module.exports = {
    buildSweepPlan,
    _internal: {
        classifyCandidate,
        resolveCandidate,
        buildPayloads,
        estimateCandidateFit
    }
};
