require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const mongoSanitize = require('express-mongo-sanitize');
const logger = require('../config/logger');
const { requestLogger, errorLogger } = require('./middleware/logging');
const systemHealth = require('./systemHealth');
const { normalizeHostUrl } = require('./helpers/ollamaHostConfig');
const { refreshOllamaHealth } = require('./services/ollamaHealthProbe');
const {
  getOpenClawRuntimeConfig,
  isOpenClawIntegrationEnabled,
} = require('./services/openclawClient');
const voiceSettings = require('./services/voixSettingsService');
const { normalizePublicUrls } = require('../../shared/browserPublicUrls');
const {
  currentAgentXProfile,
  isDemoProfile,
  createAgentXProfileGuard,
} = require('../../shared/agentxRuntimeProfile');
const {
  loadAgentXExtensions
} = require('./extensions/extensionLoader');
const { conversationLifecycle } = require('./services/conversationLifecycleService');

// Browser-reachable URLs for each service. Distinct from server-to-server
// URLs (BENCHMARK_SERVICE_URL etc.) which use container-DNS names inside
// docker. These are what rendered HTML / public JS embed into <a href>
// and fetch() calls — they have to resolve from a *remote* browser. On a
// single-host setup the localhost defaults work; on multi-host or LAN
// setups the operator provides an explicit browser-reachable URL.
function getPublicUrls() {
  return normalizePublicUrls({
    core: process.env.CORE_PUBLIC_URL,
    benchmark: process.env.BENCHMARK_PUBLIC_URL,
    rag: process.env.RAG_PUBLIC_URL,
    data: process.env.DATAAPI_PUBLIC_URL,
    hermes: process.env.HERMES_PUBLIC_URL || process.env.HERMES_DASHBOARD_URL,
    openclawControl: process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL || process.env.OPENCLAW_GATEWAY_URL,
  });
}

function getLeantimePipelineConfig() {
  const baseUrl = String(process.env.LEANTIME_BASE_URL || '').replace(/\/+$/, '');
  const projectId = Number(process.env.AGENTX_PIPELINE_PROJECT_ID || 3);
  const safeProjectId = Number.isFinite(projectId) && projectId > 0 ? projectId : 3;
  return {
    baseUrl,
    projectId: safeProjectId,
    boardUrl: baseUrl
      ? `${baseUrl}/tickets/showKanban?projectId=${encodeURIComponent(safeProjectId)}`
      : ''
  };
}

// Initialize app
const app = express();
const agentxProfile = currentAgentXProfile();
// Expose browser-reachable service URLs to all rendered views.
app.locals.publicUrls = getPublicUrls();
app.locals.agentxProfile = agentxProfile;
app.locals.openclawControl = getOpenClawRuntimeConfig().controlUi;
app.locals.publicUrls.openclawControl = app.locals.openclawControl.launchBaseUrl;
const IN_PROD = process.env.NODE_ENV === 'production';
const IN_TEST = process.env.NODE_ENV === 'test';
// Service identity for the canonical health envelope (task 0355). Read once at
// load; falls back gracefully if package.json is ever unreadable.
const SERVICE_VERSION = (() => {
  try { return require('../package.json').version || '0.0.0'; }
  catch { return '0.0.0'; }
})();

// EventEmitter for system events (SSE broadcasting)
const EventEmitter = require('events');
const systemEvents = new EventEmitter();

// Security Headers Configuration
if (process.env.NODE_ENV === 'production') {
  // Production in this workspace is often served over trusted localhost or
  // plain HTTP on a private LAN. Avoid HTTPS-forcing headers that would break
  // local-network asset loading when TLS is not actually configured.
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: [
          "'self'",
          "'unsafe-inline'", // TODO: Remove after refactoring inline scripts
          "https://cdn.jsdelivr.net" // marked.js, Chart.js
        ],
        styleSrc: [
          "'self'",
          "'unsafe-inline'", // TODO: Remove after refactoring inline styles
          "https://fonts.googleapis.com",
          "https://cdnjs.cloudflare.com"
        ],
        fontSrc: [
          "'self'",
          "https://fonts.gstatic.com",
          "https://cdnjs.cloudflare.com",
          "data:"
        ],
        imgSrc: [
          "'self'",
          "data:", // Base64 images
          "https:" // Allow external images (user avatars, etc.)
        ],
        mediaSrc: [
          "'self'",
          "blob:" // Blob URLs for client-side audio playback (Voice page TTS)
        ],
        connectSrc: [
          "'self'",
          "https://cdn.jsdelivr.net"
          // Add Ollama hosts if external
          // process.env.OLLAMA_HOST ? new URL(process.env.OLLAMA_HOST).origin : null
        ].filter(Boolean),
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"], // Equivalent to X-Frame-Options: DENY
        scriptSrcAttr: ["'none'"]
      }
    },
    hsts: false,
    referrerPolicy: {
      policy: 'strict-origin-when-cross-origin'
    },
    crossOriginOpenerPolicy: false,
    originAgentCluster: false,
    noSniff: true, // X-Content-Type-Options: nosniff
    xssFilter: true, // X-XSS-Protection: 1; mode=block
    hidePoweredBy: true // Remove X-Powered-By header
  }));

  logger.info('Production security headers enabled (Helmet + CSP)');
} else {
  // Development: Basic security headers only (for local network compatibility)
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });

  logger.info('Development security headers enabled (basic)');
}

