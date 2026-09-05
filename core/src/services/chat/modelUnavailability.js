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
const { createOperationsHealthClient } = require('../operationsHealthClient');

const TAGS_TIMEOUT_MS = 1500;

function hostOrigin(url) {
  try { return new URL(String(url)).origin; } catch { return ''; }
}

function describeHost(host) {
  return host ? `${host.name} (${host.id})` : 'the routed host';
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

async function installedModelInventory(host, fetchImpl, transportAdapter) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TAGS_TIMEOUT_MS);
  try {
    const client = createOperationsHealthClient({
      fetchImpl,
      ollamaUrl: host.url,
      transportAdapter
    });
    const result = await client.getOllamaTags({ signal: controller.signal });
    if (!result.ok) return { verified: false, names: [], reason: 'inventory probe failed' };
    const body = result.data || {};
    return {
      verified: true,
      names: (Array.isArray(body?.models) ? body.models : [])
        .map(entry => String(entry?.name || entry?.model || '').trim())
        .filter(Boolean),
      reason: null
    };
  } catch (error) {
    return {
      verified: false,
      names: [],
      reason: error?.name === 'AbortError' ? 'inventory probe timed out' : 'inventory probe unavailable'
    };
  } finally {
    clearTimeout(timer);
  }
}

function publicHost(host, fields = {}) {
  return {
    hostKey: host?.id || null,
    name: host?.name || null,
    ...fields
  };
}

async function explainModelUnavailability(error, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const hosts = options.hosts || getConfiguredHosts();
  const preferenceLookup = options.getPreference
    || (url => hostPreferenceService.getByHost(url).catch(() => null));
  const transportAdapter = options.transportAdapter;
  const model = String(error?.model || '').trim();
  const triedOrigin = hostOrigin(error?.upstreamUrl);
  const triedHost = hosts.find(host => hostOrigin(host.url) === triedOrigin) || null;

  const installedOn = [];
  const unknownHosts = [];
  if (model) {
    const others = hosts.filter(host => host !== triedHost);
    const inventories = await Promise.all(others.map(
      host => installedModelInventory(host, fetchImpl, transportAdapter)
    ));
    for (const [index, host] of others.entries()) {
      const inventory = inventories[index];
      if (!inventory.verified) {
        unknownHosts.push(publicHost(host, { status: 'unknown', reason: inventory.reason }));
        continue;
      }
      if (!inventory.names.includes(model)) continue;
      const preference = await preferenceLookup(host.url);
      installedOn.push(publicHost(host, {
        status: typeof preference?.status === 'string' ? preference.status.slice(0, 40) : null,
        unavailableBecause: reservationReason(preference)
      }));
    }
  }

  const tried = triedHost
    ? publicHost(triedHost)
    : (triedOrigin ? publicHost(null) : null);

  let message;
  if (!model) {
    message = 'The requested model is not installed on the host that served this request.';
  } else if (installedOn.length === 0 && unknownHosts.length === 0) {
    message = `Model ${model} is not installed on ${describeHost(triedHost)} and was not found on any other configured Ollama host.`;
  } else if (installedOn.length === 0) {
    const unknownNames = unknownHosts.map(entry => `${entry.name || 'configured host'} (${entry.hostKey || 'unknown'})`).join('; ');
    message = `Model ${model} is not installed on ${describeHost(triedHost)}. Availability could not be verified on: ${unknownNames}.`;
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
    unknownHosts,
    message
  };
}

module.exports = {
  explainModelUnavailability,
  reservationReason,
  installedModelInventory,
  TAGS_TIMEOUT_MS
};
