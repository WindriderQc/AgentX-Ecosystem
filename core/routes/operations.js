/**
 * Operations Center API Routes
 *
 * Unified operations API consolidating:
 * - System health checks (all services)
 * - Activity timeline
 * - System metrics
 */

const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const logger = require('../config/logger');
const ActivityLog = require('../models/ActivityLog');
const fetch = require('node-fetch');
const { normalizeHostUrl } = require('../src/helpers/ollamaHostConfig');

const DEFAULT_CLAWDX_OLLAMA_URL = '';
const DEFAULT_OPENCLAW_GATEWAY_URLS = [
  'http://127.0.0.1:18789',
  'http://localhost:18789'
];

function parsePathList(value, fallback) {
  if (!value || typeof value !== 'string') return fallback;
  const paths = value
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => (entry.startsWith('/') ? entry : `/${entry}`));
  return paths.length > 0 ? paths : fallback;
}

function joinUrl(baseUrl, path) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  const suffix = String(path || '').startsWith('/') ? path : `/${path || ''}`;
  return `${base}${suffix}`;
}

function normalizeBaseUrl(value) {
  if (!value) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed.replace(/\/+$/, '');
  }
  return `http://${trimmed.replace(/\/+$/, '')}`;
}

function dedupeUrls(urls) {
  return Array.from(new Set((urls || []).filter(Boolean)));
}

function deriveOpenclawCandidates(clawdxOllamaUrl) {
  const explicitList = dedupeUrls(
    String(process.env.OPENCLAW_GATEWAY_URLS || '')
      .split(',')
      .map((entry) => normalizeBaseUrl(entry))
  );
  if (explicitList.length > 0) {
    return explicitList;
  }

  const explicitSingle = normalizeBaseUrl(process.env.OPENCLAW_GATEWAY_URL);
  if (explicitSingle) {
    return [explicitSingle];
  }

  const candidates = [...DEFAULT_OPENCLAW_GATEWAY_URLS];
  const gatewayPort = Number(process.env.OPENCLAW_GATEWAY_PORT || 18789);
  if (Number.isFinite(gatewayPort) && gatewayPort > 0) {
    candidates.unshift(`http://127.0.0.1:${gatewayPort}`, `http://localhost:${gatewayPort}`);
  }

  try {
    const parsed = new URL(normalizeBaseUrl(clawdxOllamaUrl));
    if (parsed.hostname) {
      if (Number.isFinite(gatewayPort) && gatewayPort > 0) {
        candidates.push(`http://${parsed.hostname}:${gatewayPort}`);
      }
    }
  } catch (_err) {
    // ignore URL parsing failures; fall back to defaults
  }

  return dedupeUrls(candidates.map((entry) => normalizeBaseUrl(entry)));
}

async function probeFirstJson(baseUrl, paths, timeoutMs = 5000) {
  let lastError = 'No response';
  let lastStatus = null;

  for (const path of paths) {
    const url = joinUrl(baseUrl, path);
    try {
      const response = await fetch(url, { timeout: timeoutMs });
      lastStatus = response.status;
      const bodyText = await response.text();
      let data = null;
      // `json` records whether the body actually parsed. `ok` stays "the HTTP
      // call succeeded" because some probes (e.g. /health) legitimately answer
      // in plain text — but a caller that needs structure must be able to tell
      // "empty list" from "not JSON at all". Without that distinction an HTML
      // page scores as a successful probe carrying zero items (task 0538).
      let json = false;
      if (bodyText) {
        try {
          data = JSON.parse(bodyText);
          json = true;
        } catch (_err) {
          data = bodyText;
        }
      }

      if (response.ok) {
        return {
          ok: true,
          json,
          url,
          status: response.status,
          data
        };
      }

      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error.message;
    }
  }

  return { ok: false, error: lastError, status: lastStatus };
}

async function probeFirstJsonAcrossBases(baseUrls, paths, timeoutMs = 5000) {
  let lastResult = { ok: false, error: 'No response', status: null };
  for (const baseUrl of baseUrls) {
    const result = await probeFirstJson(baseUrl, paths, timeoutMs);
    if (result.ok) {
      return { ...result, baseUrl };
    }
    lastResult = { ...result, baseUrl };
  }
  return lastResult;
}