// Middleware Setup
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(o => o.trim())
  : IN_PROD
    ? ['http://localhost:3080', 'http://127.0.0.1:3080', 'http://localhost:3081', 'http://127.0.0.1:3081']
    : true;

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(cookieParser());

// Response Compression (Week 3 Day 12: Performance Optimization)
const compression = require('compression');
app.use(compression({
  level: 6, // Balance between speed and compression ratio
  threshold: 1024, // Only compress responses > 1KB
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false; // Skip compression if client requests it
    }
    // Never compress SSE streams — breaks chunked transfer encoding
    if (req.path === '/api/buddy/events/stream'
      || req.path === '/api/consumers/nestor/v1/events/stream') return false;
    const ct = res.getHeader('Content-Type');
    if (typeof ct === 'string' && ct.includes('text/event-stream')) return false;
    return compression.filter(req, res);
  }
}));

// Default payload limit — kept generous for data-proxy and RAG uploads.
// Parse the Nestor contract before the broad compatibility parser so its
// advertised 1 MiB transport limit cannot be bypassed by global middleware.
function requireNestorJsonEntity(req, res, next) {
  const hasEntity = Number(req.get('content-length') || 0) > 0 || Boolean(req.get('transfer-encoding'));
  if (hasEntity && !req.is('application/json')) {
    const message = 'Nestor v1 request bodies must use application/json.';
    return res.status(415).json({
      ok: false,
      status: 'error',
      error: message,
      message,
      code: 'NESTOR_UNSUPPORTED_MEDIA_TYPE'
    });
  }
  return next();
}
const chatJsonParser = express.json({ limit: '1mb' });
app.use('/api/consumers/nestor/v1', requireNestorJsonEntity, chatJsonParser);

// Parse memory-review bodies before the broad 50 MiB compatibility parser.
// Mounting a tighter parser later does not help because Express would already
// have consumed the body. This keeps the advertised 1 MiB boundary real for
// content-length and chunked requests alike.
const {
  memoryReviewJsonParser,
  requireMemoryReviewJsonEntity,
} = require('./middleware/memoryReviewTransport');
app.use(
  '/api/memory-review',
  requireMemoryReviewJsonEntity,
  memoryReviewJsonParser
);

// Route-specific tighter limits are applied below via parsers.
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Tighter JSON parsers for routes that should never receive large payloads.
const standardJsonParser = express.json({ limit: '5mb' });

// Sanitize MongoDB queries (prevent NoSQL injection)
app.use(mongoSanitize({
  replaceWith: '_',
  onSanitize: ({ req, key }) => {
    logger.warn('Sanitized malicious input', {
      ip: req.ip,
      key,
      path: req.path
    });
  }
}));

// Correlation ID — propagate or generate for cross-service tracing
const correlationId = require('./middleware/correlationId');
app.use(correlationId);

const { publicExposureGuard } = require('./middleware/publicExposureGuard');
app.use(publicExposureGuard);

// The public demo profile keeps product primitives available while making
// personal/operational integrations unreachable even if a caller knows an old
// route. This guard runs before route modules can perform upstream work.
app.use(createAgentXProfileGuard(agentxProfile));

// Request logging middleware
app.use(requestLogger);

// Performance tracking middleware (must come early to track all requests)
const performanceTracker = require('./middleware/performanceTracker');
app.use(performanceTracker.trackRequest);

// Add canonical ok/error fields to legacy {status,message,data} JSON bodies
// without removing the legacy fields that current frontend code still reads.
const { responseEnvelopeCompatibility } = require('./middleware/responseEnvelopeCompatibility');
app.use(responseEnvelopeCompatibility);

// ============================================
// API ROUTES (must come BEFORE static files)
// ============================================

// Apply rate limiters
const {
  apiLimiter,
  automationControlLimiter,
  chatLimiter,
  inferenceCallerRouter
} = require('./middleware/rateLimiter');

// Apply caller-aware rate limiter to /api/inference/generate
// Routes benchmark callers (callerDetail: benchmark-*) to 5000/15min bucket
// Routes others to general 500/15min bucket
app.use('/api/inference/generate', inferenceCallerRouter);

// Keep agent lifecycle and inference proxies out of the external/browser API
// bucket. Each path still has a finite, independently tracked 5000/15min cap.
app.use('/api/pipeline', automationControlLimiter);
app.use('/api/openclaw-ollama', automationControlLimiter);
app.use('/api/hermes-openai', automationControlLimiter);

// Apply general API rate limiter to all /api routes (except specific ones)
app.use('/api/', apiLimiter);

// Trusted operator extensions are explicit, absolute-path modules and only
// load in the full profile. Register them before built-ins so an operations
// repository can own a declared capability without patching product source.
const agentxExtensions = loadAgentXExtensions({
  app,
  express,
  mongoose,
  logger,
  profile: agentxProfile,
  standardJsonParser,
  conversationLifecycle
});
app.locals.agentxExtensions = agentxExtensions;

