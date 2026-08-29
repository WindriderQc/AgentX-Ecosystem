'use strict';

const NOW = '2026-08-28T16:00:00.000Z';
const OBSERVED_AT = '2026-08-28T15:59:30.000Z';
const PRODUCT_VERSION = '0.1.1';

function identity(service) {
  return {
    service,
    version: PRODUCT_VERSION,
    profile: 'full',
    revision: 'working-tree',
    ts: OBSERVED_AT,
  };
}

function fixture(status, body, contractVersion = null) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      date: new Date(OBSERVED_AT).toUTCString(),
      ...(contractVersion ? { 'x-agentx-consumer-contract': contractVersion } : {}),
    },
    body,
  };
}

function portalService(id) {
  return {
    id,
    label: id,
    port: 0,
    status: 'ok',
    latency_ms: 1,
    issues: [],
    identity: identity(`agentx-${id}`),
    detail: {},
  };
}

function genericCapabilities({ available = true } = {}) {
  return {
    ok: true,
    status: 'success',
    data: {
      contract: { name: 'agentx.external-consumer', version: '1.0.0', basePath: '/api/consumers/v1' },
      generatedAt: OBSERVED_AT,
      agentx: { available, health: available ? 'ok' : 'degraded', healthEndpoint: '/health' },
      inference: {
        endpoint: '/api/consumers/v1/inference',
        modes: ['chat', 'generate'],
        routed: true,
        stateless: true,
        persistence: false,
        thinking: { booleanControl: true, modes: null },
        generationOptions: ['temperature'],
        streaming: {
          supported: true,
          contentType: 'text/event-stream',
          events: ['route', 'delta', 'done', 'error'],
          cancellation: 'client-disconnect',
        },
      },
      routing: { endpoint: '/api/consumers/v1/routing', readOnly: true, topology: 'opaque' },
      authentication: {
        remote: 'bearer-or-x-agentx-consumer-token',
        environmentVariable: 'AGENTX_EXTERNAL_CONSUMER_TOKEN',
        loopback: 'allowed',
      },
      limits: { messageCount: 100, messageCharacters: 16000, totalMessageCharacters: 64000, promptCharacters: 64000 },
    },
  };
}

function nestorCapabilities({ available = true } = {}) {
  return {
    ok: true,
    status: 'success',
    data: {
      contract: { name: 'agentx.nestor.consumer', version: '1.2.0', basePath: '/api/consumers/nestor/v1' },
      generatedAt: OBSERVED_AT,
      warnings: available ? [] : ['router: unavailable'],
      agentx: { available: true, health: 'ok', healthEndpoint: '/health' },
      router: {
        available,
        inferenceEndpoint: '/api/consumers/nestor/v1/inference',
        effectiveRouteEndpoint: '/api/consumers/nestor/v1/router',
        modelCatalog: 'embedded-in-routes',
        modelCatalogEndpoint: '/api/models/all',
        operations: ['chat', 'react', 'analyze'],
        taskTypes: { chat: 'buddy_chat', react: 'buddy_reaction', analyze: 'analysis' },
        streaming: { supported: true, contentType: 'text/event-stream', events: ['route', 'delta', 'done', 'error'], cancellation: 'client-disconnect' },
      },
      memory: {
        sources: ['agentx', 'rag'],
        statusEndpoint: '/api/consumers/nestor/v1/memory/status',
        searchEndpoint: '/api/consumers/nestor/v1/memory/search',
        providers: { agentx: { source: 'agentx', available: true } },
        warnings: [],
      },
      events: {
        ingressEndpoint: '/api/platform-events',
        streamEndpoint: '/api/consumers/nestor/v1/events/stream',
        stableIds: true,
        cursorReplay: true,
        durableReplay: false,
        replayLimit: 200,
        cursorInputs: ['Last-Event-ID', 'cursor query parameter'],
      },
      panelSummary: { available: false, endpoint: '/api/consumers/nestor/v1/panel-summary', sourceEndpoint: null, code: 'ADAPTER_REQUIRED' },
      metrics: { endpoint: '/api/consumers/nestor/v1/metrics', callerDetailPrefix: 'nestor/', maxHours: 720 },
      limits: {
        messageCount: 50,
        messageCharacters: 8000,
        totalMessageCharacters: 32000,
        inferenceTimeoutMs: 125000,
        streamLineCharacters: 262144,
        memoryQueryCharacters: 2000,
        memoryResultsPerSource: 20,
        metricsHours: 720,
        metricsRows: 10000,
      },
      externalExperiences: { supported: false, code: 'ADAPTER_REQUIRED' },
    },
  };
}

