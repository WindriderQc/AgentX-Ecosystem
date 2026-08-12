const cors = require('cors');
const express = require('express');
const path = require('path');
const logger = require('./config/logger');
const {
  createCorePublicUrlsResolver,
  getPublicUrls,
} = require('../shared/browserPublicUrls');

const app = express();
app.locals.publicUrls = getPublicUrls();
const resolvePublicUrls = createCorePublicUrlsResolver({
  enabled: process.env.NODE_ENV !== 'test',
});

// EJS templating — shared layouts from core, local pages
app.set('view engine', 'ejs');
app.set('views', [
  path.join(__dirname, 'views'),
  path.join(__dirname, '..', 'core', 'views')
]);

const defaultAllowedOrigins = [
  'http://localhost:3080',
  'http://127.0.0.1:3080',
  'http://localhost:3082',
  'http://127.0.0.1:3082'
];
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map(origin => origin.trim())
  : defaultAllowedOrigins;

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

// Shared browser controls also consume Core's unified model catalog. Keep the
// request same-origin on standalone RAG deployments.
app.get('/api/models/all', async (req, res) => {
  const coreUrl = String(
    process.env.CORE_URL || process.env.CORE_PROXY_URL || 'http://localhost:3080'
  ).replace(/\/+$/, '');
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

app.get('/favicon.ico', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'favicon.svg'));
});

// The shared-utils source is copied into /dist by the RAG image and its
// relative module import resolves to this URL. Keep this exact non-Buddy asset
// available without bringing back the removed Buddy asset proxy.
app.get('/public/js/utils/polling-controller.js', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'core', 'public', 'js', 'utils', 'polling-controller.js'));
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.static(path.join(__dirname, '..', 'core', 'public')));

// Core's /api/config is the browser URL authority in the composed platform.
// Standalone RAG keeps the environment-driven localhost defaults.
app.use(async (req, res, next) => {
  if (req.method === 'GET' && !req.path.startsWith('/api/') && !path.extname(req.path)) {
    const publicUrls = await resolvePublicUrls();
    app.locals.publicUrls = publicUrls;
    res.locals.publicUrls = publicUrls;
  }
  next();
});

// ── Page routes (EJS) ────────────────────────────────────────────────────────
const ragHeadCss = '<link rel="stylesheet" href="/css/style.css">';

const dashboardPageView = path.resolve(__dirname, 'views/pages/dashboard');
const documentsPageView = path.resolve(__dirname, 'views/pages/documents');
const searchPageView    = path.resolve(__dirname, 'views/pages/search');
const uploadPageView    = path.resolve(__dirname, 'views/pages/upload');
const maintenancePageView = path.resolve(__dirname, 'views/pages/maintenance');

app.get('/', (req, res) => {
  res.render('layouts/main', {
    pageView: dashboardPageView,
    title: 'AgentX RAG — Dashboard',
    service: 'rag',
    activePage: 'rag',
    ragWorkflowStep: 'dashboard',
    bodyClass: 'dashboard-body',
    headCss: ragHeadCss,
    footerJs: '<script src="/js/api.js"></script>\n<script src="/js/dashboard.js"></script>'
  });
});

app.get('/documents', (req, res) => {
  res.render('layouts/main', {
    pageView: documentsPageView,
    title: 'AgentX RAG — Documents',
    service: 'rag',
    activePage: 'rag',
    ragWorkflowStep: 'documents',
    headCss: ragHeadCss,
    footerJs: '<script src="/js/api.js"></script>\n<script src="/js/documents.js"></script>'
  });
});

app.get('/search', (req, res) => {
  res.render('layouts/main', {
    pageView: searchPageView,
    title: 'AgentX RAG — Search Playground',
    service: 'rag',
    activePage: 'rag',
    ragWorkflowStep: 'search',
    headCss: ragHeadCss,
    footerJs: '<script src="/js/api.js"></script>\n<script src="/js/search.js"></script>'
  });
});

app.get('/upload', (req, res) => {
  res.render('layouts/main', {
    pageView: uploadPageView,
    title: 'AgentX RAG — Upload',
    service: 'rag',
    activePage: 'rag',
    ragWorkflowStep: 'upload',
    headCss: ragHeadCss,
    footerJs: '<script src="/js/api.js"></script>\n<script src="/js/upload.js"></script>'
  });
});

app.get('/maintenance', (req, res) => {
  res.render('layouts/main', {
    pageView: maintenancePageView,
    title: 'AgentX RAG — Maintenance',
    service: 'rag',
    activePage: 'rag',
    ragWorkflowStep: 'maintenance',
    headCss: ragHeadCss,
    footerJs: '<script src="/js/api.js"></script>\n<script src="/js/maintenance.js"></script>'
  });
});

// ── Legacy .html redirects ───────────────────────────────────────────────────
app.get('/index.html',       (req, res) => res.redirect(301, '/'));
app.get('/documents.html',   (req, res) => res.redirect(301, '/documents'));
app.get('/search.html',      (req, res) => res.redirect(301, '/search'));
app.get('/upload.html',      (req, res) => res.redirect(301, '/upload'));
app.get('/maintenance.html', (req, res) => res.redirect(301, '/maintenance'));

app.get('/health', (req, res) => {
  const dbReady = require('mongoose').connection.readyState === 1;
  const status = dbReady ? 'ok' : 'degraded';
  res.status(dbReady ? 200 : 503).json({
    status,
    service: 'agentx-rag',
    port: parseInt(process.env.PORT, 10) || 3082,
    db: dbReady ? 'connected' : 'disconnected'
  });
});

// ── Request-timing middleware (after /health, before API routes) ──
app.use('/api/rag', (req, res, next) => {
  req.startTime = Date.now();
  const originalJson = res.json.bind(res);
  res.json = function (body) {
    if (body && typeof body === 'object' && req.startTime) {
      const durationMs = Date.now() - req.startTime;
      body.meta = { ...(body.meta || {}), durationMs };
    }
    return originalJson(body);
  };
  next();
});

app.use('/api/rag', require('./routes/rag'));
app.use('/api/rag', require('./routes/document.routes'));
app.use('/api/rag', require('./routes/manifest.routes'));
app.use('/api/rag', require('./routes/migration.routes'));
app.use('/api/rag', require('./routes/metrics.routes'));
app.use('/api/rag', require('./routes/telemetry.routes'));
app.use('/api/rag', require('./routes/snapshots.routes'));

app.use((req, res) => {
  res.status(404).json({ ok: false, error: 'Not found' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { error: err.message, stack: err.stack, path: req.path });
  res.status(500).json({ ok: false, error: 'Internal server error' });
});

module.exports = app;