// Alert routes (Track 1: Alerts & Notifications)
const alertRoutes = require('../routes/alerts');
app.use('/api/alerts', standardJsonParser, alertRoutes);

// V4: Mount Analytics routes
const analyticsRoutes = require('../routes/analytics');
app.use('/api/analytics', standardJsonParser, analyticsRoutes);

// Federated cost & consumption (task 0166, extracted in 0188)
const analyticsFederatedRoutes = require('../routes/analytics-federated');
app.use('/api/analytics', standardJsonParser, analyticsFederatedRoutes);

// Cluster schedule (unified cross-host task schedule + live state)
const clusterScheduleRoutes = require('../routes/cluster-schedule');
app.use('/api/cluster', clusterScheduleRoutes);

// Custom Model Management routes
const customModelsRoutes = require('../routes/custom-models');
app.use('/api/custom-models', customModelsRoutes);

// History routes
const historyRoutes = require('../routes/history');
app.use('/api/history', historyRoutes);

// Host monitoring (agent heartbeats + dashboard)
const hostMonitorRoutes = require('../routes/host-monitor');
app.use('/api/hosts', hostMonitorRoutes);
app.use('/api/host-monitor', hostMonitorRoutes);

// Model Registry routes
const modelRegistryRoutes = require('../routes/model-registry');
app.use('/api/models/registry', modelRegistryRoutes);

// Nerve Center (intelligence summary, routing, failover, host preferences, health feed)
const nerveCenterRoutes = require('../routes/nerve-center');
app.use('/api/nerve-center', nerveCenterRoutes);

// Agent Ops — read-only projection of agent ownership, runtime state,
// recurring work, and pipeline responsibility.
const agentOpsRoutes = require('../routes/agent-ops');
app.use('/api/agent-ops', agentOpsRoutes);

// Unified Models API (Aggregates Ollama + custom + registry)
const modelsUnifiedRoutes = require('../routes/models-unified');
app.use('/api/models', modelsUnifiedRoutes);

// Ollama hosts routes (configuration and models)
const ollamaHostsRoutes = require('../routes/ollama-hosts');
app.use('/api/ollama-hosts', ollamaHostsRoutes);

// Ollama VRAM metrics (via SSH + nvidia-smi)
const ollamaVramRoutes = require('../routes/ollama-vram');
app.use('/api/ollama-vram', ollamaVramRoutes);

// Ollama Watchdog (inference jam detection + auto-recovery)
const ollamaWatchdogRoutes = require('../routes/ollama-watchdog');
app.use('/api/ollama-watchdog', ollamaWatchdogRoutes);

// Operations Center routes (unified health, workflows, activity)
const operationsRoutes = require('../routes/operations');
app.use('/api/operations', operationsRoutes);

// Operations: backup / restore (mongo, config tarballs, qdrant) — extracted in 0190
const operationsBackupRoutes = require('../routes/operations-backup');
app.use('/api/operations', operationsBackupRoutes);

// VoiX engine proxy routes
const voixRoutes = require('../routes/voix');
app.use('/api/voix', voixRoutes);

// Voice persona packs, safety, scoped memory, and audit primitives
const voicePersonaRoutes = require('../routes/voice-personas');
app.use('/api/voice-personas', standardJsonParser, voicePersonaRoutes);

// Council: bounded, user-invoked multi-model deliberation. The API keeps its
// historical /api/roundtable contract so saved clients and transcripts remain
// compatible; /council is the canonical user-facing surface.
const roundtableRoutes = require('../routes/roundtable');
app.use('/api/roundtable', roundtableRoutes);

// Performance routes
const performanceRoutes = require('../routes/performance');
app.use('/api/performance', performanceRoutes);

// Prompt management routes (A/B testing)
const promptRoutes = require('../routes/prompts');
app.use('/api/prompts', promptRoutes);

// Prompt template routes (CRUD, render, duplicate)
const promptTemplateRoutes = require('../routes/prompt-templates');
app.use('/api/prompt-templates', promptTemplateRoutes);

// Lightweight profile routes for chat UI compatibility
const profileRoutes = require('../routes/profile');
app.use('/api/profile', profileRoutes);

// Standalone RAG service proxy routes
const ragRoutes = require('../routes/rag');
app.use('/api/rag', ragRoutes);

// Data service proxy routes (storage, files, network, live data, databases)
const dataProxyRoutes = require('../routes/data-proxy');
app.use('/api/data', dataProxyRoutes);

// Benchmark service proxy routes (recommendations)
const benchmarkProxyRoutes = require('../routes/benchmark-proxy');
app.use('/api/benchmark-proxy', benchmarkProxyRoutes);

// Consolidated report endpoints for OpenClaw agents
const reportsRoutes = require('../routes/reports');
app.use('/api/reports', reportsRoutes);

// Ecosystem Memory Review: approval-first cross-runtime memory candidates.
// The 1 MiB parser is installed above the broad compatibility parser;
// observation batches are additionally capped by policy and raw transcript
// payloads are refused by the bounded review contract.
const memoryReviewRoutes = require('../routes/memory-review');
app.use('/api/memory-review', memoryReviewRoutes);

