const {
  buildEcosystemSnapshot,
  classifyMemory,
  redactSecrets
} = require('../../src/services/ecosystemSnapshotService');
const hostPreferenceIdentity = require('../../src/services/hostPreferenceIdentity');

const configuredHosts = [
  { id: 'primary', url: 'http://192.0.2.105:11434', name: 'Host Alpha' },
  { id: 'secondary', url: 'http://192.0.2.12:11434', name: 'Host Beta' },
  { id: 'tertiary', url: 'http://192.0.2.99:11434', name: 'Host Gamma' }
];

function chain(value) {
  const c = {
    select: jest.fn(() => c),
    sort: jest.fn(() => c),
    limit: jest.fn(() => c),
    lean: jest.fn(() => Promise.resolve(value))
  };
  return c;
}

function response(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: jest.fn(() => Promise.resolve(body)),
    text: jest.fn(() => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)))
  };
}

const runtimeExport = {
  generatedAt: '2026-07-02T00:00:00.000Z',
  coreBaseUrl: 'http://192.0.2.99:3080',
  sourceOfTruth: {
    routing: '/api/nerve-center/routing/config'
  },
  lanes: {
    daily: {
      model: 'ax/qwen3-coder:30b',
      hostKey: 'primary',
      hostUrl: 'http://192.0.2.105:11434',
      contextSize: 40038
    }
  },
  hermes: {
    proxyBaseUrl: 'http://192.0.2.99:3080/api/hermes-openai/v1',
    defaultModelConfig: {
      default: 'openrouter/z-ai/glm-5.2',
      provider: 'custom',
      base_url: 'http://192.0.2.99:3080/api/hermes-openai/v1',
      context_length: 131072,
      api_key: 'no-key-required'
    },
    localFallbackModelConfig: {
      default: 'ax/qwen3-coder:30b',
      provider: 'custom',
      base_url: 'http://192.0.2.99:3080/api/hermes-openai/v1',
      context_length: 40038,
      api_key: 'no-key-required',
      ollama_num_ctx: 40038
    },
    authority: {
      policy: 'cloud_first_via_agentx_proxy',
      decisionDate: '2026-07-02',
      expectedBaseUrl: 'http://192.0.2.99:3080/api/hermes-openai/v1',
      expectedModel: 'openrouter/z-ai/glm-5.2',
      expectedContext: 131072,
      localFallbackModel: 'ax/qwen3-coder:30b',
      localFallbackContext: 40038,
      liveConfigValidation: 'protected_human_gated',
      directRuntimeBypass: 'pending_drift_until_classified'
    }
  },
  openclaw: {
    providerId: 'ollama',
    provider: {
      apiBase: 'http://192.0.2.99:3080/api/openclaw-ollama',
      models: [
        { id: 'ax/qwen3-coder:30b', contextWindow: 40038, params: { num_ctx: 40038 } }
      ]
    },
    defaults: {
      primary: 'ollama/ax/qwen3-coder:30b'
    },
    providerAliases: [
      {
        id: 'host-alpha-ollama',
        aliasOf: 'ollama',
        baseUrl: 'http://192.0.2.99:3080/api/openclaw-ollama',
        status: 'intentional_compatibility_alias'
      },
      {
        id: 'host-gamma-ollama',
        aliasOf: 'host-alpha-ollama',
        baseUrl: 'http://192.0.2.99:3080/api/openclaw-ollama',
        status: 'legacy_live_session_alias'
      }
    ],
    contextOverrides: [
      {
        provider: 'host-alpha-ollama',
        model: 'ax/qwen3-coder:30b',
        contextWindow: 74854,
        params: { num_ctx: 74854 },
        status: 'intentional_openclaw_specialist_override'
      }
    ]
  }
};

