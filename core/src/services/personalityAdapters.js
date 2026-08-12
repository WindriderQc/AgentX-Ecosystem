// Personality source adapters for buddy linkage (Phase 6f).
// Hermes personality comes from the Hermes dashboard API. OpenClaw agents are
// discovered through the bounded official OpenClaw inventory over SSH when
// local workspaces are not mounted.

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { buildOpenClawAgentInventory } = require('./openclawAgentInventoryService');

const MAX_SOUL_BYTES = 32 * 1024;
const BOOTSTRAP_HERMES_BYTES = 2048;
const BOOTSTRAP_TOTAL_CAP = 4000;
const HERMES_API_TIMEOUT_MS = Number(process.env.HERMES_API_TIMEOUT_MS || 5000);
const HERMES_SESSION_TOKEN_HEADER = 'X-Hermes-Session-Token';

function openclawHome() {
  return process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
}

function cleanUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function hermesDashboardUrl() {
  return cleanUrl(process.env.HERMES_DASHBOARD_URL || process.env.HERMES_PUBLIC_URL || '');
}

function fetchWithTimeout(url, options = {}, timeoutMs = HERMES_API_TIMEOUT_MS) {
  if (typeof fetch !== 'function') {
    return Promise.reject(new Error('fetch is not available in this runtime'));
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, { ...options, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function extractHermesSessionToken(html) {
  const match = String(html || '').match(/window\.__HERMES_SESSION_TOKEN__\s*=\s*("([^"\\]|\\.)*")/);
  if (!match) return '';
  try {
    return JSON.parse(match[1]);
  } catch (_) {
    return '';
  }
}

async function getHermesDashboardToken(baseUrl) {
  const response = await fetchWithTimeout(`${baseUrl}/`, {
    headers: { Accept: 'text/html' },
  });
  if (!response.ok) throw new Error(`Hermes dashboard returned HTTP ${response.status}`);
  const token = extractHermesSessionToken(await response.text());
  if (!token) throw new Error('Hermes dashboard session token not found');
  return token;
}

async function fetchHermesDashboardJson(baseUrl, apiPath) {
  const token = await getHermesDashboardToken(baseUrl);
  const response = await fetchWithTimeout(`${baseUrl}${apiPath}`, {
    headers: {
      Accept: 'application/json',
      [HERMES_SESSION_TOKEN_HEADER]: token,
    },
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(json?.detail || json?.error || json?.message || `Hermes returned HTTP ${response.status}`);
  }
  return json;
}

async function resolveHermesProfileName(baseUrl) {
  const configured = String(process.env.HERMES_PROFILE || process.env.HERMES_PROFILE_NAME || '').trim();
  if (configured) return configured;

  const data = await fetchHermesDashboardJson(baseUrl, '/api/profiles');
  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const selected = profiles.find(p => p && p.is_default) || profiles[0];
  return selected?.name || 'default';
}

async function readHermesSoulFromDashboard() {
  const baseUrl = hermesDashboardUrl();
  if (!baseUrl) throw new Error('Hermes dashboard URL is not configured');

  const profile = await resolveHermesProfileName(baseUrl);
  const encodedProfile = encodeURIComponent(profile);
  const data = await fetchHermesDashboardJson(baseUrl, `/api/profiles/${encodedProfile}/soul`);
  if (data?.exists === false) {
    throw new Error(`Hermes profile SOUL not found: ${profile}`);
  }
  const content = typeof data?.content === 'string' ? data.content : '';
  return {
    soul: content.length > MAX_SOUL_BYTES ? content.slice(0, MAX_SOUL_BYTES) : content,
    ref: `${baseUrl}/api/profiles/${encodedProfile}/soul`,
    profile,
  };
}

async function readFileCapped(p, maxBytes) {
  const content = await fs.readFile(p, 'utf8');
  if (content.length > maxBytes) return content.slice(0, maxBytes);
  return content;
}

async function readHermesSoul() {
  return readHermesSoulFromDashboard();
}

function normalizeOpenclawAgent(agent) {
  if (!agent || typeof agent !== 'object') return null;
  const id = String(agent.id || agent.name || '').trim();
  if (!id) return null;
  return {
    id,
    name: String(agent.name || id),
    workspace: typeof agent.workspace === 'string' ? agent.workspace : '',
    model: typeof agent.model === 'string' ? agent.model : (agent.model?.primary || ''),
    status: typeof agent.status === 'string' ? agent.status : '',
    identitySnippet: agent.identity?.name || '',
    isDefault: Boolean(agent.isDefault || agent.default),
  };
}

async function listRuntimeOpenclawAgents() {
  const inventory = await buildOpenClawAgentInventory({
    includeContent: false,
    includeRuntimeStatus: false,
    includePromptFiles: false,
  });
  return (inventory.agents || []).map(normalizeOpenclawAgent).filter(Boolean);
}

async function getHermesPersonalitySourceStatus() {
  const baseUrl = hermesDashboardUrl();
  if (!baseUrl) {
    return { available: false, source: 'none', ref: null };
  }

  try {
    const res = await readHermesSoulFromDashboard();
    return {
      available: Boolean(res.soul),
      source: 'dashboard',
      dashboardUrl: baseUrl,
      profile: res.profile || null,
      ref: res.ref,
    };
  } catch (err) {
    return {
      available: false,
      source: 'dashboard',
      dashboardUrl: baseUrl,
      error: err.message,
    };
  }
}

function resolveOpenclawWorkspace(agentId) {
  const normalizedAgentId = String(agentId || '').trim();
  if (
    !normalizedAgentId
    || normalizedAgentId.length > 120
    || normalizedAgentId === '.'
    || normalizedAgentId === '..'
    || normalizedAgentId.includes('\0')
    || /[\\/]/.test(normalizedAgentId)
  ) {
    throw new Error('openclaw agentId must be a single safe path segment');
  }
  const root = path.resolve(openclawHome());
  const workspace = path.resolve(root, `workspace-${normalizedAgentId}`);
  if (path.dirname(workspace) !== root) {
    throw new Error('openclaw workspace resolved outside OPENCLAW_HOME');
  }
  return workspace;
}

async function readLocalOpenclawSoul(agentId) {
  const root = await fs.realpath(path.resolve(openclawHome()));
  const requestedWorkspace = resolveOpenclawWorkspace(agentId);
  let ws;
  try {
    ws = await fs.realpath(requestedWorkspace);
  } catch (_) {
    throw new Error(`openclaw workspace not found: ${requestedWorkspace}`);
  }
  if (path.dirname(ws) !== root) {
    throw new Error('openclaw workspace resolves outside OPENCLAW_HOME');
  }
  let stat;
  try {
    stat = await fs.stat(ws);
  } catch (_) {
    throw new Error(`openclaw workspace not found: ${ws}`);
  }
  if (!stat.isDirectory()) throw new Error(`openclaw workspace not a directory: ${ws}`);

  const parts = [];
  const refs = [];
  for (const fname of ['SOUL.md', 'IDENTITY.md', 'USER.md']) {
    const requestedFile = path.join(ws, fname);
    try {
      const fp = await fs.realpath(requestedFile);
      const relative = path.relative(ws, fp);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
        if (!relative) throw new Error(`openclaw personality path is not a file: ${requestedFile}`);
        throw new Error(`openclaw personality file resolves outside its workspace: ${requestedFile}`);
      }
      const content = await readFileCapped(fp, MAX_SOUL_BYTES);
      if (content.trim()) {
        parts.push(content);
        refs.push(fp);
      }
    } catch (error) {
      if (String(error.message || '').includes('resolves outside')) throw error;
      // A missing optional personality file is fine.
    }
  }
  if (parts.length === 0) {
    throw new Error(`no SOUL/IDENTITY/USER readable in ${ws}`);
  }
  return { soul: parts.join('\n\n---\n\n'), ref: refs.join(','), agentId };
}

async function readOpenclawSoulFromInventory(agentId) {
  const inventory = await buildOpenClawAgentInventory({
    includeContent: true,
    includeRuntimeStatus: false,
    includePromptFiles: true,
  });
  const agent = (inventory.agents || []).find((item) => item.id === agentId);
  if (!agent) throw new Error(`openclaw agent not found in official inventory: ${agentId}`);
  const content = ['SOUL.md', 'IDENTITY.md', 'USER.md']
    .map((name) => agent.promptFiles?.[name]?.content)
    .filter((value) => typeof value === 'string' && value.trim());
  if (content.length) {
    return {
      soul: content.join('\n\n---\n\n').slice(0, MAX_SOUL_BYTES),
      ref: `openclaw-inventory:${agentId}`,
      agentId,
      agentName: agent.name || agent.id,
      sourceDetail: 'official-openclaw-prompt-inventory',
    };
  }
  const meta = [
    `OpenClaw agent: ${agent.name || agent.id}`,
    `Agent id: ${agent.id}`,
    agent.model?.primary ? `Model: ${agent.model.primary}` : '',
    agent.workspace ? `Workspace: ${agent.workspace}` : '',
  ].filter(Boolean);
  return {
    soul: `${meta.join('\n')}\n\nOfficial OpenClaw inventory did not expose personality markdown for this agent.`.slice(0, MAX_SOUL_BYTES),
    ref: `openclaw-inventory:${agentId}`,
    agentId,
    agentName: agent.name || agent.id,
    sourceDetail: 'official-openclaw-metadata',
  };
}

async function readOpenclawSoul(agentId) {
  if (!agentId) throw new Error('openclaw personality requires agentId');
  let localErr = null;
  try {
    return await readLocalOpenclawSoul(agentId);
  } catch (err) {
    localErr = err;
  }

  try {
    return await readOpenclawSoulFromInventory(agentId);
  } catch (inventoryErr) {
    throw new Error(`${localErr.message}; OpenClaw inventory fallback failed: ${inventoryErr.message}`);
  }
}

// Returns { soul, ref } or null when source is local with no fallback.
async function getPersonality(opts) {
  const { source, agentId, soulFallback } = opts || {};
  const src = source || 'standalone';
  if (src === 'standalone' || src === 'agentx') {
    const fallback = (typeof soulFallback === 'string' && soulFallback.trim()) ? soulFallback : null;
    if (!fallback) return null;
    return { soul: fallback, ref: src === 'agentx' ? 'agentx:buddy.soul' : null };
  }
  if (src === 'hermes') return readHermesSoul();
  if (src === 'openclaw') return readOpenclawSoul(agentId);
  throw new Error(`unknown personality source: ${src}`);
}

async function listOpenclawAgents() {
  const root = openclawHome();
  const byId = new Map();
  let entries;
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (_) {
    entries = [];
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith('workspace-')) continue;
    const id = e.name.slice('workspace-'.length);
    if (!id) continue;
    byId.set(id, { id, name: id, workspace: path.join(root, e.name), source: 'local' });
  }

  try {
    const runtimeAgents = await listRuntimeOpenclawAgents();
    for (const a of runtimeAgents) {
      const existing = byId.get(a.id) || {};
      byId.set(a.id, { ...existing, ...a, source: existing.source ? 'local+openclaw' : 'openclaw' });
    }
  } catch (_) { /* Remote OpenClaw inventory is optional for this UI. */ }

  const out = Array.from(byId.values());
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

async function bootstrapSoul() {
  let head = '';
  try {
    const res = await readHermesSoulFromDashboard();
    head = String(res.soul || '').slice(0, BOOTSTRAP_HERMES_BYTES);
  } catch (_) { /* hermes optional */ }

  const platformLine = 'You are the buddy companion of the AgentX platform — you watch conversations, benchmarks, and cluster events without running them.';
  const composed = (head ? head.trim() + '\n\n' : '') + platformLine;
  return composed.slice(0, BOOTSTRAP_TOTAL_CAP);
}

module.exports = {
  getPersonality,
  getHermesPersonalitySourceStatus,
  listOpenclawAgents,
  bootstrapSoul,
  openclawHome,
  resolveOpenclawWorkspace,
};
