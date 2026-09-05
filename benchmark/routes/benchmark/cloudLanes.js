'use strict';

const express = require('express');
const logger = require('../../config/logger');
const {
    attributeProviderCall,
    buildCampaignPlan,
    checkPaidApproval,
    compareLaneObservations
} = require('../../src/services/benchmark/cloudLaneAccounting');
const {
    compareWorkerEvidence
} = require('../../src/services/benchmark/workerEvidenceComparison');
const {
    createSpendGrant,
    executeHarnessTarget,
    getHarnessTargets,
    isHarnessBrokerEnabled,
    resolveHarnessTarget
} = require('../../src/services/benchmark/harnessBrokerClient');
const HarnessCampaign = require('../../models/HarnessCampaign');
const { fingerprint } = require('../../../shared/workerContract');
const {
    acquireBenchmarkClaims,
    releaseBenchmarkClaims,
    startBenchmarkClaimHeartbeat
} = require('../../src/services/benchmark/benchmarkClaimLifecycle');

const router = express.Router();

async function invalidateHarnessAuthority(campaign, error) {
    if (!campaign?._id) return;
    const receipt = await HarnessCampaign.updateOne(
        { _id: campaign._id },
        {
            $set: {
                status: 'pending_reconciliation',
                authority_state: 'pending_reconciliation',
                authority_reconciliation_reason: error?.message || 'Harness authority could not be verified',
                failure: {
                    code: error?.code || 'WORKLOAD_ADMISSION_LOST',
                    classification: 'coordination_error'
                },
                completed_at: new Date()
            },
            $unset: {
                envelope: '',
                receipt: '',
                output_fingerprint: '',
                usage: '',
                cost: ''
            }
        },
        { upsert: true }
    );
    if (Number(receipt?.matchedCount) === 0 && Number(receipt?.upsertedCount) !== 1) {
        const invalidationError = new Error(`Harness campaign ${campaign._id} was not found for invalidation`);
        invalidationError.code = 'HARNESS_AUTHORITY_INVALIDATION_MISSING';
        throw invalidationError;
    }
}

/**
 * Optional deployment-owned cloud target catalog. The Product contains no
 * provider endpoint or credential and returns an empty disabled catalog in the
 * standalone profile.
 */
router.get('/targets', async (_req, res) => {
    try {
        const catalog = await getHarnessTargets();
        return res.json({ status: 'success', data: catalog });
    } catch (error) {
        logger.warn('Harness target catalog unavailable', { code: error.code, error: error.message });
        return res.status(Number(error.statusCode) || 503).json({
            status: 'error',
            code: error.code || 'HARNESS_CATALOG_UNAVAILABLE',
            error: error.message,
            data: { enabled: isHarnessBrokerEnabled(), targets: [] }
        });
    }
});

router.get('/harness-campaigns', async (_req, res) => {
    try {
        const campaigns = await HarnessCampaign.find({}).sort({ started_at: -1 }).limit(100).lean();
        for (const campaign of campaigns) {
            if (campaign.status === 'pending_reconciliation'
                || campaign.authority_state === 'pending_reconciliation'
                || campaign.authority_state === 'authority_invalidated') {
                campaign.envelope = null;
                campaign.receipt = null;
                campaign.output_fingerprint = null;
                campaign.usage = null;
                campaign.cost = null;
                campaign.admission_release_receipt = null;
            }
        }
        return res.json({ status: 'success', data: { campaigns } });
    } catch (error) {
        return res.status(500).json({ status: 'error', error: error.message });
    }
});

