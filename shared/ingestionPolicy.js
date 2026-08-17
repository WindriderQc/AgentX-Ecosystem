const fs = require('fs');
const path = require('path');

const DEFAULT_POLICY_PATH = path.resolve(__dirname, '../config/rag-ingestion-policy.json');

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

function validateIngestionPolicy(policy) {
  if (policy?.schemaVersion !== 1) {
    throw new Error('RAG ingestion policy schemaVersion must be 1');
  }
  if (!path.isAbsolute(policy?.source?.containerRoot || '')) {
    throw new Error('RAG ingestion source containerRoot must be absolute');
  }
  if (!Array.isArray(policy?.ingestion?.approvedRoots) || !policy.ingestion.approvedRoots.length) {
    throw new Error('RAG ingestion policy requires at least one approved root');
  }
  for (const root of policy.ingestion.approvedRoots) {
    if (!isPathUnderRoot(root, policy.source.containerRoot)) {
      throw new Error(`Approved ingestion root is outside the import source: ${root}`);
    }
  }
}

function loadIngestionPolicy(policyPath = process.env.RAG_INGESTION_POLICY_PATH || DEFAULT_POLICY_PATH) {
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  validateIngestionPolicy(policy);
  return policy;
}

function getPathSegments(filePath) {
  return normalizePath(filePath).split(path.sep).filter(Boolean);
}

function classifyIngestionPath(filePath, options = {}) {
  const policy = options.policy || loadIngestionPolicy();
  const record = options.record || {};
  const normalized = normalizePath(filePath);
  const sourceRoot = normalizePath(options.sourceRoot || policy.source.containerRoot);
  const approvedRoots = (options.approvedRoots || policy.ingestion.approvedRoots).map(normalizePath);
  const ext = normalizeExtension(record.ext, normalized);
  const basename = path.basename(normalized).toLowerCase();
  const segments = getPathSegments(normalized).map((segment) => segment.toLowerCase());
  const relative = path.relative(sourceRoot, normalized);
  const topLevel = relative.split(path.sep).filter(Boolean)[0] || '';
  const topLevelReason = Object.entries(policy.ingestion.excludedTopLevel || {})
    .find(([name]) => name.toLowerCase() === topLevel.toLowerCase())?.[1];

  if (!filePath) return { allowed: false, reason: 'missing_path' };
  if (!isPathUnderRoot(normalized, sourceRoot)) return { allowed: false, reason: 'outside_source' };

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

  const approvedRoot = getMatchingRoot(normalized, approvedRoots);
  if (!approvedRoot) return { allowed: false, reason: 'unapproved_root' };

  const allowedExtensions = new Set((policy.ingestion.allowedExtensions || []).map((value) => value.toLowerCase()));
  if (!allowedExtensions.has(ext)) {
    return { allowed: false, reason: `unsupported_extension:${ext || 'unknown'}` };
  }

  const maxFileSizeBytes = Number(options.maxFileSizeBytes || policy.ingestion.maxFileSizeBytes);
  if (Number(record.size || 0) > maxFileSizeBytes) {
    return { allowed: false, reason: 'oversized' };
  }

  return { allowed: true, reason: null, approvedRoot };
}

function getPublicIngestionPolicy(policy = loadIngestionPolicy()) {
  return {
    schemaVersion: policy.schemaVersion,
    source: policy.source,
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
    }
  };
}

module.exports = {
  classifyIngestionPath,
  getMatchingRoot,
  getPublicIngestionPolicy,
  isPathUnderRoot,
  loadIngestionPolicy,
  normalizeExtension,
  normalizePath,
  validateIngestionPolicy
};
