'use strict';

const crypto = require('crypto');
const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { getFetchOptions } = require('../../helpers/httpAgent');
const { benchmarkFetch } = require('./http');
const { getModelDigest } = require('./modelDigestService');
const { normalizeModelTag } = require('../../../../shared/modelNames');

const CORE_URL = process.env.CORE_URL || 'http://localhost:3080';
const CAMPAIGN_SCHEMA_VERSION = 1;
const CONTRACT_VERSION = 'agentx.inference-contract.v1';
const MIN_FROZEN_INPUT_TOKENS = 2048;
const MODES = Object.freeze({
    FINAL_ONLY: 'final_only',
    NATIVE: 'native',
    EXPLICIT_THINKING: 'explicit_thinking',
    PROFILE_AUTO: 'profile_auto'
});

function stableSerialize(value) {
    if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
    if (value && typeof value === 'object') {
        return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
    }
    return value === undefined ? 'null' : JSON.stringify(value);
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function candidateKey(host, model) {
    return fingerprint({ host: String(host || '').replace(/\/+$/, ''), model: String(model || '') });
}

function normalizeResponseMode(config = {}) {
    const raw = String(config.response_mode || '').trim().toLowerCase();
    if (['final_only', 'final-only', 'off'].includes(raw)) return MODES.FINAL_ONLY;
    if (['native', 'default', 'native_default'].includes(raw)) return MODES.NATIVE;
    if (['explicit_thinking', 'explicit-thinking', 'thinking', 'on'].includes(raw)) return MODES.EXPLICIT_THINKING;
    if (['profile_auto', 'profile-auto', 'auto'].includes(raw)) return MODES.PROFILE_AUTO;
    if (config.think === true) return MODES.EXPLICIT_THINKING;
    if (config.think === false) return MODES.FINAL_ONLY;
    return MODES.PROFILE_AUTO;
}

function resolveFrozenMode(contract, config = {}) {
    const name = normalizeResponseMode(config);
    const thinking = contract?.capabilities?.thinking || {};
    const thinkingQualified = contract?.qualification?.qualified === true
        && thinking.supported === true
        && Array.isArray(thinking.modes)
        && thinking.modes.includes('on')
        && thinking.visibleFinalAnswer?.qualified === true;

    if (name === MODES.FINAL_ONLY) {
        return { name, think: false, sendThink: true, rankable: true, source: 'explicit' };
    }
    if (name === MODES.NATIVE) {
        return { name, think: null, sendThink: false, rankable: true, source: 'explicit' };
    }
    if (name === MODES.EXPLICIT_THINKING) {
        return {
            name,
            think: true,
            sendThink: true,
            rankable: thinkingQualified,
            source: 'explicit',
            reason: thinkingQualified
                ? 'deployed artifact/host profile qualifies thinking with a visible final answer'
                : 'explicit thinking is diagnostic because the artifact/host thinking contract is unqualified'
        };
    }

    const policy = thinking.recommendedPolicy || 'unknown';
    const enabled = thinkingQualified && ['on', 'metered'].includes(policy);
    return {
        name,
        think: enabled,
        sendThink: true,
        rankable: false,
        source: 'contract_profile',
        reason: `profiling-only auto mode froze recommendedPolicy=${policy} to think=${enabled}`
    };
}

function buildResolutionRequest(model, host, executionConfig = {}) {
    const options = {};
    if (Number.isFinite(executionConfig.force_num_ctx) && executionConfig.force_num_ctx > 0) {
        options.num_ctx = Math.round(executionConfig.force_num_ctx);
    }
    if (executionConfig.response_max_tokens_source === 'caller'
        && Number.isFinite(executionConfig.response_max_tokens)
        && executionConfig.response_max_tokens > 0) {
        options.num_predict = Math.round(executionConfig.response_max_tokens);
    }
    return { model, host, options };
}

function validateSnapshot(snapshot, requested) {
    if (!snapshot || snapshot.version !== CONTRACT_VERSION) {
        throw new Error(`Core returned an unsupported inference contract for ${requested.model} on ${requested.host}`);
    }
    if (!/^[a-f0-9]{64}$/.test(String(snapshot.snapshot?.fingerprint || ''))) {
        throw new Error(`Core returned an invalid inference contract fingerprint for ${requested.model} on ${requested.host}`);
    }
    if (!snapshot.artifact?.digest
        || !snapshot.artifact?.runtimeFingerprint
        || snapshot.artifact?.identityQualified !== true
        || snapshot.artifact?.registryQualified !== true
        || snapshot.qualification?.qualified !== true
        || snapshot.qualification?.exactArtifact !== true) {
        throw new Error(`Cannot freeze ${requested.model} on ${requested.host}: deployed artifact digest is unresolved`);
    }
    const requestedHost = String(requested.host || '').replace(/\/+$/, '').toLowerCase();
    const returnedHost = String(snapshot.artifact?.host || '').replace(/\/+$/, '').toLowerCase();
    if (normalizeModelTag(snapshot.artifact?.model).toLowerCase() !== normalizeModelTag(requested.model).toLowerCase()
        || returnedHost !== requestedHost) {
        throw new Error(`Core returned a contract for a different artifact or host than ${requested.model} on ${requested.host}`);
    }
    const windowTokens = Number(snapshot.contextBudget?.windowTokens);
    const outputTokens = Number(snapshot.contextBudget?.output?.reservedTokens);
    const validatedWindowTokens = Number(snapshot.contextBudget?.validatedWindowTokens);
    if (!Number.isInteger(windowTokens) || windowTokens <= 0
        || !Number.isInteger(outputTokens) || outputTokens <= 0
        || (windowTokens - outputTokens) < MIN_FROZEN_INPUT_TOKENS) {
        throw new Error(`Inference contract for ${requested.model} leaves no safe input budget (${windowTokens} ctx, ${outputTokens} output)`);
    }
    if (!Number.isInteger(validatedWindowTokens) || validatedWindowTokens <= 0
        || windowTokens > validatedWindowTokens) {
        throw new Error(
            `Cannot freeze ${requested.model} on ${requested.host}: context ${windowTokens} is not within a validated host/artifact window`
        );
    }
}

async function fetchSnapshot(request, deps = {}) {
    const coreUrl = deps.coreUrl || CORE_URL;
    const fetchImpl = deps.fetchImpl || benchmarkFetch;
    const url = `${coreUrl}/api/inference/contract/resolve`;
    const response = await fetchImpl(url, getFetchOptions(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request)
    }));
    const payload = await response.json();
    if (!response.ok) {
        throw new Error(payload?.message || payload?.error || `Core contract resolution failed with HTTP ${response.status}`);
    }
    validateSnapshot(payload, request);
    return payload;
}

