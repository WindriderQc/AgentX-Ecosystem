/**
 * @file server.js
 * @description AgentX Core — main server entry point
 * @service core
 */
require('dotenv').config();
const connectDB = require('./config/db');
const logger = require('./config/logger');
const { app } = require('./src/app');
const systemHealth = require('./src/systemHealth');
const { normalizeHostUrl } = require('./src/helpers/ollamaHostConfig');
const { flagEnabled, startSingletonDaemon } = require('./src/services/leaderLeaseService');
const { currentAgentXProfile, isDemoProfile } = require('../shared/agentxRuntimeProfile');

const PORT = process.env.PORT || 3080;
const HOST = process.env.HOST || 'localhost';
const OLLAMA_HOST = normalizeHostUrl(process.env.OLLAMA_HOST);
const AGENTX_PROFILE = currentAgentXProfile();
const DEMO_RUNTIME = isDemoProfile(AGENTX_PROFILE);
if (!OLLAMA_HOST) {
  logger.warn('OLLAMA_HOST not defined in environment variables. Some features may be disabled.');
} else if (String(process.env.OLLAMA_HOST || '').includes('0.0.0.0')) {
  logger.warn('OLLAMA_HOST used a wildcard bind address; normalized to loopback for client requests.', {
    configured: process.env.OLLAMA_HOST,
    effective: OLLAMA_HOST
  });
}

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack,
    promise: promise
  });
});

process.on('uncaughtException', (error) => {
  // EPIPE = closed pipe/socket, ECONNRESET = abrupt client disconnect — both harmless, do not crash.
  if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
    logger.debug(`${error.code} ignored (closed connection)`);
    return;
  }
  logger.error('Uncaught Exception', {
    message: error.message,
    stack: error.stack
  });
  // Give time for logs to flush, then exit
  setTimeout(() => process.exit(1), 1000);
});

// Prevent EPIPE on stdout/stderr from crashing the process (PM2 pipe issues)
process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

// Health Check Functions
async function checkMongoHealth() {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState === 1) {
      await mongoose.connection.db.admin().ping();
      return { healthy: true, message: 'Connected' };
    }
    return { healthy: false, message: 'Not connected' };
  } catch (err) {
    return { healthy: false, message: err.message };
  }
}

async function checkOllamaHealth() {
  try {
    const fetch = require('node-fetch');
    const response = await fetch(`${OLLAMA_HOST}/api/tags`, {
      method: 'GET',
      timeout: 2000
    });

    if (response.ok) {
      return { healthy: true, message: 'Connected' };
    }
    return { healthy: false, message: `HTTP ${response.status}` };
  } catch (err) {
    return { healthy: false, message: err.message };
  }
}

const singletonDaemonControllers = [];

async function startCoreSingletonDaemon({ name, label, start, stop }) {
  const leaderLeaseEnabled = flagEnabled(process.env.CORE_LEADER_LEASE_ENABLED);
  const mongoose = leaderLeaseEnabled ? require('mongoose') : null;
  const controller = await startSingletonDaemon({
    name,
    db: mongoose?.connection?.db,
    enabled: leaderLeaseEnabled,
    start,
    stop,
    logger
  });

  singletonDaemonControllers.push(controller);
  if (controller.mode === 'leader-lease' && !controller.isLeader) {
    console.log(`   ⓘ ${label}: Standby (leader lease held elsewhere)`);
  }
  return controller;
}

// Health Check - Detailed
app.get('/health/detailed', async (_req, res) => {
  // Refresh checks
  const mongoStatus = await checkMongoHealth();
  const ollamaStatus = await checkOllamaHealth();

  const health = {
    status: mongoStatus.healthy ? 'healthy' : 'degraded',
    profile: AGENTX_PROFILE,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    services: {
      mongodb: {
        status: mongoStatus.healthy ? 'connected' : 'error',
        message: mongoStatus.message,
        lastCheck: new Date().toISOString()
      },
      ollama: {
        status: ollamaStatus.healthy ? 'connected' : 'error',
        required: false,
        message: ollamaStatus.message,
        host: OLLAMA_HOST,
        lastCheck: new Date().toISOString()
      }
    },
    system: {
      nodeVersion: process.version,
      platform: process.platform,
      memory: {
        used: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + 'MB',
        total: Math.round(process.memoryUsage().heapTotal / 1024 / 1024) + 'MB'
      }
    }
  };

  const statusCode = mongoStatus.healthy ? 200 : 503;
  res.status(statusCode).json(health);
});