router.post('/harness-campaigns', async (req, res) => {
    let campaign = null;
    let lifecycleId = null;
    let stopHeartbeat = null;
    let responseStatus = 200;
    let responseBody = null;
    let pendingCompletion = null;
    let retainAdmission = false;
    let campaignTtlMs = null;
    let cancellation = null;
    try {
        if (req.body?.confirmation_no_secrets !== true) {
            return res.status(422).json({
                status: 'error',
                code: 'NATIVE_AGENT_CONFIRMATION_REQUIRED',
                error: 'Confirm that the native-agent prompt contains no credentials, secrets, or private URLs'
            });
        }
        const target = await resolveHarnessTarget(req.body?.target, { force: true });
        if (target.mode !== 'native_agent' || target.capabilities.nativeAgent !== true) {
            return res.status(422).json({
                status: 'error',
                code: 'NATIVE_AGENT_TARGET_REQUIRED',
                error: 'Harness campaigns require a catalog target in native_agent mode'
            });
        }
        const prompt = String(req.body?.prompt || '');
        if (!prompt.trim() || Buffer.byteLength(prompt, 'utf8') > 200_000) {
            return res.status(400).json({ status: 'error', error: 'prompt must contain 1 to 200000 UTF-8 bytes' });
        }
        const nativeBatchFingerprint = fingerprint({
            schema: 'agentx.native-harness-campaign/v1', targetFingerprint: target.fingerprint,
            promptFingerprint: fingerprint(prompt),
            responseMaxTokens: Number(req.body?.execution_config?.response_max_tokens) || 32_000,
            timeoutMs: Number(req.body?.execution_config?.per_test_timeout_ms) || 600_000,
        });
        campaign = new HarnessCampaign({
            target,
            execution_profile: 'native-ceiling',
            batch_contract_fingerprint: nativeBatchFingerprint,
            status: 'running',
            started_at: new Date()
        });
        lifecycleId = `native-harness-${campaign._id}`;
        campaignTtlMs = Math.max(
            120_000,
            (Number(req.body?.execution_config?.per_test_timeout_ms) || 600_000) + 120_000
        );
        await acquireBenchmarkClaims([], lifecycleId, campaignTtlMs, {
            requestId: `native-harness:${campaign._id}`,
            kind: 'native-harness',
            source: 'benchmark'
        });
        cancellation = new AbortController();
        stopHeartbeat = startBenchmarkClaimHeartbeat([], lifecycleId, campaignTtlMs, {
            onFatal: error => cancellation.abort(error)
        });
        await stopHeartbeat.ready;
        stopHeartbeat.assertActive();
        await campaign.save();
        stopHeartbeat.assertActive();
        const spendGrant = await createSpendGrant({
            batchId: campaign._id.toString(),
            batchFingerprint: nativeBatchFingerprint,
            targets: [target],
            promptCount: 1,
            repeats: 1,
            executionConfig: {
                ...(req.body?.execution_config || {}),
                input_token_ceiling: Math.max(1, Math.ceil(Buffer.byteLength(prompt, 'utf8') / 3))
            },
            approval: req.body?.paid_approval || null
        });
        const execution = await executeHarnessTarget({
            batchId: campaign._id.toString(),
            batchFingerprint: nativeBatchFingerprint,
            cellId: `native:${campaign._id}`,
            target,
            promptText: prompt,
            parameters: {
                maxTokens: req.body?.execution_config?.response_max_tokens || 32_000,
                timeoutMs: req.body?.execution_config?.per_test_timeout_ms || 600_000
            },
            spendGrant,
            role: 'candidate',
            signal: cancellation.signal
        });
        stopHeartbeat.assertActive();
        campaign.status = 'pending_reconciliation';
        campaign.authority_state = 'pending_reconciliation';
        campaign.authority_reconciliation_reason = 'awaiting exact workload admission release receipt';
        campaign.envelope = execution.envelope;
        campaign.receipt = execution.publicReceipt;
        campaign.output_fingerprint = execution.outputFingerprint;
        campaign.usage = execution.receipt.usage;
        campaign.cost = {
            estimated: target.pricing?.estimated === true,
            costNanodollars: execution.receipt.usage.costNanodollars,
            pricing: target.pricing,
            observedAt: new Date().toISOString()
        };
        campaign.completed_at = new Date();
        await campaign.save(cancellation.signal ? { signal: cancellation.signal } : undefined);
        stopHeartbeat.assertActive();
        pendingCompletion = { execution };
    } catch (error) {
        // A lost workload lease means another owner may already hold runtime
        // maintenance. Never write a terminal authority result after that
        // fence was lost; TTL/recovery can reconcile the prior running row.
        if (campaign && stopHeartbeat?.getFailure?.()) {
            try {
                await invalidateHarnessAuthority(campaign, stopHeartbeat.getFailure());
            } catch (invalidationError) {
                error.invalidationError = invalidationError;
                error.retainAdmission = true;
                retainAdmission = true;
            }
        } else if (campaign) {
            campaign.status = 'failed';
            campaign.failure = {
                code: error.code || 'HARNESS_EXECUTION_FAILED',
                classification: error.failureClassification || 'infrastructure_error'
            };
            campaign.completed_at = new Date();
            try {
                await campaign.save(stopHeartbeat ? { signal: cancellation?.signal } : undefined);
            } catch (persistenceError) {
                error.persistenceError = persistenceError;
                error.retainAdmission = true;
                retainAdmission = true;
            }
            try {
                stopHeartbeat?.assertActive?.();
            } catch (authorityError) {
                try {
                    await invalidateHarnessAuthority(campaign, authorityError);
                } catch (invalidationError) {
                    error.invalidationError = invalidationError;
                    error.retainAdmission = true;
                    retainAdmission = true;
                }
            }
        }
        responseStatus = Number(error.statusCode) || 500;
        responseBody = {
            status: 'error', code: error.code || 'HARNESS_EXECUTION_FAILED', error: error.message
        };
    } finally {
        if (retainAdmission && stopHeartbeat) {
            const holdMs = Math.min(Number(campaignTtlMs) || 300_000, 300_000);
            const timer = setTimeout(() => {
                stopHeartbeat.drain().catch(error => logger.error('Retained harness heartbeat drain failed', {
                    lifecycleId,
                    error: error.message
                }));
            }, holdMs);
            timer.unref?.();
        } else if (stopHeartbeat) {
            try {
                await stopHeartbeat.drain();
            } catch (drainError) {
                retainAdmission = true;
                responseStatus = 503;
                responseBody = {
                    status: 'error', code: 'WORKLOAD_ADMISSION_DRAIN_UNVERIFIED', error: drainError.message
                };
            }
        }
        if (lifecycleId && !retainAdmission) {
            let release = null;
            try {
                release = await releaseBenchmarkClaims([], lifecycleId);
            } catch (error) {
                release = { failed: 1, workloadAdmission: { released: false, reason: error.message } };
            }
            if (release?.failed !== 0 || release?.workloadAdmission?.released !== true) {
                const releaseError = new Error(release?.workloadAdmission?.reason || 'Workload admission release was not verified');
                releaseError.code = 'WORKLOAD_ADMISSION_RELEASE_UNVERIFIED';
                if (campaign) {
                    try {
                        await invalidateHarnessAuthority(campaign, releaseError);
                    } catch (invalidationError) {
                        releaseError.invalidationError = invalidationError;
                        logger.error('Harness authority invalidation failed after admission release failure', {
                            campaignId: String(campaign._id),
                            error: invalidationError.message
                        });
                        retainAdmission = true;
                    }
                }
                responseStatus = 503;
                responseBody = {
                    status: 'error',
                    code: releaseError.code,
                    error: releaseError.message
                };
            } else if (pendingCompletion && campaign) {
                campaign.status = 'completed';
                campaign.authority_state = 'authoritative';
                campaign.authority_reconciliation_reason = null;
                campaign.admission_release_receipt = release.workloadAdmission;
                campaign.completed_at = new Date();
                try {
                    await campaign.save();
                } catch (publicationError) {
                    responseStatus = 503;
                    responseBody = {
                        status: 'error',
                        code: 'HARNESS_AUTHORITY_PUBLICATION_FAILED',
                        error: publicationError.message
                    };
                }
                if (responseStatus !== 503) {
                    responseStatus = 200;
                    responseBody = {
                        status: 'success',
                        data: { campaign: campaign.toObject(), output: pendingCompletion.execution.output }
                    };
                }
            }
        }
    }
    return res.status(responseStatus).json(responseBody || {
        status: 'error', code: 'HARNESS_EXECUTION_FAILED', error: 'Harness campaign produced no terminal result'
    });
});

