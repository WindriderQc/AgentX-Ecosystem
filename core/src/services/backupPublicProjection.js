'use strict';

const SAFE_NAME = /^[a-zA-Z0-9._-]+$/;
const SAFE_SOURCE = new Set(['default', 'env', 'runtime', 'unknown', 'disabled']);
const CONFIG_SOURCE_IDS = Object.freeze({
  'docker-compose.yml': 'base-compose',
  'docker-compose.ollama.yml': 'optional-ollama-compose',
  'config/agentx.env': 'product-defaults',
  'config/rag-ingestion-policy.json': 'rag-ingestion-policy',
  'config/product-surfaces.json': 'product-surfaces',
  'config/adapter-consumer-contracts.json': 'adapter-consumer-contracts',
  'config/container-image-pins.json': 'container-image-pins'
});

const SAFE_NEXT_RUN_REASONS = new Set(['startup', 'normal', 'retry', 'retry-exhausted', 'non-retryable-failure']);
const OPERATION_NAMES = ['mongo', 'config', 'qdrant'];

function projectFailures(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(entry => entry && OPERATION_NAMES.includes(entry.name))
    .map(entry => ({
      name: entry.name,
      error: typeof entry.error === 'string' ? entry.error.slice(0, 200) : 'unknown error',
      code: typeof entry.code === 'string' && /^[A-Z0-9_]{1,64}$/.test(entry.code) ? entry.code : null,
      retryable: entry.retryable !== false
    }));
}

const RECOVERY_STORAGE = Object.freeze({
  kind: 'docker-named-volume',
  scope: 'persistent-recovery-storage',
  lifecycle: 'preserved-by-ordinary-down',
  resetBehavior: 'removed-only-by-explicit-confirmed-reset',
  hostLossProtection: 'separate-export-required'
});

function safeName(value) {
  return typeof value === 'string' && value.length <= 255 && SAFE_NAME.test(value)
    ? value
    : null;
}

