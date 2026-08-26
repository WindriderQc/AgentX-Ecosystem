'use strict';

const { getConfiguredHosts, hostUrlKey } = require('../helpers/ollamaHostConfig');

function hostnameOf(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return String(value || 'unknown');
  }
}

function describeHost(hostUrl, hostKey, configuredHosts = getConfiguredHosts()) {
  const normalizedKey = hostUrlKey(hostUrl);
  const configured = (configuredHosts || []).find(host => (
    (hostKey && host.id === hostKey)
    || (normalizedKey && hostUrlKey(host.url) === normalizedKey)
  ));
  const role = configured?.id || hostKey || null;
  const ip = hostnameOf(configured?.url || hostUrl);
  const displayName = configured?.name || ip || role || 'unknown';
  return {
    key: role || normalizedKey || displayName,
    displayName,
    role,
    ip,
    url: configured?.url || hostUrl || null,
  };
}

function configuredHostIdentities() {
  return getConfiguredHosts().map(host => describeHost(host.url, host.id));
}

module.exports = { describeHost, configuredHostIdentities, hostnameOf };
