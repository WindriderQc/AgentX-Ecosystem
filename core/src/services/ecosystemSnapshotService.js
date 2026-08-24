'use strict';

const ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION = 1;
const DEFAULT_ECOSYSTEM_SNAPSHOT_TIMEOUT_MS = 7000;

function positiveTimeout(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

async function collectWithinDeadline(collectors, timeoutMs) {
  let timeoutId;
  const deadline = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const error = new Error(`Ecosystem snapshot collection timed out after ${timeoutMs}ms`);
      error.code = 'ECOSYSTEM_SNAPSHOT_TIMEOUT';
      reject(error);
    }, timeoutMs);
  });

  try {
    return await Promise.race([Promise.all(collectors), deadline]);
  } finally {
    clearTimeout(timeoutId);
  }
}

function assertBuilder(value, name) {
  if (typeof value !== 'function') {
    throw new TypeError(`${name} must be a function`);
  }
}

function assertIntelligenceContract(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Nerve Center intelligence returned no data');
  }
  for (const key of ['cluster', 'hostPreferences', 'alerts', 'recentRouting']) {
    if (!Array.isArray(value[key])) {
      throw new Error(`Nerve Center intelligence field ${key} must be an array`);
    }
  }
  if (!value.routing || typeof value.routing !== 'object') {
    throw new Error('Nerve Center intelligence field routing must be an object');
  }
}

function assertRoutingConfigContract(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('Nerve Center routing configuration returned no data');
  }
  for (const key of ['taskModels', 'hosts', 'taskConfigState']) {
    if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) {
      throw new Error(`Nerve Center routing configuration field ${key} must be an object`);
    }
  }
}

function summarizeCluster(cluster) {
  const onlineHosts = cluster.filter((host) => host?.status === 'online').length;
  const modelNames = new Set();
  for (const host of cluster) {
    for (const model of Array.isArray(host?.models) ? host.models : []) {
      const name = typeof model === 'string' ? model : model?.name || model?.model;
      if (name) modelNames.add(name);
    }
  }
  return {
    status: cluster.length > 0 && onlineHosts === cluster.length ? 'ok' : 'degraded',
    configuredHosts: cluster.length,
    onlineHosts,
    offlineHosts: cluster.length - onlineHosts,
    observedModels: modelNames.size
  };
}

async function buildEcosystemSnapshot(options = {}) {
  const buildIntelligence = options.buildIntelligence;
  const buildRoutingConfig = options.buildRoutingConfig;
  assertBuilder(buildIntelligence, 'buildIntelligence');
  assertBuilder(buildRoutingConfig, 'buildRoutingConfig');

  const timeoutMs = positiveTimeout(
    options.timeoutMs ?? process.env.ECOSYSTEM_SNAPSHOT_TIMEOUT_MS,
    DEFAULT_ECOSYSTEM_SNAPSHOT_TIMEOUT_MS
  );
  const [intelligence, routingConfig] = await collectWithinDeadline([
    Promise.resolve().then(() => buildIntelligence()),
    Promise.resolve().then(() => buildRoutingConfig())
  ], timeoutMs);
  assertIntelligenceContract(intelligence);
  assertRoutingConfigContract(routingConfig);

  const now = typeof options.now === 'function' ? options.now() : new Date();
  const generatedDate = now instanceof Date ? now : new Date(now);
  if (Number.isNaN(generatedDate.getTime())) {
    throw new Error('Ecosystem snapshot timestamp is invalid');
  }
  const generatedAt = generatedDate.toISOString();

  return {
    schemaVersion: ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION,
    generatedAt,
    authority: 'agentx-product',
    readOnly: true,
    health: summarizeCluster(intelligence.cluster),
    cluster: intelligence.cluster,
    routing: intelligence.routing,
    routingConfig,
    hostPreferences: intelligence.hostPreferences,
    alerts: intelligence.alerts,
    recentRouting: intelligence.recentRouting
  };
}

module.exports = {
  DEFAULT_ECOSYSTEM_SNAPSHOT_TIMEOUT_MS,
  ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION,
  assertIntelligenceContract,
  assertRoutingConfigContract,
  buildEcosystemSnapshot,
  summarizeCluster
};