function respond(res, operation) {
    try {
        return res.json({ status: 'success', data: operation() });
    } catch (error) {
        const statusCode = Number(error.statusCode) || 400;
        if (statusCode >= 500) {
            logger.error('Cloud/local lane contract failed', { error: error.message, code: error.code });
        }
        return res.status(statusCode).json({
            status: 'error',
            code: error.code || 'CLOUD_LANE_CONTRACT_INVALID',
            error: error.message
        });
    }
}

/**
 * Pure planning endpoint. It performs no provider call, persists nothing, and
 * never authorizes network execution or routing mutation.
 */
router.post('/cloud-lanes/plan', (req, res) => respond(res, () => buildCampaignPlan(req.body || {})));

/**
 * Validates an immutable paid-campaign declaration against a plan. This is
 * deliberately not an execution token: a future runner must still authenticate
 * the operator at its own mutation/network boundary.
 */
router.post('/cloud-lanes/approval-check', (req, res) => respond(res, () => (
    checkPaidApproval(req.body?.plan, req.body?.approval)
)));

/** Attribute one already-observed provider call using integer nanodollars. */
router.post('/cloud-lanes/attribute', (req, res) => respond(res, () => attributeProviderCall(req.body || {})));

/**
 * Compare normalized observations only when their lane contract matches.
 * Cohorts stay separate and the result can never mutate routing.
 */
router.post('/cloud-lanes/compare', (req, res) => respond(res, () => compareLaneObservations(req.body || {})));

/**
 * Validate and compare envelope-bound receipts produced by separately operated
 * workers. This route performs no execution, persistence, promotion, or routing
 * mutation.
 */
router.post('/worker-evidence/compare', (req, res) => respond(res, () => compareWorkerEvidence(req.body || {})));

module.exports = router;