function buildCandidate(snapshot, request, executionConfig) {
    const mode = resolveFrozenMode(snapshot, executionConfig);
    return {
        key: candidateKey(request.host, request.model),
        model: request.model,
        host: request.host,
        artifactDigest: snapshot.artifact.digest,
        contractFingerprint: snapshot.snapshot.fingerprint,
        mode,
        execution: {
            num_ctx: snapshot.contextBudget.windowTokens,
            num_ctx_source: `inference_contract:${snapshot.contextBudget.source}`,
            num_predict: snapshot.contextBudget.output.reservedTokens,
            sampling: {
                profile: executionConfig.sampling_profile || 'controlled',
                source: executionConfig.sampling_source || 'controlled_override',
                temperature: executionConfig.temperature ?? null,
                top_p: executionConfig.top_p ?? null,
                top_k: executionConfig.top_k ?? null,
                repeat_penalty: executionConfig.repeat_penalty ?? null,
                seed: executionConfig.seed ?? null
            }
        },
        contract: snapshot
    };
}

function campaignRequest(hostGroups, executionConfig) {
    const candidates = [];
    for (const [host, models] of hostGroups) {
        for (const model of models) {
            candidates.push(buildResolutionRequest(model, host, executionConfig));
        }
    }
    return {
        schemaVersion: CAMPAIGN_SCHEMA_VERSION,
        responseMode: normalizeResponseMode(executionConfig),
        fixedSettings: {
            sampling_profile: executionConfig.sampling_profile || 'controlled',
            sampling_source: executionConfig.sampling_source || 'controlled_override',
            temperature: executionConfig.temperature ?? null,
            top_p: executionConfig.top_p ?? null,
            top_k: executionConfig.top_k ?? null,
            repeat_penalty: executionConfig.repeat_penalty ?? null,
            seed: executionConfig.seed ?? null,
            api_mode: executionConfig.api_mode || 'chat',
            repeats: Number(executionConfig.repeats) || 1,
            answer_contract_mode: executionConfig.answer_contract_mode || 'auto',
            include_length_hint: executionConfig.include_length_hint === true,
            thinking_final_answer_policy: executionConfig.thinking_final_answer_policy || 'visible_required'
        },
        candidates
    };
}

function validatePersistedCampaign(campaign, requestFingerprint) {
    if (!campaign || campaign.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) return false;
    if (campaign.requestFingerprint !== requestFingerprint) {
        throw new Error('Persisted inference contract campaign does not match the requested model/host matrix or execution mode');
    }
    for (const candidate of campaign.candidates || []) {
        validateSnapshot(candidate.contract, candidate);
        if (candidate.contractFingerprint !== candidate.contract.snapshot.fingerprint) {
            throw new Error(`Persisted inference contract fingerprint mismatch for ${candidate.model} on ${candidate.host}`);
        }
    }
    return true;
}