// Deterministic TODO authoring endpoint for the Nestor -> pipeline membrane
const todosRoutes = require('../routes/todos');
app.use('/api/todos', standardJsonParser, todosRoutes);

// Secretary lane: Nestor's personal-task list (add/list/complete). Separate
// from the dev pipeline — `service: personal` tasks are already excluded from
// worker dispatch by buildNextTaskQuery (task 0457).
const secretaryRoutes = require('../routes/secretary');
app.use('/api/secretary', standardJsonParser, secretaryRoutes);

// Pipeline spine: Mongo is the source of truth; Leantime is a bidirectional
// view (agent pushes status, human drags cards / drops ideas back). Reads open,
// mutators token-gated inside the router. Cutover 2026-06-26 (git TODO/ retired).
const pipelineRoutes = require('../routes/pipeline');
app.use('/api/pipeline', standardJsonParser, pipelineRoutes);

// AgentX-native planning: workstreams, outcomes, milestones, ideas, decisions,
// evidence, and linkage to the pipeline/runtime schedule.
const planningRoutes = require('../routes/planning');
app.use('/api/planning', standardJsonParser, planningRoutes);

// AgentX MCP skill bus (Streamable HTTP JSON-RPC endpoint)
const mcpRoutes = require('../routes/mcp');
app.use('/mcp', standardJsonParser, mcpRoutes);
app.use('/api/mcp', standardJsonParser, mcpRoutes);

// Nestor durable memory writes (explicit facts/summaries into RAG)
const nestorMemoryRoutes = require('../routes/nestor-memory');
app.use('/api/nestor/memory', standardJsonParser, nestorMemoryRoutes);

// Nestor one-brain turn endpoint: every surface (voice console, Surface
// panel, desktop app) reaches the SAME brain — OpenClaw `main` — with a
// local-inference fallback when the gateway is down (task 0453).
const nestorTurnRoutes = require('../routes/nestor-turn');
app.use('/api/nestor/turn', standardJsonParser, nestorTurnRoutes);

// Nestor fallback prewarm: functionally checks the effective local Ollama
// quick-chat route without fighting host pins (task 0454). The endpoint is
// safe to invoke from the platform maintenance scheduler.
const nestorPrewarmRoutes = require('../routes/nestor-prewarm');
app.use('/api/nestor/prewarm', standardJsonParser, nestorPrewarmRoutes);

// Physical house panel API (Surface Pro 3 kiosk)
const createPanelRoutes = require('../routes/panel');
app.use('/api/panel', standardJsonParser, createPanelRoutes({ systemHealth }));

// Generic cross-service event ingress. The deployed BUDDY_EMIT_TOKEN remains
// the shared-secret source during the legacy alias window.
const {
  buddyLimiter,
  buddyReactLimiter,
  nestorConsumerLimiter,
} = require('./middleware/rateLimiter');
const platformEventRoutes = require('../routes/platform-events');
app.use('/api/platform-events', standardJsonParser, buddyLimiter, platformEventRoutes);

// Versioned standalone Nestor consumer contract. The legacy /api/buddy API
// remains mounted below for Nestor v0.2.7 compatibility only.
const createNestorConsumerV1Routes = require('../routes/nestor-consumer-v1');
app.use(
  '/api/consumers/nestor/v1',
  nestorConsumerLimiter,
  createNestorConsumerV1Routes({ systemHealth })
);

// OpenClaw integration routes (agent control, chat, sessions, config)
if (isOpenClawIntegrationEnabled()) {
  const openclawRoutes = require('../routes/openclaw');
  app.use('/api/openclaw', standardJsonParser, openclawRoutes);
  logger.info('OpenClaw integration routes enabled', getOpenClawRuntimeConfig());
} else {
  logger.info('OpenClaw integration routes disabled');
}

app.use('/api/hermes', require('../routes/hermes'));

// System metrics (process, OS, database stats)
const metricsRoutes = require('../routes/metrics');
app.use('/api/metrics', metricsRoutes);

// Inference telemetry aggregation (host/model/caller summaries, timeline)
const inferenceTelemetryRoutes = require('../routes/inference-telemetry');
app.use('/api/telemetry', inferenceTelemetryRoutes);

// Host capacity report + verdict (underused / balanced / vram-constrained / saturated)
const hostCapacityRoutes = require('../routes/host-capacity');
app.use('/api/host-capacity', hostCapacityRoutes);

// Budget status (token burn summary + health indicator)
const budgetRoutes = require('../routes/budget');
app.use('/api/budget', budgetRoutes);

// Legacy Nestor v0.2.7 compatibility API. Default-on for rolling upgrades,
// but explicitly disableable so the supported v1 contract can be exercised
// without accidentally depending on /api/buddy/*.
const { isLegacyBuddyApiEnabled } = require('./services/legacyBuddyCompatibility');
if (isLegacyBuddyApiEnabled()) {
  const buddyRoutes = require('../routes/buddy');
  app.use('/api/buddy', chatJsonParser, buddyLimiter);
  app.use('/api/buddy/react', buddyReactLimiter);
  app.use('/api/buddy', buddyRoutes);
} else {
  logger.info('Legacy Buddy compatibility API disabled');
}