function nestorRoute(operation, taskType, available = true) {
  return {
    taskType,
    default: { model: `${operation}-model`, host: 'primary' },
    override: null,
    effective: { model: `${operation}-model`, host: 'primary' },
    provenance: 'router-default',
    model: `${operation}-model`,
    hostKey: 'primary',
    readiness: {
      stage: 'benchmarked',
      profiledAt: OBSERVED_AT,
      profileDepth: 'standard',
      benchmarkQualified: true,
      benchmarkedAt: OBSERVED_AT,
      stale: false,
      hostId: 'primary',
      scope: 'host',
      isReady: true,
    },
    lane: 'interactive',
    routingSource: available ? 'configured-host' : null,
    reason: available ? 'Configured route.' : 'Routing evidence is unavailable.',
    available,
  };
}

function healthyFixtures() {
  const portalServices = ['core', 'benchmark', 'rag'].map(portalService);
  return {
    'core-health': fixture(200, {
      ok: true,
      status: 'ok',
      ...identity('agentx-core'),
      port: 3080,
      details: { mongodb: 'connected', ollama: 'unavailable' },
    }),
    'rag-health': fixture(200, {
      ok: true,
      status: 'ok',
      ...identity('agentx-rag'),
      port: 3082,
      db: 'connected',
      vectorStore: { healthy: true, type: 'qdrant' },
    }),
    'core-portal-health': fixture(200, {
      generatedAt: OBSERVED_AT,
      generated_at: OBSERVED_AT,
      summary: { status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0, identityStatus: 'ok' },
      consistency: { status: 'ok', profiles: ['full'], versions: [PRODUCT_VERSION], revisions: ['working-tree'], missing: [], issues: [] },
      services: portalServices,
    }),
    'core-ecosystem-snapshot': fixture(200, {
      status: 'success',
      data: {
        schemaVersion: 2,
        generatedAt: OBSERVED_AT,
        authority: 'agentx-product',
        readOnly: true,
        health: { status: 'ok', configuredHosts: 2, onlineHosts: 2, offlineHosts: 0, observedModels: 4 },
        serviceHealth: { status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0 },
        services: portalServices,
        identityConsistency: { status: 'ok' },
        evidence: { snapshotObservedAt: OBSERVED_AT, servicesObservedAt: OBSERVED_AT },
        cluster: [],
        routing: {},
        routingConfig: {},
        hostPreferences: [],
        alerts: [],
        alertSummary: { activeCount: 0 },
        recentRouting: [],
      },
    }),
    'generic-consumer-capabilities': fixture(200, genericCapabilities(), '1.0.0'),
    'generic-consumer-routing': fixture(200, {
      ok: true,
      status: 'success',
      data: {
        schemaVersion: 1,
        generatedAt: OBSERVED_AT,
        readOnly: true,
        topology: 'opaque',
        tasks: {
          general_chat: {
            taskType: 'general_chat',
            model: 'chat-model',
            hostKey: 'primary',
            available: true,
            host: { key: 'primary', status: 'available', benchmarkClaimed: false },
            context: { windowTokens: 32768, source: 'profile' },
            qualification: { state: 'qualified', qualified: true },
          },
        },
        warnings: [],
      },
    }, '1.0.0'),
    'nestor-consumer-capabilities': fixture(200, nestorCapabilities(), '1.2.0'),
    'nestor-consumer-routing': fixture(200, {
      ok: true,
      status: 'success',
      data: {
        generatedAt: OBSERVED_AT,
        available: true,
        readOnly: true,
        topology: 'opaque',
        modelCatalog: '/api/models/all',
        modelCatalogMode: 'embedded-in-routes',
        effectiveRoute: '/api/consumers/nestor/v1/router',
        routes: {
          chat: nestorRoute('chat', 'buddy_chat'),
          react: nestorRoute('react', 'buddy_reaction'),
          analyze: nestorRoute('analyze', 'analysis'),
        },
      },
    }, '1.2.0'),
    'nestor-data-read-status': fixture(200, {
      ok: true,
      status: 'success',
      data: {
        generatedAt: OBSERVED_AT,
        readOnly: true,
        sources: { agentx: { source: 'agentx', available: true, lane: 'core-mongo', counts: {} } },
        available: ['agentx'],
        warnings: [],
      },
    }, '1.2.0'),
    'nestor-data-read-search': fixture(200, {
      ok: true,
      status: 'success',
      data: {
        generatedAt: OBSERVED_AT,
        readOnly: true,
        query: 'agentx conformance probe',
        k: 3,
        sources: ['agentx'],
        results: [{ source: 'agentx', text: 'bounded result', snippet: 'bounded result', score: 0.9, ref: 'conversation:1' }],
        bySource: { agentx: [{ source: 'agentx', text: 'bounded result', snippet: 'bounded result', score: 0.9, ref: 'conversation:1' }] },
        warnings: [],
      },
    }, '1.2.0'),
    'rag-status': fixture(200, {
      ok: true,
      data: {
        documentCount: 1,
        vectorStore: { healthy: true, type: 'qdrant' },
        cache: { size: 0 },
        dependencies: {
          mongodb: { healthy: true, readyState: 1 },
          embedding: { healthy: true, provider: 'local', model: 'embed-model' },
          qdrant: { healthy: true },
        },
        healthy: true,
      },
      meta: { durationMs: 1, observedAt: OBSERVED_AT },
    }),
    'rag-documents-read': fixture(200, {
      ok: true,
      data: { documents: [{ documentId: 'doc-1', source: 'fixture', chunkCount: 1 }], total: 1, limit: 3, offset: 0 },
      meta: { durationMs: 1, observedAt: OBSERVED_AT },
    }),
    'rag-search-read': fixture(200, {
      ok: true,
      data: {
        results: [{ text: 'result', score: 0.9, metadata: { documentId: 'doc-1', source: 'fixture' } }],
        count: 1,
      },
      meta: { durationMs: 1, observedAt: OBSERVED_AT },
    }),
  };
}

