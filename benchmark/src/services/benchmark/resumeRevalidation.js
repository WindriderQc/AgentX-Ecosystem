'use strict';

const BenchmarkBatch = require('../../../models/BenchmarkBatch');
const { getBenchmarkClaims } = require('../../clients/coreApiClient');
const {
    assertFrozenArtifactDigest,
    getFrozenModelExecutionConfig,
    loadOrResumeCampaignInferenceContracts
} = require('./inferenceContractSnapshot');

const RESUME_CODES = Object.freeze({
    ARTIFACT_DRIFT: 'ARTIFACT_DRIFT',
    CLAIM_ACQUISITION_FAILED: 'CLAIM_ACQUISITION_FAILED',
    CLAIM_STATE_UNAVAILABLE: 'CLAIM_STATE_UNAVAILABLE',
    FROZEN_MODEL_CONTRACT_INVALID: 'FROZEN_MODEL_CONTRACT_INVALID',
    MISSING_FROZEN_CAMPAIGN: 'MISSING_FROZEN_CAMPAIGN',
    PIN_DETECTION_FAILED: 'PIN_DETECTION_FAILED',
    PIN_RELEASE_FAILED: 'PIN_RELEASE_FAILED',
    RESUME_DECISION_PERSISTENCE_FAILED: 'RESUME_DECISION_PERSISTENCE_FAILED',
    STALE_HOST_CLAIM: 'STALE_HOST_CLAIM'
});

function normalizeHost(host) {
    return String(host || '').replace(/\/+$/, '').toLowerCase();
}

function repeatCount(config = {}) {
    return Math.max(1, Math.min(5, Number(config.repeats) || 1));
}

function pairKey(model, prompt, repeatIndex) {
    const base = `${model}::${prompt.name}`;
    return repeatIndex === 0 ? base : `${base}::r${repeatIndex}`;
}

function hasPendingPairs(model, prompts, completedPairs, config) {
    for (const prompt of prompts) {
        for (let repeatIndex = 0; repeatIndex < repeatCount(config); repeatIndex += 1) {
            if (!completedPairs.has(pairKey(model, prompt, repeatIndex))) return true;
        }
    }
    return false;
}

function asResumeBlocked(error, fallbackCode, context = {}) {
    const source = error instanceof Error ? error : new Error(String(error));
    const blocked = new Error(source.message);
    blocked.name = source.name;
    blocked.stack = source.stack;
    blocked.code = source.code || fallbackCode;
    blocked.resumeBlocked = true;
    blocked.reloadRequired = true;
    blocked.resumeContext = context;
    return blocked;
}

