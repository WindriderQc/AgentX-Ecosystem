'use strict';

const { getMemoryStatus } = require('./nestorConsumerMemoryService');
const { getRouterSnapshot } = require('./nestorConsumerRuntimeService');
const {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  CONTRACT_BASE_PATH,
  OPERATION_TASK_TYPES,
  MEMORY_SOURCES,
  LIMITS,
} = require('./nestorConsumerContract');

const DEFAULT_PROBE_TIMEOUT_MS = 5000;
const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

function publicMessage(value) {
  return String(value || 'unavailable')
    .replace(ABSOLUTE_URL_PATTERN, '[redacted-endpoint]')
    .slice(0, 500);
}

async function settle(label, action, fallback, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(action),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`timed out after ${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } catch (error) {
    return { ...fallback, available: false, warning: `${label}: ${publicMessage(error.message)}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getCapabilities({ systemHealth, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const boundedProbeTimeoutMs = Math.max(1, Math.min(Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS, 30000));
  const [router, memory] = await Promise.all([
    settle('router', getRouterSnapshot, { routes: {} }, boundedProbeTimeoutMs),
    settle('memory', () => getMemoryStatus(MEMORY_SOURCES), { sources: {}, warnings: [] }, boundedProbeTimeoutMs),
  ]);

  const warnings = [router.warning, memory.warning].filter(Boolean);

  return {
    contract: {
      name: CONTRACT_NAME,
      version: CONTRACT_VERSION,
      basePath: CONTRACT_BASE_PATH,
    },
    generatedAt: new Date().toISOString(),
    warnings,
    agentx: {
      available: true,
      health: systemHealth?.overall || systemHealth?.status || 'serving',
      healthEndpoint: '/health',
    },
    router: {
      available: router.available !== false,
      inferenceEndpoint: `${CONTRACT_BASE_PATH}/inference`,
      effectiveRouteEndpoint: `${CONTRACT_BASE_PATH}/router`,
      modelCatalog: 'embedded-in-routes',
      modelCatalogEndpoint: '/api/models/all',
      operations: Object.keys(OPERATION_TASK_TYPES),
      taskTypes: OPERATION_TASK_TYPES,
      streaming: {
        supported: true,
        contentType: 'text/event-stream',
        events: ['route', 'delta', 'done', 'error'],
        cancellation: 'client-disconnect',
      },
    },
    memory: {
      sources: MEMORY_SOURCES,
      statusEndpoint: `${CONTRACT_BASE_PATH}/memory/status`,
      searchEndpoint: `${CONTRACT_BASE_PATH}/memory/search`,
      providers: memory.sources || {},
      warnings: memory.warnings || [],
    },
    events: {
      ingressEndpoint: '/api/platform-events',
      streamEndpoint: `${CONTRACT_BASE_PATH}/events/stream`,
      stableIds: true,
      cursorReplay: true,
      durableReplay: false,
      replayLimit: 200,
      cursorInputs: ['Last-Event-ID', 'cursor query parameter'],
    },
    panelSummary: {
      available: false,
      endpoint: `${CONTRACT_BASE_PATH}/panel-summary`,
      sourceEndpoint: null,
      code: 'ADAPTER_REQUIRED',
    },
    metrics: {
      endpoint: `${CONTRACT_BASE_PATH}/metrics`,
      callerDetailPrefix: 'nestor/',
      maxHours: LIMITS.metricsHours,
    },
    limits: { ...LIMITS },
    externalExperiences: {
      supported: false,
      code: 'ADAPTER_REQUIRED'
    },
  };
}

module.exports = { getCapabilities, publicMessage, settle, DEFAULT_PROBE_TIMEOUT_MS };