function safeDate(value) {
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function safeSize(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function projectArtifact(value = {}, dateField = 'date') {
  const name = safeName(value.name);
  if (!name) return null;
  const projected = { name };
  const date = safeDate(value[dateField]);
  const size = safeSize(value.size);
  if (date) projected[dateField] = date;
  if (size !== null) projected.size = size;
  if (typeof value.compressed === 'boolean') projected.compressed = value.compressed;
  if (typeof value.checksum === 'string' && /^[a-fA-F0-9]{8,128}$/.test(value.checksum)) {
    projected.checksum = value.checksum;
  }
  return projected;
}

function projectArtifacts(values, dateField = 'date') {
  return (Array.isArray(values) ? values : [])
    .map(value => projectArtifact(value, dateField))
    .filter(Boolean);
}

function projectNames(values) {
  return (Array.isArray(values) ? values : []).map(safeName).filter(Boolean);
}

function projectRestorePolicy(value = {}) {
  const enabled = value.enabled === true;
  return {
    enabled,
    mode: enabled ? 'controlled-rehearsal' : 'offline-rehearsal-required',
    code: enabled ? null : 'OFFLINE_RESTORE_REQUIRED',
    message: enabled
      ? 'Restore is enabled only for a controlled, offline release rehearsal.'
      : 'Restore requires a controlled offline release rehearsal and is disabled in the running product.',
    coherentRecoverySetVerified: false
  };
}

function projectPolicyEvidence(value = {}) {
  const schedule = value.schedule || {};
  const retention = value.retention || {};
  const growthRisk = value.growthRisk || {};
  const source = candidate => SAFE_SOURCE.has(candidate) ? candidate : 'unknown';
  const finite = candidate => {
    const parsed = Number(candidate);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  };
  const riskLevel = ['low', 'watch', 'high'].includes(growthRisk.level) ? growthRisk.level : 'watch';
  const lastFailures = projectFailures(schedule.lastFailures);
  const blockedLayers = lastFailures.filter(entry => entry.retryable === false);
  const nextRunReason = SAFE_NEXT_RUN_REASONS.has(schedule.nextRunReason) ? schedule.nextRunReason : null;
  const riskReasons = riskLevel === 'high'
    ? ['Scheduled creation is enabled while retention is unbounded.']
    : riskLevel === 'watch'
      ? ['Retention or creation policy requires operator attention.']
      : ['Retention and creation cadence are bounded.'];
  const riskWarnings = ['A recovery archive is not proof of a coherent, restorable recovery set.'];
  if (blockedLayers.length > 0) {
    riskReasons.push(
      `${blockedLayers.map(entry => entry.name).join(', ')} backup${blockedLayers.length > 1 ? 's are' : ' is'} failing with a non-retryable error; automatic retries are suspended for that layer until an operator fixes the configuration.`
    );
    for (const entry of blockedLayers) {
      riskWarnings.push(`${entry.name}: ${entry.error}${entry.code ? ` (${entry.code})` : ''}`);
    }
  } else if (lastFailures.length > 0) {
    riskWarnings.push(
      `Last cycle left ${lastFailures.map(entry => entry.name).join(', ')} without a fresh artifact; only the failed layer${lastFailures.length > 1 ? 's are' : ' is'} retried.`
    );
  }
  if (nextRunReason === 'retry-exhausted') {
    riskWarnings.push('The retry budget for the last failure was exhausted; the scheduler is back on the normal cadence.');
  }
  return {
    authority: 'core.backup-policy',
    observedAt: safeDate(value.observedAt) || new Date().toISOString(),
    schedule: {
      enabled: schedule.enabled === true,
      enabledSource: source(schedule.enabledSource),
      normalEveryMs: finite(schedule.normalEveryMs),
      normalEverySource: source(schedule.normalEverySource),
      failureRetryEveryMs: finite(schedule.failureRetryEveryMs),
      failureRetrySource: source(schedule.failureRetrySource),
      startupDelayMs: finite(schedule.startupDelayMs),
      startupDelaySource: source(schedule.startupDelaySource),
      nextRunAt: safeDate(schedule.nextRunAt),
      lastStartedAt: safeDate(schedule.lastStartedAt),
      lastFinishedAt: safeDate(schedule.lastFinishedAt),
      lastStatus: ['never', 'running', 'success', 'partial', 'failed', 'stopped'].includes(schedule.lastStatus)
        ? schedule.lastStatus
        : 'unknown',
      lastCycleMode: schedule.lastCycleMode === 'retry' ? 'retry' : (schedule.lastCycleMode === 'full' ? 'full' : null),
      lastFailures,
      nextRunReason,
      consecutiveRetries: Math.floor(finite(schedule.consecutiveRetries)),
      maxRetries: Math.floor(finite(schedule.maxRetries)),
      maxRetriesSource: source(schedule.maxRetriesSource),
      logicalOperationsPerCycle: finite(schedule.logicalOperationsPerCycle),
      operationNames: ['mongo', 'config', 'qdrant'],
      normalCyclesPerDay: finite(schedule.normalCyclesPerDay),
      logicalOperationsPerDay: finite(schedule.logicalOperationsPerDay),
      note: 'Qdrant snapshots may also have a persistent recovery copy.'
    },
    retention: {
      days: Math.floor(finite(retention.days)),
      source: source(retention.source),
      mode: retention.mode === 'bounded' ? 'bounded' : 'unbounded',
      automaticCleanup: retention.automaticCleanup === true,
      enforcement: retention.automaticCleanup === true
        ? 'after each successful backup operation'
        : 'disabled',
      coveredArtifacts: [
        'current MongoDB tarballs',
        'configuration tarballs',
        'persistent Qdrant snapshot copies',
        'Qdrant server snapshots (best effort)'
      ],
      excludedArtifacts: ['legacy uncompressed MongoDB backup directories']
    },
    growthRisk: {
      level: riskLevel,
      reasons: riskReasons,
      warnings: riskWarnings
    }
  };
}

function projectInventoryEvidence(value = {}, kind = 'artifact') {
  const inventory = value.inventory || {};
  const dates = {
    oldestAt: safeDate(inventory.oldestAt),
    newestAt: safeDate(inventory.newestAt),
    observedAt: safeDate(inventory.observedAt) || new Date().toISOString()
  };
  return {
    inventory: {
      authority: `core.backup-inventory.${kind}`,
      source: kind === 'qdrant' ? 'Internal recovery snapshot inventory' : 'Persistent recovery inventory',
      scope: `Complete recognized ${kind} recovery inventory`,
      countBasis: 'All recognized records returned by the logical recovery store; no date window or pagination',
      count: Math.floor(safeSize(inventory.count) || 0),
      knownSizeCount: Math.floor(safeSize(inventory.knownSizeCount) || 0),
      totalKnownBytes: safeSize(inventory.totalKnownBytes) || 0,
      ...dates
    },
    retention: projectPolicyEvidence({ retention: value.retention }).retention,
    growthRisk: projectPolicyEvidence({ growthRisk: value.growthRisk }).growthRisk,
    observedAt: safeDate(value.observedAt) || dates.observedAt
  };
}

function projectBackupConfig(config = {}, policyEvidence = {}, restorePolicy = {}) {
  const retentionDays = Math.floor(safeSize(config.retentionDays) || 0);
  const sourceIds = (Array.isArray(config.configSources) ? config.configSources : [])
    .map(value => CONFIG_SOURCE_IDS[value])
    .filter(Boolean);
  return {
    storage: { ...RECOVERY_STORAGE },
    retentionDays,
    retentionDaysSource: SAFE_SOURCE.has(config.retentionDaysSource) ? config.retentionDaysSource : 'unknown',
    configBackup: {
      scope: 'supported-secret-free-product-sources',
      sourceCount: sourceIds.length,
      sourceIds,
      excludesRuntimeEnvironment: true,
      excludesSecrets: true,
      excludesPrivateAdapters: true,
      excludesData: true,
      excludesSystemCrontab: true
    },
    restorePolicy: projectRestorePolicy(restorePolicy),
    policyEvidence: projectPolicyEvidence(policyEvidence)
  };
}

function pathLikePrivate(value) {
  const normalized = String(value).replace(/\\/g, '/').toLowerCase();
  return normalized.startsWith('/')
    || /^[a-z]:\//.test(normalized)
    || normalized.includes('://')
    || normalized === '.env'
    || normalized.endsWith('/.env')
    || normalized.includes('secret')
    || normalized.includes('credential')
    || normalized.includes('crontab')
    || normalized.startsWith('data/');
}

function projectCreatedArtifact(value = {}, dateField = 'timestamp') {
  const artifact = projectArtifact(value, dateField) || {};
  return {
    ...artifact,
    pruned: projectNames(value.pruned),
    persistent: true
  };
}

function projectCreatedConfig(value = {}) {
  const sourceIds = (Array.isArray(value.includes) ? value.includes : [])
    .map(item => CONFIG_SOURCE_IDS[item])
    .filter(Boolean);
  return {
    ...projectCreatedArtifact(value),
    sourceCount: sourceIds.length,
    sourceIds
  };
}

function projectCreatedQdrant(value = {}) {
  const artifact = projectArtifact(value, 'creation_time') || {};
  return {
    ...artifact,
    persistentCopy: Boolean(value.localPath),
    prunedPersistentCopies: projectNames(value.prunedLocal),
    prunedServerSnapshots: projectNames(value.prunedServer)
  };
}

function projectMutationResult(value = {}, extra = {}) {
  const name = safeName(value.name);
  return {
    ...(name ? { name } : {}),
    ...extra
  };
}

module.exports = {
  CONFIG_SOURCE_IDS,
  RECOVERY_STORAGE,
  pathLikePrivate,
  projectArtifact,
  projectArtifacts,
  projectBackupConfig,
  projectCreatedArtifact,
  projectCreatedConfig,
  projectCreatedQdrant,
  projectInventoryEvidence,
  projectMutationResult,
  projectPolicyEvidence,
  projectRestorePolicy,
  safeName
};