/**
 * Agent names from an OpenClaw payload, or `null` when the payload is not a
 * recognizable agent list.
 *
 * The null return is the point (task 0538). Returning `[]` for an unrecognized
 * shape makes "OpenClaw told us it has no agents" indistinguishable from "we
 * could not read the answer", and the caller then reports a confident zero. In
 * production that surfaced as `agentCount: 0` against eight live agents, because
 * OpenClaw 2026.7.1-2 serves the Control UI (HTML) at `/agents`.
 */
function extractAgentNames(payload) {
  let list = null;

  if (Array.isArray(payload)) {
    list = payload;
  } else if (Array.isArray(payload?.agents)) {
    list = payload.agents;
  } else if (Array.isArray(payload?.data)) {
    list = payload.data;
  } else if (Array.isArray(payload?.items)) {
    list = payload.items;
  } else if (Array.isArray(payload?.result)) {
    list = payload.result;
  }

  if (list === null) return null;

  const names = list
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return null;
      return item.name || item.agentName || item.slug || item.id || item.title || item.model || null;
    })
    .filter(Boolean);

  return Array.from(new Set(names));
}

// ========================================
// Unified Health Check
// ========================================

/**
 * GET /api/operations/health
 * Comprehensive system health check for all services
 */
router.get('/health', async (req, res) => {
  try {
    const clawdxOllamaUrl =
      process.env.CLAWDX_OLLAMA_URL ||
      process.env.OLLAMA_HOST_TERTIARY ||
      process.env.OLLAMA_HOST_3 ||
      DEFAULT_CLAWDX_OLLAMA_URL;
    const openclawBaseUrls = deriveOpenclawCandidates(clawdxOllamaUrl);
    const openclawTimeoutMs = Number(process.env.OPENCLAW_TIMEOUT_MS || 3000);
    const openclawHealthPaths = parsePathList(
      process.env.OPENCLAW_HEALTH_PATHS,
      ['/api/health', '/health', '/healthz', '/api/status']
    );
    const openclawAgentsPaths = parsePathList(
      process.env.OPENCLAW_AGENTS_PATHS,
      ['/api/agents', '/agents', '/api/v1/agents']
    );

    const healthStatus = {
      timestamp: new Date().toISOString(),
      status: 'healthy', // Will be downgraded if any service fails
      services: {},
      metrics: {},
      system: {}
    };

    // 1. AgentX (always up if we're responding)
    healthStatus.services.agentx = {
      status: 'up',
      uptime: Math.floor(process.uptime()),
      version: require('../package.json').version || '1.4.1',
      nodeVersion: process.version,
      pid: process.pid
    };

    // 2. MongoDB
    try {
      const mongoState = mongoose.connection.readyState;
      const isConnected = mongoState === 1;

      healthStatus.services.mongodb = {
        status: isConnected ? 'up' : 'down',
        readyState: mongoState,
        host: mongoose.connection.host,
        port: mongoose.connection.port,
        db: mongoose.connection.name
      };

      if (isConnected) {
        // Get database stats
        const stats = await mongoose.connection.db.stats();
        healthStatus.services.mongodb.collections = stats.collections;
        healthStatus.services.mongodb.documents = stats.objects;
        healthStatus.services.mongodb.dataSize = Math.round(stats.dataSize / 1024 / 1024 * 100) / 100; // MB

        // Total on-disk size (data + indexes). Prefer Mongo's totalSize when available.
        const totalSizeBytes =
          typeof stats.totalSize === 'number'
            ? stats.totalSize
            : (Number(stats.storageSize) || 0) + (Number(stats.indexSize) || 0);
        healthStatus.services.mongodb.totalSizeMb = Math.round(totalSizeBytes / 1024 / 1024 * 100) / 100; // MB
      } else {
        healthStatus.status = 'degraded';
      }
    } catch (error) {
      healthStatus.services.mongodb = { status: 'error', error: error.message };
      healthStatus.status = 'degraded';
    }

    // 3. Ollama (primary host)
    try {
      const ollamaHost = normalizeHostUrl(process.env.OLLAMA_HOST) || 'http://localhost:11434';
      const response = await fetch(`${ollamaHost}/api/tags`, { timeout: 5000 });

      if (response.ok) {
        const data = await response.json();
        healthStatus.services.ollama = {
          status: 'up',
          host: ollamaHost,
          models: data.models?.length || 0
        };
      } else {
        healthStatus.services.ollama = { status: 'down', host: ollamaHost };
        healthStatus.status = 'degraded';
      }
    } catch (error) {
        healthStatus.services.ollama = {
          status: 'error',
          host: normalizeHostUrl(process.env.OLLAMA_HOST) || process.env.OLLAMA_HOST,
          error: error.message
        };
      healthStatus.status = 'degraded';
    }

    // 4. Data
    try {
      const dataapiUrl = process.env.DATAAPI_BASE_URL || 'http://localhost:3083';
      // Data service has a public /health endpoint (no auth required)
      const response = await fetch(`${dataapiUrl}/health`, { timeout: 5000 });

      if (response.ok) {
        const data = await response.json();
        healthStatus.services.data = {
          status: 'up',
          url: dataapiUrl,
          version: data.version || 'unknown'
        };
      } else {
        healthStatus.services.data = { status: 'down', url: dataapiUrl };
      }
    } catch (error) {
      healthStatus.services.data = {
        status: 'error',
        url: process.env.DATAAPI_BASE_URL,
        error: error.message
      };
    }

    // 6. Qdrant (if configured)
    if (process.env.VECTOR_STORE_TYPE === 'qdrant') {
      try {
        const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
        const response = await fetch(`${qdrantUrl}/healthz`, { timeout: 5000 });

        if (response.ok) {
          healthStatus.services.qdrant = {
            status: 'up',
            url: qdrantUrl
          };
        } else {
          healthStatus.services.qdrant = { status: 'down', url: qdrantUrl };
        }
      } catch (error) {
        healthStatus.services.qdrant = {
          status: 'error',
          url: process.env.QDRANT_URL,
          error: error.message
        };
      }
    }

    // 7. OpenClaw-adjacent Ollama fallback (Host Gamma .99 tertiary/model-store) + OpenClaw status
    const [clawdxTagsProbe, clawdxPsProbe] = await Promise.all([
      probeFirstJson(clawdxOllamaUrl, ['/api/tags']),
      probeFirstJson(clawdxOllamaUrl, ['/api/ps'])
    ]);
    const clawdxModels = clawdxTagsProbe.ok && Array.isArray(clawdxTagsProbe.data?.models)
      ? clawdxTagsProbe.data.models
        .map((model) => model?.name || model?.model)
        .filter(Boolean)
      : [];
    const clawdxRunningModels = clawdxPsProbe.ok && Array.isArray(clawdxPsProbe.data?.models)
      ? clawdxPsProbe.data.models
        .map((model) => model?.name || model?.model)
        .filter(Boolean)
      : [];

    if (clawdxTagsProbe.ok) {
      healthStatus.services.clawdx = {
        status: 'up',
        host: clawdxOllamaUrl,
        models: clawdxModels.length,
        runningModels: clawdxRunningModels.length,
        modelNames: clawdxModels.slice(0, 30),
        runningModelNames: clawdxRunningModels.slice(0, 30)
      };
    } else {
      healthStatus.services.clawdx = {
        status: 'down',
        host: clawdxOllamaUrl,
        error: clawdxTagsProbe.error || 'Unable to query /api/tags'
      };
      healthStatus.status = 'degraded';
    }

    const [openclawHealthProbe, openclawAgentsProbe] = await Promise.all([
      probeFirstJsonAcrossBases(openclawBaseUrls, openclawHealthPaths, openclawTimeoutMs),
      probeFirstJsonAcrossBases(openclawBaseUrls, openclawAgentsPaths, openclawTimeoutMs)
    ]);
    const resolvedOpenclawBaseUrl =
      openclawHealthProbe.baseUrl ||
      openclawAgentsProbe.baseUrl ||
      openclawBaseUrls[0] ||
      null;
    // `null` means "could not read agents", which is NOT the same as zero.
    const openclawAgentNames = openclawAgentsProbe.ok && openclawAgentsProbe.json
      ? extractAgentNames(openclawAgentsProbe.data)
      : null;
    const agentsMeasured = Array.isArray(openclawAgentNames);
    const agentsUnknownReason = agentsMeasured
      ? null
      : (!openclawAgentsProbe.ok
        ? 'agents_endpoint_unreachable'
        : (!openclawAgentsProbe.json
          ? 'agents_endpoint_returned_non_json'
          : 'agents_payload_unrecognized'));

    if (openclawHealthProbe.ok || openclawAgentsProbe.ok) {
      healthStatus.services.openclaw = {
        status: 'up',
        baseUrl: resolvedOpenclawBaseUrl,
        baseUrls: openclawBaseUrls,
        healthEndpoint: openclawHealthProbe.ok ? openclawHealthProbe.url : null,
        // Only claim an agents endpoint when it actually yielded agent data;
        // pointing at a URL that served HTML implies a reading we did not get.
        agentsEndpoint: agentsMeasured ? openclawAgentsProbe.url : null,
        agentsEvidence: agentsMeasured ? 'measured' : 'unknown',
        agentsUnknownReason,
        agentCount: agentsMeasured ? openclawAgentNames.length : null,
        agents: agentsMeasured ? openclawAgentNames.slice(0, 30) : []
      };
    } else if (clawdxModels.length > 0) {
      healthStatus.services.openclaw = {
        status: 'degraded',
        baseUrl: resolvedOpenclawBaseUrl,
        baseUrls: openclawBaseUrls,
        healthEndpoint: null,
        agentsEndpoint: null,
        // Models are not agents. This branch previously reported the Ollama
        // model list under `agentCount`/`agents`, which reads as a healthy agent
        // roster when the OpenClaw API is in fact unreachable. The models stay
        // available under their own name as the weak signal they are.
        agentsEvidence: 'unknown',
        agentsUnknownReason: 'openclaw_api_unreachable',
        agentCount: null,
        agents: [],
        fallbackModelCount: clawdxModels.length,
        fallbackModels: clawdxModels.slice(0, 30),
        source: 'clawdx_ollama_fallback',
        error: openclawAgentsProbe.error || openclawHealthProbe.error || 'OpenClaw API unreachable'
      };
      healthStatus.status = 'degraded';
    } else {
      healthStatus.services.openclaw = {
        status: 'down',
        baseUrl: resolvedOpenclawBaseUrl,
        baseUrls: openclawBaseUrls,
        healthEndpoint: null,
        agentsEndpoint: null,
        // Unreachable means we do not know the roster. A `0` here would claim
        // OpenClaw is running with no agents, which is a different — and much
        // less alarming — statement than "OpenClaw is down".
        agentsEvidence: 'unknown',
        agentsUnknownReason: 'openclaw_api_unreachable',
        agentCount: null,
        agents: [],
        error: openclawAgentsProbe.error || openclawHealthProbe.error || 'OpenClaw API unreachable'
      };
      healthStatus.status = 'degraded';
    }

    // 8. System Metrics
    const memUsage = process.memoryUsage();
    healthStatus.system = {
      memory: {
        heapUsed: Math.round(memUsage.heapUsed / 1024 / 1024 * 100) / 100, // MB
        heapTotal: Math.round(memUsage.heapTotal / 1024 / 1024 * 100) / 100, // MB
        rss: Math.round(memUsage.rss / 1024 / 1024 * 100) / 100, // MB
        external: Math.round(memUsage.external / 1024 / 1024 * 100) / 100 // MB
      },
      uptime: Math.floor(process.uptime()),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version
    };

    // 9. Recent Metrics (last 24 hours)
    try {
      const PerformanceSnapshot = require('../models/PerformanceSnapshot');
      const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const recentSnapshots = await PerformanceSnapshot.find({
        hour: { $gte: oneDayAgo }
      }).lean();

      if (recentSnapshots.length > 0) {
        // Aggregate across all hourly snapshots
        const totalRequests = recentSnapshots.reduce((sum, s) => sum + (s.requests_total || 0), 0);
        const totalErrors = recentSnapshots.reduce((sum, s) => sum + (s.requests_failed || 0), 0);
        const avgLatency = recentSnapshots.reduce((sum, s) => sum + (s.latency?.avg || 0), 0) / recentSnapshots.length;

        healthStatus.metrics = {
          requests24h: totalRequests,
          avgLatency: Math.round(avgLatency * 100) / 100, // ms
          errorRate: totalRequests > 0
            ? Math.round((totalErrors / totalRequests) * 10000) / 100 // percentage
            : 0,
          errorCount: totalErrors
        };
      } else {
        healthStatus.metrics = {
          requests24h: 0,
          avgLatency: 0,
          errorRate: 0,
          errorCount: 0
        };
      }
    } catch (error) {
      logger.error('Failed to fetch recent metrics', { error: error.message });
      healthStatus.metrics = { error: 'Unable to fetch metrics' };
    }

    res.json(healthStatus);

  } catch (error) {
    logger.error('Health check failed', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Health check failed',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// ========================================
// Activity Timeline
// ========================================

/**
 * GET /api/operations/activity
 * Get recent system activity across all sources
 */
router.get('/activity', async (req, res) => {
  try {
    const { limit = 50, hours = 24 } = req.query;

    const cutoff = new Date(Date.now() - hours * 60 * 60 * 1000);

    // 1. Activity Logs
    const activityLogs = await ActivityLog.find({ timestamp: { $gte: cutoff } })
      .sort({ timestamp: -1 })
      .limit(parseInt(limit, 10))
      .lean();

    // 2. Recent Alerts (if Alert model exists)
    let recentAlerts = [];
    try {
      const Alert = require('../models/Alert');
      recentAlerts = await Alert.find({ createdAt: { $gte: cutoff } })
        .sort({ createdAt: -1 })
        .limit(20)
        .lean();
    } catch (e) {
      // Alert model may not exist
    }

    // 3. Merge and sort by timestamp
    const timeline = [
      ...activityLogs.map(log => ({
        type: 'activity',
        action: log.action,
        target: log.target,
        username: log.username,
        status: log.status,
        timestamp: log.timestamp,
        details: log.details
      })),
      ...recentAlerts.map(alert => ({
        type: 'alert',
        level: alert.level,
        message: alert.message,
        timestamp: alert.createdAt,
        resolved: alert.status === 'resolved'
      }))
    ].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, parseInt(limit, 10));

    res.json({
      status: 'success',
      data: timeline,
      total: timeline.length,
      period: `${hours}h`
    });

  } catch (error) {
    logger.error('Failed to get activity timeline', { error: error.message });
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch activity timeline',
      error: error.message
    });
  }
});

// ========================================
// Real-Time Events (SSE)
// ========================================

/**
 * GET /api/operations/events
 * Server-Sent Events endpoint for real-time dashboard updates
 */
router.get('/events', (req, res) => {
  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable Nginx buffering

  // Helper to send SSE event
  const sendEvent = (event, data) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Send initial connection event
  sendEvent('connected', {
    message: 'Operations dashboard connected',
    timestamp: new Date().toISOString()
  });

  // Import systemEvents from app
  const { systemEvents } = require('../src/app');

  // Event listeners
  const healthChangeHandler = (data) => {
    sendEvent('health-change', data);
  };

  const activityLogHandler = (data) => {
    sendEvent('activity', data);
  };

  const alertHandler = (data) => {
    sendEvent('alert', data);
  };

  const workflowTestHandler = (data) => {
    sendEvent('workflow-test', data);
  };

  const ragActivityHandler = (data) => {
    sendEvent('rag-activity', data);
  };

  // Register listeners
  systemEvents.on('health-change', healthChangeHandler);
  systemEvents.on('activity-log', activityLogHandler);
  systemEvents.on('alert-created', alertHandler);
  systemEvents.on('workflow-test', workflowTestHandler);
  systemEvents.on('rag-activity', ragActivityHandler);

  // Send heartbeat every 30 seconds to keep connection alive
  const heartbeatInterval = setInterval(() => {
    sendEvent('heartbeat', { timestamp: new Date().toISOString() });
  }, 30000);

  // Cleanup on client disconnect
  req.on('close', () => {
    clearInterval(heartbeatInterval);
    systemEvents.off('health-change', healthChangeHandler);
    systemEvents.off('activity-log', activityLogHandler);
    systemEvents.off('alert-created', alertHandler);
    systemEvents.off('workflow-test', workflowTestHandler);
    systemEvents.off('rag-activity', ragActivityHandler);
    logger.info('Dashboard client disconnected from SSE');
  });

  logger.info('Dashboard client connected to SSE');
});

module.exports = router;

// Exported for tests (task 0538). The empty-vs-unreadable distinction is the
// contract that keeps a health surface from reporting a confident zero it cannot
// justify, so it is covered directly rather than only through the route.
module.exports.extractAgentNames = extractAgentNames;