function createResumeRevalidation({
    batchId,
    completedPairs,
    lastCheckpointModel,
    recordBatchTimelineEvent
}, deps = {}) {
    const BatchModel = deps.BatchModel || BenchmarkBatch;
    const getClaims = deps.getBenchmarkClaims || getBenchmarkClaims;
    const loadCampaign = deps.loadCampaign || loadOrResumeCampaignInferenceContracts;
    const getExecutionConfig = deps.getExecutionConfig || getFrozenModelExecutionConfig;
    const assertArtifactDigest = deps.assertArtifactDigest || assertFrozenArtifactDigest;
    const completed = completedPairs instanceof Set ? completedPairs : new Set(completedPairs || []);

    async function persistBlocked(error, context = {}) {
        const blockedAt = new Date();
        const details = {
            success: false,
            code: error.code,
            reason: error.message,
            reload_required: true,
            last_checkpoint_model: lastCheckpointModel || null,
            model: context.model || null,
            host: context.host || null,
            blocked_at: blockedAt.toISOString()
        };
        const writes = [
            BatchModel.updateOne(
                { _id: batchId },
                {
                    $set: {
                        'checkpoint.resume_decision': 'blocked',
                        'checkpoint.resume_model': context.model || lastCheckpointModel || null,
                        'checkpoint.reload_required': true,
                        'checkpoint.resume_blocked': {
                            code: error.code,
                            reason: error.message,
                            host: context.host || null,
                            at: blockedAt
                        },
                        last_activity_at: blockedAt
                    }
                }
            )
        ];
        if (typeof recordBatchTimelineEvent === 'function') {
            writes.push(recordBatchTimelineEvent('inference_contract_resume_blocked', details));
        }
        const results = await Promise.allSettled(writes);
        if (results.every(result => result.status === 'rejected')) {
            const persistenceError = new Error(
                `Resume blocked but its reason could not be persisted: ${error.message}`
            );
            persistenceError.code = RESUME_CODES.RESUME_DECISION_PERSISTENCE_FAILED;
            persistenceError.resumeBlocked = true;
            persistenceError.reloadRequired = true;
            throw persistenceError;
        }
    }

    async function fail(error, fallbackCode, context = {}) {
        const blocked = asResumeBlocked(error, fallbackCode, context);
        await persistBlocked(blocked, context);
        throw blocked;
    }

    async function guard(operation, fallbackCode, context = {}) {
        try {
            return await operation();
        } catch (error) {
            return fail(error, fallbackCode, context);
        }
    }

    async function loadFrozenCampaign({ hostGroups, executionConfig }) {
        return guard(
            () => loadCampaign({ batchId, hostGroups, executionConfig }),
            RESUME_CODES.MISSING_FROZEN_CAMPAIGN
        );
    }

    async function selectPendingHostGroups(campaign, hostGroups, prompts, executionConfig) {
        const pendingGroups = [];
        for (const [host, models] of hostGroups) {
            const pendingModels = [];
            for (const model of models) {
                const config = await guard(
                    () => Promise.resolve(getExecutionConfig(campaign, model, host, executionConfig)),
                    RESUME_CODES.FROZEN_MODEL_CONTRACT_INVALID,
                    { model, host }
                );
                if (hasPendingPairs(model, prompts, completed, config)) pendingModels.push(model);
            }
            if (pendingModels.length > 0) pendingGroups.push([host, pendingModels]);
        }
        return pendingGroups;
    }

    async function recordReady(pendingHostGroups) {
        const firstHost = pendingHostGroups[0]?.[0] || null;
        const firstModel = pendingHostGroups[0]?.[1]?.[0] || null;
        const validatedAt = new Date();
        await guard(
            async () => {
                await BatchModel.updateOne(
                    { _id: batchId },
                    {
                        $set: {
                            'checkpoint.resume_decision': 'reuse_frozen_snapshot',
                            'checkpoint.resume_model': firstModel,
                            'checkpoint.reload_required': false,
                            'checkpoint.resume_validated_at': validatedAt,
                            last_activity_at: validatedAt
                        },
                        $unset: { 'checkpoint.resume_blocked': '' }
                    }
                );
                if (typeof recordBatchTimelineEvent === 'function') {
                    await recordBatchTimelineEvent('inference_contract_resumed', {
                        success: true,
                        code: 'FROZEN_CAMPAIGN_REUSED',
                        resume_decision: 'reuse_frozen_snapshot',
                        reload_required: false,
                        last_checkpoint_model: lastCheckpointModel || null,
                        model: firstModel,
                        host: firstHost,
                        pending_model_count: pendingHostGroups.reduce(
                            (count, [, models]) => count + models.length,
                            0
                        ),
                        completed_pairs_count: completed.size,
                        resumed_at: validatedAt.toISOString()
                    });
                }
            },
            RESUME_CODES.RESUME_DECISION_PERSISTENCE_FAILED,
            { model: firstModel, host: firstHost }
        );
    }

    async function validateModel(campaign, model, host, executionConfig) {
        const activeClaims = await guard(
            () => getClaims(),
            RESUME_CODES.CLAIM_STATE_UNAVAILABLE,
            { model, host }
        );
        const hostClaim = activeClaims.find(claim =>
            normalizeHost(claim.hostUrl || claim.host) === normalizeHost(host)
            && String(claim.batchId) === String(batchId)
        );
        if (!hostClaim) {
            await fail(
                new Error(
                    `Resume blocked: host claim lost for ${model} on ${host}. `
                    + 'The claim may have expired or been stolen.'
                ),
                RESUME_CODES.STALE_HOST_CLAIM,
                { model, host }
            );
        }
        const config = await guard(
            () => Promise.resolve(getExecutionConfig(campaign, model, host, executionConfig)),
            RESUME_CODES.FROZEN_MODEL_CONTRACT_INVALID,
            { model, host }
        );
        await guard(
            () => assertArtifactDigest(campaign, model, host),
            RESUME_CODES.ARTIFACT_DRIFT,
            { model, host }
        );
        return config;
    }

    return {
        fail,
        loadFrozenCampaign,
        recordReady,
        selectPendingHostGroups,
        validateModel
    };
}

module.exports = {
    RESUME_CODES,
    asResumeBlocked,
    createResumeRevalidation,
    hasPendingPairs
};
