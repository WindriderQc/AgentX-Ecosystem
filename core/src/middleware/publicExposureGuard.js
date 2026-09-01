'use strict';

const crypto = require('crypto');

const {
  isLoopbackAddress,
  hasBrowserRequestSignals,
  operatorTokenAllowed,
  operatorUiHostAllowed,
  sameOriginUiAllowed,
} = require('./operatorAccess');
const {
  externalConsumerTokenAllowed,
  isExternalConsumerPath,
} = require('./externalConsumerAccess');
const { tokenAllowed: mcpTokenAllowed } = require('../helpers/mcpToken');

const PROTECTED_PATH_PREFIXES = ['/api/', '/mcp', '/api/mcp'];
const RUNTIME_BRIDGE_PATH_PREFIX = '/api/openclaw-ollama';
// These names exist only on the product-owned container network. They preserve
// secret-free default service-to-service calls while browser-shaped requests
// to the same Host values still have to prove exact same-origin access.
const INTERNAL_CORE_HOSTS = new Set(['core', 'agentx-core', 'agentx-ecosystem-core']);
const LOOPBACK_PUBLISHED_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

function splitList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function hostnameFromUrl(value) {
  try {
    return new URL(String(value)).hostname;
  } catch {
    return '';
  }
}

function normalizeHost(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .replace(/:\d+$/, '');
}

function configuredPublicHosts() {
  const configuredHosts = [
    ...splitList(process.env.AGENTX_PUBLIC_HOSTS),
    ...splitList(process.env.AGENTX_PUBLIC_HOST)
  ];

  const explicitUrlHosts = [
    hostnameFromUrl(process.env.AGENTX_PUBLIC_URL)
  ].filter(Boolean);

  return new Set([...configuredHosts, ...explicitUrlHosts]
    .map((entry) => normalizeHost(hostnameFromUrl(entry) || entry))
    .filter(Boolean));
}

function requestHost(req) {
  // Do not trust caller-supplied forwarding metadata. Deployments that use a
  // reverse proxy must preserve the external Host value (or enforce auth at
  // the proxy) rather than allowing X-Forwarded-Host to disable this guard.
  return normalizeHost(req.get?.('host') || req.hostname || '');
}

function isProtectedPath(pathname) {
  // Express route matching is case-insensitive by default, so the guard must
  // normalize too; otherwise `/API/...` would reach lowercase route handlers.
  const path = String(pathname || '').toLowerCase();
  return PROTECTED_PATH_PREFIXES.some((prefix) => (
    path === prefix.replace(/\/$/, '') || path.startsWith(prefix)
  ));
}

function tokensMatch(expected, presented) {
  const left = Buffer.from(String(expected || ''));
  const right = Buffer.from(String(presented || ''));
  return left.length > 0
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
}

function benchmarkCredentialPath(pathname, method) {
  const path = String(pathname || '').toLowerCase();
  const verb = String(method || 'GET').toUpperCase();
  if (path === '/api/inference/generate' || path.startsWith('/api/inference/generate/')) {
    return verb === 'POST';
  }
  if (path === '/api/inference/contract/resolve') return verb === 'POST';
  if (verb === 'GET' && path === '/api/models/registry') return true;
  if (verb === 'GET' && /^\/api\/models\/registry\/[^/]+$/.test(path)) {
    // Benchmark consumes only the collection and one-model reads. Keep its
    // service credential away from nested routes such as `context-info`,
    // which can perform caller-selected outbound probes.
    return !new Set(['stats', 'grouped']).has(path.split('/').at(-1));
  }
  if (path === '/api/nerve-center/host-preferences') return verb === 'GET';
  if (path === '/api/nerve-center/host-preferences/benchmark-claims/active') return verb === 'GET';
  if (!path.startsWith('/api/nerve-center/host-preferences/')) return false;
  return (verb === 'POST' && (
    path.endsWith('/reload')
    || path.endsWith('/benchmark-claim')
    || /\/benchmark-claim\/[^/]+\/heartbeat$/.test(path)
  )) || (verb === 'DELETE' && /\/benchmark-claim\/[^/]+$/.test(path));
}

function runtimeBridgeCredentialPath(pathname) {
  const path = String(pathname || '').split('?')[0].toLowerCase();
  return path === RUNTIME_BRIDGE_PATH_PREFIX
    || path.startsWith(`${RUNTIME_BRIDGE_PATH_PREFIX}/`);
}

function runtimeBridgeCredentialAllowed(req) {
  if (!runtimeBridgeCredentialPath(req.path || req.originalUrl)) return false;
  const authorization = String(req.get?.('authorization') || '');
  const bearer = authorization.toLowerCase().startsWith('bearer ')
    ? authorization.slice(7).trim()
    : '';
  const presented = bearer || String(req.get?.('x-agentx-runtime-token') || '').trim();
  return tokensMatch(process.env.AGENTX_RUNTIME_BRIDGE_TOKEN, presented);
}

