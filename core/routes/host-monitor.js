const express = require('express');
const router = express.Router();
const hostMonitorService = require('../src/services/hostMonitorService');
const ollamaEnrichmentService = require('../src/services/ollamaEnrichmentService');
const { getConfiguredHosts, hostUrlKey, parseHostIp } = require('../src/helpers/ollamaHostConfig');
const { requireOperatorUiAccess } = require('../src/middleware/operatorAccess');
const logger = require('../config/logger');

const AGENT_TOKEN = process.env.HOST_AGENT_TOKEN || '';

function buildOllamaStatusEntry(host, ollamaState = {}) {
  const models = (host.ollamaModels && host.ollamaModels.length > 0)
    ? host.ollamaModels
    : (ollamaState.models || []);
  const runningModels = (host.ollamaRunningModels && host.ollamaRunningModels.length > 0)
    ? host.ollamaRunningModels
    : (ollamaState.runningModels || []);

  return {
    hostId: host.hostId,
    hostname: host.hostname,
    ip: host.ip,
    ollamaHostKey: host.ollamaHostKey || '',
    ollamaStatus: host.ollamaStatus || ollamaState.status || 'unknown',
    ollamaUrl: host.ollamaUrl || ollamaState.hostUrl || '',
    ollamaVersion: host.ollamaVersion || ollamaState.version || '',
    ollamaLatencyMs: host.ollamaLatencyMs ?? ollamaState.latencyMs ?? null,
    ollamaModelCount: host.ollamaModelCount || ollamaState.modelCount || models.length || 0,
    ollamaModels: models,
    ollamaRunningModels: runningModels,
    ollamaVram: host.ollamaVram || ollamaState.vram || {},
    ollamaLastChecked: host.ollamaLastChecked || ollamaState.checkedAt || null
  };
}

function buildConfiguredOllamaStatusEntry(configuredHost, ollamaState = {}) {
  const models = ollamaState.models || [];
  return {
    hostId: configuredHost.id,
    hostname: configuredHost.name,
    ip: parseHostIp(configuredHost.url),
    ollamaHostKey: configuredHost.id,
    ollamaStatus: ollamaState.status || 'unknown',
    ollamaUrl: configuredHost.url,
    ollamaVersion: ollamaState.version || '',
    ollamaLatencyMs: ollamaState.latencyMs ?? null,
    ollamaModelCount: ollamaState.modelCount || models.length || 0,
    ollamaModels: models,
    ollamaRunningModels: ollamaState.runningModels || [],
    ollamaVram: ollamaState.vram || {},
    ollamaLastChecked: ollamaState.checkedAt || null
  };
}

/**
 * Simple token check for agent reports.
 * If HOST_AGENT_TOKEN is set, the agent must send it in the x-agent-token header.
 */
function validateAgentToken(req, res, next) {
  if (!AGENT_TOKEN) return next(); // no token configured → open
  const token = req.headers['x-agent-token'] || '';
  if (token === AGENT_TOKEN) return next();
  return res.status(401).json({ status: 'error', message: 'Invalid agent token' });
}

// ─── Agent heartbeat endpoint ─────────────────────────────

