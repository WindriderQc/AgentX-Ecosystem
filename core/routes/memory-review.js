// /api/memory-review — Ecosystem Memory Review (approval-first, shadow by default).
//
// Mounted in src/app.js with a dedicated 1mb JSON parser: observation batches
// are bounded by policy, and raw transcript payloads are refused at the
// validation layer. There is deliberately NO bulk-approve endpoint — review is
// candidate-by-candidate through the bounded review contract.

const express = require('express');

const router = express.Router();
const service = require('../src/services/memoryReview/memoryReviewService');
const insightsService = require('../src/services/memoryReview/insightsService');
const applyService = require('../src/services/memoryReview/applyService');
const policy = require('../src/services/memoryReview/policy');
const {
  operatorRequestIdentity,
  requireOperatorAccess,
  requireOperatorUiAccess,
} = require('../src/middleware/operatorAccess');
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
      schemaVersion: policy.SCHEMA_VERSION,
      coreVersion,
      limits: policy.LIMITS,
      runtimes: policy.RUNTIMES,
      candidateTypes: policy.CANDIDATE_TYPES,
      targetKinds: policy.TARGET_KINDS,
      targetsByType: policy.TARGETS_BY_TYPE,
      applyEnabled: policy.serverMode() === 'apply',
    },
  });
});

router.post('/runs', requireOperatorAccess, async (req, res) => {
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

router.post('/runs/:runId/observations', requireOperatorAccess, async (req, res) => {
  try {
    const body = req.body || {};
    policy.assertKnownKeys(body, ['collector', 'observations'], 'body');
    const data = await service.submitObservations(
      req.params.runId,
      body.collector,
      body.observations,
      { submittedBy: operatorRequestIdentity(req) }
    );
    res.json({ status: 'success', data });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_OBSERVATIONS_FAILED'); }
});

router.post('/runs/:runId/finalize', requireOperatorAccess, async (req, res) => {
  try {
    const run = await service.finalizeCollection(req.params.runId);
    res.json({ status: 'success', data: { runId: run.runId, status: run.status, summary: run.summary, dedupDegraded: !!run.dedupContext?.degraded } });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_FINALIZE_FAILED'); }
});

router.get('/runs/:runId/synthesis-input', requireOperatorAccess, async (req, res) => {
  try {
    const run = await service.getRunOrThrow(req.params.runId);
    res.json({ status: 'success', data: service.buildSynthesisInput(run) });
  } catch (err) { fail(res, err, 'MEMORY_REVIEW_SYNTHESIS_INPUT_FAILED'); }
});

router.post('/runs/:runId/candidates', requireOperatorAccess, async (req, res) => {
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

router.post('/runs/:runId/fail', requireOperatorAccess, async (req, res) => {
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
