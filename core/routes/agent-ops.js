const express = require('express');
const logger = require('../config/logger');
const { buildAgentOpsProjection } = require('../src/services/agentOpsProjectionService');
const { loadAgentOpsHistoryInputs } = require('../src/services/agentOpsHistoryService');
const {
  AgentOpsActionError,
  confirmationKey,
  executeAgentOpsAction
} = require('../src/services/agentOpsActionService');

const router = express.Router();
router.use(express.json({ limit: '16kb' }));

function sameOriginRequest(req) {
  const origin = req.get('origin');
  if (!origin) return true;
  return origin === `${req.protocol}://${req.get('host')}`;
}

function projectionOptions(req, history = {}) {
  return {
    snapshotOptions: { coreBaseUrl: `${req.protocol}://${req.get('host')}` },
    openclawControl: req.app.locals.openclawControl,
    ...history
  };
}

router.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const history = await loadAgentOpsHistoryInputs();
    const data = await buildAgentOpsProjection(projectionOptions(req, history));
    return res.json({ status: 'success', data });
  } catch (err) {
    logger.error('[AgentOps] projection failed', { error: err.message });
    return res.status(500).json({
      status: 'error',
      message: 'Failed to build Agent Ops projection'
    });
  }
});

router.post('/actions', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const body = req.body || {};
  const action = String(body.action || '').trim();
  const target = String(body.target || '').trim();
  const confirmation = req.get('x-agent-ops-confirmation') || '';

  if (!sameOriginRequest(req)) {
    return res.status(403).json({ status: 'error', message: 'Same-origin Agent Ops request required' });
  }
  if (!action || !target || confirmation !== confirmationKey(action, target)) {
    return res.status(400).json({ status: 'error', message: 'Explicit Agent Ops confirmation is required' });
  }

  try {
    const projection = await buildAgentOpsProjection(projectionOptions(req));
    const result = await executeAgentOpsAction({
      action,
      target,
      assignee: body.assignee,
      projection,
      requestMeta: {
        username: 'operator',
        ipAddress: req.ip,
        userAgent: req.get('user-agent')
      }
    });
    return res.json({ status: 'success', data: result });
  } catch (err) {
    const known = err instanceof AgentOpsActionError;
    const status = known ? err.status : 500;
    logger.error('[AgentOps] operator action failed', { action, target, error: err.message });
    return res.status(status).json({
      status: 'error',
      code: known ? err.code : 'AGENT_OPS_ACTION_FAILED',
      message: known ? err.message : 'Agent Ops action failed'
    });
  }
});

module.exports = router;