// Startup initialization - perform health checks before starting server
async function startServer() {
  const packageJson = require('./package.json');
  console.log(`\n╔════════════════════════════════════════════════════════╗`);
  console.log(`║                   Agent X Core v${packageJson.version}                  ║`);
  console.log(`╚════════════════════════════════════════════════════════╝\n`);
  console.log(`🔍 Checking system dependencies...\n`);

  // Check MongoDB
  try {
    await connectDB();
    systemHealth.mongodb = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
    console.log(`   ✓ MongoDB:  Connected`);
    logger.info('MongoDB connected successfully');

    // Seed default data
    try {
      const seedDefaultData = require('./src/helpers/initDb');
      await seedDefaultData();
    } catch (seedErr) {
      logger.warn('Failed to seed default data', { error: seedErr.message });
    }

    // Load dynamic routing overrides from MongoDB
    try {
      const { ensureTaskModelOverridesLoaded } = require('./src/services/modelRouterConfig');
      const overrides = await ensureTaskModelOverridesLoaded({ force: true });
      const count = Object.keys(overrides).length;
      if (count > 0) {
        console.log(`   ✓ Routing:  ${count} task override(s) loaded from DB`);
      } else {
        console.log(`   ✓ Routing:  Using static defaults`);
      }
    } catch (routeErr) {
      logger.warn('Dynamic routing load failed (using static defaults)', { error: routeErr.message });
    }

    // Sync model registry from Ollama hosts
    try {
      const { syncAllHosts } = require('./src/services/modelSync/syncOrchestrator');
      const syncResult = await syncAllHosts();
      const syncParts = [];
      if (syncResult.created) syncParts.push(`${syncResult.created} new`);
      if (syncResult.updated) syncParts.push(`${syncResult.updated} updated`);
      if (syncResult.retired) syncParts.push(`${syncResult.retired} retired`);
      if (syncParts.length > 0) {
        console.log(`   ✓ Registry: Synced ${syncParts.join(', ')}`);
      } else {
        console.log(`   ✓ Registry: ${syncResult.unchanged} models up to date`);
      }
    } catch (syncErr) {
      logger.warn('Model registry sync failed (non-fatal)', { error: syncErr.message });
    }

  } catch (err) {
    systemHealth.mongodb = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
    console.log(`   ✗ MongoDB:  ${err.message}`);
    logger.warn('Starting without database connection - some features will be limited', { error: err.message });
  }

  // Check Ollama
  try {
    const ollamaResult = await checkOllamaHealth();
    if (ollamaResult.healthy) {
      systemHealth.ollama = { status: 'connected', lastCheck: new Date().toISOString(), error: null };
      console.log(`   ✓ Ollama:   Connected (${OLLAMA_HOST})`);
      logger.info('Ollama connected successfully', { host: OLLAMA_HOST });

      // Full-profile operators may explicitly prewarm configured defaults.
      // The demo only discovers models; it never consumes VRAM implicitly.
      if (!DEMO_RUNTIME) {
        try {
          const hostPrefService = require('./src/services/hostPreferenceService');
          const prefs = await hostPrefService.getAll();
          console.log(`   ✓ Host Preferences: ${prefs.length} host(s) configured`);
          hostPrefService.warmAllDefaults().then(results => {
            for (const r of results) {
              if (r.status === 'ok') {
                console.log(`   ✓ Default: ${r.model} loaded on ${r.host} (${r.durationMs}ms)`);
              } else {
                console.log(`   ⚠ Default: ${r.model} on ${r.host} — ${r.error}`);
              }
            }
          }).catch(warmErr => {
            console.log(`   ⚠ Warm defaults: ${warmErr.message}`);
          });
          await startCoreSingletonDaemon({
            name: 'host-preference-health-check',
            label: 'Host preference health check',
            start: async () => {
              hostPrefService.startHealthCheck();
              const intervalSec = typeof hostPrefService.getHealthCheckIntervalMs === 'function'
                ? Math.round(hostPrefService.getHealthCheckIntervalMs() / 1000)
                : 60;
              console.log(`   ✓ Host preference health check: Active (${intervalSec}s interval)`);
            },
            stop: async () => {
              if (typeof hostPrefService.stopHealthCheck === 'function') hostPrefService.stopHealthCheck();
            }
          });
        } catch (warmErr) {
          console.log(`   ⚠ Host Preferences: ${warmErr.message}`);
        }
      } else {
        console.log('   ⓘ Model prewarm and host health polling: Disabled in demo profile');
      }
    } else {
      throw new Error(ollamaResult.message);
    }
  } catch (err) {
    systemHealth.ollama = { status: 'error', lastCheck: new Date().toISOString(), error: err.message };
    console.log(`   ✗ Ollama:   ${err.message} (${OLLAMA_HOST})`);
    logger.warn('Ollama not available - chat features will not work until Ollama is running', {
      error: err.message,
      host: OLLAMA_HOST
    });
  }

  // Keep systemHealth live so the basic /health endpoint self-heals. /health is
  // a cheap read of the cached systemHealth snapshot (monitors hit it often), so
  // without a refresher it stays frozen at the boot-time value forever — task
  // 0396: /health reported ollama:error for ~40min during a host cutover while
  // Ollama was actually up, until a manual container restart. Re-probe on an
  // interval; unref() so the timer never keeps the process alive.
  const HEALTH_REFRESH_MS = Number(process.env.HEALTH_REFRESH_MS) || 30_000;
  const healthRefreshTimer = setInterval(async () => {
    try {
      const r = await checkOllamaHealth();
      systemHealth.ollama = r.healthy
        ? { status: 'connected', lastCheck: new Date().toISOString(), error: null }
        : { status: 'error', lastCheck: new Date().toISOString(), error: r.message };
      const rs = require('mongoose').connection.readyState;
      systemHealth.mongodb.status = rs === 1 ? 'connected' : 'error';
    } catch (refreshErr) {
      logger.debug('health refresh tick failed', { error: refreshErr.message });
    }
  }, HEALTH_REFRESH_MS);
  if (typeof healthRefreshTimer.unref === 'function') healthRefreshTimer.unref();

  // Full-profile operational daemons never run in the product demo.
  if (!DEMO_RUNTIME) {
  // Auto-resolve stale alerts (task 0361). Event-driven alerts have no "cleared"
  // signal, so a condition that stops recurring (e.g. a host recovered) would
  // leave its alert active indefinitely. Sweep periodically; the reaper is
  // idempotent (a filtered updateMany) so running it is always safe.
  try {
    const alertService = require('./src/services/alertService');
    let staleAlertTimer = null;
    await startCoreSingletonDaemon({
      name: 'alert-stale-resolver',
      label: 'Alert Auto-Resolver',
      start: async () => {
        const tick = () => alertService.resolveStaleAlerts()
          .catch(err => logger.debug('stale-alert sweep failed', { error: err.message }));
        tick();
        staleAlertTimer = setInterval(tick, Number(process.env.ALERT_STALE_SWEEP_MS) || 300000);
        if (typeof staleAlertTimer.unref === 'function') staleAlertTimer.unref();
        console.log('   ✓ Alert Auto-Resolver: Active (stale sweep)');
      },
      stop: async () => { if (staleAlertTimer) { clearInterval(staleAlertTimer); staleAlertTimer = null; } }
    });
  } catch (err) {
    console.log(`   ⚠ Alert Auto-Resolver: ${err.message}`);
  }

  // Start Host Monitor service (stale-host detection)
  try {
    const hostMonitorService = require('./src/services/hostMonitorService');
    await startCoreSingletonDaemon({
      name: 'host-monitor-stale-detection',
      label: 'Host Monitor',
      start: async () => {
        hostMonitorService.start();
        console.log(`   ✓ Host Monitor: Active`);
      },
      stop: async () => hostMonitorService.stop()
    });
  } catch (err) {
    console.log(`   ⚠ Host Monitor: ${err.message}`);
  }

  // Start Ollama Enrichment service (polls configured Ollama hosts for telemetry)
  try {
    const ollamaEnrichmentService = require('./src/services/ollamaEnrichmentService');
    await startCoreSingletonDaemon({
      name: 'ollama-enrichment',
      label: 'Ollama Enrichment',
      start: async () => {
        ollamaEnrichmentService.start();
        console.log(`   ✓ Ollama Enrichment: Active`);
      },
      stop: async () => ollamaEnrichmentService.stop()
    });
  } catch (err) {
    console.log(`   ⚠ Ollama Enrichment: ${err.message}`);
  }

  // Start Ollama Watchdog (inference jam detection + auto-recovery)
  try {
    const ollamaWatchdog = require('./src/services/ollamaWatchdogService');
    await startCoreSingletonDaemon({
      name: 'ollama-watchdog',
      label: 'Ollama Watchdog',
      start: async () => {
        ollamaWatchdog.start();
        console.log(`   ✓ Ollama Watchdog: Active`);
      },
      stop: async () => ollamaWatchdog.stop()
    });
  } catch (err) {
    console.log(`   ⚠ Ollama Watchdog: ${err.message}`);
  }

  // Hourly inference aggregation — populates HostUsageLedger
  try {
    const { aggregateHour } = require('./src/services/hostUsageAggregator');
    let usageAggregationInterval = null;
    await startCoreSingletonDaemon({
      name: 'host-usage-aggregator',
      label: 'Usage Aggregator',
      start: async () => {
        aggregateHour().catch(err => console.warn('Initial aggregation failed:', err.message));
        usageAggregationInterval = setInterval(() => {
          aggregateHour().catch(err => console.warn('Hourly aggregation failed:', err.message));
        }, 3_600_000);
        console.log(`   ✓ Usage Aggregator: Active (hourly)`);
      },
      stop: async () => {
        if (usageAggregationInterval) {
          clearInterval(usageAggregationInterval);
          usageAggregationInterval = null;
        }
      }
    });
  } catch (err) {
    console.log(`   ⚠ Usage Aggregator: ${err.message}`);
  }
  } else {
    console.log('   ⓘ Operational monitors and usage aggregation: Disabled in demo profile');
  }

  // Stale benchmark-claim reaper — if a batch crashes between claim and
  // release, HostPreference.status stays 'benchmarking' and blocks consumers.
  // Grace factor (1.5×estimatedDurationMs) and hard cap (2h) live in
  // hostPreferenceService.reapStaleBenchmarkClaims. Interval is
  // env-configurable via BENCHMARK_CLAIM_REAP_INTERVAL_MS (default 5 min).
  try {
    const hostPrefSvc = require('./src/services/hostPreferenceService');
    const startReaper = async () => {
      // One immediate sweep so a freshly-booted core doesn't wait a full
      // interval to clear any claim left over from the previous process.
      hostPrefSvc.reapStaleBenchmarkClaims()
        .then(r => { if (r.reaped.length > 0) console.warn(`   ♻ Reaped ${r.reaped.length} stale benchmark claim(s)`); })
        .catch(err => console.warn('Benchmark claim reap failed:', err.message));
      hostPrefSvc.startBenchmarkClaimReaper();
      const intervalSec = hostPrefSvc.getBenchmarkClaimReaperIntervalMs() / 1000;
      console.log(`   ✓ Benchmark Claim Reaper: Active (every ${intervalSec}s)`);
    };
    const stopReaper = async () => hostPrefSvc.stopBenchmarkClaimReaper();
    await startCoreSingletonDaemon({
      name: 'benchmark-claim-reaper',
      label: 'Benchmark Claim Reaper',
      start: startReaper,
      stop: stopReaper
    });
  } catch (err) {
    console.log(`   ⚠ Benchmark Claim Reaper: ${err.message}`);
  }

  if (!DEMO_RUNTIME) {
  // Load default alert rules (seed to MongoDB + sync to in-memory engine)
  try {
    const { seedDefaultRules, syncRulesToEngine } = require('./src/services/alertRuleSeeder');
    const seeded = await seedDefaultRules();
    await syncRulesToEngine();
    const AlertRule = require('./models/AlertRule');
    const total = await AlertRule.countDocuments({ enabled: true });
    console.log(`   ✓ Alert Rules: ${total} enabled rules loaded${seeded > 0 ? ` (${seeded} defaults seeded)` : ''}`);
  } catch (err) {
    // Fallback: load from JSON if MongoDB seeding fails
    try {
      const { getAlertService } = require('./src/services/alertService');
      const defaultRules = require('./config/default-alert-rules.json');
      const alertService = getAlertService();
      if (alertService && typeof alertService.loadRules === 'function') {
        alertService.loadRules(defaultRules);
        console.log(`   ✓ Alert Rules: Loaded ${defaultRules.length} default rules (JSON fallback)`);
      }
    } catch (fallbackErr) {
      console.warn('   ⚠ Alert Rules:', err.message);
    }
  }

  // Observe benchmark-qualified inference lanes without touching routing,
  // claims, pins, or model residency (task 0465). Event-driven contract and
  // lifecycle signals flow through the same service; this singleton daemon
  // only runs the sample-gated latency comparison.
  try {
    const laneObservability = require('./src/services/laneObservabilityService');
    await startCoreSingletonDaemon({
      name: 'lane-observability-monitor',
      label: 'Lane Observability',
      start: async () => {
        laneObservability.start();
        console.log('   ✓ Lane Observability: Active (observe-only, 5m latency scan)');
      },
      stop: async () => laneObservability.stop()
    });
  } catch (err) {
    console.log(`   ⚠ Lane Observability: ${err.message}`);
  }

  // Host capacity monitor — emits capacity alerts (VRAM pressure, GPU imbalance,
  // underused-while-busier, host/Ollama down) for the configured Ollama hosts.
  // Disable with HOST_CAPACITY_MONITOR=0; cadence via HOST_CAPACITY_MONITOR_INTERVAL_MS.
  try {
    const flag = String(process.env.HOST_CAPACITY_MONITOR ?? '1').toLowerCase();
    if (['0', 'false', 'off'].includes(flag)) {
      console.log('   ⓘ Host Capacity Monitor: Disabled (HOST_CAPACITY_MONITOR)');
    } else {
      const { checkCapacityAlerts } = require('./src/services/hostCapacityService');
      const intervalMs = Math.max(60_000, parseInt(process.env.HOST_CAPACITY_MONITOR_INTERVAL_MS, 10) || 300_000);
      const run = () => checkCapacityAlerts().catch(err => console.warn('Host capacity check failed:', err.message));
      let firstRunTimer = null;
      let capacityInterval = null;
      await startCoreSingletonDaemon({
        name: 'host-capacity-monitor',
        label: 'Host Capacity Monitor',
        start: async () => {
          // Defer the first run so host metrics/telemetry are warm after boot.
          firstRunTimer = setTimeout(run, 60_000);
          capacityInterval = setInterval(run, intervalMs);
          console.log(`   ✓ Host Capacity Monitor: Active (every ${Math.round(intervalMs / 1000)}s)`);
        },
        stop: async () => {
          if (firstRunTimer) {
            clearTimeout(firstRunTimer);
            firstRunTimer = null;
          }
          if (capacityInterval) {
            clearInterval(capacityInterval);
            capacityInterval = null;
          }
        }
      });
    }
  } catch (err) {
    console.log(`   ⚠ Host Capacity Monitor: ${err.message}`);
  }

  // Durable platform backups. Docker enables this by default after wiring a
  // host-visible /backups mount and the MongoDB database tools into Core. Each
  // cycle attempts Mongo, runtime config, and Qdrant independently so one
  // failing layer cannot prevent the others from being protected.
  try {
    const backupScheduler = require('./src/services/backupSchedulerService');
    if (!backupScheduler.isEnabled()) {
      console.log('   ⓘ Backup Scheduler: Disabled (BACKUP_SCHEDULE_ENABLED)');
    } else {
      await startCoreSingletonDaemon({
        name: 'platform-backup-scheduler',
        label: 'Backup Scheduler',
        start: async () => {
          backupScheduler.start();
          const status = backupScheduler.getStatus();
          console.log(`   ✓ Backup Scheduler: Active (every ${Math.round(status.intervalMs / 3600000)}h)`);
        },
        stop: async () => backupScheduler.stop()
      });
    }
  } catch (err) {
    console.log(`   ⚠ Backup Scheduler: ${err.message}`);
  }
  } else {
    console.log('   ⓘ Alerts, capacity monitoring, lane monitoring, and backups: Disabled in demo profile');
  }

  // Start Express server
  app.listen(PORT, () => {
    console.log(`\n${'─'.repeat(58)}`);
    console.log(`🚀 Server:    http://${HOST}:${PORT}`);
    console.log(`💚 Health:    http://${HOST}:${PORT}/health/detailed`);
    console.log(`📚 Docs:      /docs folder`);
    console.log(`📋 Logs:      logs/combined.log & logs/error.log`);
    console.log(`${'─'.repeat(58)}\n`);

    const isHealthy = systemHealth.mongodb.status === 'connected';

    if (isHealthy) {
      console.log(`✅ Required product services are ready\n`);
      if (systemHealth.ollama.status !== 'connected') {
        console.log(`   ⓘ Ollama is optional and currently unavailable: ${systemHealth.ollama.error}\n`);
      }
    } else {
      console.log(`⚠️  WARNING: Running in degraded mode\n`);
      if (systemHealth.mongodb.status !== 'connected') {
        console.log(`   MongoDB Issue: ${systemHealth.mongodb.error}`);
      }
      console.log(`\n   Restore required dependencies before using the product.\n`);
    }

    logger.info('AgentX Core server started', {
      port: PORT,
      host: process.env.SERVER_HOST || 'localhost',
      environment: process.env.NODE_ENV || 'development',
      mongodb: systemHealth.mongodb.status,
      ollama: systemHealth.ollama.status,
      healthy: isHealthy
    });

    // Live Data → Buddy demo (TODO 0288) — opt-in via LIVEDATA_BUDDY_DEMO=true.
    if (!DEMO_RUNTIME && process.env.LIVEDATA_BUDDY_DEMO === 'true') {
      try {
        const liveDataWatcher = require('./src/services/liveDataWatcher');
        startCoreSingletonDaemon({
          name: 'live-data-buddy-demo',
          label: 'Live Data → Buddy demo',
          start: async () => {
            if (liveDataWatcher.start()) console.log('   ✓ Live Data → Buddy demo: watching data quake feed');
          },
          stop: async () => liveDataWatcher.stop()
        }).catch(err => {
          console.warn('   ⚠ Live Data → Buddy demo:', err.message);
        });
      } catch (err) {
        console.warn('   ⚠ Live Data → Buddy demo:', err.message);
      }
    }
  });
}

// Start the server
startServer().catch(err => {
  logger.error('Failed to start server', { error: err.message, stack: err.stack });
  console.error(`\n❌ Fatal Error: ${err.message}\n`);
  process.exit(1);
});