const openclawInventory = {
  source: { degraded: false, issues: [] },
  memory_strategy: { provider: 'ollama' },
  agents: [
    {
      id: 'deepsearch',
      name: 'DeepSearch',
      active: true,
      model: { primary: 'openrouter/qwen/qwen3-next-80b-a3b-instruct:free' },
      workspace: '/home/agentx/.openclaw/workspace-deepsearch',
      memory: {
        indexStatus: 'missing',
        dirty: true,
        files: 0,
        chunks: 0,
        issues: ['memory directory missing']
      }
    },
    {
      id: 'leadx',
      name: 'LeadX',
      active: true,
      model: { primary: 'ollama/ax/gemma4:e4b' },
      workspace: '/home/agentx/.openclaw/workspace-leadx',
      memory: {
        indexStatus: 'valid',
        dirty: false,
        files: 0,
        chunks: 0,
        issues: []
      }
    }
  ],
  known_gaps: [
    {
      id: 'deepsearch-memory-index-missing',
      severity: 'medium',
      detail: 'Memory index for deepsearch is missing.'
    }
  ]
};

const openclawRuntimeEvidence = {
  source: {
    inventory: openclawInventory.source,
    degraded: false,
    issues: [],
  },
  status: {
    online: true,
    version: '2026.7.1-2',
    gateway: { reachable: true },
    sessions: { count: 12, recent: [] },
  },
  defaults: { primary: 'ollama/ax/gemma4:e4b' },
  memoryStrategy: openclawInventory.memory_strategy,
  agents: openclawInventory.agents,
  inactiveWorkspaces: [],
  knownGaps: openclawInventory.known_gaps,
  cron: {
    available: true,
    count: 1,
    jobs: [{
      id: 'weekly',
      name: 'weekly-review',
      enabled: true,
      lastRunStatus: 'error',
      lastStatus: 'error',
      consecutiveErrors: 3,
      lastError: 'KeyError',
    }],
  },
  models: {
    default: 'ollama/ax/gemma4:e4b',
    fallbacks: [],
    providers: ['ollama', 'host-alpha-ollama'],
    liveModels: {
      'clawdx-coder': {
        provider: 'host-alpha-ollama',
        model: 'ax/qwen3-coder:30b',
        fullModel: 'ax/qwen3-coder:30b',
        updatedAt: 1783030802967,
      },
    },
  },
};

function makeFetch() {
  return jest.fn((url, requestOptions = {}) => {
    const text = String(url);
    const parsed = new URL(text);
    if (text.includes('/api/rag/status')) {
      return Promise.resolve(response({ status: 'success', data: { healthy: true, documents: 12 } }));
    }
    if (text.includes('/api/status')) {
      return Promise.resolve(response({
        version: '0.16.0',
        gateway_running: true,
        gateway_state: 'running',
        gateway_platforms: { telegram: { state: 'connected', token: 'secret-telegram-token' } }
      }));
    }
    if (parsed.host === 'hermes.test' && parsed.pathname === '/') {
      return Promise.resolve(response('<script>window.__HERMES_SESSION_TOKEN__="token-123";</script>'));
    }
    if (parsed.host === 'hermes.test' && parsed.pathname === '/api/config/raw') {
      const headers = requestOptions.headers || {};
      if (headers['X-Hermes-Session-Token'] !== 'token-123') {
        return Promise.resolve(response({ message: 'auth required' }, false, 401));
      }
      return Promise.resolve(response({
        yaml: [
          'model:',
          '  default: openrouter/z-ai/glm-5.2',
          '  provider: custom',
          '  base_url: http://192.0.2.99:3080/api/hermes-openai/v1',
          '  context_length: 131072',
          '  api_key: no-key-required'
        ].join('\n')
      }));
    }
    if (text.includes('/api/models/summary')) {
      return Promise.resolve(response({
        defaults: { primary: 'ollama/ax/gemma4:e4b' },
        configuredProviders: ['ollama', 'host-alpha-ollama'],
        agents: [
          {
            id: 'clawdx-coder',
            name: 'ClawdX Coder',
            modelPrimary: 'host-alpha-ollama/ax/qwen3-coder:30b',
            modelFallbacks: ['ollama/ax/gemma4:e4b']
          }
        ],
        liveModels: {
          'clawdx-coder': {
            provider: 'host-alpha-ollama',
            model: 'ax/qwen3-coder:30b',
            fullModel: 'ax/qwen3-coder:30b',
            updatedAt: 1783030802967
          }
        }
      }));
    }
    if (text.includes('/api/cron')) {
      return Promise.resolve(response({
        jobs: [
          {
            id: 'weekly',
            name: 'weekly-review',
            enabled: true,
            state: { lastRunStatus: 'error', lastStatus: 'error', consecutiveErrors: 3, lastError: 'KeyError' }
          }
        ]
      }));
    }
    if (text.includes('/api/config')) {
      return Promise.resolve(response({
        rawConfig: {
          models: {
            providers: {
              'host-alpha-ollama': {
                api: 'ollama',
                baseURL: 'http://192.0.2.99:3080/api/openclaw-ollama',
                apiKey: 'super-secret',
                models: [
                  {
                    id: 'ax/qwen3-coder:30b',
                    contextWindow: 74854,
                    params: { num_ctx: 74854 }
                  }
                ]
              }
            }
          }
        }
      }));
    }
    return Promise.resolve(response({}));
  });
}

