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

const router = express.Router();

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
 * Validate and compare receipts produced by separately operated workers.
 * This endpoint executes no harness/provider call, stores no transcript, and
 * never promotes a candidate or mutates routing.
 */
router.post('/worker-evidence/compare', (req, res) => respond(res, () => compareWorkerEvidence(req.body || {})));

module.exports = router;
