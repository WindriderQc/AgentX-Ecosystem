'use strict';

const fetch = require('node-fetch');
const { normalizeHostUrl } = require('../helpers/ollamaHostConfig');

const DEFAULT_TIMEOUT_MS = 2000;

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function probeOllamaHealth(options = {}) {
  const host = normalizeHostUrl(options.host ?? process.env.OLLAMA_HOST);
  const checkedAt = new Date().toISOString();
  if (!host) {
    return {
      healthy: false,
      host: null,
      checkedAt,
      message: 'OLLAMA_HOST is not configured',
    };
  }

  const fetchImpl = options.fetchImpl || fetch;
  const timeoutMs = positiveNumber(
    options.timeoutMs ?? process.env.BASIC_HEALTH_OLLAMA_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS
  );

  try {
    const response = await fetchImpl(`${host}/api/tags`, {
      method: 'GET',
      timeout: timeoutMs,
    });
    if (response.ok) {
      return { healthy: true, host, checkedAt, message: 'Connected' };
    }
    return {
      healthy: false,
      host,
      checkedAt,
      message: `HTTP ${response.status}`,
    };
  } catch (error) {
    return {
      healthy: false,
      host,
      checkedAt,
      message: error.message,
    };
  }
}

async function refreshOllamaHealth(systemHealth, options = {}) {
  const result = await probeOllamaHealth(options);
  const next = {
    status: result.healthy ? 'connected' : 'error',
    lastCheck: result.checkedAt,
    error: result.healthy ? null : result.message,
  };
  systemHealth.ollama = next;
  return next;
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  probeOllamaHealth,
  refreshOllamaHealth,
};