// Legacy/Compatibility routes
// Map /conversations -> history
app.use('/api/conversations', historyRoutes);

// Mount Main API routes (Chat, Feedback, Ollama)
const apiRoutes = require('../routes/api');
// Apply chat-specific rate limiter and tighter payload limit to chat endpoint
app.use('/api/chat', chatJsonParser, chatLimiter);
app.use('/api', apiRoutes);

// ============================================
// EJS TEMPLATING (before static files)
// ============================================
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));

// ============================================
// STATIC FILES (must come AFTER API routes)
// ============================================

app.use(express.static(path.join(__dirname, '..', 'public')));

// Browsers often request /favicon.ico implicitly. We serve a real icon to avoid noisy 404s.
app.get('/favicon.ico', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'img', 'favicon.ico'));
});

// Health Check - Basic
// Canonical platform envelope {ok, service, version, ts} (task 0355/F13) is
// returned additively; the legacy {status, port, details} fields are preserved
// so existing consumers (Nerve Center, the Ops MCP health sweep, portal status)
// keep working until they migrate.
app.get('/health', async (_req, res) => {
  const ollamaHealth = await refreshOllamaHealth(systemHealth);
  const isHealthy = systemHealth.mongodb.status === 'connected';

  res.status(isHealthy ? 200 : 503).json({
    ok: isHealthy,
    service: 'agentx-core',
    version: SERVICE_VERSION,
    ts: new Date().toISOString(),
    // Legacy fields (pre-0355): retained for backward compatibility.
    status: isHealthy ? 'ok' : 'degraded',
    port: process.env.PORT || 3080,
    details: {
      mongodb: systemHealth.mongodb.status,
      ollama: ollamaHealth.status
    }
  });
});

// Config endpoint - expose server configuration
app.get('/api/config', (_req, res) => {
  const ollamaHost = normalizeHostUrl(process.env.OLLAMA_HOST);

  if (!ollamaHost) {
    return res.status(500).json({
      status: 'error',
      message: 'OLLAMA_HOST environment variable is not configured'
    });
  }

  const match = ollamaHost.match(/^(?:https?:\/\/)?([^:]+)(?::(\d+))?/);
  const host = match ? match[1] : 'localhost';
  const port = match && match[2] ? match[2] : '11434';

  const demo = isDemoProfile(agentxProfile);
  res.json({
    profile: agentxProfile,
    ollama: {
      host,
      port,
      fullUrl: ollamaHost
    },
    features: demo
      ? {}
      : { openclaw: getOpenClawRuntimeConfig(), voice: voiceSettings.getSettings() },
    // Browser-reachable URLs for cross-service navigation. Public JS
    // and EJS pages use these instead of hardcoded localhost:<port>
    // so remote browsers reach the right host. (0208)
    publicUrls: app.locals.publicUrls
  });
});

