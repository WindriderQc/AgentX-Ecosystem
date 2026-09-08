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
    '/api/agent-ops',
    '/api/ollama-vram/status',
    '/api/ollama-watchdog/status',
    '/api/analytics/federated',
    '/api/analytics/codex-usage',
    '/api/analytics/voice',
    '/api/reports/morning-brief',
    '/api/pipeline/tasks',
    '/agent-ops',
    '/voice-personas'
  ])('disables integration surface %s', (pathname) => {
    expect(demoSurfaceDisabled(pathname)).toBe(true);
  });

  test.each([
    '/',
    '/portal',
    '/portal/',
    '/playground',
    '/models',
    '/analytics',
    '/prompts',
    '/api/prompts',
    '/api/inference/generate',
    '/api/rag/search',
    '/api/benchmark-proxy/recommend'
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

  test('allows a Benchmark reservation lifecycle in demo while keeping host editing hidden', () => {
    const host = encodeURIComponent('http://127.0.0.1:11434');
    const prefix = '/api/nerve-center';
    for (const [method, path] of [
      ['POST', '/workload-admissions'],
      ['POST', '/workload-admissions/run-1/heartbeat'],
      ['POST', `/host-preferences/${host}/benchmark-claim`],
      ['POST', `/host-preferences/${host}/benchmark-claim/run-1/heartbeat`],
      ['DELETE', `/host-preferences/${host}/benchmark-claim/run-1`],
      ['POST', `/host-preferences/${host}/benchmark-claim/run-1/release-receipt`],
      ['DELETE', '/workload-admissions/run-1'],
      ['POST', '/workload-admissions/run-1/release-receipt']
    ]) expect(demoSurfaceDisabled(prefix + path, method)).toBe(false);

    expect(demoSurfaceDisabled(`${prefix}/host-preferences/${host}`, 'PUT')).toBe(true);
    expect(demoSurfaceDisabled(`${prefix}/host-preferences/${host}/swap`, 'POST')).toBe(true);
    expect(demoSurfaceDisabled(`${prefix}/maintenance-leases`, 'POST')).toBe(true);
    expect(demoSurfaceDisabled(`${prefix}/ecosystem`, 'GET')).toBe(true);
    expect(demoSurfaceDisabled(`${prefix}/workload-admissions`, 'GET')).toBe(true);
    expect(demoSurfaceDisabled('/nerve-center')).toBe(true);
  });
});
