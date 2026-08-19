'use strict';

const mongoose = require('mongoose');
const { normalizeModelTag } = require('../../../shared/modelNames');
const {
  buildRuntimeFingerprint,
  exactModelNamesMatch,
  normalizeHostUrl
} = require('../../../shared/artifactIdentity');
const { getBenchmarkServiceClient } = require('./benchmarkServiceClient');

const LOOKUP_TIMEOUT_MS = 5000;

function registryInstallation(registry, hostUrl) {
  const host = normalizeHostUrl(hostUrl);
  const installations = Array.isArray(registry?.installations) ? registry.installations : [];
  return installations.find((entry) => normalizeHostUrl(entry?.hostUrl || entry?.host) === host)
    || (normalizeHostUrl(registry?.sourceHost || registry?.host) === host ? {
      hostUrl: registry.sourceHost || registry.host,
      digest: registry.ollamaDigest,
      status: registry.status,
      isActive: registry.isActive
    } : null);
}

async function readLiveDigest(model, host, deps = {}) {
  if (typeof deps.resolveArtifactDigest === 'function') {
    return deps.resolveArtifactDigest(model, host);
  }
  if (process.env.NODE_ENV === 'test' && !deps.fetchImpl) return null;
  const fetchImpl = deps.fetchImpl || require('node-fetch');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
  try {
    const response = await fetchImpl(`${host}/api/tags`, { signal: controller.signal });
    if (!response.ok) return null;
    const payload = await response.json();
    const match = (Array.isArray(payload?.models) ? payload.models : []).find((entry) =>
      exactModelNamesMatch(entry?.name || entry?.model, model)
    );
    return typeof match?.digest === 'string' && match.digest.trim() ? match.digest.trim() : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function readHostProfile(hostUrl, deps = {}) {
  if (deps.hostProfile) return deps.hostProfile;
  try {
    if (deps.hostProfilesCollection) {
      return deps.hostProfilesCollection.findOne({ hostUrl: normalizeHostUrl(hostUrl) });
    }
    if (process.env.NODE_ENV === 'test' && !deps.benchmarkClient) return null;
    const client = deps.benchmarkClient || getBenchmarkServiceClient();
    return client.getHostProfile(normalizeHostUrl(hostUrl));
  } catch {
    return null;
  }
}

async function readRegistry(model, deps = {}) {
  if (deps.registryEntry) return deps.registryEntry;
  try {
    if (!deps.ModelRegistry && mongoose.connection.readyState !== 1) return null;
    const ModelRegistry = deps.ModelRegistry || require('../../models/ModelRegistry');
    return ModelRegistry.findOne({ modelName: normalizeModelTag(model) }).lean();
  } catch {
    return null;
  }
}

async function resolveArtifactIdentity(model, host, deps = {}) {
  const exactModel = normalizeModelTag(model);
  const hostUrl = normalizeHostUrl(host);
  const [digest, hostProfile, registry] = await Promise.all([
    readLiveDigest(exactModel, hostUrl, deps),
    readHostProfile(hostUrl, deps),
    readRegistry(exactModel, deps)
  ]);
  const installation = registryInstallation(registry, hostUrl);
  const registryDigest = installation?.digest || null;
  const registryQualified = Boolean(
    registry
    && exactModelNamesMatch(registry.modelName, exactModel)
    && installation
    && digest
    && registryDigest === digest
    && installation.isActive !== false
    && String(installation.status || 'active').toLowerCase() !== 'retired'
  );

  return {
    model: exactModel,
    hostId: hostProfile?.hostId || null,
    hostUrl,
    digest,
    runtimeFingerprint: buildRuntimeFingerprint(hostProfile || { hostUrl }, hostUrl),
    registryId: registry?._id ? String(registry._id) : null,
    registryDigest,
    registryQualified,
    identityQualified: Boolean(digest && registryQualified)
  };
}

function profileMatchesArtifact(profileArtifact, currentArtifact) {
  return Boolean(
    profileArtifact
    && currentArtifact?.identityQualified
    && exactModelNamesMatch(profileArtifact.model, currentArtifact.model)
    && String(profileArtifact.hostId || '') === String(currentArtifact.hostId || '')
    && normalizeHostUrl(profileArtifact.hostUrl) === normalizeHostUrl(currentArtifact.hostUrl)
    && profileArtifact.digest === currentArtifact.digest
    && profileArtifact.runtimeFingerprint === currentArtifact.runtimeFingerprint
    && profileArtifact.registryQualified === true
  );
}

module.exports = {
  profileMatchesArtifact,
  readLiveDigest,
  registryInstallation,
  resolveArtifactIdentity
};
