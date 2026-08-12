'use strict';

const { getConfiguredHosts, hostUrlKey } = require('../helpers/ollamaHostConfig');

function findConfiguredHostByUrl(hostUrl, configuredHosts = getConfiguredHosts()) {
  const key = hostUrlKey(hostUrl);
  if (!key) return null;

  return (configuredHosts || []).find((host) => hostUrlKey(host.url) === key) || null;
}

function normalizeHostPreferenceIdentity(pref, configuredHosts = getConfiguredHosts()) {
  const row = { ...(pref || {}) };
  const persistedHostKey = row.hostKey || null;
  const configuredHost = findConfiguredHostByUrl(row.hostUrl, configuredHosts);

  row.persistedHostKey = persistedHostKey;
  row.configuredHostKey = configuredHost?.id || null;
  row.configuredHostName = configuredHost?.name || null;
  row.configuredHostUrl = configuredHost?.url || null;
  row.hostIdentitySource = configuredHost ? 'configured_host_url' : 'persisted_host_key';
  row.hostKeyDrift = null;

  if (configuredHost) {
    row.hostKey = configuredHost.id;
    if (!row.displayName && configuredHost.name) row.displayName = configuredHost.name;

    if (persistedHostKey && persistedHostKey !== configuredHost.id) {
      row.hostKeyDrift = {
        type: 'host_key_mismatch',
        persisted: persistedHostKey,
        configured: configuredHost.id,
        message: `Persisted hostKey ${persistedHostKey} differs from configured hostKey ${configuredHost.id}`
      };
    }
  } else if (row.hostUrl) {
    row.hostKeyDrift = {
      type: 'unconfigured_host',
      persisted: persistedHostKey,
      configured: null,
      message: 'Host preference URL is not in the configured Ollama host allowlist'
    };
  }

  return row;
}

function normalizeHostPreferenceUpdates(hostUrl, updates = {}, configuredHosts = getConfiguredHosts()) {
  const normalized = { ...(updates || {}) };
  const configuredHost = findConfiguredHostByUrl(hostUrl, configuredHosts);
  if (configuredHost) {
    normalized.hostKey = configuredHost.id;
  }
  return normalized;
}

function summarizeHost(pref) {
  return {
    name: pref.displayName || pref.configuredHostName || pref.hostKey || pref.hostUrl,
    hostUrl: pref.hostUrl,
    persistedHostKey: pref.persistedHostKey || pref.hostKey || null,
    configuredHostKey: pref.configuredHostKey || null
  };
}

function duplicateGroups(rows, keySelector) {
  const byKey = new Map();
  for (const row of rows) {
    const key = keySelector(row);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(row);
  }

  return [...byKey.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([hostKey, group]) => ({
      hostKey,
      count: group.length,
      hosts: group.map(summarizeHost)
    }));
}

function detectHostPreferenceIdentityDrift(prefs = [], configuredHosts = getConfiguredHosts()) {
  const normalized = (prefs || []).map((pref) => normalizeHostPreferenceIdentity(pref, configuredHosts));
  const mismatches = normalized
    .filter((pref) => pref.hostKeyDrift?.type === 'host_key_mismatch')
    .map((pref) => ({
      ...pref.hostKeyDrift,
      host: summarizeHost(pref)
    }));
  const unconfigured = normalized
    .filter((pref) => pref.hostKeyDrift?.type === 'unconfigured_host')
    .map((pref) => ({
      ...pref.hostKeyDrift,
      host: summarizeHost(pref)
    }));

  const duplicatePersistedHostKeys = duplicateGroups(normalized, (pref) => pref.persistedHostKey);
  const duplicateActiveHostKeys = duplicateGroups(normalized, (pref) => pref.hostKey);

  return {
    mismatches,
    unconfigured,
    duplicatePersistedHostKeys,
    duplicateActiveHostKeys,
    hasDrift: mismatches.length > 0
      || unconfigured.length > 0
      || duplicatePersistedHostKeys.length > 0
      || duplicateActiveHostKeys.length > 0
  };
}

module.exports = {
  findConfiguredHostByUrl,
  normalizeHostPreferenceIdentity,
  normalizeHostPreferenceUpdates,
  detectHostPreferenceIdentityDrift
};