/**
 * Lightweight validation of a persisted campaign for resume. Only checks
 * campaign-level metadata; individual candidate contracts are validated
 * lazily during model execution (assertFrozenArtifactDigest and
 * getFrozenModelExecutionConfig already verify per-model).
 *
 * Throws a closed, actionable error if the snapshot is missing or
 * incompatible so that resume fails fast rather than silently reloading
 * the full roster.
 */
function validateCampaignMetadata(campaign, requestFingerprint) {
    if (!campaign || campaign.schemaVersion !== CAMPAIGN_SCHEMA_VERSION) {
        const reason = !campaign
            ? 'missing frozen campaign snapshot'
            : `incompatible campaign schema version (expected ${CAMPAIGN_SCHEMA_VERSION}, got ${campaign.schemaVersion})`;
        const err = new Error(`Resume blocked: ${reason}. A full restart is required.`);
        err.resumeBlocked = true;
        err.code = 'MISSING_OR_INCOMPATIBLE_CAMPAIGN';
        throw err;
    }
    if (campaign.requestFingerprint !== requestFingerprint) {
        const err = new Error(
            'Resume blocked: frozen campaign snapshot does not match the current ' +
            'model/host matrix or execution mode (fingerprint mismatch). A full restart is required.'
        );
        err.resumeBlocked = true;
        err.code = 'CAMPAIGN_FINGERPRINT_MISMATCH';
        throw err;
    }
    if (!Array.isArray(campaign.candidates) || campaign.candidates.length === 0) {
        const err = new Error('Resume blocked: frozen campaign has no candidate contracts. A full restart is required.');
        err.resumeBlocked = true;
        err.code = 'EMPTY_CAMPAIGN';
        throw err;
    }
    return true;
}

async function readPersistedCampaign(batchId, BatchModel = BenchmarkBatch) {
    const query = BatchModel.findById(batchId);
    if (!query || typeof query.select !== 'function') return null;
    return query.select('inference_contract_campaign').lean();
}

async function loadOrResolveCampaignInferenceContracts({
    batchId,
    hostGroups,
    executionConfig,
    recordBatchTimelineEvent
}, deps = {}) {
    const BatchModel = deps.BatchModel || BenchmarkBatch;
    const request = campaignRequest(hostGroups, executionConfig);
    const requestFingerprint = fingerprint(request);
    const existingDoc = await readPersistedCampaign(batchId, BatchModel);
    if (validatePersistedCampaign(existingDoc?.inference_contract_campaign, requestFingerprint)) {
        return existingDoc.inference_contract_campaign;
    }

    const campaign = await resolveStandaloneCampaignInferenceContracts({
        hostGroups,
        executionConfig
    }, deps);

    const update = await BatchModel.updateOne(
        {
            _id: batchId,
            $or: [
                { inference_contract_campaign: { $exists: false } },
                { inference_contract_campaign: null }
            ]
        },
        { $set: { inference_contract_campaign: campaign, last_activity_at: new Date() } }
    );
    if (update?.matchedCount === 0) {
        const racedDoc = await readPersistedCampaign(batchId, BatchModel);
        if (!validatePersistedCampaign(racedDoc?.inference_contract_campaign, requestFingerprint)) {
            throw new Error('A concurrent runner persisted an incompatible inference contract campaign');
        }
        return racedDoc.inference_contract_campaign;
    }

    if (typeof recordBatchTimelineEvent === 'function') {
        await recordBatchTimelineEvent('inference_contract_frozen', {
            success: true,
            response_mode: campaign.responseMode,
            rankable: campaign.rankable,
            request_fingerprint: requestFingerprint,
            contracts: campaign.candidates.map(candidate => ({
                model: candidate.model,
                host: candidate.host,
                artifact_digest: candidate.artifactDigest,
                contract_fingerprint: candidate.contractFingerprint,
                rankable: candidate.mode.rankable
            }))
        });
    }
    return campaign;
}

/**
 * Resume a frozen campaign snapshot for checkpoint resume.
 *
 * On resume the campaign MUST already exist and be compatible. We never
 * re-resolve the full roster here — that would be an unnecessary reload.
 * Per-model artifact-drift and contract validity are checked lazily in
 * runModelPromptLoop via assertFrozenArtifactDigest and
 * getFrozenModelExecutionConfig.
 *
 * @returns {Promise<Object>} The frozen campaign
 * @throws {Error} With `err.resumeBlocked = true` if the snapshot is missing
 *                 or incompatible, so the caller can persist the reason and
 *                 fail closed.
 */
