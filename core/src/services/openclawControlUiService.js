const DEFAULT_GATEWAY_URL = 'http://127.0.0.1:18789';
const DEFAULT_LOCAL_CONTROL_URL = 'http://127.0.0.1:18790';

const NATIVE_CAPABILITIES = Object.freeze([
  { id: 'overview', label: 'Overview', path: '/overview', icon: 'fa-gauge-high' },
  { id: 'chat', label: 'Chat', path: '/chat', icon: 'fa-comments' },
  { id: 'agents', label: 'Agents', path: '/agents', icon: 'fa-users-gear' },
  { id: 'sessions', label: 'Sessions', path: '/sessions', icon: 'fa-layer-group' },
  { id: 'tasks', label: 'Tasks', path: '/tasks', icon: 'fa-list-check' },
  { id: 'cron', label: 'Cron', path: '/cron', icon: 'fa-clock-rotate-left' },
  { id: 'channels', label: 'Channels', path: '/channels', icon: 'fa-paper-plane' },
  { id: 'skills', label: 'Skills', path: '/skills', icon: 'fa-wand-magic-sparkles' },
  { id: 'usage', label: 'Usage', path: '/usage', icon: 'fa-chart-pie' },
  { id: 'config', label: 'Config', path: '/config', icon: 'fa-sliders' },
  { id: 'logs', label: 'Logs', path: '/logs', icon: 'fa-file-lines' },
  { id: 'debug', label: 'Debug', path: '/debug', icon: 'fa-stethoscope' }
]);

const AGENTX_COMPLEMENTS = Object.freeze([
  { id: 'integration-events', label: 'Integration events', href: '/data-toolbox#live-data', icon: 'fa-satellite-dish', reason: 'AgentX Data owns generic webhook and live-data ingestion.' },
  { id: 'memory-vector', label: 'Memory / vector', href: '/agent-ops#agents', icon: 'fa-brain', reason: 'Agent Ops projects OpenClaw memory state; AgentX RAG owns cross-service retrieval.' },
  { id: 'provider-usage', label: 'Provider budget', href: '/analytics', icon: 'fa-chart-line', reason: 'AgentX reports routed cloud traffic; OpenClaw Usage owns native provider balances.' },
  { id: 'runtime-evidence', label: 'Runtime evidence', href: '/nerve-center', icon: 'fa-wave-square', reason: 'Nerve Center and Agent Ops own cross-platform health and routing evidence.' }
]);

function cleanBaseUrl(value, fallback = '') {
  const candidate = String(value || fallback || '').trim().replace(/\/+$/, '');
  if (!candidate) return '';
  try {
    const parsed = new URL(candidate);
    if (!['http:', 'https:'].includes(parsed.protocol)) return '';
    return parsed.toString().replace(/\/+$/, '');
  } catch {
    return '';
  }
}

function isLoopbackHost(hostname) {
  const value = String(hostname || '').replace(/^\[|\]$/g, '').toLowerCase();
  return value === 'localhost' || value === '::1' || value.startsWith('127.');
}

function hasSecureBrowserContext(baseUrl) {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === 'https:' || (parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname));
  } catch {
    return false;
  }
}

function safePort(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : fallback;
}

function safeSshTarget(value, fallback) {
  const candidate = String(value || '').trim();
  return /^[a-z0-9_.@:-]+$/i.test(candidate) ? candidate : fallback;
}

function launchMode(value) {
  const candidate = String(value || '').trim().toLowerCase();
  return ['ssh-tunnel', 'tunnel'].includes(candidate) ? 'ssh-tunnel' : 'direct';
}

function withBase(baseUrl, path) {
  return baseUrl ? `${baseUrl}${path}` : '';
}

function getOpenClawControlUiConfig(options = {}) {
  const gatewayUrl = cleanBaseUrl(
    options.gatewayUrl || process.env.OPENCLAW_GATEWAY_URL,
    DEFAULT_GATEWAY_URL
  );
  const directBaseUrl = cleanBaseUrl(
    options.directBaseUrl || process.env.OPENCLAW_CONTROL_UI_PUBLIC_URL,
    gatewayUrl
  );
  const localBaseUrl = cleanBaseUrl(
    options.localBaseUrl || process.env.OPENCLAW_CONTROL_UI_LOCAL_URL,
    DEFAULT_LOCAL_CONTROL_URL
  );
  const gateway = new URL(gatewayUrl || DEFAULT_GATEWAY_URL);
  const remotePort = safePort(gateway.port, 18789);
  const local = new URL(localBaseUrl || DEFAULT_LOCAL_CONTROL_URL);
  const localPort = safePort(local.port, 18790);
  const fallbackTarget = `${process.env.OPENCLAW_CONTROL_UI_SSH_USER || 'yb'}@${gateway.hostname}`;
  const tunnelTarget = safeSshTarget(
    options.tunnelTarget
      || process.env.OPENCLAW_CONTROL_UI_SSH_TARGET
      || process.env.OPENCLAW_INVENTORY_SSH_TARGET,
    fallbackTarget
  );
  const secureContextAvailable = hasSecureBrowserContext(directBaseUrl);
  const mode = launchMode(options.mode || process.env.OPENCLAW_CONTROL_UI_MODE);
  const requiresTunnel = mode === 'ssh-tunnel';
  const launchBaseUrl = requiresTunnel ? localBaseUrl : directBaseUrl;

  return {
    authority: 'official-openclaw-control-ui',
    directBaseUrl,
    launchBaseUrl,
    localBaseUrl,
    mode,
    secureContextAvailable,
    requiresSecureContext: false,
    requiresTunnel,
    tunnelTarget,
    tunnelCommand: requiresTunnel
      ? `ssh -N -L ${localPort}:127.0.0.1:${remotePort} ${tunnelTarget}`
      : '',
    nativeCapabilities: NATIVE_CAPABILITIES.map((capability) => ({
      ...capability,
      owner: 'openclaw',
      href: withBase(launchBaseUrl, capability.path)
    })),
    agentx: {
      authority: 'cross-platform-complements',
      complements: AGENTX_COMPLEMENTS.map((capability) => ({
        ...capability,
        owner: 'agentx'
      }))
    }
  };
}

module.exports = {
  getOpenClawControlUiConfig,
  hasSecureBrowserContext,
  cleanBaseUrl
};
