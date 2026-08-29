'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');

const DEFAULT_POLICY_FILE = path.resolve(__dirname, '..', 'config', 'legacy-release-baselines.json');
const PREVIOUS_BASELINE_SCHEMA = 'agentx.previous-release-baseline/v1';
const LEGACY_IDENTITY_MODE = 'legacy-oci-bound';
const PRODUCT_SERVICES = Object.freeze(['core', 'benchmark', 'rag']);
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_WRAPPER_BYTES = 64 * 1024;

// This is intentionally not a registry of generally trusted historical
// releases. It is one audited bootstrap exception and changing or extending it
// requires changing this executable contract as well as the committed policy.
const EXPECTED_POLICY = deepFreeze({
  schemaVersion: 1,
  baselines: [
    {
      tag: 'v0.1.1',
      version: '0.1.1',
      commit: '6888750556cecc5277bf36b91f64a27806ea42a5',
      manifestSha256: '9a6d1b84fec83bd6a42d2a79852d3ac3e4e17ab4b70b5bf7c59cdef350e4912a',
      profile: 'demo',
      oci: {
        source: 'https://github.com/WindriderQc/AgentX-Ecosystem',
        version: 'v0.1.1',
      },
      services: {
        core: {
          service: 'agentx-core',
          image: 'ghcr.io/windriderqc/agentx-core',
          digest: 'sha256:7000ef7e85cf4ca23387bce1959f00f626aeb5e76ac4ba973441b05b0bd7d794',
          ref: 'ghcr.io/windriderqc/agentx-core@sha256:7000ef7e85cf4ca23387bce1959f00f626aeb5e76ac4ba973441b05b0bd7d794',
        },
        benchmark: {
          service: 'agentx-benchmark',
          image: 'ghcr.io/windriderqc/agentx-benchmark',
          digest: 'sha256:4525c3c2c44bb4e91dac3964d7cf7be1a1216035905cbfef4d63fc616164747f',
          ref: 'ghcr.io/windriderqc/agentx-benchmark@sha256:4525c3c2c44bb4e91dac3964d7cf7be1a1216035905cbfef4d63fc616164747f',
        },
        rag: {
          service: 'agentx-rag',
          image: 'ghcr.io/windriderqc/agentx-rag',
          digest: 'sha256:763511e85ad0ca67403e7ba0a9039a661eaf6ae56303a97b71ee65535e4e1423',
          ref: 'ghcr.io/windriderqc/agentx-rag@sha256:763511e85ad0ca67403e7ba0a9039a661eaf6ae56303a97b71ee65535e4e1423',
        },
      },
    },
  ],
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function baselineFromPolicy(policy) {
  return policy?.baselines?.[0] || null;
}

function validateLegacyReleasePolicy(policy) {
  return isDeepStrictEqual(policy, EXPECTED_POLICY)
    ? []
    : ['legacy release baseline policy is not the exact one-entry v0.1.1 policy'];
}

function loadLegacyReleasePolicy(policyFile = DEFAULT_POLICY_FILE) {
  const bytes = fs.readFileSync(policyFile);
  if (bytes.length === 0 || bytes.length > MAX_WRAPPER_BYTES) {
    throw new Error('legacy release baseline policy size is invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('legacy release baseline policy is not valid JSON');
  }
  const errors = validateLegacyReleasePolicy(parsed);
  if (errors.length) throw new Error(errors[0]);
  return deepFreeze(parsed);
}

function expectedManifest(policy) {
  const baseline = baselineFromPolicy(policy);
  return {
    schemaVersion: 1,
    product: 'Agent X Ecosystem',
    version: baseline?.version,
    tag: baseline?.tag,
    commit: baseline?.commit,
    images: Object.fromEntries(PRODUCT_SERVICES.map((service) => {
      const image = baseline?.services?.[service];
      return [service, { image: image?.image, digest: image?.digest, ref: image?.ref }];
    })),
  };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sameKeys(value, expected) {
  return isPlainObject(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function validateImmutablePreviousManifestBytes(bytes, { expectedRevision, expectedImages } = {}) {
  const errors = [];
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    return Object.freeze({
      errors: Object.freeze(['previous release manifest byte size is invalid']),
      manifestSha256: null,
      manifest: null,
    });
  }
  const manifestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    errors.push('previous release manifest is not valid JSON');
  }
  if (manifest) {
    if (!sameKeys(manifest, ['schemaVersion', 'product', 'version', 'tag', 'commit', 'images'])
      || manifest.schemaVersion !== 1
      || manifest.product !== 'Agent X Ecosystem'
      || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(manifest.version || ''))
      || manifest.tag !== `v${manifest.version}`
      || manifest.commit !== expectedRevision
      || !sameKeys(manifest.images, PRODUCT_SERVICES)) {
      errors.push('previous release manifest metadata shape or identity is invalid');
    }
    for (const service of PRODUCT_SERVICES) {
      const image = manifest?.images?.[service];
      const expected = expectedImages?.[service];
      if (!sameKeys(image, ['image', 'digest', 'ref'])
        || image?.digest !== expected?.digest
        || image?.ref !== expected?.ref
        || image?.ref !== `${image?.image}@${image?.digest}`) {
        errors.push(`${service} previous release manifest image binding is invalid`);
      }
    }
  }
  return Object.freeze({
    errors: Object.freeze([...new Set(errors)]),
    manifestSha256,
    manifest,
  });
}

function validatePreviousManifestBytes(bytes, policy) {
  const errors = validateLegacyReleasePolicy(policy);
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_MANIFEST_BYTES) {
    return [...errors, 'previous release manifest byte size is invalid'];
  }
  const baseline = baselineFromPolicy(policy);
  const manifestSha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  if (manifestSha256 !== baseline?.manifestSha256) errors.push('previous release manifest byte hash is not exact');
  let manifest;
  try {
    manifest = JSON.parse(bytes.toString('utf8'));
  } catch {
    errors.push('previous release manifest is not valid JSON');
  }
  if (manifest && !isDeepStrictEqual(manifest, expectedManifest(policy))) {
    errors.push('previous release manifest content is not the exact v0.1.1 asset');
  }
  return Object.freeze({ errors: Object.freeze([...new Set(errors)]), manifestSha256, manifest });
}

function strictBase64Bytes(value) {
  const encoded = String(value || '');
  if (!encoded || encoded.length > Math.ceil(MAX_MANIFEST_BYTES / 3) * 4
    || encoded.length % 4 !== 0
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
    throw new Error('previous release manifest base64 is not canonical');
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) throw new Error('previous release manifest base64 is not canonical');
  return bytes;
}

function readPreviousManifest(
  { manifestPath, manifestBase64, manifestSha256 },
  { expectedRevision, expectedImages, legacyPolicy = null } = {}
) {
  if (Boolean(manifestPath) === Boolean(manifestBase64)) {
    throw new Error('exactly one previous release manifest file or base64 input is required');
  }
  if (manifestSha256 != null && !HASH_PATTERN.test(String(manifestSha256))) {
    throw new Error('previous release manifest sha256 must be 64 lowercase hexadecimal characters');
  }
  const bytes = manifestPath ? fs.readFileSync(path.resolve(String(manifestPath))) : strictBase64Bytes(manifestBase64);
  const immutableValidation = validateImmutablePreviousManifestBytes(bytes, { expectedRevision, expectedImages });
  if (immutableValidation.errors.length) throw new Error(immutableValidation.errors[0]);
  const validation = legacyPolicy
    ? validatePreviousManifestBytes(bytes, legacyPolicy)
    : immutableValidation;
  if (validation.errors.length) throw new Error(validation.errors[0]);
  if (manifestSha256 != null && manifestSha256 !== validation.manifestSha256) {
    throw new Error('explicit previous release manifest sha256 does not match the exact bytes');
  }
  return deepFreeze({
    manifestSha256: validation.manifestSha256,
    manifest: validation.manifest,
  });
}

function previousReleaseBaselineTemplate(policy) {
  const errors = validateLegacyReleasePolicy(policy);
  if (errors.length) throw new Error(errors[0]);
  const baseline = baselineFromPolicy(policy);
  return deepFreeze({
    schema: PREVIOUS_BASELINE_SCHEMA,
    identityEvidenceMode: LEGACY_IDENTITY_MODE,
    tag: baseline.tag,
    version: baseline.version,
    commit: baseline.commit,
    profile: baseline.profile,
    manifestSha256: baseline.manifestSha256,
    images: Object.fromEntries(PRODUCT_SERVICES.map((service) => {
      const image = baseline.services[service];
      return [service, { image: image.image, digest: image.digest, ref: image.ref }];
    })),
    ociLabels: Object.fromEntries(PRODUCT_SERVICES.map((service) => [service, {
      revision: baseline.commit,
      version: baseline.oci.version,
      source: baseline.oci.source,
    }])),
  });
}

function validatePreviousReleaseBaseline(value, policy) {
  let expected;
  try {
    expected = previousReleaseBaselineTemplate(policy);
  } catch (error) {
    return [error.message];
  }
  return isDeepStrictEqual(value, expected)
    ? []
    : ['previous release baseline wrapper is not the exact closed v0.1.1 binding'];
}

function normalizePreviousReleaseBaseline(value, policy) {
  const errors = validatePreviousReleaseBaseline(value, policy);
  if (errors.length) throw new Error(errors[0]);
  return deepFreeze(clone(value));
}

function readPreviousReleaseBaseline(wrapperFile, policy) {
  if (!wrapperFile) return previousReleaseBaselineTemplate(policy);
  const bytes = fs.readFileSync(path.resolve(String(wrapperFile)));
  if (bytes.length === 0 || bytes.length > MAX_WRAPPER_BYTES) {
    throw new Error('previous release baseline wrapper size is invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('previous release baseline wrapper is not valid JSON');
  }
  return normalizePreviousReleaseBaseline(parsed, policy);
}

function receiptBaselineBinding(policy) {
  const baseline = baselineFromPolicy(policy);
  return Object.freeze({
    tag: baseline.tag,
    version: baseline.version,
    commit: baseline.commit,
    manifestSha256: baseline.manifestSha256,
    profile: baseline.profile,
  });
}

module.exports = {
  DEFAULT_POLICY_FILE,
  EXPECTED_POLICY,
  HASH_PATTERN,
  LEGACY_IDENTITY_MODE,
  MAX_MANIFEST_BYTES,
  PREVIOUS_BASELINE_SCHEMA,
  PRODUCT_SERVICES,
  baselineFromPolicy,
  expectedManifest,
  loadLegacyReleasePolicy,
  normalizePreviousReleaseBaseline,
  previousReleaseBaselineTemplate,
  readPreviousManifest,
  readPreviousReleaseBaseline,
  receiptBaselineBinding,
  validateLegacyReleasePolicy,
  validateImmutablePreviousManifestBytes,
  validatePreviousManifestBytes,
  validatePreviousReleaseBaseline,
};
