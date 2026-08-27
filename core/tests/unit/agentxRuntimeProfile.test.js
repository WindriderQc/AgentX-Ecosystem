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
    '/api/ollama-vram/status',
    '/api/ollama-watchdog/status',
    '/api/analytics/federated',
    '/api/analytics/codex-usage',
    '/api/analytics/voice',
    '/api/reports/morning-brief',
    '/api/pipeline/tasks',
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
    '/prompts',
    '/api/prompts',
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

    createAgentXProfileGuard('demo')({ path: '/api/pipeline/tasks' }, res, next);

    expect(res.setHeader).toHaveBeenCalledWith('X-AgentX-Profile', 'demo');
    expect(res.status).toHaveBeenCalledWith(404);
    expect(json).toHaveBeenCalledWith(expect.objectContaining({ code: 'AGENTX_DEMO_SURFACE_DISABLED' }));
    expect(next).not.toHaveBeenCalled();
  });
});
