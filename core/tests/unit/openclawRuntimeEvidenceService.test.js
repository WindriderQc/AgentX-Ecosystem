const {
  summarizeCron,
  summarizeMemory,
  summarizeModels,
  summarizeSessions,
  summarizeStatus,
} = require('../../src/services/openclawRuntimeEvidenceService');

describe('openclawRuntimeEvidenceService projections', () => {
  it('projects runtime status without session keys or credential fields', () => {
    const raw = {
      runtimeVersion: '2026.7.1-2',
      gateway: { reachable: true, url: 'http://127.0.0.1:18789', connectLatencyMs: 12, token: 'secret' },
      gatewayService: { running: true, state: 'running', apiKey: 'secret' },
      sessions: {
        count: 1,
        recent: [{
          sessionKey: 'agent:main:secret-session',
          agentId: 'main',
          kind: 'direct',
          model: 'ollama/model',
          totalTokens: 42,
          prompt: 'private prompt',
        }],
      },
    };

    const projected = summarizeStatus(raw, 8);

    expect(projected).toMatchObject({
      online: true,
      runtimeVersion: '2026.7.1-2',
      agents: 8,
      sessions: { count: 1, recent: [expect.objectContaining({ agentId: 'main', totalTokens: 42 })] },
    });
    expect(JSON.stringify(projected)).not.toContain('secret-session');
    expect(JSON.stringify(projected)).not.toContain('private prompt');
    expect(JSON.stringify(projected)).not.toContain('"token"');
    expect(JSON.stringify(projected)).not.toContain('"apiKey"');
  });

  it('projects cron health but omits executable payloads and delivery targets', () => {
    const projected = summarizeCron({ jobs: [{
      id: 'weekly',
      name: 'Weekly review',
      enabled: true,
      schedule: { kind: 'cron', expr: '0 18 * * *' },
      payload: { message: 'private automation prompt' },
      delivery: { to: 'private-channel' },
      state: { lastRunStatus: 'ok', consecutiveErrors: 0 },
    }] });

    expect(projected).toMatchObject({
      available: true,
      count: 1,
      jobs: [expect.objectContaining({ id: 'weekly', lastRunStatus: 'ok' })],
    });
    expect(JSON.stringify(projected)).not.toContain('private automation prompt');
    expect(JSON.stringify(projected)).not.toContain('private-channel');
  });

  it('summarizes configured models and providers from official inventory', () => {
    const models = summarizeModels({
      defaults: { model: { primary: 'ollama/default', fallbacks: ['openrouter/fallback'] } },
      agents: [{ id: 'main', name: 'Nestor', model: { primary: 'ollama/main', fallbacks: [] } }],
    });

    expect(models.default).toBe('ollama/default');
    expect(models.providers).toEqual(['ollama', 'openrouter']);
    expect(models.liveModels.main).toEqual(expect.objectContaining({ fullModel: 'ollama/main' }));
    expect(summarizeSessions({ sessions: { recent: [] } })).toEqual({ count: 0, recent: [] });
  });

  it('projects memory and vector health without filesystem paths', () => {
    const memory = summarizeMemory({ memory: {
      agentId: 'main',
      backend: 'builtin',
      files: 9,
      chunks: 37,
      dbPath: '/private/openclaw-agent.sqlite',
      provider: 'ollama',
      vector: { enabled: true, storeAvailable: true, dims: 1024, extensionPath: '/private/vec0.so' },
      custom: { indexIdentity: { status: 'valid' } },
    } });

    expect(memory).toEqual(expect.objectContaining({
      agentId: 'main',
      files: 9,
      chunks: 37,
      vector: { enabled: true, storeAvailable: true, dimensions: 1024 },
      indexStatus: 'valid',
    }));
    expect(JSON.stringify(memory)).not.toContain('/private/');
  });
});