// Live portal status — server-side aggregation of each service's /health so the
// portal landing page shows live status without any cross-origin requests.
// Fail-soft: returns best-effort per-service status; never blocks on one service.
app.get('/api/portal/health', async (_req, res) => {
  try {
    const portalStatusService = require('./services/portalStatusService');
    const data = await portalStatusService.getPortalStatus(systemHealth);
    res.set('Cache-Control', 'no-store');
    res.json(data);
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ============================================
// 301 REDIRECTS (formerly meta-refresh HTML pages)
// ============================================
app.get('/nerve-center.html', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/agent-ops.html', (req, res) => res.redirect(301, '/agent-ops'));
app.get('/models.html', (req, res) => res.redirect(301, '/models'));
app.get('/cluster-schedule.html', (req, res) => res.redirect(301, '/cluster-schedule'));
app.get('/analytics.html', (req, res) => res.redirect(301, '/analytics'));
app.get('/performance.html', (req, res) => res.redirect(301, '/performance'));
app.get('/prompts.html', (req, res) => res.redirect(301, '/prompts'));
app.get('/pipeline.html', (req, res) => res.redirect(301, '/pipeline'));
app.get('/alert-analytics', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/alert-analytics.html', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/alerts', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/alerts.html', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/cluster', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/cluster.html', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/cost-tracking', (req, res) => res.redirect(301, '/analytics'));
app.get('/cost-tracking.html', (req, res) => res.redirect(301, '/analytics'));
app.get('/dashboard', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/dashboard.html', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/hardware-matrix', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/hardware-matrix.html', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/hosts', (req, res) => res.redirect(301, '/nerve-center'));
app.get('/hosts.html', (req, res) => res.redirect(301, '/nerve-center'));

// Redirects for old data pages → data-toolbox
app.get('/storage', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/storage.html', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/files', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/files.html', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/janitor', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/janitor.html', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/network', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/network.html', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/databases', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/databases.html', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/live-data-dashboard', (req, res) => res.redirect(301, '/data-toolbox'));
app.get('/live-data-dashboard.html', (req, res) => res.redirect(301, '/data-toolbox'));

// ============================================
// EJS PAGE ROUTES
// ============================================
// Root \u2192 Portal (cross-app landing). The former "/" chat page is now Playground.
app.get('/', (req, res) => {
  if (isDemoProfile(agentxProfile)) return res.redirect(302, '/demo');
  res.sendFile(path.join(__dirname, '..', 'public', 'portal', 'index.html'));
});

app.get('/demo', (_req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/demo',
    title: 'Agent X · Demo',
    service: 'core',
    activePage: 'demo',
    showNav: false,
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/demo.css">'
    ].join('\n'),
    footerJs: ''
  });
});

// Legacy alias: redirect /chat \u2192 /playground (page rename 2026-04-23)
app.get('/chat', (req, res) => res.redirect(301, '/playground'));

// Short, bookmarkable Nestor runtime entry point. The second hop mints the
// browser-only OpenClaw token fragment without exposing it in page markup.
app.get('/nestor', (_req, res) => {
  res.set({
    'Cache-Control': 'no-store, max-age=0',
    Pragma: 'no-cache',
    'Referrer-Policy': 'no-referrer'
  });
  return res.redirect(302, '/api/openclaw/control-launch/chat');
});

app.get('/playground', (req, res) => {
  const demo = isDemoProfile(agentxProfile);
  res.render('layouts/main', {
    pageView: '../pages/chat',
    title: 'AgentX \u2022 Playground',
    service: 'core',
    activePage: 'playground',
    showNav: !demo,
    bodyClass: demo ? 'agentx-demo-profile' : '',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/agentx.css">',
      '<link rel="stylesheet" href="/css/chat-inline.css">',
      '<link rel="stylesheet" href="/css/chat-intelligence.css">',
      demo ? '<link rel="stylesheet" href="/css/demo-profile.css">' : ''
    ].join('\n'),
    footerJs: [
      '<script src="https://cdn.jsdelivr.net/npm/marked/marked.min.js"></script>',
      '<script src="https://cdn.jsdelivr.net/npm/dompurify@3.0.8/dist/purify.min.js"></script>',
      '<script src="/js/persona-selector.js"></script>',
      demo ? '' : '<script src="/js/components/chat-intelligence.js"></script>',
      '<script src="/js/chat/chat-context-indicator.js"></script>',
      '<script src="/js/chat/chat-model-readiness.js"></script>',
      '<script type="module" src="/js/chat/chat-main.js"></script>'
    ].join('\n')
  });
});

app.get('/panel', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/panel',
    title: 'Nestor - Maison',
    service: 'core',
    activePage: 'panel',
    bodyClass: 'panel-kiosk-page',
    showNav: false,
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/panel.css">'
    ].join('\n'),
    footerJs: [
      '<script src="/js/nestor-voice-stream.js"></script>',
      '<script src="/js/panel.js"></script>'
    ].join('')
  });
});

app.get('/lecture', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/lecture',
    title: 'Nestor Lecteur',
    service: 'core',
    activePage: 'lecture',
    bodyClass: 'lecture-kiosk-page',
    showNav: false,
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/lecture.css">'
    ].join('\n'),
    footerJs: '<script src="/js/lecture.js"></script>'
  });
});

app.get('/lecture/parents', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/lecture-parents',
    title: 'KidX Reader Parent Log',
    service: 'core',
    activePage: 'voice-personas',
    bodyClass: 'lecture-parent-page',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/lecture-parents.css">'
    ].join('\n'),
    footerJs: '<script src="/js/lecture-parents.js"></script>'
  });
});
app.get('/lecture/parents.html', (req, res) => res.redirect(301, '/lecture/parents'));

app.get('/nerve-center', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/nerve-center',
    title: 'AgentX \u2022 Nerve Center',
    service: 'core',
    activePage: 'nerve-center',
    bodyClass: 'nerve-center-page',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/nerve-center.css">',
      '<link rel="stylesheet" href="/css/nerve-center-fastlane.css">',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>'
    ].join('\n'),
    footerJs: [
      '<script src="/js/nerve-center-mode.js"></script>',
      '<script src="/js/nerve-center.js"></script>',
      '<script src="/js/nerve-center-brainmap.js"></script>',
      '<script src="/js/nerve-center-fastlane.js"></script>',
      '<script src="/js/nerve-center-routing.js"></script>',
      '<script src="/js/nerve-center-cluster.js"></script>',
      '<script src="/js/nerve-center-health.js"></script>',
      '<script src="/js/nerve-center-performance.js"></script>',
      '<script src="/js/nerve-center-inference.js"></script>',
      '<script src="/js/nerve-center-inference-health.js"></script>',
      '<script src="/js/nerve-center-capacity.js"></script>',
      '<script src="/js/nerve-center-alerts.js"></script>',
      '<script src="/js/nerve-center-rag.js"></script>',
      '<script src="/js/nerve-center-tasks.js"></script>',
      '<script src="/js/nerve-center-hermes.js"></script>',
      '<script src="/js/nerve-center-openclaw.js"></script>'
    ].join('\n')
  });
});

