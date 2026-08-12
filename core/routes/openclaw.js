/**
 * OpenClaw read-only runtime evidence routes.
 *
 * OpenClaw's official Control UI is the authority for native runtime work.
 * AgentX projects a bounded operational summary from the official CLI over
 * SSH; it does not proxy or duplicate the native OpenClaw control surface.
 */

const express = require('express');
const { buildOpenClawAgentInventory } = require('../src/services/openclawAgentInventoryService');
const { getOpenClawRuntimeEvidence } = require('../src/services/openclawRuntimeEvidenceService');
const { getOpenClawControlUiConfig } = require('../src/services/openclawControlUiService');
const {
  OpenClawClientError,
  getOpenClawControlLaunchUrl,
} = require('../src/services/openclawClient');
const { isLoopbackAddress, requireOperatorAccess } = require('../src/middleware/operatorAccess');
const logger = require('../config/logger');

const router = express.Router();

function truthyQuery(value) {
  return ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());
}

function requireOperatorForPromptContent(req, res, next) {
  if (!truthyQuery(req.query.includeContent)) return next();
  return requireOperatorAccess(req, res, next);
}

function controlHref(path) {
  const base = getOpenClawControlUiConfig().launchBaseUrl.replace(/\/+$/, '');
  return `${base}/${String(path || '').replace(/^\/+/, '')}`;
}

async function runtimeEvidence(req) {
  return getOpenClawRuntimeEvidence({ refresh: truthyQuery(req.query.refresh) });
}

function sendEvidenceError(res, err, label) {
  logger.warn(`OpenClaw ${label} failed`, { error: err.message });
  res.status(err.status || 502).json({ status: 'error', message: err.message });
}

router.get('/status', async (req, res) => {
  try {
    const evidence = await runtimeEvidence(req);
    const status = evidence.status;
    res.json({
      status: status.online ? 'online' : 'offline',
      authority: evidence.authority,
      source: evidence.source,
      runtimeVersion: status.runtimeVersion,
      gateway: status.gateway,
      gatewayService: status.gatewayService,
      agents: status.agents,
      sessions: status.sessions.count,
      timestamp: evidence.generatedAt,
      controlUi: controlHref('/overview'),
    });
  } catch (err) {
    sendEvidenceError(res, err, 'status check');
  }
});

// One-click official Control UI handoff. OpenClaw itself supports receiving
// the gateway token in the URL fragment; fragments stay browser-side and are
// not sent to Caddy/OpenClaw as part of the HTTP request. This endpoint keeps
// the credential out of AgentX page markup and prevents response caching.
router.get('/control-launch/:target', (req, res) => {
  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim().toLowerCase();
  const protocol = forwardedProto || String(req.protocol || '').toLowerCase();
  if (protocol !== 'https' && !isLoopbackAddress(req.ip || req.socket?.remoteAddress)) {
    return res.status(400).json({
      status: 'error',
      code: 'OPENCLAW_CONTROL_HTTPS_REQUIRED',
      message: 'OpenClaw one-click launch requires HTTPS'
    });
  }

  const agent = String(req.query.agent || '').trim();
  if (agent && !/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(agent)) {
    return res.status(400).json({
      status: 'error',
      code: 'OPENCLAW_AGENT_ID_INVALID',
      message: 'OpenClaw agent id is invalid'
    });
  }

  try {
    const location = getOpenClawControlLaunchUrl(req.params.target, agent ? { agent } : {});
    res.set({
      'Cache-Control': 'no-store, max-age=0',
      Pragma: 'no-cache',
      'Referrer-Policy': 'no-referrer'
    });
    return res.redirect(302, location);
  } catch (err) {
    const status = err instanceof OpenClawClientError ? err.status : 500;
    if (status >= 500) logger.warn('OpenClaw Control UI launch failed', { error: err.message });
    return res.status(status).json({
      status: 'error',
      code: err.code || 'OPENCLAW_CONTROL_LAUNCH_ERROR',
      message: err.message || 'OpenClaw Control UI launch failed'
    });
  }
});

