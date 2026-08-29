'use strict';

const EVIDENCE_TRUST_SCHEMA_VERSION = 1;
const DEFAULT_EVIDENCE_FRESHNESS_BUDGET_MS = 120_000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5_000;

function finiteTimestamp(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function countByStatus(items) {
  return items.reduce((counts, item) => {
    const status = String(item?.status || '').toLowerCase();
    if (status === 'ok') counts.healthy += 1;
    else if (status === 'degraded') counts.degraded += 1;
    else if (status === 'down') counts.down += 1;
    return counts;
  }, { healthy: 0, degraded: 0, down: 0 });
}

function observedModelCount(cluster) {
  const names = new Set();
  for (const host of cluster) {
    for (const model of Array.isArray(host?.models) ? host.models : []) {
      const name = typeof model === 'string' ? model : model?.name || model?.model;
      if (name) names.add(name);
    }
  }
  return names.size;
}

function expectedServiceStatus(counts) {
  if (counts.down > 0) return 'down';
  if (counts.degraded > 0) return 'degraded';
  return 'ok';
}

function recordMismatch(contradictions, id, expected, observed) {
  if (expected === observed) return;
  contradictions.push(Object.freeze({ id, expected, observed }));
}

function assessTimestamp(source, observedAt, generatedAtMs, freshnessBudgetMs, contradictions) {
  const observedAtMs = finiteTimestamp(observedAt);
  if (observedAtMs === null) {
    return Object.freeze({ source, observedAt: null, status: 'unknown', ageMs: null });
  }

  const ageMs = generatedAtMs - observedAtMs;
  if (ageMs < -FUTURE_TIMESTAMP_TOLERANCE_MS) {
    contradictions.push(Object.freeze({
      id: `future-timestamp:${source}`,
      expected: `not more than ${FUTURE_TIMESTAMP_TOLERANCE_MS}ms after snapshot generation`,
      observed: observedAt,
    }));
    return Object.freeze({ source, observedAt, status: 'future', ageMs });
  }

  return Object.freeze({
    source,
    observedAt,
    status: ageMs > freshnessBudgetMs ? 'stale' : 'current',
    ageMs: Math.max(0, ageMs),
  });
}

function assessEcosystemEvidence(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    throw new TypeError('snapshot must be an object');
  }

  const generatedAtMs = finiteTimestamp(snapshot.generatedAt);
  if (generatedAtMs === null) throw new Error('snapshot.generatedAt must be an ISO-8601 timestamp');

  const freshnessBudgetMs = Number.isFinite(Number(options.freshnessBudgetMs))
    && Number(options.freshnessBudgetMs) > 0
    ? Number(options.freshnessBudgetMs)
    : DEFAULT_EVIDENCE_FRESHNESS_BUDGET_MS;
  const services = Array.isArray(snapshot.services) ? snapshot.services : [];
  const cluster = Array.isArray(snapshot.cluster) ? snapshot.cluster : [];
  const serviceHealth = snapshot.serviceHealth || {};
  const health = snapshot.health || {};
  const contradictions = [];

  const serviceCounts = countByStatus(services);
  recordMismatch(contradictions, 'service-total', services.length, Number(serviceHealth.total));
  recordMismatch(contradictions, 'service-healthy', serviceCounts.healthy, Number(serviceHealth.healthy));
  recordMismatch(contradictions, 'service-degraded', serviceCounts.degraded, Number(serviceHealth.degraded));
  recordMismatch(contradictions, 'service-down', serviceCounts.down, Number(serviceHealth.down));
  recordMismatch(
    contradictions,
    'service-summary-status',
    expectedServiceStatus(serviceCounts),
    serviceHealth.status
  );

  const onlineHosts = cluster.filter((host) => host?.status === 'online').length;
  recordMismatch(contradictions, 'cluster-configured-hosts', cluster.length, Number(health.configuredHosts));
  recordMismatch(contradictions, 'cluster-online-hosts', onlineHosts, Number(health.onlineHosts));
  recordMismatch(contradictions, 'cluster-offline-hosts', cluster.length - onlineHosts, Number(health.offlineHosts));
  recordMismatch(contradictions, 'cluster-observed-models', observedModelCount(cluster), Number(health.observedModels));

  const timestampSources = [
    ['services', snapshot.evidence?.servicesObservedAt],
    ['alerts', snapshot.alertSummary?.observedAt],
    ...services.map((service) => [`service:${service.id || 'unknown'}`, service.identity?.ts]),
    ...cluster.map((host) => [`host:${host.hostKey || 'unknown'}`, host.checkedAt]),
  ];
  const freshnessSources = timestampSources.map(([source, observedAt]) => assessTimestamp(
    source,
    observedAt,
    generatedAtMs,
    freshnessBudgetMs,
    contradictions
  ));
  const staleSources = freshnessSources.filter((source) => source.status === 'stale');
  const unknownSources = freshnessSources.filter((source) => source.status === 'unknown');
  const currentSources = freshnessSources.filter((source) => source.status === 'current');

  const runtimeConsistency = snapshot.identityConsistency?.status || 'unverified';
  let status = 'verified';
  if (contradictions.length > 0) status = 'contradictory';
  else if (runtimeConsistency === 'degraded') status = 'inconsistent';
  else if (staleSources.length > 0) status = 'stale';
  else if (unknownSources.length > 0 || runtimeConsistency !== 'ok') status = 'partial';

  const checks = Object.freeze([
    Object.freeze({
      id: 'internal-consistency',
      status: contradictions.length === 0 ? 'pass' : 'fail',
      detail: `${contradictions.length} contradiction${contradictions.length === 1 ? '' : 's'} observed`,
    }),
    Object.freeze({
      id: 'runtime-identity',
      status: runtimeConsistency === 'ok' ? 'pass' : (runtimeConsistency === 'degraded' ? 'fail' : 'warn'),
      detail: runtimeConsistency,
    }),
    Object.freeze({
      id: 'freshness',
      status: staleSources.length > 0 ? 'fail' : (unknownSources.length > 0 ? 'warn' : 'pass'),
      detail: `${currentSources.length}/${freshnessSources.length} sources current`,
    }),
  ]);

  return Object.freeze({
    schemaVersion: EVIDENCE_TRUST_SCHEMA_VERSION,
    status,
    operationalStatus: health.status || 'unknown',
    contradictionBudget: Object.freeze({
      allowed: 0,
      observed: contradictions.length,
      withinBudget: contradictions.length === 0,
      contradictions: Object.freeze(contradictions),
    }),
    freshness: Object.freeze({
      status: staleSources.length > 0 ? 'stale' : (unknownSources.length > 0 ? 'partial' : 'current'),
      budgetMs: freshnessBudgetMs,
      current: currentSources.length,
      stale: staleSources.length,
      unknown: unknownSources.length,
      sources: Object.freeze(freshnessSources),
    }),
    coverage: Object.freeze({
      status: unknownSources.length === 0 ? 'complete' : 'partial',
      expectedSources: freshnessSources.length,
      observedSources: freshnessSources.length - unknownSources.length,
      missing: Object.freeze(unknownSources.map((source) => source.source)),
    }),
    checks,
  });
}

module.exports = {
  DEFAULT_EVIDENCE_FRESHNESS_BUDGET_MS,
  EVIDENCE_TRUST_SCHEMA_VERSION,
  FUTURE_TIMESTAMP_TOLERANCE_MS,
  assessEcosystemEvidence,
  countByStatus,
  observedModelCount,
};