app.get('/models', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/models',
    title: 'AgentX \u2022 Models',
    service: 'core',
    activePage: 'models',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/models.css">'
    ].join('\n'),
    footerJs: [
      '<script src="/js/models-unified.js"></script>',
      '<script src="/js/models-unified-popouts.js"></script>',
      '<script src="/js/models-management.js"></script>',
      '<script src="/js/models-comparison.js"></script>',
      '<script src="/js/models-execution-config.js"></script>',
      '<script src="/js/models-recommendations.js"></script>'
    ].join('\n')
  });
});

app.get('/cluster-schedule', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/cluster-schedule',
    title: 'AgentX \u2022 Cluster Schedule',
    service: 'core',
    activePage: 'cluster-schedule',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/cluster-schedule-layout.css">',
      '<link rel="stylesheet" href="/css/cluster-schedule-components.css">'
    ].join('\n'),
    footerJs: [
      '<script src="/js/cluster-schedule.js"></script>',
      '<script src="/js/cluster-schedule-services.js"></script>'
    ].join('\n')
  });
});

app.get('/memory-review', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/memory-review',
    title: 'AgentX • Memory Review',
    service: 'core',
    activePage: 'memory-review',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/memory-review.css">'
    ].join('\n'),
    footerJs: '<script src="/js/memory-review.js"></script>'
  });
});

app.get('/agent-ops', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/agent-ops',
    title: 'AgentX • Agent Ops',
    service: 'core',
    activePage: 'agent-ops',
    bodyClass: 'agent-ops-surface',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/agent-ops.css">',
      '<link rel="stylesheet" href="/css/agent-ops-advanced.css">'
    ].join('\n'),
    footerJs: [
      '<script src="/js/agent-ops-advanced.js"></script>',
      '<script src="/js/agent-ops.js"></script>'
    ].join('\n')
  });
});

app.get('/pipeline', (req, res) => {
  const leantimePipeline = getLeantimePipelineConfig();
  res.render('layouts/main', {
    pageView: '../pages/pipeline',
    title: 'AgentX - Pipeline',
    service: 'core',
    activePage: 'pipeline',
    leantimePipeline,
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/pipeline.css">'
    ].join('\n'),
    footerJs: '<script src="/js/pipeline.js"></script>'
  });
});

app.get('/planning', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/planning',
    title: 'AgentX - Planning',
    service: 'core',
    activePage: 'planning',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/planning.css?v=3">',
      '<link rel="stylesheet" href="/css/planning-components.css?v=3">'
    ].join('\n'),
    footerJs: [
      '<script src="/js/planning.js?v=3"></script>',
      '<script src="/js/planning-editor.js?v=3"></script>'
    ].join('\n')
  });
});

app.get('/analytics', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/analytics',
    title: 'AgentX \u2022 Analytics',
    service: 'core',
    activePage: 'analytics',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>'
    ].join('\n'),
    footerJs: [
      '<script type="module" src="/js/analytics-cost.js"></script>',
      '<script type="module" src="/js/analytics-inference.js"></script>'
    ].join('\n')
  });
});

app.get('/performance', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/performance',
    title: 'AgentX \u2022 Performance',
    service: 'core',
    activePage: 'performance',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/performance.css">',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>'
    ].join('\n'),
    footerJs: [
      '<script src="/js/performance-page.js"></script>',
      '<script src="/js/performance-charts.js"></script>',
      '<script src="/js/performance-loadtests.js"></script>',
      '<script src="/js/performance-baselines.js"></script>'
    ].join('\n')
  });
});

app.get('/prompts', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/prompts',
    title: 'AgentX \u2022 Prompts',
    service: 'core',
    activePage: 'prompts',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/prompts-layout.css">',
      '<link rel="stylesheet" href="/css/prompts-editor.css">',
      '<link rel="stylesheet" href="/css/prompts-cards.css">',
      '<link rel="stylesheet" href="/css/prompts-variants.css">',
      '<link rel="stylesheet" href="/css/agentx.css">',
      '<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/editor/editor.main.css">',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>'
    ].join('\n'),
    footerJs: [
      '<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>',
      '<script>require.config({ paths: { \'vs\': \'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs\' }});</script>',
      '<script>',
      '  (function() {',
      '    var simpleModeToggle = document.getElementById(\'simpleModeToggle\');',
      '    var isSimpleMode = localStorage.getItem(\'agentx_simple_mode\') === \'true\';',
      '    if (isSimpleMode) { simpleModeToggle.checked = true; document.body.classList.add(\'simple-mode\'); }',
      '    simpleModeToggle.addEventListener(\'change\', function(e) {',
      '      if (e.target.checked) { document.body.classList.add(\'simple-mode\'); localStorage.setItem(\'agentx_simple_mode\', \'true\'); }',
      '      else { document.body.classList.remove(\'simple-mode\'); localStorage.setItem(\'agentx_simple_mode\', \'false\'); }',
      '    });',
      '  })();',
      '</script>'
    ].join('\n')
  });
});