function makeDeps(overrides = {}) {
  const counts = { queued: 2, in_progress: 1, review: 1, blocked: 0, done: 10 };
  return {
    agentRuntimeConfigService: {
      buildAgentRuntimeConfigExport: jest.fn(() => Promise.resolve(runtimeExport))
    },
    hostPrefService: {
      getAll: jest.fn(() => Promise.resolve([
        {
          hostUrl: 'http://192.0.2.99:11434',
          hostKey: 'primary',
          displayName: 'Host Gamma',
          status: 'ready',
          pinnedModels: []
        }
      ])),
      normalizeHostPreferenceIdentity: jest.fn((pref) =>
        hostPreferenceIdentity.normalizeHostPreferenceIdentity(pref, configuredHosts)),
      detectHostPreferenceIdentityDrift: jest.fn((prefs) =>
        hostPreferenceIdentity.detectHostPreferenceIdentityDrift(prefs, configuredHosts))
    },
    getConfiguredHosts: jest.fn(() => configuredHosts),
    computeHostCapacity: jest.fn(() => Promise.resolve({
      configId: 'primary',
      host: {
        configId: 'primary',
        hostId: 'host-alpha',
        hostname: 'Host Alpha',
        ollamaUrl: 'http://192.0.2.105:11434',
        online: true,
        ollamaReachable: true,
        hostStatus: 'offline',
        serviceStatus: 'offline',
        telemetryStale: true
      },
      verdict: 'BALANCED',
      verdictReasons: ['within balanced operating band'],
      vram: { totalMiB: 49152, usedMiB: 20000 },
      inference: { callSharePct: 75, errorRate: 0, topModels: [{ model: 'ax/qwen3-coder:30b', count: 4 }] },
      loadedModels: [{ name: 'ax/qwen3-coder:30b', contextLength: 40038 }]
    })),
    openclawRuntimeEvidenceService: {
      getOpenClawRuntimeEvidence: jest.fn(() => Promise.resolve(openclawRuntimeEvidence))
    },
    nestorFastlaneConfigService: {
      buildNestorFastlaneConfig: jest.fn(() => Promise.resolve({
        frontDoor: { id: 'main', runtime: 'openclaw' },
        controls: {
          hermesRuntime: {
            provider: 'agentx_hermes_openai_proxy',
            baseUrl: 'http://192.0.2.99:3080/api/hermes-openai/v1',
            primaryModel: 'ax/gemma4:26b-a4b-it-qat',
            context: 65536,
            authorityPolicy: {
              policy: 'cloud_first_via_agentx_proxy',
              status: 'drifted_until_live_config_validated',
              decisionDate: '2026-07-02'
            }
          },
          openclawRuntime: {
            provider: 'agentx_openclaw_ollama_proxy',
            baseUrl: 'http://192.0.2.99:3080/api/openclaw-ollama',
            providerAliases: runtimeExport.openclaw.providerAliases,
            contextOverrides: runtimeExport.openclaw.contextOverrides
          }
        },
        specialists: [{ id: 'clawdx-coder' }]
      }))
    },
    PromptConfig: {
      find: jest.fn(() => chain([
        {
          _id: 'p1',
          name: 'default_chat',
          version: 3,
          isActive: true,
          description: 'default',
          systemPrompt: 'do not expose me',
          stats: { impressions: 5 },
          uiConfig: { type: 'chat', route: '/chat' }
        }
      ]))
    },
    PipelineTask: {
      countDocuments: jest.fn(({ status }) => Promise.resolve(counts[status] || 0)),
      find: jest.fn(() => chain([
        { pipelineId: '0333', title: 'Build ecosystem snapshot API', status: 'in_progress', assignee: 'codex' }
      ]))
    },
    Alert: {
      find: jest.fn(() => chain([]))
    },
    clusterScheduleService: {
      getAllEntries: jest.fn(() => Promise.resolve([
        { source: 'openclaw', sourceId: 'weekly', name: 'weekly-review', taskType: 'monitoring', enabled: true }
      ]))
    },
    ...overrides
  };
}

