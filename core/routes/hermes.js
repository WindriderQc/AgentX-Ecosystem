const express = require('express');
const logger = require('../config/logger');

const router = express.Router();

const DEFAULT_TIMEOUT_MS = Number(process.env.HERMES_API_TIMEOUT_MS || 5000);

function cleanUrl(value) {
  return String(value || '').replace(/\/+$/, '');
}

function getHermesDashboardUrl() {
  return cleanUrl(process.env.HERMES_DASHBOARD_URL || process.env.HERMES_PUBLIC_URL);
}

async function fetchHermesJson(path, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const baseUrl = getHermesDashboardUrl();
  if (!baseUrl) {
    const err = new Error('Hermes dashboard URL is not configured');
    err.status = 503;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(json?.error || json?.message || `Hermes returned HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHermesText(path, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const baseUrl = getHermesDashboardUrl();
  if (!baseUrl) {
    const err = new Error('Hermes dashboard URL is not configured');
    err.status = 503;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: { Accept: 'text/html' },
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      const err = new Error(`Hermes returned HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
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

async function fetchHermesProtectedJson(path, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const baseUrl = getHermesDashboardUrl();
  const token = extractHermesSessionToken(await fetchHermesText('/', timeoutMs));
  if (!token) {
    const err = new Error('Hermes dashboard session token not found');
    err.status = 401;
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      headers: {
        Accept: 'application/json',
        'X-Hermes-Session-Token': token,
      },
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) {
      const err = new Error(json?.error || json?.message || `Hermes returned HTTP ${response.status}`);
      err.status = response.status;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchHermesConfigAccess() {
  try {
    await fetchHermesProtectedJson('/api/config/raw').catch((err) => {
      if (err.status === 401 || err.status === 403) throw err;
      return fetchHermesProtectedJson('/api/config');
    });
    return { available: true, status: 'checked' };
  } catch (err) {
    return {
      available: false,
      status: err.status === 401 || err.status === 403 ? 'protected' : 'unavailable',
      error: err.status ? `HTTP ${err.status}` : err.message,
    };
  }
}

router.get('/status', async (_req, res) => {
  const dashboardUrl = getHermesDashboardUrl();
  const start = Date.now();

  try {
    const [status, configAccess] = await Promise.all([
      fetchHermesJson('/api/status'),
      fetchHermesConfigAccess(),
    ]);
    res.json({
      ok: true,
      dashboard: {
        url: dashboardUrl,
        latencyMs: Date.now() - start,
      },
      hermes: {
        version: status.version || null,
        releaseDate: status.release_date || null,
        home: status.hermes_home || null,
        activeSessions: Number(status.active_sessions || 0),
      },
      gateway: {
        running: Boolean(status.gateway_running),
        pid: status.gateway_pid || null,
        state: status.gateway_state || null,
        exitReason: status.gateway_exit_reason || null,
        updatedAt: status.gateway_updated_at || null,
        platforms: status.gateway_platforms || {},
      },
      authority: {
        policy: 'cloud_first_via_agentx_proxy',
        expectedSource: '/api/nerve-center/agent-runtime-config/export',
        liveConfig: configAccess,
        liveApply: 'human-gated',
      },
    });
  } catch (err) {
    logger.warn('[hermes] status fetch failed', { error: err.message });
    res.status(err.status || 502).json({
      ok: false,
      dashboard: { url: dashboardUrl || null },
      error: err.message,
    });
  }
});

module.exports = router;
