'use strict';

/**
 * Explain a MODEL_UNAVAILABLE chat failure instead of echoing Ollama's bare
 * "model not found".
 *
 * The router can legitimately send a request to a host that does not carry the
 * requested model (for example when the primary host is reserved by a
 * benchmark claim). Ollama then answers 404 in a few milliseconds and the
 * operator sees "model X not found" while X is installed and pinned on another
 * host. This helper names the host that was tried, lists where the model is
 * actually installed, and states why those hosts were not usable when the
 * platform knows it.
 */

const fetch = require('node-fetch');
const { getConfiguredHosts } = require('../../helpers/ollamaHostConfig');
const hostPreferenceService = require('../hostPreferenceService');
const { getFetchOptions } = require('../../helpers/httpAgent');

const TAGS_TIMEOUT_MS = 1500;

function hostOrigin(url) {
  try { return new URL(String(url)).origin; } catch { return ''; }
}

function describeHost(host) {
  return host ? `${host.name} (${host.id}, ${host.url})` : 'the routed host';
}

function reservationReason(preference) {
  if (!preference) return null;
  const status = String(preference.status || '').toLowerCase();
  if (status === 'benchmarking' || preference.benchmarkClaim?.batchId) {
    return 'reserved by a benchmark claim';
  }
  if (status === 'offline') return 'offline';
  if (status === 'swapping' || status === 'restoring') return `busy (${status})`;
  return null;
}

async function installedModelNames(host, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAGS_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${host.url}/api/tags`, {
      ...getFetchOptions(`${host.url}/api/tags`),
      signal: controller.signal
    });
    if (!response.ok) return [];
    const body = await response.json().catch(() => ({}));
    return (Array.isArray(body?.models) ? body.models : [])
      .map(entry => String(entry?.name || entry?.model || '').trim())
      .filter(Boolean);
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function explainModelUnavailability(error, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const hosts = options.hosts || getConfiguredHosts();
  const preferenceLookup = options.getPreference
    || (url => hostPreferenceService.getByHost(url).catch(() => null));
  const model = String(error?.model || '').trim();
  const triedOrigin = hostOrigin(error?.upstreamUrl);
  const triedHost = hosts.find(host => hostOrigin(host.url) === triedOrigin) || null;

  const installedOn = [];
  if (model) {
    const others = hosts.filter(host => host !== triedHost);
    const inventories = await Promise.all(others.map(host => installedModelNames(host, fetchImpl)));
    for (const [index, host] of others.entries()) {
      if (!inventories[index].includes(model)) continue;
      const preference = await preferenceLookup(host.url);
      installedOn.push({
        hostKey: host.id,
        name: host.name,
        url: host.url,
        status: preference?.status || null,
        unavailableBecause: reservationReason(preference)
      });
    }
  }

  const tried = triedHost
    ? { hostKey: triedHost.id, name: triedHost.name, url: triedHost.url }
    : (triedOrigin ? { hostKey: null, name: null, url: triedOrigin } : null);

  let message;
  if (!model) {
    message = 'The requested model is not installed on the host that served this request.';
  } else if (installedOn.length === 0) {
    message = `Model ${model} is not installed on ${describeHost(triedHost)} and was not found on any other configured Ollama host.`;
  } else {
    const where = installedOn.map(entry => {
      const reason = entry.unavailableBecause ? ` — currently ${entry.unavailableBecause}` : '';
      return `${entry.name} (${entry.hostKey})${reason}`;
    }).join('; ');
    message = `Model ${model} is not installed on ${describeHost(triedHost)}. It is installed on: ${where}.`;
    if (installedOn.every(entry => entry.unavailableBecause)) {
      message += ' Retry once that host is released, or pick a model installed on an available host.';
    }
  }

  return {
    model: model || null,
    tried,
    installedOn,
    message
  };
}

module.exports = {
  explainModelUnavailability,
  reservationReason,
  TAGS_TIMEOUT_MS
};
