const express = require('express');
const envelope = require('../src/helpers/responseEnvelope');
const planningService = require('../src/services/planningService');
const planningBootstrapService = require('../src/services/planningBootstrapService');
const planningReferencePlanService = require('../src/services/planningReferencePlanService');
const planningMetricRegistry = require('../src/services/planningMetricRegistry');
const planningAutomationService = require('../src/services/planningAutomationService');
const planningEvidenceService = require('../src/services/planningEvidenceService');
const { planningAutomationAllowed } = require('../src/helpers/planningAutomationAuth');
const { requireTypedConfirmation } = require('../src/helpers/typedConfirmation');

const router = express.Router();

function sendError(res, err) {
  return envelope.error(
    res,
    err.status || 500,
    err.message || 'Planning operation failed',
    err.code || 'PLANNING_ERROR'
  );
}

router.get('/dashboard', async (_req, res) => {
  try {
    return envelope.success(res, await planningService.getDashboard());
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/bootstrap', async (req, res) => {
  try {
    const result = await planningBootstrapService.bootstrapFromPipeline({
      by: req.body?.by || 'operator',
      dryRun: Boolean(req.body?.dryRun),
      includeEmpty: Boolean(req.body?.includeEmpty)
    });
    return envelope.success(res, result);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/reference-plans', (_req, res) => {
  return envelope.success(res, { plans: planningReferencePlanService.catalog() });
});

router.post('/reference-plans/:key/import', async (req, res) => {
  try {
    const result = await planningReferencePlanService.importReferencePlan(req.params.key, {
      by: req.body?.by || 'operator',
      dryRun: req.body?.dryRun !== false
    });
    return envelope.success(res, result);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/automation/catalog', (_req, res) => {
  return envelope.success(res, {
    adapters: planningMetricRegistry.catalog(),
    evidenceSources: planningEvidenceService.catalog()
  });
});

router.get('/automation/status', async (_req, res) => {
  try {
    return envelope.success(res, await planningAutomationService.getStatus());
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/automation/reconcile', async (req, res) => {
  const auth = planningAutomationAllowed(req);
  if (!auth.allowed) return envelope.error(res, auth.status, auth.message, auth.code);
  try {
    const result = await planningAutomationService.reconcile({
      dryRun: req.body?.dryRun !== false,
      source: req.body?.source || '',
      itemId: req.body?.itemId || req.body?.item || '',
      force: Boolean(req.body?.force),
      owner: req.body?.owner || undefined
    });
    return envelope.success(res, result);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/items', async (req, res) => {
  try {
    const items = await planningService.listItems({
      type: req.query.type,
      status: req.query.status,
      workstreamId: req.query.workstreamId,
      includeArchived: ['1', 'true', 'yes'].includes(String(req.query.includeArchived || '').toLowerCase())
    });
    return envelope.success(res, { count: items.length, items });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/items', async (req, res) => {
  try {
    const item = await planningService.createItem(req.body || {});
    return envelope.success(res, { item }, null, 201);
  } catch (err) {
    return sendError(res, err);
  }
});

router.get('/items/:id', async (req, res) => {
  try {
    return envelope.success(res, await planningService.getItemDetail(req.params.id));
  } catch (err) {
    return sendError(res, err);
  }
});

router.patch('/items/:id', async (req, res) => {
  try {
    const item = await planningService.updateItem(req.params.id, req.body || {});
    return envelope.success(res, { item });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/items/:id/actions/:action', async (req, res) => {
  try {
    const item = await planningService.transitionItem(
      req.params.id,
      req.params.action,
      req.body || {}
    );
    return envelope.success(res, { item });
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/items/:id', async (req, res) => {
  try {
    if (!requireTypedConfirmation(req, res, 'ARCHIVE PLANNING ITEM', req.params.id)) return;
    const item = await planningService.archiveItem(req.params.id, req.body || {});
    return envelope.success(res, { item });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/items/:id/tasks/:pipelineId', async (req, res) => {
  try {
    return envelope.success(res, await planningService.linkTask(
      req.params.id,
      req.params.pipelineId,
      req.body || {}
    ));
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/items/:id/tasks/:pipelineId', async (req, res) => {
  try {
    if (!requireTypedConfirmation(req, res, 'UNLINK PLANNING TASK', req.params.id, req.params.pipelineId)) return;
    return envelope.success(res, await planningService.unlinkTask(
      req.params.id,
      req.params.pipelineId,
      req.body || {}
    ));
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/items/:id/schedules', async (req, res) => {
  try {
    return envelope.success(res, await planningService.linkSchedule(req.params.id, req.body || {}));
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/items/:id/schedules/:sourceId', async (req, res) => {
  try {
    const sourceId = decodeURIComponent(req.params.sourceId);
    if (!requireTypedConfirmation(req, res, 'UNLINK PLANNING SCHEDULE', req.params.id, sourceId)) return;
    const item = await planningService.unlinkSchedule(
      req.params.id,
      sourceId,
      req.body || {}
    );
    return envelope.success(res, { item });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/items/:id/evidence', async (req, res) => {
  try {
    return envelope.success(res, await planningService.addEvidence(req.params.id, req.body || {}), null, 201);
  } catch (err) {
    return sendError(res, err);
  }
});

router.delete('/items/:id/evidence/:evidenceId', async (req, res) => {
  try {
    if (!requireTypedConfirmation(req, res, 'DELETE PLANNING EVIDENCE', req.params.id, req.params.evidenceId)) return;
    const item = await planningService.removeEvidence(
      req.params.id,
      req.params.evidenceId,
      req.body || {}
    );
    return envelope.success(res, { item });
  } catch (err) {
    return sendError(res, err);
  }
});

router.post('/ideas/:id/promote', async (req, res) => {
  try {
    return envelope.success(res, await planningService.promoteIdea(req.params.id, req.body || {}), null, 201);
  } catch (err) {
    return sendError(res, err);
  }
});

module.exports = router;
