'use strict';

const voixClient = require('./voixClientService');
const { getMemoryStatus } = require('./nestorConsumerMemoryService');
const { getPersonalitySources } = require('./nestorConsumerPersonalityService');
const { getRouterSnapshot } = require('./nestorConsumerRuntimeService');
const { isLegacyBuddyApiEnabled } = require('./legacyBuddyCompatibility');
const {
  CONTRACT_NAME,
  CONTRACT_VERSION,
  CONTRACT_BASE_PATH,
  OPERATION_TASK_TYPES,
  MEMORY_SOURCES,
  PERSONALITY_SOURCES,
  LIMITS,
} = require('./nestorConsumerContract');

const DEFAULT_PROBE_TIMEOUT_MS = 5000;

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
    return { ...fallback, available: false, warning: `${label}: ${error.message}` };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getCapabilities({ systemHealth, probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const boundedProbeTimeoutMs = Math.max(1, Math.min(Number(probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS, 30000));
  const [router, memory, personality, voix] = await Promise.all([
    settle('router', getRouterSnapshot, { routes: {} }, boundedProbeTimeoutMs),
    settle('memory', () => getMemoryStatus(MEMORY_SOURCES), { sources: {}, warnings: [] }, boundedProbeTimeoutMs),
    settle('personality', getPersonalitySources, { sources: {} }, boundedProbeTimeoutMs),
    settle(
      'voix',
      async () => ({ available: true, health: await voixClient.health({ query: {} }) }),
      {},
      boundedProbeTimeoutMs
    ),
  ]);

  const warnings = [router.warning, memory.warning, personality.warning, voix.warning].filter(Boolean);

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
    },
    memory: {
      sources: MEMORY_SOURCES,
      statusEndpoint: `${CONTRACT_BASE_PATH}/memory/status`,
      searchEndpoint: `${CONTRACT_BASE_PATH}/memory/search`,
      providers: memory.sources || {},
      warnings: memory.warnings || [],
    },
    personality: {
      sources: PERSONALITY_SOURCES,
      discoveryEndpoint: `${CONTRACT_BASE_PATH}/personality/sources`,
      resolveEndpoint: `${CONTRACT_BASE_PATH}/personality/resolve`,
      providers: personality.sources || {},
      readOnly: true,
    },
    voix: {
      available: voix.available !== false,
      proxy: {
        settings: '/api/voix/settings',
        config: '/api/voix/config',
        transcribe: '/api/voix/transcribe',
        synthesize: '/api/voix/synthesize',
      },
      operatorConsole: '/voice',
      health: voix.health || null,
      warning: voix.warning || null,
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
      available: true,
      endpoint: `${CONTRACT_BASE_PATH}/panel-summary`,
      sourceEndpoint: '/api/panel/status',
    },
    metrics: {
      endpoint: `${CONTRACT_BASE_PATH}/metrics`,
      callerDetailPrefix: 'nestor/',
      maxHours: LIMITS.metricsHours,
    },
    limits: { ...LIMITS },
    legacyBuddy: {
      apiSupported: isLegacyBuddyApiEnabled(),
      uiSupported: false,
      compatibilityBaseline: 'Nestor v0.2.7',
      removalVersion: null,
      removalCondition: 'Nestor main no longer references /api/buddy/* and an explicit deprecation gate is approved.',
    },
  };
}

module.exports = { getCapabilities, settle, DEFAULT_PROBE_TIMEOUT_MS };