async function loadOrResumeCampaignInferenceContracts({
    batchId,
    hostGroups,
    executionConfig
}, deps = {}) {
    const BatchModel = deps.BatchModel || BenchmarkBatch;
    const request = campaignRequest(hostGroups, executionConfig);
    const requestFingerprint = fingerprint(request);
    const existingDoc = await readPersistedCampaign(batchId, BatchModel);
    const campaign = existingDoc?.inference_contract_campaign;

    validateCampaignMetadata(campaign, requestFingerprint);

    return campaign;
}

/**
 * Resolve a complete campaign contract without Mongo persistence. This is for
 * benchmark-owned executable qualification runners that persist their own
 * immutable report directory instead of a BenchmarkBatch document. Resolution
 * still happens exactly once before attempt one; callers must reuse the returned
 * object for the whole matrix.
 */
async function resolveStandaloneCampaignInferenceContracts({
    hostGroups,
    executionConfig
}, deps = {}) {
    const request = campaignRequest(hostGroups, executionConfig);
    const requestFingerprint = fingerprint(request);
    const candidates = [];
    for (const candidateRequest of request.candidates) {
        const snapshot = await fetchSnapshot(candidateRequest, deps);
        candidates.push(buildCandidate(snapshot, candidateRequest, executionConfig));
    }
    return {
        schemaVersion: CAMPAIGN_SCHEMA_VERSION,
        requestFingerprint,
        responseMode: request.responseMode,
        fixedSettings: request.fixedSettings,
        rankable: candidates.every(candidate => candidate.mode.rankable === true),
        resolvedAt: new Date().toISOString(),
        candidates
    };
}

function getFrozenModelExecutionConfig(campaign, model, host, baseConfig = {}) {
    const key = candidateKey(host, model);
    const candidate = campaign?.candidates?.find(entry => entry.key === key);
    if (!candidate) throw new Error(`No frozen inference contract for ${model} on ${host}`);
    const fixed = campaign.fixedSettings || {};
    return {
        ...baseConfig,
        response_max_tokens: candidate.execution.num_predict,
        num_ctx: candidate.execution.num_ctx,
        num_ctx_source: candidate.execution.num_ctx_source,
        think: candidate.mode.think,
        send_think: candidate.mode.sendThink,
        think_mode: candidate.mode.name,
        think_resolved_by: candidate.mode.source,
        thinking_policy_reason: candidate.mode.reason || null,
        rankable_mode: candidate.mode.rankable,
        inference_contract_fingerprint: candidate.contractFingerprint,
        inference_contract_request_fingerprint: campaign.requestFingerprint,
        artifact_digest: candidate.artifactDigest,
        sampling_profile: candidate.execution.sampling.profile || fixed.sampling_profile || 'controlled',
        sampling_source: candidate.execution.sampling.source || fixed.sampling_source || 'controlled_override',
        temperature: candidate.execution.sampling.temperature,
        top_p: candidate.execution.sampling.top_p,
        top_k: candidate.execution.sampling.top_k,
        repeat_penalty: candidate.execution.sampling.repeat_penalty,
        seed: candidate.execution.sampling.seed,
        api_mode: fixed.api_mode || baseConfig.api_mode,
        repeats: fixed.repeats || baseConfig.repeats,
        answer_contract_mode: fixed.answer_contract_mode || baseConfig.answer_contract_mode,
        include_length_hint: fixed.include_length_hint === true,
        thinking_final_answer_policy: fixed.thinking_final_answer_policy || baseConfig.thinking_final_answer_policy
    };
}

async function assertFrozenArtifactDigest(campaign, model, host, deps = {}) {
    const key = candidateKey(host, model);
    const candidate = campaign?.candidates?.find(entry => entry.key === key);
    if (!candidate) throw new Error(`No frozen inference contract for ${model} on ${host}`);
    const digestResolver = deps.getModelDigest || getModelDigest;
    const currentDigest = await digestResolver(host, model);
    if (!currentDigest) {
        throw new Error(`Cannot verify deployed artifact digest for ${model} on ${host} before execution`);
    }
    if (currentDigest !== candidate.artifactDigest) {
        throw new Error(
            `Deployed artifact changed after campaign freeze for ${model} on ${host}: `
            + `${candidate.artifactDigest} -> ${currentDigest}`
        );
    }
    return candidate.artifactDigest;
}

module.exports = {
    CAMPAIGN_SCHEMA_VERSION,
    MIN_FROZEN_INPUT_TOKENS,
    MODES,
    assertFrozenArtifactDigest,
    buildResolutionRequest,
    candidateKey,
    getFrozenModelExecutionConfig,
    loadOrResolveCampaignInferenceContracts,
    loadOrResumeCampaignInferenceContracts,
    normalizeResponseMode,
    resolveStandaloneCampaignInferenceContracts,
    resolveFrozenMode,
    validateSnapshot,
    validateCampaignMetadata
};
