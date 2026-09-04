const cors = require('cors');
const express = require('express');
const path = require('path');
const connectDB = require('./config/db');
const logger = require('./config/logger');
const {
  createCorePublicUrlsResolver,
  getPublicUrls,
} = require('../shared/browserPublicUrls');
const { currentAgentXProfile } = require('../shared/agentxRuntimeProfile');
const { createServiceIdentity } = require('../shared/serviceIdentity');
const { registerLocalStyleVendorAssets } = require('../shared/localStyleVendorAssets');
const { createApiHostGuard } = require('../shared/apiHostGuard');
const { admitOllamaTargetResolved } = require('./src/helpers/ollamaTargetAdmission');
const { readBoundedJson } = require('./src/helpers/boundedJsonResponse');
const { shouldRecoverBenchmarkClaims } = require('./src/helpers/benchmarkProfileCapabilities');

require('dotenv').config({
  path: path.join(__dirname, '.env')
});
const { loadCorePublicConfig } = require('./src/clients/coreApiClient');

const PORT = process.env.PORT || 3081;
// Standalone development is local-only by default. Compose opts into the
// container interface explicitly and publishes it back to host loopback.
const HOST = process.env.HOST || '127.0.0.1';
const SERVICE_VERSION = require('./package.json').version || '0.0.0';

// Global error handlers
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled Promise Rejection', {
    reason: reason?.message || reason,
    stack: reason?.stack
  });
});

process.on('uncaughtException', (error) => {
  if (error.code === 'EPIPE' || error.code === 'ECONNRESET') {
    logger.debug(`${error.code} ignored (closed connection)`);
    return;
  }
  logger.error('Uncaught Exception', { message: error.message, stack: error.stack });
  setTimeout(() => process.exit(1), 1000);
});

process.stdout.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });
process.stderr.on('error', (err) => { if (err.code !== 'EPIPE') throw err; });

const app = express();
app.locals.publicUrls = getPublicUrls();
app.locals.agentxProfile = currentAgentXProfile();
const resolvePublicUrls = createCorePublicUrlsResolver({
  enabled: process.env.NODE_ENV !== 'test',
  loadCoreConfig: loadCorePublicConfig,
});
// Guard every API route before proxies, parsers, or route modules run. Besides
// rejecting untrusted Host values, mutation protection blocks cross-site form
// submissions while retaining exact same-origin UI, loopback CLI, bounded
// internal-service, and operator-token callers.
app.use(createApiHostGuard({
  serviceHosts: ['benchmark', 'agentx-benchmark'],
  publicUrlEnv: ['BENCHMARK_PUBLIC_URL'],
  protectMutations: true,
}));

// EJS templating — shared layouts from core, local pages
app.set('view engine', 'ejs');
app.set('views', [
  path.join(__dirname, 'views'),
  path.join(__dirname, '..', 'core', 'views')
]);

