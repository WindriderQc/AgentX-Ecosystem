'use strict';

const { getModelRegistryByName } = require('../../clients/coreApiClient');
const { getModelDigest } = require('../benchmark/modelDigestService');
const hostProfileService = require('./hostProfileService');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const {
  buildRuntimeFingerprint,
  exactModelNamesMatch,
  normalizeHostUrl
} = require('../../../../shared/artifactIdentity');

function registryInstallation(registry, hostUrl) {
  const normalizedHost = normalizeHostUrl(hostUrl);
  if (normalizeHostUrl(registry?.installation?.hostUrl || registry?.installation?.host) === normalizedHost) {
    return registry.installation;
  }
  const installations = Array.isArray(registry?.installations) ? registry.installations : [];
  return installations.find((entry) => normalizeHostUrl(entry?.hostUrl || entry?.host) === normalizedHost)
    || (normalizeHostUrl(registry?.sourceHost || registry?.host) === normalizedHost ? {
      hostUrl: registry.sourceHost || registry.host,
      digest: registry.ollamaDigest,
      status: registry.status,
      isActive: registry.isActive
    } : null);
}

async function resolveArtifactIdentity(modelName, hostId, hostUrl, options = {}) {
  const model = normalizeModelTag(modelName);
  const normalizedHost = normalizeHostUrl(hostUrl);
  if (!model || !hostId || !normalizedHost) {
    throw new Error('Exact model name, hostId, and hostUrl are required for profiling');
  }

  const [digest, hostProfile, registry] = await Promise.all([
    getModelDigest(normalizedHost, model, { refresh: options.refresh !== false }),
    hostProfileService.getById(hostId),
    getModelRegistryByName(model, { host: normalizedHost }).catch(() => null)
  ]);
  if (!digest) throw new Error(`Cannot resolve exact Ollama digest for ${model} on ${normalizedHost}`);

  const installation = registryInstallation(registry, normalizedHost);
  const registryDigest = installation?.digest || registry?.ollamaDigest || null;
  const registryQualified = Boolean(
    registry
    && exactModelNamesMatch(registry.modelName, model)
    && installation
    && registryDigest === digest
    && installation.isActive !== false
    && String(installation.status || 'active').toLowerCase() !== 'retired'
  );
  if (options.requireRegistry !== false && !registryQualified) {
    throw new Error(
      `Core registry is missing or stale for exact artifact ${model}@${normalizedHost} (${digest}); sync the model registry before profiling`
    );
  }

  return {
    model,
    hostId,
    hostUrl: normalizedHost,
    digest,
    runtimeFingerprint: buildRuntimeFingerprint(hostProfile || { hostId, hostUrl: normalizedHost }, normalizedHost),
    registryId: registry?._id ? String(registry._id) : null,
    registryDigest,
    registryQualified
  };
}

function identitiesMatch(left, right) {
  return Boolean(
    left
    && right
    && exactModelNamesMatch(left.model, right.model)
    && String(left.hostId || '') === String(right.hostId || '')
    && normalizeHostUrl(left.hostUrl) === normalizeHostUrl(right.hostUrl)
    && left.digest === right.digest
    && left.runtimeFingerprint === right.runtimeFingerprint
    && right.registryQualified === true
  );
}

module.exports = { identitiesMatch, registryInstallation, resolveArtifactIdentity };