function workflowMachineCredential(pathname, method) {
  const path = String(pathname || '').toLowerCase();
  const verb = String(method || 'GET').toUpperCase();

  if ((verb === 'POST' && (
    path === '/api/memory-review/runs'
    || /^\/api\/memory-review\/runs\/[^/]+\/(observations|finalize|candidates|fail)$/.test(path)
  )) || (verb === 'GET'
    && /^\/api\/memory-review\/runs\/[^/]+\/synthesis-input$/.test(path))) {
    return {
      environmentVariable: 'AGENTX_MEMORY_REVIEW_TOKEN',
      header: 'x-agentx-memory-review-token',
    };
  }

  if ((verb === 'POST' && (
    path === '/api/cluster/schedule/sync'
    || path === '/api/cluster/schedule/claim'
  )) || (verb === 'DELETE' && /^\/api\/cluster\/schedule\/claim\/[^/]+$/.test(path))) {
    return {
      environmentVariable: 'AGENTX_SCHEDULE_TOKEN',
      header: 'x-agentx-schedule-token',
    };
  }

  if ((verb === 'POST' && (
    /^\/api\/pipeline\/tasks\/[^/]+\/(claim|feedback|heartbeat|status)$/.test(path)
    || path === '/api/todos'
  )) || (verb === 'GET' && (
    path === '/api/pipeline/tasks/next'
    || /^\/api\/pipeline\/tasks\/[^/]+\/worker$/.test(path)
  ))) {
    return {
      environmentVariable: 'AGENTX_PIPELINE_TOKEN',
      header: 'x-agentx-pipeline-token',
    };
  }

  if (verb === 'POST' && /^\/api\/alerts\/[^/]+\/delivery-status$/.test(path)) {
    return {
      environmentVariable: 'AGENTX_ALERT_DELIVERY_TOKEN',
      header: 'x-agentx-alert-delivery-token',
    };
  }

  return null;
}

function scopedMachineCredentialAllowed(req) {
  const pathname = String(req.path || req.originalUrl || '').split('?')[0].toLowerCase();
  const method = req.method;

  const mcpPath = (String(method || 'GET').toUpperCase() === 'POST') && (
    pathname === '/mcp'
    || pathname.startsWith('/mcp/')
    || pathname === '/api/mcp'
    || pathname.startsWith('/api/mcp/')
    || pathname === '/api/planning/automation/reconcile'
  );
  if (mcpPath && mcpTokenAllowed(req)) return true;

  if (String(method || 'GET').toUpperCase() === 'POST'
    && pathname === '/api/analytics/codex-usage' && tokensMatch(
    process.env.AGENTX_CODEX_USAGE_TOKEN,
    req.get?.('x-agentx-codex-usage-token')
  )) return true;

  if (String(method || 'GET').toUpperCase() === 'POST'
    && pathname === '/api/platform-events'
    && tokensMatch(
      process.env.AGENTX_PLATFORM_EVENT_TOKEN,
      req.get?.('x-platform-event-token')
    )) return true;

  if (benchmarkCredentialPath(pathname, method) && tokensMatch(
    process.env.AGENTX_BENCHMARK_TOKEN,
    req.get?.('x-agentx-benchmark-token')
  )) return true;

  // A separately operated runtime bridge may receive one dedicated token, but
  // only on the exact OpenClaw-compatible proxy family. The mounted bridge
  // revalidates this same credential before serving discovery or inference.
  if (runtimeBridgeCredentialAllowed(req)) return true;

  const workflowCredential = workflowMachineCredential(pathname, method);
  if (workflowCredential && tokensMatch(
    process.env[workflowCredential.environmentVariable],
    req.get?.(workflowCredential.header)
  )) return true;

  return false;
}

function trustedLocalMachineAllowed(req, resolvedHost = requestHost(req)) {
  const remoteAddress = req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || '';
  const headerlessRequest = !hasBrowserRequestSignals(req);
  const trustedLoopback = isLoopbackAddress(remoteAddress)
    && operatorUiHostAllowed(req)
    && headerlessRequest;
  const trustedLoopbackPublishedMachine = LOOPBACK_PUBLISHED_HOSTS.has(resolvedHost)
    && String(process.env.AGENTX_TRUST_LOOPBACK_PROXY_UI || '').trim().toLowerCase() === 'true'
    && headerlessRequest;
  const trustedInternalMachine = INTERNAL_CORE_HOSTS.has(resolvedHost)
    && String(process.env.AGENTX_TRUST_INTERNAL_SERVICE_HOSTS || '').trim().toLowerCase() === 'true'
    && headerlessRequest;
  return trustedLoopback || trustedLoopbackPublishedMachine || trustedInternalMachine;
}

function publicExposureGuard(req, res, next) {
  const publicHosts = configuredPublicHosts();
  const host = requestHost(req);

  if (!isProtectedPath(req.path || req.originalUrl)) {
    return next();
  }

  if (operatorTokenAllowed(req)) return next();
  if (isExternalConsumerPath(req.path || req.originalUrl)
    && externalConsumerTokenAllowed(req)) return next();
  // Scoped credentials are admitted only to the route families that own them.
  // Their route-local validators still run and remain the contract authority.
  if (scopedMachineCredentialAllowed(req)) return next();

  const trustedBrowserUi = sameOriginUiAllowed(req);
  // Docker Desktop forwards a host-loopback published port through its VM, so
  // Core observes the gateway address rather than 127.0.0.1. The default
  // Compose topology opts into this narrow bridge explicitly. It admits only
  // headerless CLI/tooling calls addressed to a literal loopback Host; browser
  // requests still have to pass the exact same-origin check above.
  const trustedLocalMachine = trustedLocalMachineAllowed(req, host);
  if (!publicHosts.has(host) && (
    trustedBrowserUi
    || trustedLocalMachine
  )) {
    return next();
  }

  return res.status(403).json({
    ok: false,
    status: 'error',
    code: 'PUBLIC_EXPOSURE_GUARD',
    message: 'AgentX API access requires a trusted local UI origin or operator token.'
  });
}

module.exports = {
  configuredPublicHosts,
  INTERNAL_CORE_HOSTS,
  LOOPBACK_PUBLISHED_HOSTS,
  RUNTIME_BRIDGE_PATH_PREFIX,
  benchmarkCredentialPath,
  requestHost,
  isProtectedPath,
  publicExposureGuard,
  runtimeBridgeCredentialAllowed,
  runtimeBridgeCredentialPath,
  scopedMachineCredentialAllowed,
  trustedLocalMachineAllowed,
  tokensMatch,
  workflowMachineCredential,
};