// Middleware
const defaultAllowedOrigins = [
  'http://localhost:3080',
  'http://127.0.0.1:3080',
  'http://localhost:3081',
  'http://127.0.0.1:3081'
];
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : defaultAllowedOrigins;

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// Shared browser controls also consume Core's unified model catalog. Keep the
// request same-origin on standalone Benchmark deployments.
app.get('/api/models/all', async (req, res) => {
  const coreUrl = String(process.env.CORE_URL || 'http://localhost:3080').replace(/\/+$/, '');
  const query = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
  try {
    const headers = { Accept: req.get('accept') || 'application/json' };
    if (process.env.AGENTX_OPERATOR_TOKEN) {
      headers['X-AgentX-Operator-Token'] = process.env.AGENTX_OPERATOR_TOKEN;
    }
    const response = await fetch(`${coreUrl}/api/models/all${query}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    for (const header of ['content-type', 'cache-control', 'x-require-profiled-models']) {
      const value = response.headers.get(header);
      if (value) res.set(header, value);
    }
    return res.status(response.status).send(Buffer.from(await response.arrayBuffer()));
  } catch (error) {
    return res.status(502).json({
      status: 'error',
      code: 'CORE_MODEL_CATALOG_UNAVAILABLE',
      message: error.message,
    });
  }
});

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// Browser-critical libraries are production dependencies served through an
// explicit, immutable allowlist. Never expose node_modules as a static root.
const benchmarkVendorAssets = Object.freeze({
  '/vendor/chart.js/4.4.1/chart.umd.js': path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js')
});

for (const [route, assetPath] of Object.entries(benchmarkVendorAssets)) {
  app.get(route, (_req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type('application/javascript');
    res.sendFile(assetPath);
  });
}

registerLocalStyleVendorAssets(app, path.join(__dirname, 'node_modules'));

// The shared-utils source is copied into /dist by the Benchmark image and its
// relative module import resolves to this legacy-looking URL. Serve only the
// required non-Buddy utility; do not restore the removed generic Buddy proxy.
app.get('/public/js/utils/polling-controller.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'core', 'public', 'js', 'utils', 'polling-controller.js'));
});

// Static files — Benchmark plus an explicit allowlist of shared Core assets.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.includes(`${path.sep}model-profiler${path.sep}`)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

const sharedPublicRoot = path.join(__dirname, '..', 'core', 'public');
const sharedAssets = {
  '/dist/shared-tokens.css': ['dist', 'shared-tokens.css'],
  '/dist/shared-utils.js': ['dist', 'shared-utils.js'],
  '/css/local-fonts.css': ['css', 'local-fonts.css'],
  '/css/platform-chrome.css': ['css', 'platform-chrome.css'],
  '/js/utils/polling-controller.js': ['js', 'utils', 'polling-controller.js'],
  '/js/utils/polling-controller-global.js': ['js', 'utils', 'polling-controller-global.js'],
  '/js/utils/shared.js': ['js', 'utils', 'shared.js'],
  '/js/utils/typed-confirmation.js': ['js', 'utils', 'typed-confirmation.js'],
  '/js/utils/shortcut-hints.js': ['js', 'utils', 'shortcut-hints.js'],
  '/js/utils/shortcuts-modal.js': ['js', 'utils', 'shortcuts-modal.js'],
  '/js/utils/toast.js': ['js', 'utils', 'toast.js']
};
for (const [route, segments] of Object.entries(sharedAssets)) {
  app.get(route, (_req, res) => res.sendFile(path.join(sharedPublicRoot, ...segments)));
}

// Core's /api/config is the browser URL authority in the composed platform.
// Standalone Benchmark keeps the environment-driven localhost defaults.
app.use(async (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !path.extname(req.path)) {
    const publicUrls = await resolvePublicUrls();
    app.locals.publicUrls = publicUrls;
    res.locals.publicUrls = publicUrls;
  }
  next();
});

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// ── Page routes (EJS) ────────────────────────────────────────────────────────

const benchmarkPageView = path.resolve(__dirname, 'views/pages/benchmark');
const leaderboardPageView = path.resolve(__dirname, 'views/pages/leaderboard');
const courthousePageView = path.resolve(__dirname, 'views/pages/courthouse');
const profilerPageView = path.resolve(__dirname, 'views/pages/profiler');
const efficiencyMapPageView = path.resolve(__dirname, 'views/pages/efficiency-map');
const resultsExplorerPageView = path.resolve(__dirname, 'views/pages/results-explorer');
const setupPageView = path.resolve(__dirname, 'views/pages/setup');
const harnessesPageView = path.resolve(__dirname, 'views/pages/harnesses');

app.get('/', (req, res) => {
  const { isConfigured } = require('./src/helpers/ollamaHostConfig');
  const harnessEnabled = String(process.env.BENCHMARK_HARNESS_ENABLED || '').toLowerCase() === 'true';
  if (!isConfigured() && !harnessEnabled) return res.redirect('/setup');
  res.render('layouts/main', {
    pageView: benchmarkPageView,
    title: 'Agent X Evaluation — Compare Models',
    service: 'benchmark',
    activePage: 'benchmark',
    bodyClass: 'page-benchmark',
    headCss: [
      '<link rel="stylesheet" href="/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/css/redesign-components.css">',
      '<link rel="stylesheet" href="/css/benchmark-v2-layout.css?v=unbenchmarked-models-20260501">',
      '<link rel="stylesheet" href="/css/benchmark-v2-config.css">',
      '<link rel="stylesheet" href="/css/benchmark-v2-live.css">',
      '<link rel="stylesheet" href="/css/model-evidence-experience.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/js/benchmark-v2/index.js?v=unbenchmarked-models-20260501"></script>\n<script src="/js/benchmark-v2/experience.js"></script>'
  });
});

app.get('/leaderboard', (req, res) => {
  res.render('layouts/main', {
    pageView: leaderboardPageView,
    title: 'Agent X Evaluation — Ranked Models',
    service: 'benchmark',
    activePage: 'leaderboard',
    headCss: [
      '<link rel="stylesheet" href="/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/css/redesign-components.css">',
      '<link rel="stylesheet" href="/css/leaderboard-v2.css">',
      '<link rel="stylesheet" href="/css/scoring-profile.css">',
      '<link rel="stylesheet" href="/css/model-evidence-experience.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/js/leaderboard-v2/index.js?v=trust-scope-20260613"></script>'
  });
});

app.get('/harnesses', (req, res) => {
  res.render('layouts/main', {
    pageView: harnessesPageView,
    title: 'Agent X Evaluation — Harnesses',
    service: 'benchmark',
    activePage: 'harnesses',
    headCss: [
      '<link rel="stylesheet" href="/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/css/redesign-components.css">',
      '<link rel="stylesheet" href="/css/harnesses.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/js/harnesses/index.js"></script>'
  });
});

app.get('/courthouse', (req, res) => {
  res.render('layouts/main', {
    pageView: courthousePageView,
    title: 'Courthouse — The Judge\'s Chambers',
    service: 'benchmark',
    activePage: 'courthouse',
    headCss: [
      '<link rel="stylesheet" href="/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/css/redesign-components.css">',
      '<link rel="stylesheet" href="/css/courthouse-v2-layout.css">',
      '<link rel="stylesheet" href="/css/courthouse-v2-detail.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/js/courthouse-v2/index.js?v=fast-hosts-20260503"></script>'
  });
});

app.get('/profiler', (req, res) => {
  res.render('layouts/main', {
    pageView: profilerPageView,
    title: 'Agent X Evaluation — Prepare Models',
    service: 'benchmark',
    activePage: 'profiler',
    headCss: [
      '<link rel="stylesheet" href="/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/css/redesign-components.css">',
      '<link rel="stylesheet" href="/css/model-profiler.css?v=host-telemetry-20260622b">',
      '<link rel="stylesheet" href="/css/profiler-experience.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/js/model-profiler/index.js?v=host-telemetry-20260622b"></script>\n<script src="/js/model-profiler/experience.js"></script>'
  });
});

app.get('/efficiency-map', (req, res) => {
  res.render('layouts/main', {
    pageView: efficiencyMapPageView,
    title: 'Efficiency Map — Intelligence per tok/s',
    service: 'benchmark',
    activePage: 'efficiency-map',
    headCss: [
      '<link rel="stylesheet" href="/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/css/redesign-components.css">',
      '<link rel="stylesheet" href="/css/efficiency-map.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/js/efficiency-map/index.js"></script>'
  });
});

app.get('/results-explorer', (req, res) => {
  res.render('layouts/main', {
    pageView: resultsExplorerPageView,
    title: 'Agent X Evaluation — Evidence',
    service: 'benchmark',
    activePage: 'results-explorer',
    bodyClass: 'benchmark-shell',
    headCss: [
      '<link rel="stylesheet" href="/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/css/redesign-components.css">',
      '<link rel="stylesheet" href="/css/results-explorer-layout.css">',
      '<link rel="stylesheet" href="/css/results-explorer-components.css">',
      '<link rel="stylesheet" href="/css/benchmark-shell.css">',
      '<link rel="stylesheet" href="/css/model-evidence-experience.css">',
      '<script src="/vendor/chart.js/4.4.1/chart.umd.js"></script>'
    ].join('\n'),
    footerJs: [
      '<script src="/js/results-explorer.js"></script>',
      '<script src="/js/results-explorer-charts.js"></script>',
      '<script src="/js/results-explorer-inspector.js"></script>'
    ].join('\n')
  });
});

app.get('/setup', (req, res) => {
  res.render('layouts/main', {
    pageView: setupPageView,
    title: 'AgentX Benchmark — Setup',
    service: 'benchmark',
    activePage: 'setup',
    showNav: false,
    headCss: [
      '<link rel="stylesheet" href="/css/redesign-tokens.css">',
      '<link rel="stylesheet" href="/css/setup.css">'
    ].join('\n'),
    footerJs: '<script type="module" src="/js/setup/index.js"></script>'
  });
});

// ── Legacy .html redirects ───────────────────────────────────────────────────
app.get('/benchmark', (req, res) => res.redirect(301, '/'));
app.get('/benchmark-v2.html', (req, res) => res.redirect(301, '/'));
app.get('/leaderboard-v2.html', (req, res) => res.redirect(301, '/leaderboard'));
app.get('/courthouse-v2.html', (req, res) => res.redirect(301, '/courthouse'));
app.get('/model-profiler.html', (req, res) => res.redirect(301, '/profiler'));
app.get('/efficiency-map.html', (req, res) => res.redirect(301, '/efficiency-map'));
app.get('/results-explorer.html', (req, res) => res.redirect(301, '/results-explorer'));
app.get('/setup.html', (req, res) => res.redirect(301, '/setup'));

// Health check
app.get('/health', (req, res) => {
  const dbReady = require('mongoose').connection.readyState === 1;
  const status = dbReady ? 'ok' : 'degraded';
  res.status(dbReady ? 200 : 503).json({
    ok: dbReady,
    status,
    ...createServiceIdentity({ service: 'agentx-benchmark', version: SERVICE_VERSION }),
    uptime: process.uptime(),
    db: dbReady ? 'connected' : 'disconnected'
  });
});

// Ollama hosts endpoint — enriched with availability and model lists
app.get('/api/ollama-hosts', async (req, res) => {
  const { getConfiguredHosts, readConfigFile } = require('./src/helpers/ollamaHostConfig');
  const hosts = getConfiguredHosts();

  const enriched = await Promise.all(hosts.map(async (host) => {
    let timeout;
    try {
      const admittedUrl = await admitOllamaTargetResolved(host.url, { configuredHosts: hosts });
      const ctrl = new AbortController();
      timeout = setTimeout(() => ctrl.abort(), 4000);
      const resp = await fetch(`${admittedUrl}/api/tags`, {
        signal: ctrl.signal,
        redirect: 'manual'
      });
      if (!resp.ok) return { ...host, available: false, models: [], modelDetails: [] };
      const data = await readBoundedJson(resp);
      const models = (data.models || []).map(m => m.name);
      const modelDetails = (data.models || []).map(m => ({
        name: m.name,
        size: m.size || 0,
        parameterSize: m.details?.parameter_size || '',
        family: m.details?.family || '',
        quantization: m.details?.quantization_level || ''
      }));
      return { ...host, available: true, models, modelDetails };
    } catch {
      return { ...host, available: false, models: [], modelDetails: [] };
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }));

  // Include judge config from config file if available
  const config = readConfigFile();
  const judgeConfig = config?.judge || null;

  res.json({ hosts: enriched, judgeConfig });
});

// Setup wizard routes
app.use('/api/setup', require('./routes/setup'));

// Benchmark API routes
app.use('/api/benchmark', require('./routes/benchmark'));

// Profiler API routes (includes host testing at /api/profiler/hosts/test/*)
app.use('/api/profiler', require('./routes/profiler'));

// Start
async function start() {
  await connectDB();

  // Prompt-library synchronization is an explicit startup mutation. Keeping
  // it out of GET /api/benchmark/prompts preserves safe-method semantics while
  // ensuring a normal service start still presents the canonical library.
  const benchmarkService = require('./src/services/benchmark');
  await benchmarkService.seedPrompts();

  // Recover orphaned judge queue entries from previous crash
  const { recoverJudgeQueue } = require('./src/services/benchmark/judgeQueueRecovery');
  recoverJudgeQueue().catch(err => logger.warn('Judge queue recovery error', { error: err.message }));

  // Claim coordination is a full-profile capability. In demo, Core
  // intentionally disables the Nerve Center routes, so Benchmark must not
  // probe them and manufacture a misleading startup warning.
  if (shouldRecoverBenchmarkClaims(app.locals.agentxProfile)) {
    // Reconcile benchmark claims with actual batch state. A process crash
    // mid-batch can otherwise leave a host claimed until the hard-cap reaper.
    const {
      recoverLeakedClaims,
      reacquireActiveBatchClaims,
      startPriorRuntimeTrustBatchRecoverySweep
    } = require('./src/services/benchmark/claimRecovery');
    const recoveryStartedAt = new Date();
    startPriorRuntimeTrustBatchRecoverySweep({ recoveryStartedAt });
    recoverLeakedClaims({ recoveryStartedAt })
      .then(() => reacquireActiveBatchClaims())
      .catch(err => logger.warn('Claim recovery error', { error: err.message }));
    const { startProfilerProjectionRecovery } = require('./src/services/profiler/profilerProjectionRecovery');
    startProfilerProjectionRecovery();
    const {
      startBenchmarkAuthorityReconciliation
    } = require('./src/services/benchmark/benchmarkAuthorityReconciliation');
    startBenchmarkAuthorityReconciliation();
  } else {
    logger.info('[ClaimRecovery] Disabled by the demo product profile');
  }

  app.listen(PORT, HOST, () => {
    logger.info(`agentx-benchmark listening on ${HOST}:${PORT}`);
  });
}

if (require.main === module) {
  start().catch(err => {
    logger.error('Failed to start', { error: err.message });
    process.exit(1);
  });
}

module.exports = app;
