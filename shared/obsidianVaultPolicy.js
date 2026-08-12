const fs = require('fs');
const path = require('path');

const DEFAULT_POLICY_PATH = path.resolve(__dirname, '../config/rag-ingestion-policy.json');

function loadVaultPolicy(policyPath = process.env.OBSIDIAN_VAULT_POLICY_PATH || DEFAULT_POLICY_PATH) {
  const raw = fs.readFileSync(policyPath, 'utf8');
  const policy = JSON.parse(raw);
  validateVaultPolicy(policy);
  return policy;
}

function validateVaultPolicy(policy) {
  if (policy?.schemaVersion !== 1) {
    throw new Error('Obsidian vault policy schemaVersion must be 1');
  }
  if (!path.isAbsolute(policy?.vault?.containerRoot || '')) {
    throw new Error('Obsidian vault containerRoot must be absolute');
  }
  if (!Array.isArray(policy?.ingestion?.approvedRoots) || !policy.ingestion.approvedRoots.length) {
    throw new Error('Obsidian vault policy requires at least one approved ingestion root');
  }
  for (const root of policy.ingestion.approvedRoots) {
    if (!isPathUnderRoot(root, policy.vault.containerRoot)) {
      throw new Error(`Approved ingestion root is outside the vault: ${root}`);
    }
  }
}

function normalizePath(value) {
  return path.resolve(String(value || ''));
}

function normalizeExtension(value, filePath = '') {
  const raw = String(value || path.extname(filePath).slice(1) || '').trim().toLowerCase();
  return raw.startsWith('.') ? raw.slice(1) : raw;
}

function isPathUnderRoot(filePath, root) {
  const resolvedPath = normalizePath(filePath);
  const resolvedRoot = normalizePath(root);
  return resolvedPath === resolvedRoot || resolvedPath.startsWith(`${resolvedRoot}${path.sep}`);
}

function getMatchingRoot(filePath, roots) {
  return (roots || [])
    .map(normalizePath)
    .filter((root) => isPathUnderRoot(filePath, root))
    .sort((a, b) => b.length - a.length)[0] || null;
}

function getPathSegments(filePath) {
  return normalizePath(filePath).split(path.sep).filter(Boolean);
}

function classifyVaultPath(filePath, options = {}) {
  const policy = options.policy || loadVaultPolicy();
  const record = options.record || {};
  const normalized = normalizePath(filePath);
  const vaultRoot = normalizePath(options.vaultRoot || policy.vault.containerRoot);
  const approvedRoots = (options.approvedRoots || policy.ingestion.approvedRoots).map(normalizePath);
  const ext = normalizeExtension(record.ext, normalized);
  const basename = path.basename(normalized).toLowerCase();
  const segments = getPathSegments(normalized).map((segment) => segment.toLowerCase());
  const relative = path.relative(vaultRoot, normalized);
  const topLevel = relative.split(path.sep).filter(Boolean)[0] || '';
  const topLevelReason = Object.entries(policy.ingestion.excludedTopLevel || {})
    .find(([name]) => name.toLowerCase() === topLevel.toLowerCase())?.[1];

  if (!filePath) return { allowed: false, reason: 'missing_path' };
  if (!isPathUnderRoot(normalized, vaultRoot)) return { allowed: false, reason: 'outside_vault' };

  const secretBasenames = new Set((policy.ingestion.secretBasenames || []).map((value) => value.toLowerCase()));
  const secretExtensions = new Set((policy.ingestion.secretExtensions || []).map((value) => value.toLowerCase()));
  const secretFragments = (policy.ingestion.secretNameFragments || []).map((value) => value.toLowerCase());
  if (secretBasenames.has(basename) || secretExtensions.has(ext) || secretFragments.some((value) => basename.includes(value))) {
    return { allowed: false, reason: 'secret_material' };
  }

  if (topLevelReason) return { allowed: false, reason: topLevelReason };

  const excludedDirs = new Set((policy.ingestion.excludedDirectoryNames || []).map((value) => value.toLowerCase()));
  if (segments.some((segment) => excludedDirs.has(segment))) {
    return { allowed: false, reason: 'excluded_directory' };
  }

  const generatedFragments = (policy.ingestion.generatedNameFragments || []).map((value) => value.toLowerCase());
  if (generatedFragments.some((value) => basename.includes(value))) {
    return { allowed: false, reason: 'generated_export' };
  }

  if (!getMatchingRoot(normalized, approvedRoots)) {
    return { allowed: false, reason: 'unapproved_root' };
  }

  const allowedExtensions = new Set((policy.ingestion.allowedExtensions || []).map((value) => value.toLowerCase()));
  if (!allowedExtensions.has(ext)) {
    return { allowed: false, reason: `unsupported_extension:${ext || 'unknown'}` };
  }

  const maxFileSizeBytes = Number(options.maxFileSizeBytes || policy.ingestion.maxFileSizeBytes);
  if (Number(record.size || 0) > maxFileSizeBytes) {
    return { allowed: false, reason: 'oversized' };
  }

  return { allowed: true, reason: null, approvedRoot: getMatchingRoot(normalized, approvedRoots) };
}

function buildProjectionIndex(policy = loadVaultPolicy()) {
  const projection = policy.projection;
  const repository = projection.repository.replace(/\/+$/, '');
  const branch = encodeURIComponent(projection.branch);
  return {
    mode: projection.mode,
    direction: projection.direction,
    writeToVault: false,
    operationalAuthority: projection.operationalAuthority,
    vaultIndexName: projection.vaultIndexName,
    entries: projection.entries.map((entry) => ({
      label: entry.label,
      path: entry.path,
      url: `${repository}/blob/${branch}/${entry.path}`
    }))
  };
}

function getPublicVaultPolicy(policy = loadVaultPolicy()) {
  return {
    schemaVersion: policy.schemaVersion,
    vault: policy.vault,
    inventory: policy.inventory,
    ingestion: {
      approvedRoots: policy.ingestion.approvedRoots,
      allowedExtensions: policy.ingestion.allowedExtensions,
      maxFileSizeBytes: policy.ingestion.maxFileSizeBytes,
      exclusions: {
        topLevel: policy.ingestion.excludedTopLevel,
        directoryNames: policy.ingestion.excludedDirectoryNames,
        secretExtensions: policy.ingestion.secretExtensions,
        generatedNameFragments: policy.ingestion.generatedNameFragments
      }
    },
    projection: buildProjectionIndex(policy)
  };
}

module.exports = {
  buildProjectionIndex,
  classifyVaultPath,
  getMatchingRoot,
  getPublicVaultPolicy,
  isPathUnderRoot,
  loadVaultPolicy,
  normalizeExtension,
  normalizePath,
  validateVaultPolicy
};