router.get('/agent-inventory', requireOperatorForPromptContent, async (req, res) => {
  try {
    const inventory = await buildOpenClawAgentInventory({
      includeContent: truthyQuery(req.query.includeContent),
      includeRuntimeStatus: truthyQuery(req.query.includeRuntimeStatus),
    });
    res.json(inventory);
  } catch (err) {
    logger.warn('OpenClaw agent inventory failed', { error: err.message });
    res.status(err.status || 502).json({
      schema_version: 2,
      status: 'error',
      message: err.message,
      agents: [],
      inactiveWorkspaces: [],
      known_gaps: [{ id: 'inventory-build-failed', severity: 'high', detail: err.message }],
    });
  }
});

router.get('/agents', async (req, res) => {
  try {
    const evidence = await runtimeEvidence(req);
    res.json({ data: evidence.agents, authority: evidence.authority });
  } catch (err) {
    sendEvidenceError(res, err, 'agents list');
  }
});

router.get('/agents/:id', async (req, res) => {
  try {
    const evidence = await runtimeEvidence(req);
    const agent = evidence.agents.find((item) => item.id === req.params.id);
    if (!agent) return res.status(404).json({ status: 'error', message: 'OpenClaw agent not found' });
    return res.json({ data: agent, authority: evidence.authority });
  } catch (err) {
    return sendEvidenceError(res, err, 'agent detail');
  }
});

router.get('/sessions', async (req, res) => {
  try {
    const evidence = await runtimeEvidence(req);
    res.json({
      data: evidence.status.sessions.recent,
      count: evidence.status.sessions.count,
      authority: evidence.authority,
      controlUi: controlHref('/sessions'),
    });
  } catch (err) {
    sendEvidenceError(res, err, 'sessions list');
  }
});

router.get('/config', async (req, res) => {
  try {
    const evidence = await runtimeEvidence(req);
    res.json({
      data: {
        defaults: evidence.defaults,
        memoryStrategy: evidence.memoryStrategy,
        agents: evidence.agents.map((agent) => ({
          id: agent.id,
          name: agent.name,
          default: agent.default,
          workspace: agent.workspace,
          model: agent.model,
          tools: agent.tools,
          subagents: agent.subagents,
        })),
      },
      authority: evidence.authority,
      readOnly: true,
      controlUi: controlHref('/config'),
    });
  } catch (err) {
    sendEvidenceError(res, err, 'config summary');
  }
});

router.patch('/config', requireOperatorAccess, (_req, res) => {
  res.status(409).json({
    status: 'error',
    code: 'OPENCLAW_NATIVE_AUTHORITY',
    message: 'OpenClaw configuration changes belong in the official Control UI.',
    controlUi: controlHref('/config'),
  });
});

router.get('/models', async (req, res) => {
  try {
    const evidence = await runtimeEvidence(req);
    res.json({ data: evidence.models, authority: evidence.authority });
  } catch (err) {
    sendEvidenceError(res, err, 'models summary');
  }
});

router.get('/channels', (_req, res) => {
  res.json({
    data: [],
    authority: 'official-openclaw-control-ui',
    projected: false,
    controlUi: controlHref('/channels'),
  });
});

router.get('/memory/:agentId', async (req, res) => {
  try {
    const evidence = await runtimeEvidence(req);
    const agent = evidence.agents.find((item) => item.id === req.params.agentId);
    if (!agent) return res.status(404).json({ status: 'error', message: 'OpenClaw agent not found' });
    return res.json({
      data: agent.memory || null,
      runtime: evidence.memory?.agentId === agent.id ? evidence.memory : null,
      authority: evidence.authority,
      controlUi: controlHref('/agents'),
    });
  } catch (err) {
    return sendEvidenceError(res, err, 'memory summary');
  }
});

router.get('/cron', async (req, res) => {
  try {
    const evidence = await runtimeEvidence(req);
    res.json({
      data: evidence.cron.jobs,
      count: evidence.cron.count,
      authority: evidence.authority,
      controlUi: controlHref('/cron'),
    });
  } catch (err) {
    sendEvidenceError(res, err, 'cron list');
  }
});

async function sendRuntimeSummary(req, res) {
  try {
    const evidence = await runtimeEvidence(req);
    res.json({
      status: evidence.source.degraded ? 'degraded' : 'ok',
      source: evidence.authority,
      controlUi: controlHref('/agents'),
      data: {
        ...evidence.models,
        degraded: evidence.source.degraded,
        runtimeVersion: evidence.status.runtimeVersion,
      },
    });
  } catch (err) {
    sendEvidenceError(res, err, 'runtime summary');
  }
}

router.get('/runtime-summary', sendRuntimeSummary);

module.exports = router;
