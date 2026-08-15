const {
  normalizeAgentXProfile,
  demoSurfaceDisabled,
  createAgentXProfileGuard
} = require('../../../shared/agentxRuntimeProfile');

describe('Agent X runtime profile', () => {
  test('defaults safely to demo and requires an explicit full profile', () => {
    expect(normalizeAgentXProfile('demo')).toBe('demo');
    expect(normalizeAgentXProfile('DEMO')).toBe('demo');
    expect(normalizeAgentXProfile('')).toBe('demo');
    expect(normalizeAgentXProfile('personal')).toBe('demo');
    expect(normalizeAgentXProfile('full')).toBe('full');
  });

  test.each([
    '/api/openclaw/status',
    '/api/hermes/health',
    '/api/hermes-openai/v1/chat/completions',
    '/api/openclaw-ollama/api/generate',
    '/api/ollama-vram/status',
    '/api/ollama-watchdog/status',
    '/api/analytics/federated',
    '/api/analytics/codex-usage',
    '/api/analytics/voice',
    '/api/host-capacity',
    '/api/reports/morning-brief',
    '/api/pipeline/tasks',
    '/data-toolbox',
    '/host-agent/agent.js',
    '/portal',
    '/voice-personas.html'
  ])('disables integration surface %s', (pathname) => {
    expect(demoSurfaceDisabled(pathname)).toBe(true);
  });

  test.each([
    '/',
    '/playground',
    '/models',
    '/analytics',
    '/api/inference/generate',
    '/api/rag/search',
    '/api/benchmark-proxy/results'
  ])('keeps product surface %s', (pathname) => {
    expect(demoSurfaceDisabled(pathname)).toBe(false);
  });

  test('guard returns a bounded JSON 404 for disabled APIs', () => {
    const json = jest.fn();
    const res = {
      setHeader: jest.fn(),
      status: jest.fn(() => ({ json }))
    };
    const next = jest.fn();

    createAgentXProfileGuard('demo')({ path: '/api/openclaw/status' }, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-AgentX-Profile', 'demo');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AGENTX_DEMO_SURFACE_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });
});
