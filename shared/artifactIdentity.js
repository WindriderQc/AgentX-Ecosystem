'use strict';

const crypto = require('crypto');
const { normalizeModelTag } = require('./modelNames');

function normalizeHostUrl(value) {
  return String(value || '').trim().replace(/\/+$/, '').toLowerCase();
}

function stableSerialize(value) {
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableSerialize(value[key])}`).join(',')}}`;
  }
  return value === undefined ? 'null' : JSON.stringify(value);
}

function runtimeIdentity(hostProfile = {}, fallbackHostUrl = null) {
  return {
    hostId: hostProfile.hostId || null,
    hostUrl: normalizeHostUrl(hostProfile.hostUrl || fallbackHostUrl),
    gpu: {
      model: hostProfile.gpu?.model || null,
      vramTotalMiB: Number(hostProfile.gpu?.vramTotalMiB) || null,
      computeCapability: hostProfile.gpu?.computeCapability || null,
      driver: hostProfile.gpu?.driver || null
    },
    ollama: {
      version: hostProfile.ollama?.version || null,
      backend: hostProfile.ollama?.backend || null,
      cudaVersion: hostProfile.ollama?.cudaVersion || null
    },
    cpu: {
      cores: Number(hostProfile.cpu?.cores) || null,
      threadOverride: Number(hostProfile.cpu?.threadOverride) || null
    }
  };
}

function buildRuntimeFingerprint(hostProfile = {}, fallbackHostUrl = null) {
  return crypto.createHash('sha256')
    .update(stableSerialize(runtimeIdentity(hostProfile, fallbackHostUrl)))
    .digest('hex');
}

function exactModelNamesMatch(left, right) {
  const a = normalizeModelTag(left).toLowerCase();
  const b = normalizeModelTag(right).toLowerCase();
  return Boolean(a && b && a === b);
}

module.exports = {
  buildRuntimeFingerprint,
  exactModelNamesMatch,
  normalizeHostUrl,
  runtimeIdentity,
  stableSerialize
};