router.post('/report', validateAgentToken, async (req, res) => {
  try {
    const report = req.body;
    if (!report || !report.hostId) {
      return res.status(400).json({ status: 'error', message: 'hostId is required' });
    }

    const host = await hostMonitorService.processReport(report);

    // Process completed task results from agent
    const taskService = require('../src/services/hostTaskService');
    if (Array.isArray(report.taskResults) && report.taskResults.length > 0) {
      await taskService.processTaskResults(report.taskResults);
    }

    // Dispatch pending tasks for this agent
    let tasks = [];
    try {
      tasks = await taskService.dispatchTasks(host.hostId);
      logger.info('[HostMonitor] report processed', { hostId: host.hostId, tasksDispatched: tasks.length });
    } catch (taskErr) {
      logger.error('[HostMonitor] dispatchTasks failed', { hostId: host.hostId, error: taskErr.message });
    }

    return res.json({
      status: 'success',
      data: { hostId: host.hostId, status: host.status },
      tasks
    });
  } catch (err) {
    logger.error('Host report failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Dashboard endpoints ──────────────────────────────────

router.get('/summary', async (_req, res) => {
  try {
    const summary = await hostMonitorService.getSummary();
    return res.json({ status: 'success', data: summary });
  } catch (err) {
    logger.error('Host summary failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/status', async (_req, res) => {
  try {
    const summary = await hostMonitorService.getSummary();
    return res.json({ status: 'success', data: summary });
  } catch (err) {
    logger.error('Host status failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/', async (req, res) => {
  try {
    const { status } = req.query;
    const hosts = await hostMonitorService.getAllHosts(status || null);
    return res.json({ status: 'success', data: hosts });
  } catch (err) {
    logger.error('List hosts failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Ollama enrichment endpoints (before /:hostId catch-all) ──

/** GET /api/hosts/ollama-status — enriched Ollama data for all hosts */
router.get('/ollama-status', async (_req, res) => {
  try {
    const hosts = await hostMonitorService.getAllHosts();
    const ollamaState = ollamaEnrichmentService.getOllamaState();
    const configuredHosts = getConfiguredHosts();

    const enrichedByConfiguredId = new Map();
    const extraEnriched = [];

    for (const h of hosts) {
      const hostKey = h.ollamaHostKey || '';
      const urlKey = hostUrlKey(h.ollamaUrl);
      const matchedConfig = configuredHosts.find(host => host.id === hostKey || hostUrlKey(host.url) === urlKey);

      const entry = buildOllamaStatusEntry(h, ollamaState[matchedConfig?.id || hostKey] || {});
      if (matchedConfig) {
        entry.ollamaHostKey = entry.ollamaHostKey || matchedConfig.id;
        entry.ollamaUrl = entry.ollamaUrl || matchedConfig.url;
        entry.hostname = entry.hostname || matchedConfig.name;
        entry.ip = entry.ip || parseHostIp(matchedConfig.url);
        enrichedByConfiguredId.set(matchedConfig.id, entry);
      } else {
        extraEnriched.push(entry);
      }
    }

    const enriched = [];
    for (const configuredHost of configuredHosts) {
      enriched.push(
        enrichedByConfiguredId.get(configuredHost.id) ||
        buildConfiguredOllamaStatusEntry(configuredHost, ollamaState[configuredHost.id] || {})
      );
    }
    enriched.push(...extraEnriched);

    return res.json({
      status: 'success',
      data: {
        hosts: enriched,
        configuredHosts: configuredHosts.map(c => ({ id: c.id, name: c.name, url: c.url })),
        inMemoryState: ollamaState
      }
    });
  } catch (err) {
    logger.error('Ollama status failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

/** POST /api/hosts/ollama-refresh — trigger immediate re-poll */
router.post('/ollama-refresh', async (_req, res) => {
  try {
    await ollamaEnrichmentService.refresh();
    return res.json({ status: 'success', message: 'Ollama poll complete' });
  } catch (err) {
    logger.error('Ollama refresh failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Host task endpoints ─────────────────────────────────

router.post('/:hostId/tasks', requireOperatorUiAccess, async (req, res) => {
  try {
    const { type, params } = req.body || {};
    if (!type) return res.status(400).json({ status: 'error', message: 'type is required' });
    const taskService = require('../src/services/hostTaskService');
    const task = await taskService.createTask(req.params.hostId, type, params || {});
    return res.json({ status: 'success', data: { taskId: task._id, type: task.type, status: task.status } });
  } catch (err) {
    logger.error('Create task failed', { error: err.message });
    const code = err.message.includes('Unknown task type') ? 400 : 500;
    return res.status(code).json({ status: 'error', message: err.message });
  }
});

router.get('/:hostId/tasks', async (req, res) => {
  try {
    const { status, limit } = req.query;
    const taskService = require('../src/services/hostTaskService');
    const tasks = await taskService.getTasksForHost(req.params.hostId, {
      status: status || null,
      limit: limit ? parseInt(limit, 10) : 20
    });
    return res.json({ status: 'success', data: tasks });
  } catch (err) {
    logger.error('List tasks failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/:hostId', async (req, res) => {
  try {
    const host = await hostMonitorService.getHost(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', message: 'Host not found' });
    return res.json({ status: 'success', data: host });
  } catch (err) {
    logger.error('Get host failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/:hostId/history', async (req, res) => {
  try {
    const { from, to, limit } = req.query;
    const history = await hostMonitorService.getHostHistory(req.params.hostId, {
      from, to,
      limit: limit ? parseInt(limit, 10) : 500
    });
    return res.json({ status: 'success', data: history });
  } catch (err) {
    logger.error('Host history failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.put('/:hostId', requireOperatorUiAccess, async (req, res) => {
  try {
    const host = await hostMonitorService.updateHost(req.params.hostId, req.body);
    if (!host) return res.status(404).json({ status: 'error', message: 'Host not found or no valid fields' });
    return res.json({ status: 'success', data: host });
  } catch (err) {
    logger.error('Update host failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

router.delete('/:hostId', requireOperatorUiAccess, async (req, res) => {
  try {
    const host = await hostMonitorService.removeHost(req.params.hostId);
    if (!host) return res.status(404).json({ status: 'error', message: 'Host not found' });
    return res.json({ status: 'success', message: 'Host removed' });
  } catch (err) {
    logger.error('Remove host failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

/** PUT /api/hosts/:hostId/link-ollama — link host to Ollama host key */
router.put('/:hostId/link-ollama', requireOperatorUiAccess, async (req, res) => {
  try {
    const { ollamaHostKey } = req.body || {};
    if (ollamaHostKey === undefined) {
      return res.status(400).json({ status: 'error', message: 'ollamaHostKey is required' });
    }

    const host = await hostMonitorService.updateHost(req.params.hostId, { ollamaHostKey });
    if (!host) return res.status(404).json({ status: 'error', message: 'Host not found' });
    return res.json({ status: 'success', data: host });
  } catch (err) {
    logger.error('Link Ollama failed', { error: err.message });
    return res.status(500).json({ status: 'error', message: err.message });
  }
});

module.exports = router;