function degradedFixtures() {
  const fixtures = healthyFixtures();
  fixtures['core-health'] = fixture(503, {
    ok: false,
    status: 'degraded',
    ...identity('agentx-core'),
    details: { mongodb: 'disconnected', ollama: 'unavailable' },
  });
  fixtures['rag-health'] = fixture(503, {
    ok: false,
    status: 'degraded',
    ...identity('agentx-rag'),
    db: 'disconnected',
    vectorStore: { healthy: false, type: 'qdrant', error: 'dependency unavailable' },
  });

  const portal = fixtures['core-portal-health'].body;
  portal.summary = { status: 'down', total: 3, healthy: 2, degraded: 0, down: 1, identityStatus: 'degraded' };
  portal.consistency = { status: 'degraded', profiles: ['full'], versions: [PRODUCT_VERSION], revisions: ['working-tree'], missing: ['rag'], issues: ['Identity unavailable: rag'] };
  portal.services[2] = { id: 'rag', label: 'rag', port: 0, status: 'down', latency_ms: null, issues: ['unreachable'], identity: null, detail: { error: 'unreachable' } };

  const ecosystem = fixtures['core-ecosystem-snapshot'].body.data;
  ecosystem.health = { status: 'degraded', configuredHosts: 2, onlineHosts: 1, offlineHosts: 1, observedModels: 2 };
  ecosystem.serviceHealth = { status: 'down', total: 3, healthy: 2, degraded: 0, down: 1 };
  ecosystem.identityConsistency = { status: 'degraded' };

  fixtures['generic-consumer-capabilities'] = fixture(200, genericCapabilities({ available: false }), '1.0.0');
  const genericRouting = fixtures['generic-consumer-routing'].body.data;
  genericRouting.tasks.general_chat.available = false;
  genericRouting.tasks.general_chat.model = null;
  genericRouting.tasks.general_chat.hostKey = null;
  genericRouting.tasks.general_chat.host.key = null;
  genericRouting.warnings = ['Some routing evidence is unavailable.'];

  fixtures['nestor-consumer-capabilities'] = fixture(200, nestorCapabilities({ available: false }), '1.2.0');
  const nestorRouting = fixtures['nestor-consumer-routing'].body.data;
  nestorRouting.available = false;
  Object.values(nestorRouting.routes).forEach((route) => {
    route.available = false;
    route.routingSource = null;
    route.reason = 'Routing evidence is unavailable.';
  });

  fixtures['nestor-data-read-status'] = fixture(200, {
    ok: true,
    status: 'success',
    data: {
      generatedAt: OBSERVED_AT,
      readOnly: true,
      sources: { agentx: { source: 'agentx', available: false, error: 'database unavailable' } },
      available: [],
      warnings: [{ source: 'agentx', code: 'MEMORY_SOURCE_UNAVAILABLE', message: 'database unavailable' }],
    },
  }, '1.2.0');
  fixtures['nestor-data-read-search'] = fixture(200, {
    ok: true,
    status: 'success',
    data: {
      generatedAt: OBSERVED_AT,
      readOnly: true,
      query: 'agentx conformance probe',
      k: 3,
      sources: ['agentx'],
      results: [],
      bySource: { agentx: [] },
      warnings: [{ source: 'agentx', code: 'MEMORY_SOURCE_SEARCH_FAILED', message: 'database unavailable' }],
    },
  }, '1.2.0');
  fixtures['rag-status'].body.data.healthy = false;
  fixtures['rag-status'].body.data.dependencies.qdrant = { healthy: false, error: 'dependency unavailable' };
  fixtures['rag-documents-read'] = fixture(503, {
    ok: false,
    error: 'RAG_NOT_READY',
    meta: { durationMs: 1, observedAt: OBSERVED_AT },
  });
  fixtures['rag-search-read'] = fixture(503, {
    ok: false,
    error: 'RAG_NOT_READY',
    meta: { durationMs: 1, observedAt: OBSERVED_AT },
  });
  return fixtures;
}

module.exports = {
  NOW,
  OBSERVED_AT,
  PRODUCT_VERSION,
  degradedFixtures,
  fixture,
  healthyFixtures,
  identity,
};
