// /api/memory-review — Ecosystem Memory Review with bounded standing policy.
//
// Mounted in src/app.js with a dedicated 1mb JSON parser: observation batches
// are bounded by policy, and raw transcript payloads are refused at the
// validation layer. Safe reversible writes may be policy-authorized; exception
// review remains candidate-by-candidate and there is no bulk-approve endpoint.

const express = require('express');

const router = express.Router();
const service = require('../src/services/memoryReview/memoryReviewService');
const insightsService = require('../src/services/memoryReview/insightsService');
const applyService = require('../src/services/memoryReview/applyService');
const policy = require('../src/services/memoryReview/policy');
const {
  operatorRequestIdentity,
  requireOperatorUiAccess,
} = require('../src/middleware/operatorAccess');
const {
  memoryReviewProducerRequestIdentity,
  requireMemoryReviewProducerAccess,
} = require('../src/middleware/memoryReviewProducerAccess');
const { version: coreVersion } = require('../package.json');

router.use((req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

function fail(res, err, fallbackCode) {
  const status = Number(err.status) || 500;
  res.status(status).json({
    status: 'error',
    message: err.message || 'memory review error',
    code: err.code || fallbackCode || 'MEMORY_REVIEW_ERROR',
  });
}

router.get('/config', requireOperatorUiAccess, (req, res) => {
  res.json({
    status: 'success',
    data: {
      mode: policy.serverMode(),
      automationMode: policy.automationMode(),
      automationPolicyVersion: policy.POLICY_VERSION,
      reviewExceptionBudget: policy.reviewExceptionBudget(),
      schemaVersion: policy.SCHEMA_VERSION,
      coreVersion,
      limits: policy.LIMITS,
      runtimes: policy.RUNTIMES,
      candidateTypes: policy.CANDIDATE_TYPES,
      targetKinds: policy.TARGET_KINDS,
      targetsByType: policy.TARGETS_BY_TYPE,
      scopes: policy.MEMORY_SCOPES,
      sensitivities: policy.SENSITIVITY_LEVELS,
      impacts: policy.IMPACT_LEVELS,
      stabilities: policy.STABILITY_LEVELS,
      applyEnabled: policy.serverMode() === 'apply',
      safeAutomationEnabled: policy.serverMode() === 'apply' && policy.automationMode() === 'safe',
    },
  });
});

router.post('/runs', requireMemoryReviewProducerAccess, async (req, res) => {
  try {
    const run = await service.openRun(req.body || {});
    res.json({ status: 'success', data: { runId: run.runId, status: run.status, mode: run.mode } });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_OPEN_FAILED'); }
});

router.get('/runs', requireOperatorUiAccess, async (req, res) => {
  try {
    const data = await service.listRuns({ limit: req.query.limit, status: req.query.status });
    res.json({ status: 'success', data });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_LIST_FAILED'); }
});

router.get('/digest', requireOperatorUiAccess, async (req, res) => {
  try {
    res.json({ status: 'success', data: await service.buildDigest() });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_DIGEST_FAILED'); }
});

router.get('/insights', requireOperatorUiAccess, async (req, res) => {
  try {
    res.json({ status: 'success', data: await insightsService.buildInsights({ limit: req.query.limit }) });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_INSIGHTS_FAILED'); }
});

router.get('/runs/:runId', requireOperatorUiAccess, async (req, res) => {
  try {
    const data = await service.getRunDetail(req.params.runId, {
      includeObservations: req.query.includeObservations === 'true',
    });
    res.json({ status: 'success', data });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_GET_FAILED'); }
});

router.get('/runs/:runId/audit', requireOperatorUiAccess, async (req, res) => {
  try {
    const run = await service.getRunOrThrow(req.params.runId);
    res.json({ status: 'success', data: { runId: run.runId, audit: run.audit } });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_AUDIT_FAILED'); }
});

router.post('/runs/:runId/observations', requireMemoryReviewProducerAccess, async (req, res) => {
  try {
    const body = req.body || {};
    policy.assertKnownKeys(body, ['collector', 'observations'], 'body');
    const data = await service.submitObservations(
      req.params.runId,
      body.collector,
      body.observations,
      { submittedBy: memoryReviewProducerRequestIdentity(req) }
    );
    res.json({ status: 'success', data });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_OBSERVATIONS_FAILED'); }
});

router.post('/runs/:runId/finalize', requireMemoryReviewProducerAccess, async (req, res) => {
  try {
    const run = await service.finalizeCollection(req.params.runId);
    res.json({ status: 'success', data: { runId: run.runId, status: run.status, summary: run.summary, dedupDegraded: !!run.dedupContext?.degraded } });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_FINALIZE_FAILED'); }
});

router.get('/runs/:runId/synthesis-input', requireMemoryReviewProducerAccess, async (req, res) => {
  try {
    const run = await service.getRunOrThrow(req.params.runId);
    res.json({ status: 'success', data: service.buildSynthesisInput(run) });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_SYNTHESIS_INPUT_FAILED'); }
});

router.post('/runs/:runId/candidates', requireMemoryReviewProducerAccess, async (req, res) => {
  try {
    const body = req.body || {};
    policy.assertKnownKeys(body, ['candidates', 'promptVersion', 'model'], 'body');
    const data = await service.submitCandidates(req.params.runId, body.candidates, {
      promptVersion: body.promptVersion,
      model: body.model,
    });
    res.json({ status: 'success', data });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_CANDIDATES_FAILED'); }
});

router.post('/runs/:runId/fail', requireMemoryReviewProducerAccess, async (req, res) => {
  try {
    const run = await service.failRun(req.params.runId, req.body || {});
    res.json({ status: 'success', data: { runId: run.runId, status: run.status, failure: run.failure } });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_FAIL_FAILED'); }
});

// Candidate-level review: approve | reject | defer | edit_approve — one
// candidate per call, reviewer identity required. No bulk endpoint exists.
router.post('/runs/:runId/candidates/:candidateId/review', requireOperatorUiAccess, async (req, res) => {
  try {
    const data = await service.reviewCandidate(req.params.runId, req.params.candidateId, {
      ...(req.body || {}),
      by: operatorRequestIdentity(req),
    });
    res.json({ status: 'success', data });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_REVIEW_FAILED'); }
});

// Applying requires two independent switches: the server-wide env gate and an
// explicit, audited authorization of this particular run.
router.post('/runs/:runId/authorize-apply', requireOperatorUiAccess, async (req, res) => {
  try {
    policy.assertKnownKeys(req.body || {}, ['by'], 'authorizeApply');
    const run = await service.authorizeApplyRun(req.params.runId, {
      by: operatorRequestIdentity(req),
    });
    res.json({
      status: 'success',
      data: { runId: run.runId, mode: run.mode, applyAuthorization: run.applyAuthorization },
    });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_AUTHORIZE_APPLY_FAILED'); }
});

// Apply an individually-approved candidate. Hard-gated server-side:
// global apply mode + explicit run authorization + approved status + policy
// compatible adapter; applyService acquires the atomic lease.
router.post('/runs/:runId/candidates/:candidateId/apply', requireOperatorUiAccess, async (req, res) => {
  try {
    policy.assertKnownKeys(req.body || {}, ['by'], 'apply');
    const data = await applyService.applyCandidate(req.params.runId, req.params.candidateId, {
      by: operatorRequestIdentity(req),
    });
    res.json({ status: 'success', data });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_APPLY_FAILED'); }
});

module.exports = router;
