const portalStatusService = require('./portalStatusService');
const voixClient = require('./voixClientService');
const { getStatus: getKidxLexiconStatus } = require('./kidxLexiconService');
const {
  getPack,
  packSummary,
  resolveMode
} = require('./voicePersonaPacks');

const DEFAULT_PANEL_DEVICE_ID = 'surface-pro-3-main-house';
const HOME_ASSISTANT_TIMEOUT_MS = Number(process.env.HOME_ASSISTANT_TIMEOUT_MS) || 2000;

const heartbeats = new Map();

function nowIso() {
  return new Date().toISOString();
}

function cleanText(value, fallback = '') {
  const text = String(value == null ? '' : value).trim();
  return text || fallback;
}

function parseAllowlist(raw = process.env.HOME_ASSISTANT_ENTITY_ALLOWLIST) {
  return String(raw || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .filter((item, index, all) => all.indexOf(item) === index);
}

function homeAssistantConfig() {
  const baseUrl = String(process.env.HOME_ASSISTANT_BASE_URL || '').replace(/\/+$/, '');
  const token = String(process.env.HOME_ASSISTANT_TOKEN || '').trim();
  const allowlist = parseAllowlist();
  const enabled = Boolean(baseUrl && token && allowlist.length);

  return {
    enabled,
    baseUrl,
    token,
    allowlist,
    timeoutMs: HOME_ASSISTANT_TIMEOUT_MS,
    reason: enabled
      ? ''
      : 'Set HOME_ASSISTANT_BASE_URL, HOME_ASSISTANT_TOKEN, and HOME_ASSISTANT_ENTITY_ALLOWLIST to enable read-only home cards.'
  };
}

async function fetchJsonWithTimeout(url, options = {}, timeoutMs = 2000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch (_err) {
      body = { raw: text };
    }
    if (!response.ok) {
      const message = body?.message || body?.error || `HTTP ${response.status}`;
      throw new Error(message);
    }
    return body;
  } finally {
    clearTimeout(timer);
  }
}

function sanitizeHomeEntity(entity) {
  const attrs = entity?.attributes || {};
  return {
    entity_id: entity?.entity_id || '',
    state: entity?.state || 'unknown',
    name: attrs.friendly_name || entity?.entity_id || 'Home entity',
    unit: attrs.unit_of_measurement || '',
    deviceClass: attrs.device_class || '',
    icon: attrs.icon || '',
    lastChanged: entity?.last_changed || '',
    lastUpdated: entity?.last_updated || ''
  };
}

async function getHomeAssistantSnapshot({ limit } = {}) {
  const config = homeAssistantConfig();
  if (!config.enabled) {
    return {
      enabled: false,
      status: 'disabled',
      reason: config.reason,
      entities: []
    };
  }

  const wanted = Number.isFinite(Number(limit))
    ? config.allowlist.slice(0, Math.max(1, Number(limit)))
    : config.allowlist;

  try {
    const results = await Promise.all(wanted.map(async (entityId) => {
      const url = `${config.baseUrl}/api/states/${encodeURIComponent(entityId)}`;
      try {
        const entity = await fetchJsonWithTimeout(url, {
          headers: {
            Authorization: `Bearer ${config.token}`,
            Accept: 'application/json'
          }
        }, config.timeoutMs);
        return sanitizeHomeEntity(entity);
      } catch (err) {
        return {
          entity_id: entityId,
          state: 'unavailable',
          name: entityId,
          unit: '',
          deviceClass: '',
          icon: '',
          lastChanged: '',
          lastUpdated: '',
          error: err.message
        };
      }
    }));

    const down = results.filter((entity) => entity.error || entity.state === 'unavailable').length;
    return {
      enabled: true,
      status: down === results.length ? 'down' : (down ? 'degraded' : 'ok'),
      allowlisted: config.allowlist.length,
      entities: results
    };
  } catch (err) {
    return {
      enabled: true,
      status: 'down',
      error: err.message,
      allowlisted: config.allowlist.length,
      entities: []
    };
  }
}

function recordHeartbeat(input = {}, req = null) {
  const deviceId = cleanText(input.deviceId, DEFAULT_PANEL_DEVICE_ID).slice(0, 80);
  const heartbeat = {
    deviceId,
    label: cleanText(input.label, 'Surface Pro 3 Main House').slice(0, 120),
    userAgent: cleanText(input.userAgent || req?.get?.('user-agent'), '').slice(0, 300),
    ip: cleanText(req?.ip, ''),
    receivedAt: nowIso()
  };
  heartbeats.set(deviceId, heartbeat);
  return heartbeat;
}

function getHeartbeats() {
  return Array.from(heartbeats.values())
    .sort((left, right) => String(right.receivedAt).localeCompare(String(left.receivedAt)));
}

async function getVoixStatus() {
  try {
    const health = await voixClient.health({ query: {} });
    return {
      status: 'ok',
      health
    };
  } catch (err) {
    return {
      status: 'down',
      error: err.message
    };
  }
}

function getFamilyVoicePersonaStatus() {
  try {
    const pack = getPack('kidx_nestor');
    const mode = resolveMode(pack, 'family');
    return {
      status: 'available',
      kind: 'agentx_voice_persona',
      displayName: 'AgentX Family Voice',
      pack: packSummary(pack),
      mode: {
        id: mode.id,
        label: mode.label,
        description: mode.description || ''
      },
      connection: {
        state: 'not_applicable',
        note: 'Voice-pack availability does not report desktop Nestor connectivity.'
      }
    };
  } catch (err) {
    return {
      status: 'unavailable',
      kind: 'agentx_voice_persona',
      displayName: 'AgentX Family Voice',
      error: err.message
    };
  }
}

function getReaderStatus() {
  try {
    const pack = getPack('kidx_reader');
    const mode = resolveMode(pack, 'reader');
    return {
      status: 'ok',
      pack: packSummary(pack),
      lexicon: getKidxLexiconStatus(),
      mode: {
        id: mode.id,
        label: mode.label,
        description: mode.description || ''
      }
    };
  } catch (err) {
    return {
      status: 'down',
      error: err.message
    };
  }
}

async function getPanelStatus(localHealth) {
  const [portal, voix, home] = await Promise.all([
    portalStatusService.getPortalStatus(localHealth),
    getVoixStatus(),
    getHomeAssistantSnapshot({ limit: 8 })
  ]);

  return {
    generatedAt: nowIso(),
    deviceTarget: {
      id: DEFAULT_PANEL_DEVICE_ID,
      label: 'Surface Pro 3 Main House',
      kioskUrl: process.env.PANEL_KIOSK_URL || ''
    },
    portal,
    voix,
    familyVoicePersona: getFamilyVoicePersonaStatus(),
    reader: getReaderStatus(),
    home,
    heartbeats: getHeartbeats()
  };
}

function _resetForTests() {
  heartbeats.clear();
}

module.exports = {
  getPanelStatus,
  getHomeAssistantSnapshot,
  recordHeartbeat,
  getHeartbeats,
  getReaderStatus,
  parseAllowlist,
  homeAssistantConfig,
  _resetForTests
};
