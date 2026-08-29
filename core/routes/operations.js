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
const { normalizeHostUrl } = require('../src/helpers/ollamaHostConfig');
const {
  createOperationsHealthClient,
  publicOperationsHealthError,
} = require('../src/services/operationsHealthClient');

const DEFAULT_CLAWDX_OLLAMA_URL = '';

async function probeFirstJson(healthClient, paths) {
  let lastError = 'No response';
  let lastStatus = null;

  for (const path of paths) {
    try {
      const result = await healthClient.probeOptionalRuntime(path);
      lastStatus = result.status;

      if (result.ok) {
        return {
          ok: true,
          json: result.json,
          url: result.url,
          status: result.status,
          data: result.data
        };
      }

      lastError = `HTTP ${result.status}`;
    } catch (error) {
      lastError = publicOperationsHealthError(error);
    }
  }

  return { ok: false, error: lastError, status: lastStatus };
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
    const ollamaHost = normalizeHostUrl(process.env.OLLAMA_HOST) || 'http://localhost:11434';
    const qdrantUrl = process.env.QDRANT_URL || 'http://localhost:6333';
    const healthClient = createOperationsHealthClient({
      optionalRuntimeUrl: clawdxOllamaUrl,
      ollamaUrl: ollamaHost,
      qdrantUrl,
    });
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
      const response = await healthClient.getOllamaTags();

      if (response.ok) {
        const data = response.data;
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
          error: publicOperationsHealthError(error)
        };
      healthStatus.status = 'degraded';
    }

    // 6. Qdrant (if configured)
    if (process.env.VECTOR_STORE_TYPE === 'qdrant') {
      try {
        const response = await healthClient.getQdrantHealth();

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
          error: publicOperationsHealthError(error)
        };
      }
    }

    // 7. Optional runtime fallback plus external-adapter status
    const [clawdxTagsProbe, clawdxPsProbe] = await Promise.all([
      probeFirstJson(healthClient, ['/api/tags']),
      probeFirstJson(healthClient, ['/api/ps'])
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