describe('ecosystemSnapshotService', () => {
  it('returns the full snapshot shape and redacts sensitive values', async () => {
    const deps = makeDeps();
    const snapshot = await buildEcosystemSnapshot({
      now: '2026-07-02T00:00:00.000Z',
      coreBaseUrl: 'http://192.0.2.99:3080',
      ragBaseUrl: 'http://rag.test',
      hermesBaseUrl: 'http://hermes.test',
      fetchImpl: makeFetch(),
      deps
    });

    expect(snapshot.status).toBe('ok');
    expect(snapshot.generatedAt).toBe('2026-07-02T00:00:00.000Z');
    expect(snapshot).toHaveProperty('sources.runtime.status', 'ok');
    expect(snapshot).toHaveProperty('runtimes.hermes.expected.model', 'openrouter/z-ai/glm-5.2');
    expect(snapshot).toHaveProperty('runtimes.hermes.expected.localFallback.model', 'ax/qwen3-coder:30b');
    expect(snapshot).toHaveProperty('runtimes.hermes.authority.status', 'drifted');
    expect(snapshot).toHaveProperty('runtimes.hermes.authority.live.configValidation', 'checked');
    expect(snapshot).toHaveProperty('runtimes.openclaw.expected.providerAliases.0.id', 'host-alpha-ollama');
    expect(snapshot).toHaveProperty('runtimes.openclaw.expected.contextOverrides.0.contextWindow', 74854);
    expect(snapshot).toHaveProperty('hosts.capacity');
    expect(snapshot).toHaveProperty('hosts.summary.online', 3);
    expect(snapshot).toHaveProperty('hosts.summary.degraded', 0);
    expect(snapshot).toHaveProperty('hosts.capacity.0.hostId', 'host-alpha');
    expect(snapshot).toHaveProperty('hosts.capacity.0.hostname', 'Host Alpha');
    expect(snapshot).toHaveProperty('hosts.capacity.0.online', true);
    expect(snapshot).toHaveProperty('hosts.capacity.0.hostStatus', 'offline');
    expect(snapshot).toHaveProperty('hosts.capacity.0.telemetryStale', true);
    expect(snapshot).toHaveProperty('hosts.capacity.0.reasons.0', 'within balanced operating band');
    expect(snapshot).toHaveProperty('hosts.capacity.0.inference.errorRatePct', 0);
    expect(snapshot.hosts.preferences).toEqual(expect.arrayContaining([
      expect.objectContaining({
        displayName: 'Host Gamma',
        hostKey: 'tertiary',
        persistedHostKey: 'primary',
        configuredHostKey: 'tertiary',
        hostIdentityDrift: expect.objectContaining({ type: 'host_key_mismatch' })
      })
    ]));
    expect(snapshot).toHaveProperty('agents.openclaw');
    expect(snapshot).toHaveProperty('models.openclawProviders', ['ollama', 'host-alpha-ollama']);
    expect(snapshot).toHaveProperty('rag.healthy', true);
    expect(snapshot).toHaveProperty('prompts.configs');
    expect(snapshot).toHaveProperty('memory.byAgent.deepsearch.classification', 'missing');
    expect(snapshot).toHaveProperty('schedules.openclawCron.count', 1);
    expect(snapshot).toHaveProperty('pipeline.sourceOfTruth', 'mongodb:pipelinetasks');
    expect(snapshot).toHaveProperty('alerts.activeCount', 0);
    expect(deps.openclawRuntimeEvidenceService.getOpenClawRuntimeEvidence)
      .toHaveBeenCalledWith({ commandTimeoutMs: 15000 });

    const rendered = JSON.stringify(snapshot);
    expect(rendered).not.toContain('super-secret');
    expect(rendered).not.toContain('secret-telegram-token');
    expect(rendered).not.toContain('do not expose me');
    expect(snapshot.runtimes.hermes.expected.apiKey).toBe('[REDACTED]');
  });

  it('marks only the failed source degraded when one collector fails', async () => {
    const snapshot = await buildEcosystemSnapshot({
      now: '2026-07-02T00:00:00.000Z',
      fetchImpl: makeFetch(),
      deps: makeDeps({
        PromptConfig: {
          find: jest.fn(() => {
            throw new Error('prompt db down');
          })
        }
      })
    });

    expect(snapshot.status).toBe('degraded');
    expect(snapshot.sources.prompts.status).toBe('degraded');
    expect(snapshot.sources.prompts.error).toContain('prompt db down');
    expect(snapshot.sources.runtime.status).toBe('ok');
    expect(snapshot.sources.pipeline.status).toBe('ok');
    expect(snapshot.prompts).toEqual({ count: 0, activeCount: 0, configs: [] });
  });

  it('bounds a hanging official OpenClaw evidence collector so the snapshot stays responsive', async () => {
    const deps = makeDeps({
      openclawRuntimeEvidenceService: {
        getOpenClawRuntimeEvidence: jest.fn(() => new Promise(() => {}))
      }
    });

    const started = Date.now();
    const snapshot = await buildEcosystemSnapshot({
      now: '2026-07-02T00:00:00.000Z',
      openclawTimeoutMs: 25,
      fetchImpl: makeFetch(),
      deps
    });
    const elapsedMs = Date.now() - started;

    expect(elapsedMs).toBeLessThan(1000);
    expect(snapshot.status).toBe('degraded');
    expect(snapshot.sources.openclaw).toEqual(expect.objectContaining({
      status: 'degraded',
      error: 'openclaw timed out after 25ms'
    }));
    expect(snapshot.agents.openclaw).toEqual([]);
    expect(deps.openclawRuntimeEvidenceService.getOpenClawRuntimeEvidence)
      .toHaveBeenCalledWith({ commandTimeoutMs: 500 });
  });

  it('emits structured drift records while suppressing documented OpenClaw aliases', async () => {
    const deps = makeDeps();
    const originalBuildFastlaneConfig = deps.nestorFastlaneConfigService.buildNestorFastlaneConfig;
    deps.nestorFastlaneConfigService.buildNestorFastlaneConfig = jest.fn(async (...args) => {
      const config = await originalBuildFastlaneConfig(...args);
      return {
        ...config,
        controls: {
          ...config.controls,
          hermesRuntime: {
            ...config.controls.hermesRuntime,
            baseUrl: 'http://wrong.example/api/hermes-openai/v1'
          }
        }
      };
    });

    const snapshot = await buildEcosystemSnapshot({
      now: '2026-07-02T00:00:00.000Z',
      hermesBaseUrl: 'http://hermes.test',
      fetchImpl: makeFetch(),
      deps
    });

    const ids = snapshot.drift.map((record) => record.id);
    expect(ids).toContain('hermes-authority-base-url-mismatch');
    expect(ids).toContain('hermes-authority-model-mismatch');
    expect(ids).toContain('hermes-authority-context-mismatch');
    expect(ids).not.toContain('hermes-live-config-protected');
    expect(ids).toContain('host-identity-Host Gamma');
    expect(ids).toContain('openclaw-deepsearch-memory-index-missing');
    expect(ids).toContain('openclaw-cron-weekly-review');
    expect(snapshot.recommendations).toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: '0330' }),
      expect.objectContaining({ owner: '0332' })
    ]));
    expect(snapshot.recommendations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ owner: '0331' })
    ]));
  });

  it('treats documented OpenClaw missing memory as classified instead of drift', async () => {
    const deps = makeDeps({
      nestorFastlaneConfigService: {
        buildNestorFastlaneConfig: jest.fn(() => Promise.resolve({
          frontDoor: { id: 'main', runtime: 'openclaw' },
          controls: {
            hermesRuntime: {
              provider: 'agentx_hermes_openai_proxy',
              baseUrl: 'http://192.0.2.99:3080/api/hermes-openai/v1',
              primaryModel: 'openrouter/z-ai/glm-5.2',
              context: 131072
            },
            openclawRuntime: {
              provider: 'agentx_openclaw_ollama_proxy',
              baseUrl: 'http://192.0.2.99:3080/api/openclaw-ollama',
              providerAliases: runtimeExport.openclaw.providerAliases,
              contextOverrides: runtimeExport.openclaw.contextOverrides,
              memoryPolicies: [{
                agentId: 'deepsearch',
                expected: true,
                classification: 'missing',
                status: 'missing_bootstrap_source',
                reason: 'Documented test policy.'
              }]
            }
          },
          specialists: []
        }))
      }
    });

    const snapshot = await buildEcosystemSnapshot({
      now: '2026-07-02T00:00:00.000Z',
      fetchImpl: makeFetch(),
      deps
    });

    const ids = snapshot.drift.map((record) => record.id);
    expect(ids).not.toContain('openclaw-deepsearch-memory-index-missing');
    expect(snapshot).toHaveProperty('memory.byAgent.deepsearch.classification', 'missing');
    expect(snapshot).toHaveProperty('memory.byAgent.deepsearch.policy.status', 'missing_bootstrap_source');
    const gap = snapshot.memory.knownGaps.find((record) => record.agentId === 'deepsearch' || record.id === 'deepsearch-memory-index-missing');
    expect(gap).toHaveProperty('policy.reason', 'Documented test policy.');
  });

  it('classifies empty valid memory separately from healthy memory', () => {
    expect(classifyMemory({ indexStatus: 'missing', dirty: true, files: 0, chunks: 0 }).classification)
      .toBe('missing');
    expect(classifyMemory({ indexStatus: 'valid', dirty: false, files: 0, chunks: 0 }).classification)
      .toBe('empty-valid');
    expect(classifyMemory({ indexStatus: 'valid', dirty: false, files: 1, chunks: 4 }).classification)
      .toBe('healthy');
    expect(classifyMemory(null, { classification: 'stateless' }).classification)
      .toBe('intentionally-stateless');
  });

  it('redacts nested sensitive fields and URL query secrets', () => {
    expect(redactSecrets({
      apiKey: 'abc',
      nested: { url: 'https://example.test/path?token=abc&x=1' }
    })).toEqual({
      apiKey: '[REDACTED]',
      nested: { url: 'https://example.test/path?token=%5BREDACTED%5D&x=1' }
    });
  });
});
