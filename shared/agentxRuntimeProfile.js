'use strict';

const DEFAULT_PROFILE = 'demo';
const DEMO_PROFILE = 'demo';
const FULL_PROFILE = 'full';

const DEMO_DISABLED_PREFIXES = Object.freeze([
  '/api/agent-ops',
  '/api/alerts',
  '/api/analytics/codex-subscription-value',
  '/api/analytics/codex-usage',
  '/api/analytics/federated',
  '/api/analytics/voice',
  '/api/buddy',
  '/api/cluster',
  '/api/consumers/nestor',
  '/api/mcp',
  '/api/memory-review',
  '/api/nerve-center',
  '/api/nestor',
  '/api/ollama-vram',
  '/api/ollama-watchdog',
  '/api/operations',
  '/api/panel',
  '/api/pipeline',
  '/api/planning',
  '/api/platform-events',
  '/api/profile',
  '/api/reports',
  '/api/secretary',
  '/api/todos',
  '/api/voice-personas',
  '/api/voix',
  '/mcp',
  '/agent-ops',
  '/backup',
  '/cluster-schedule',
  '/lecture',
  '/memory-review',
  '/nestor',
  '/nerve-center',
  '/panel',
  '/pipeline',
  '/planning',
  '/portal',
  '/voice',
  '/voice-personas',
  '/voix'
]);

function normalizeAgentXProfile(value) {
  return String(value || DEFAULT_PROFILE).trim().toLowerCase() === FULL_PROFILE
    ? FULL_PROFILE
    : DEFAULT_PROFILE;
}

function currentAgentXProfile(env = process.env) {
  return normalizeAgentXProfile(env.AGENTX_PROFILE);
}

function isDemoProfile(value = process.env.AGENTX_PROFILE) {
  return normalizeAgentXProfile(value) === DEMO_PROFILE;
}

function matchesPrefix(pathname, prefix) {
  return pathname === prefix || pathname.startsWith(`${prefix}/`) || pathname.startsWith(`${prefix}.`);
}

function demoSurfaceDisabled(pathname) {
  const path = String(pathname || '/').split('?')[0];
  return DEMO_DISABLED_PREFIXES.some((prefix) => matchesPrefix(path, prefix));
}

function createAgentXProfileGuard(profile = currentAgentXProfile()) {
  const normalized = normalizeAgentXProfile(profile);
  return function agentXProfileGuard(req, res, next) {
    res.setHeader('X-AgentX-Profile', normalized);
    if (normalized !== DEMO_PROFILE || !demoSurfaceDisabled(req.path || req.url)) return next();

    if (String(req.path || '').startsWith('/api/') || String(req.path || '') === '/mcp') {
      return res.status(404).json({
        ok: false,
        error: 'This integration is not available in the Agent X demo profile.',
        code: 'AGENTX_DEMO_SURFACE_DISABLED'
      });
    }
    return res.status(404).type('text/plain').send('Not available in the Agent X demo profile.');
  };
}

module.exports = {
  DEFAULT_PROFILE,
  DEMO_PROFILE,
  FULL_PROFILE,
  DEMO_DISABLED_PREFIXES,
  normalizeAgentXProfile,
  currentAgentXProfile,
  isDemoProfile,
  demoSurfaceDisabled,
  createAgentXProfileGuard
};
