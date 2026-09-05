'use strict';

const { getModelRegistryByName } = require('../../clients/coreApiClient');
const { getModelDigest } = require('../benchmark/modelDigestService');
const { getVersion, listModels, listRunning } = require('../../clients/ollamaClient');
const hostProfileService = require('./hostProfileService');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const {
  buildRuntimeArtifactReceipt,
  buildRuntimeFingerprint,
  canonicalSha256Digest,
  exactModelNamesMatch,
  normalizeHostUrl,
  verifyRuntimeArtifactReceipt
} = require('../../../../shared/artifactIdentity');

function digestsMatch(left, right) {
  const leftRaw = String(left || '').trim().toLowerCase();
  const rightRaw = String(right || '').trim().toLowerCase();
  if (!leftRaw || !rightRaw) return false;
  if (leftRaw === rightRaw) return true;
  try {
    return canonicalSha256Digest(leftRaw) === canonicalSha256Digest(rightRaw);
  } catch {
    return false;
  }
}

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
    getModelDigest(normalizedHost, model, { refresh: options.refresh !== false, signal: options.signal }),
    hostProfileService.getById(hostId),
    getModelRegistryByName(model, { host: normalizedHost, signal: options.signal }).catch(() => null)
  ]);
  if (!digest) throw new Error(`Cannot resolve exact Ollama digest for ${model} on ${normalizedHost}`);

  const installation = registryInstallation(registry, normalizedHost);
  const registryDigest = installation?.digest || registry?.ollamaDigest || null;
  const registryQualified = Boolean(
    registry
    && exactModelNamesMatch(registry.modelName, model)
    && installation
    && digestsMatch(registryDigest, digest)
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

function findExactModel(entries, model) {
  return (Array.isArray(entries) ? entries : []).find(entry =>
    exactModelNamesMatch(entry?.name || entry?.model, model)
  ) || null;
}

async function resolveRuntimeArtifactReceipt(modelName, hostId, hostUrl, options = {}) {
  const model = normalizeModelTag(modelName);
  const normalizedHost = normalizeHostUrl(hostUrl);
  if (!model || !hostId || !normalizedHost) {
    throw new Error('Exact model name, hostId, and hostUrl are required for runtime identity');
  }

  const observe = async () => {
    const [artifact, hostProfile, tags, running, version] = await Promise.all([
      resolveArtifactIdentity(model, hostId, normalizedHost, {
        refresh: true,
        requireRegistry: options.requireRegistry,
        signal: options.signal
      }),
      hostProfileService.getById(hostId),
      listModels(normalizedHost, { timeoutMs: 5_000, signal: options.signal }),
      listRunning(normalizedHost, { timeoutMs: 5_000, signal: options.signal }),
      getVersion(normalizedHost, { timeoutMs: 5_000, signal: options.signal })
    ]);
    if (normalizeHostUrl(hostProfile?.hostUrl) !== normalizedHost) {
      throw new Error('Configured host identity does not match the requested runtime endpoint');
    }
    const installed = findExactModel(tags?.models, model);
    if (!installed || !digestsMatch(installed.digest, artifact.digest)) {
      throw new Error('Live Ollama tag and registry digest do not identify the same artifact');
    }
    const resident = findExactModel(running?.models, model);
    if (!resident) {
      throw new Error('Exact model is not resident; live sizeVram and contextLength cannot be attested');
    }
    if (!resident.digest || !digestsMatch(resident.digest, installed.digest)
      || !digestsMatch(resident.digest, artifact.digest)) {
      throw new Error('Live Ollama tag, resident runtime, and registry do not identify the same digest');
    }
    return {
      artifact,
      installed,
      resident,
      runtimeVersion: version?.version || null,
      stabilityKey: JSON.stringify({
        artifact: {
          model: artifact.model,
          hostId: artifact.hostId,
          hostUrl: artifact.hostUrl,
          digest: artifact.digest,
          runtimeFingerprint: artifact.runtimeFingerprint,
          registryId: artifact.registryId,
          registryDigest: artifact.registryDigest,
          registryQualified: artifact.registryQualified
        },
        installed: {
          name: installed.name || installed.model,
          digest: installed.digest,
          size: installed.size
        },
        resident: {
          name: resident.name || resident.model,
          digest: resident.digest,
          size: resident.size,
          sizeVram: resident.size_vram,
          contextLength: resident.context_length
        },
        runtimeVersion: version?.version || null
      })
    };
  };

  // A runtime receipt is decision authority, not a best-effort dashboard
  // sample. Two identical complete observations prevent a concurrent
  // reload/context change from yielding a body assembled across two epochs.
  const first = await observe();
  const second = await observe();
  if (first.stabilityKey !== second.stabilityKey) {
    throw new Error('Live runtime identity changed while the receipt was being observed');
  }
  const { artifact, installed, resident, runtimeVersion } = second;

  return buildRuntimeArtifactReceipt({
    tag: String(installed.name || installed.model || '').trim(),
    hostId: artifact.hostId,
    hostUrl: artifact.hostUrl,
    digest: artifact.digest,
    artifactSize: installed.size,
    residentSize: resident.size,
    sizeVram: resident.size_vram,
    contextLength: resident.context_length,
    runtimeVersion
  }, {
    observedAt: options.observedAt || new Date(),
    freshnessMs: options.freshnessMs
  });
}

function runtimeReceiptMatchesProfile(receipt, evidence, options = {}) {
  const verified = verifyRuntimeArtifactReceipt(receipt, { now: options.now });
  const artifact = evidence?.artifact;
  const recommendedContext = Number(evidence?.profile?.recommendedInteractiveContext);
  return Boolean(
    verified.valid
    && artifact
    && exactModelNamesMatch(receipt?.model, artifact.model || evidence?.modelName)
    && exactModelNamesMatch(receipt?.tag, artifact.model || evidence?.modelName)
    && String(receipt?.hostId || '') === String(artifact.hostId || evidence?.hostId || '')
    && normalizeHostUrl(receipt?.hostUrl) === normalizeHostUrl(artifact.hostUrl)
    && digestsMatch(receipt?.digest, artifact.digest)
    && Number.isSafeInteger(recommendedContext)
    && recommendedContext > 0
    && receipt.contextLength === recommendedContext
  );
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

module.exports = {
  findExactModel,
  digestsMatch,
  identitiesMatch,
  registryInstallation,
  resolveArtifactIdentity,
  resolveRuntimeArtifactReceipt,
  runtimeReceiptMatchesProfile
};