app.get('/data-toolbox', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/data-toolbox',
    title: 'AgentX \u2022 Data Toolbox',
    service: 'core',
    activePage: 'data-toolbox',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      // Leaflet CSS from cdnjs (allowed by styleSrc); JS from jsdelivr below (allowed by scriptSrc). Live Data map — no external tiles (0287).
      '<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css">'
    ].join('\n'),
    footerJs: [
      '<script src="/js/utils/data-commons.js"></script>',
      '<script src="/js/data-toolbox-ops.js"></script>',
      '<script src="/js/storage.js"></script>',
      '<script src="/js/files.js"></script>',
      '<script src="/js/janitor.js"></script>',
      '<script src="/js/janitor-profiles.js"></script>',
      '<script src="/js/shared-drive-janitor.js"></script>',
      '<script src="/js/docjanitor.js"></script>',
      '<script src="/js/network.js"></script>',
      '<script src="/js/databases.js"></script>',
      // Live Data tab libs — Leaflet (map), satellite.js (TLE propagation), Chart.js (series). All from jsdelivr (scriptSrc-allowed).
      '<script src="https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js"></script>',
      '<script src="https://cdn.jsdelivr.net/npm/satellite.js@5.0.0/dist/satellite.min.js"></script>',
      '<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>',
      '<script src="/js/live-data-dashboard.js"></script>'
    ].join('\n')
  });
});

app.get('/backup', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/backup',
    title: 'AgentX \u2022 Backup',
    service: 'core',
    activePage: 'backup',
    headCss: '<link rel="stylesheet" href="/styles.css">',
    footerJs: '<script src="/js/backup.js"></script>'
  });
});
app.get('/backup.html', (req, res) => res.redirect(301, '/backup'));

app.get('/voice', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/voice',
    title: 'AgentX \u2022 Voice',
    service: 'core',
    activePage: 'voice',
    headCss: '<link rel="stylesheet" href="/styles.css">',
    footerJs: [
      '<script src="/js/nestor-voice-stream.js"></script>',
      '<script src="/js/voice.js"></script>'
    ].join('')
  });
});
app.get('/voice.html', (req, res) => res.redirect(301, '/voice'));
app.get('/voix', (req, res) => res.redirect(301, '/voice'));

app.get('/voice-personas', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/voice-personas',
    title: 'AgentX \u2022 Voice Personas',
    service: 'core',
    activePage: 'voice-personas',
    headCss: [
      '<link rel="stylesheet" href="/styles.css">',
      '<link rel="stylesheet" href="/css/voice-personas.css">'
    ].join('\n'),
    footerJs: '<script src="/js/voice-personas.js"></script>'
  });
});
app.get('/voice-personas.html', (req, res) => res.redirect(301, '/voice-personas'));

app.get('/council', (req, res) => {
  res.render('layouts/main', {
    pageView: '../pages/roundtable',
    title: 'AgentX \u2022 Council',
    service: 'core',
    activePage: 'council',
    headCss: '<link rel="stylesheet" href="/styles.css">',
    footerJs: '<script src="/js/roundtable.js"></script>'
  });
});
// Compatibility aliases for saved Roundtable links. Council is canonical.
function redirectLegacyRoundtable(req, res) {
  const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(301, `/council${query}`);
}
app.get('/roundtable', redirectLegacyRoundtable);
app.get('/roundtable.html', redirectLegacyRoundtable);

// Error logging middleware (must be after routes)
app.use(errorLogger);

// Global error handler
app.use((err, req, res, _next) => {
  const requestPath = String(req.originalUrl || '').split('?', 1)[0];
  const isNestorContract = requestPath === '/api/consumers/nestor/v1'
    || requestPath.startsWith('/api/consumers/nestor/v1/');

  if (err.type === 'entity.parse.failed' && isNestorContract) {
    const message = 'Nestor v1 request body contains invalid JSON.';
    return res.status(400).json({
      ok: false,
      status: 'error',
      error: message,
      message,
      code: 'NESTOR_INVALID_JSON'
    });
  }

  // Handle PayloadTooLargeError specifically
  if (err.type === 'entity.too.large') {
    const message = isNestorContract
      ? 'Payload too large. The Nestor v1 request exceeds the 1 MiB transport limit.'
      : 'Payload too large. The document exceeds the maximum allowed size (50MB).';
    return res.status(413).json({
      ok: false,
      status: 'error',
      error: message,
      message,
      code: 'PAYLOAD_TOO_LARGE'
    });
  }

  const statusCode = err.statusCode || 500;
  res.status(statusCode).json({
    status: 'error',
    message: err.message || 'Internal server error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
});

// 404 handler for API routes (catch API paths that don't exist)
app.use('/api', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `API endpoint not found: ${req.method} ${req.path}`,
    code: 'API_NOT_FOUND'
  });
});

// 404 handler for unmatched non-API, non-static routes
app.use((req, res) => {
  const isStaticRequest = /\.\w+$/.test(req.path);
  if (isStaticRequest) {
    res.status(404).type('text/plain').send(`Resource not found: ${req.path}`);
  } else {
    res.status(404).type('text/plain').send(`Page not found: ${req.path}`);
  }
});

module.exports = { app, systemHealth, systemEvents };
