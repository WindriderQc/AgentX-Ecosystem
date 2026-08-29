#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const {
  DEFAULT_BASE_URLS,
  readRegistry,
  selectSurfaces,
  validateRegistry,
} = require('./verify-product-surfaces');
const { VERSION_PATTERN } = require('./verify-release-contract');

const RECEIPT_KIND = 'agentx.support-receipt';
const RECEIPT_SCHEMA_VERSION = 1;
const ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION = 2;
const EVIDENCE_TRUST_SCHEMA_VERSION = 1;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_FRESHNESS_MS = 120_000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5000;
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_RECEIPT_BYTES = 65_536;
const MAX_SURFACES = 128;
const MAX_SOURCE_RECORDS = 128;
const MAX_TRUST_CHECKS = 16;
const MAX_SAFE_COUNT = 1_000_000;

const SERVICE_ORDER = Object.freeze(['core', 'benchmark', 'rag']);
const SERVICE_IDENTITIES = Object.freeze({
  core: 'agentx-core',
  benchmark: 'agentx-benchmark',
  rag: 'agentx-rag',
});
const PROFILES = new Set(['demo', 'full']);
const REVISION_PATTERN = /^(?:[A-Fa-f0-9]{7,64}|[A-Za-z][A-Za-z0-9_-]{0,127})$/;
const SURFACE_ID_PATTERN = /^[a-z0-9-]{1,80}$/;
const HEALTH_STATUS = new Set(['ok', 'degraded', 'down']);
const TRUST_STATUS = new Set(['verified', 'contradictory', 'inconsistent', 'stale', 'partial']);
const COVERAGE_STATUS = new Set(['complete', 'partial']);
const FRESHNESS_STATUS = new Set(['current', 'stale', 'partial']);
const IDENTITY_STATUS = new Set(['ok', 'degraded', 'unverified']);
const CHECK_STATUS = new Set(['pass', 'warn', 'fail']);
const CHECK_IDS = new Set(['internal-consistency', 'runtime-identity', 'freshness']);
const SAFE_CONTRADICTION_IDS = new Set([
  'service-total',
  'service-healthy',
  'service-degraded',
  'service-down',
  'service-summary-status',
  'cluster-configured-hosts',
  'cluster-online-hosts',
  'cluster-offline-hosts',
  'cluster-observed-models',
]);
const FORBIDDEN_RECEIPT_KEY = /(url|uri|path|header|environment|secret|token|credential|stack|trace|chat|task|adapter|address)/i;
const UNSAFE_RECEIPT_STRING = /(:\/\/|\\|\/(?:[^/]|$)|\b(?:file|data|javascript):)/i;

class SupportReceiptError extends Error {
  constructor(receipt) {
    super('Agent X support receipt contains failed required evidence gates.');
    this.name = 'SupportReceiptError';
    this.receipt = receipt;
  }
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function safeReasonCodes(values) {
  return Object.freeze([...new Set(values)].sort());
}

function safeEnum(value, allowed, fallback = 'unknown') {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function safeCount(value, maximum = MAX_SAFE_COUNT) {
  return Number.isInteger(value) && value >= 0 && value <= maximum ? value : null;
}

function canonicalTimestamp(value) {
  if (typeof value !== 'string') return null;
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) return null;
  return new Date(milliseconds).toISOString() === value ? value : null;
}

function clockMilliseconds(now) {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  required(Number.isFinite(milliseconds), 'support receipt clock is invalid');
  return milliseconds;
}

function freshnessProjection(value, nowMs, freshnessMs) {
  const observedAt = canonicalTimestamp(value);
  if (!observedAt) return Object.freeze({ observedAt: null, ageMs: null, status: 'invalid' });
  const ageMs = nowMs - Date.parse(observedAt);
  if (ageMs < -FUTURE_TIMESTAMP_TOLERANCE_MS) {
    return Object.freeze({ observedAt, ageMs, status: 'future' });
  }
  if (ageMs > freshnessMs) {
    return Object.freeze({ observedAt, ageMs, status: 'stale' });
  }
  return Object.freeze({ observedAt, ageMs: Math.max(0, ageMs), status: 'current' });
}

function normalizedBaseUrl(value) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error('service address is invalid');
  }
  required(url.protocol === 'http:' || url.protocol === 'https:', 'service address must use HTTP or HTTPS');
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function requestBoundedJson(fetchImpl, address, timeoutMs) {
  let response;
  try {
    response = await fetchImpl(address, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return Object.freeze({ body: null, code: 'request_unavailable', status: null });
  }

  const status = Number.isInteger(response?.status) ? response.status : null;
  if (status === null) return Object.freeze({ body: null, code: 'invalid_response', status: null });
  if (status >= 300 && status < 400) {
    return Object.freeze({ body: null, code: 'redirect_rejected', status });
  }

  const declaredLength = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    return Object.freeze({ body: null, code: 'response_too_large', status });
  }

  let bytes;
  try {
    const chunks = [];
    let total = 0;
    const append = (value) => {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        const error = new Error('response exceeded support receipt byte limit');
        error.code = 'RESPONSE_TOO_LARGE';
        throw error;
      }
      chunks.push(chunk);
    };

    if (typeof response.body?.getReader === 'function') {
      const reader = response.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          append(value);
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      } finally {
        reader.releaseLock?.();
      }
    } else if (response.body && typeof response.body[Symbol.asyncIterator] === 'function') {
      for await (const chunk of response.body) append(chunk);
    } else {
      return Object.freeze({ body: null, code: 'response_unreadable', status });
    }
    bytes = Buffer.concat(chunks, total);
  } catch (error) {
    return Object.freeze({
      body: null,
      code: error?.code === 'RESPONSE_TOO_LARGE' ? 'response_too_large' : 'response_unreadable',
      status,
    });
  }

  let body;
  try {
    body = JSON.parse(bytes.toString('utf8'));
  } catch {
    return Object.freeze({ body: null, code: 'invalid_json', status });
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return Object.freeze({ body: null, code: 'invalid_payload', status });
  }
  return Object.freeze({ body, code: null, status });
}

function componentState(value) {
  const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
  if (['ok', 'up', 'ready', 'healthy', 'connected', 'available'].includes(normalized)) return 'ok';
  if (['degraded', 'partial', 'warn', 'warning'].includes(normalized)) return 'degraded';
  if (['down', 'failed', 'error', 'unhealthy', 'disconnected', 'unavailable', 'unconfigured', 'not-configured'].includes(normalized)) {
    return 'unavailable';
  }
  return 'unknown';
}

function serviceComponents(service, body) {
  if (service === 'core') {
    return Object.freeze([
      Object.freeze({ id: 'mongodb', required: true, status: componentState(body?.details?.mongodb) }),
      Object.freeze({ id: 'ollama', required: false, status: componentState(body?.details?.ollama) }),
    ]);
  }
  if (service === 'benchmark') {
    return Object.freeze([
      Object.freeze({ id: 'mongodb', required: true, status: componentState(body?.db) }),
    ]);
  }
  return Object.freeze([
    Object.freeze({ id: 'mongodb', required: true, status: componentState(body?.db) }),
    Object.freeze({
      id: 'vector-store',
      required: true,
      status: body?.vectorStore?.healthy === true ? 'ok'
        : (body?.vectorStore?.healthy === false ? 'unavailable' : 'unknown'),
    }),
  ]);
}

function projectServiceHealth(service, request, profile, nowMs, freshnessMs) {
  const issues = [];
  if (request.code) {
    issues.push(`${service}_${request.code}`);
    return Object.freeze({
      id: service,
      evidenceStatus: 'unavailable',
      healthStatus: 'unknown',
      identity: null,
      components: Object.freeze([]),
      reasonCodes: safeReasonCodes(issues),
    });
  }

  const body = request.body;
  const expectedIdentity = SERVICE_IDENTITIES[service];
  const observedService = body.service === expectedIdentity ? body.service : null;
  const version = VERSION_PATTERN.test(String(body.version || '')) ? body.version : null;
  const observedProfile = PROFILES.has(body.profile) ? body.profile : null;
  const revision = REVISION_PATTERN.test(String(body.revision || '')) && body.revision !== 'unknown'
    ? body.revision
    : null;
  const freshness = freshnessProjection(body.ts, nowMs, freshnessMs);
  const healthStatus = safeEnum(body.status, HEALTH_STATUS);
  const components = serviceComponents(service, body);

  if (!observedService) issues.push(`${service}_service_identity_invalid`);
  if (!version) issues.push(`${service}_version_invalid`);
  if (!observedProfile) issues.push(`${service}_profile_invalid`);
  else if (observedProfile !== profile) issues.push(`${service}_profile_mismatch`);
  if (!revision) issues.push(`${service}_revision_unavailable`);
  if (freshness.status !== 'current') issues.push(`${service}_health_${freshness.status}`);
  if (body.ok !== true || healthStatus !== 'ok' || request.status < 200 || request.status >= 300) {
    issues.push(`${service}_health_not_ready`);
  }
  for (const component of components) {
    if (component.required && component.status !== 'ok') {
      issues.push(`${service}_${component.id.replace(/-/g, '_')}_not_ready`);
    }
  }

  return Object.freeze({
    id: service,
    evidenceStatus: issues.some((code) => code.includes('invalid') || code.includes('unavailable'))
      ? 'invalid'
      : 'available',
    healthStatus,
    identity: Object.freeze({
      service: observedService,
      version,
      profile: observedProfile,
      revision,
      observedAt: freshness.observedAt,
      ageMs: freshness.ageMs,
      freshness: freshness.status,
    }),
    components,
    reasonCodes: safeReasonCodes(issues),
  });
}

function summarizeRuntimeIdentity(services, expectedProfile) {
  const issues = [];
  const identities = services.map((service) => service.identity).filter(Boolean);
  const distinct = (key) => [...new Set(identities.map((identity) => identity[key]).filter(Boolean))].sort();
  const profiles = distinct('profile');
  const versions = distinct('version');
  const revisions = distinct('revision');
  if (identities.length !== SERVICE_ORDER.length) issues.push('service_identity_coverage_incomplete');
  if (profiles.length !== 1 || profiles[0] !== expectedProfile) issues.push('service_profiles_inconsistent');
  if (versions.length !== 1) issues.push('service_versions_inconsistent');
  if (revisions.length !== 1) issues.push('service_revisions_inconsistent');
  return Object.freeze({
    status: issues.length === 0 ? 'consistent' : 'inconsistent',
    serviceCount: identities.length,
    profile: profiles.length === 1 ? profiles[0] : null,
    version: versions.length === 1 ? versions[0] : null,
    revision: revisions.length === 1 ? revisions[0] : null,
    reasonCodes: safeReasonCodes(issues),
  });
}

async function collectComponentHealth({ fetchImpl, baseUrls, profile, timeoutMs, nowMs, freshnessMs }) {
  const requests = await Promise.all(SERVICE_ORDER.map((service) => requestBoundedJson(
    fetchImpl,
    `${baseUrls[service]}/health`,
    timeoutMs
  )));
  const services = Object.freeze(SERVICE_ORDER.map((service, index) => projectServiceHealth(
    service,
    requests[index],
    profile,
    nowMs,
    freshnessMs
  )));
  const reasonCodes = safeReasonCodes(services.flatMap((service) => service.reasonCodes));
  return Object.freeze({
    status: reasonCodes.length === 0 ? 'ready' : 'not-ready',
    services,
    reasonCodes,
  });
}

function sourceCategory(value) {
  if (value === 'services' || value === 'alerts') return value;
  if (value === 'service:core' || value === 'service:benchmark' || value === 'service:rag') return value;
  if (typeof value === 'string' && value.startsWith('host:')) return 'host';
  return 'unclassified';
}

function aggregateCategories(values, classifier, limit, issues, limitCode) {
  if (!Array.isArray(values)) {
    issues.push(`${limitCode}_invalid`);
    return Object.freeze([]);
  }
  if (values.length > limit) issues.push(`${limitCode}_limit_exceeded`);
  const counts = new Map();
  for (const value of values.slice(0, limit)) {
    const id = classifier(value);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  return Object.freeze([...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, count]) => Object.freeze({ id, count })));
}

function contradictionCategory(item) {
  const id = typeof item?.id === 'string' ? item.id : '';
  if (SAFE_CONTRADICTION_IDS.has(id)) return id;
  if (id.startsWith('future-timestamp:')) {
    return `future-timestamp:${sourceCategory(id.slice('future-timestamp:'.length))}`;
  }
  return 'unclassified';
}

function projectEcosystemIdentity(value, profile, issues) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    issues.push('ecosystem_identity_unavailable');
    return null;
  }
  const rawProfiles = Array.isArray(value.profiles) ? value.profiles : [];
  const rawVersions = Array.isArray(value.versions) ? value.versions : [];
  const rawRevisions = Array.isArray(value.revisions) ? value.revisions : [];
  const profiles = Array.isArray(value.profiles)
    ? [...new Set(rawProfiles.filter((item) => PROFILES.has(item)))].sort()
    : [];
  const versions = Array.isArray(value.versions)
    ? [...new Set(rawVersions.filter((item) => VERSION_PATTERN.test(String(item || ''))))].sort()
    : [];
  const revisions = Array.isArray(value.revisions)
    ? [...new Set(rawRevisions.filter((item) => REVISION_PATTERN.test(String(item || '')) && item !== 'unknown'))].sort()
    : [];
  const status = safeEnum(value.status, IDENTITY_STATUS);
  if (status !== 'ok') issues.push('ecosystem_identity_not_consistent');
  if (rawProfiles.length !== 1 || profiles.length !== 1 || profiles[0] !== profile) {
    issues.push('ecosystem_profile_mismatch');
  }
  if (rawVersions.length !== 1 || versions.length !== 1) issues.push('ecosystem_version_unavailable');
  if (rawRevisions.length !== 1 || revisions.length !== 1) issues.push('ecosystem_revision_unavailable');
  return Object.freeze({
    status,
    profile: profiles.length === 1 ? profiles[0] : null,
    version: versions.length === 1 ? versions[0] : null,
    revision: revisions.length === 1 ? revisions[0] : null,
  });
}

function projectTrustChecks(value, issues) {
  if (!Array.isArray(value)) {
    issues.push('ecosystem_checks_invalid');
    return Object.freeze([]);
  }
  if (value.length > MAX_TRUST_CHECKS) issues.push('ecosystem_checks_limit_exceeded');
  const projected = value.slice(0, MAX_TRUST_CHECKS).map((check) => Object.freeze({
    id: CHECK_IDS.has(check?.id) ? check.id : 'unclassified',
    status: safeEnum(check?.status, CHECK_STATUS),
  })).sort((left, right) => left.id.localeCompare(right.id));
  if (projected.some((check) => check.id === 'unclassified' || check.status === 'unknown')) {
    issues.push('ecosystem_checks_invalid');
  }
  for (const id of CHECK_IDS) {
    const matches = projected.filter((check) => check.id === id);
    if (matches.length !== 1) issues.push('ecosystem_checks_incomplete');
    else if (matches[0].status !== 'pass') issues.push('ecosystem_check_failed');
  }
  return Object.freeze(projected);
}

function projectEcosystemSnapshot(snapshot, profile, nowMs, freshnessMs) {
  const issues = [];
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) {
    return Object.freeze({
      availability: 'unavailable',
      reasonCodes: Object.freeze(['ecosystem_payload_invalid']),
    });
  }

  const generated = freshnessProjection(snapshot.generatedAt, nowMs, freshnessMs);
  if (snapshot.schemaVersion !== ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION) issues.push('ecosystem_schema_invalid');
  if (snapshot.authority !== 'agentx-product') issues.push('ecosystem_authority_invalid');
  if (snapshot.readOnly !== true) issues.push('ecosystem_read_only_marker_invalid');
  if (generated.status !== 'current') issues.push(`ecosystem_snapshot_${generated.status}`);

  const trust = snapshot.evidenceTrust;
  if (!trust || typeof trust !== 'object' || Array.isArray(trust)) {
    issues.push('ecosystem_trust_unavailable');
  }
  const trustStatus = safeEnum(trust?.status, TRUST_STATUS);
  const trustOperationalStatus = safeEnum(trust?.operationalStatus, HEALTH_STATUS);
  if (trust?.schemaVersion !== EVIDENCE_TRUST_SCHEMA_VERSION) issues.push('ecosystem_trust_schema_invalid');
  if (trustStatus !== 'verified') issues.push('ecosystem_trust_not_verified');
  if (trustOperationalStatus !== safeEnum(snapshot.health?.status, HEALTH_STATUS)) {
    issues.push('ecosystem_operational_status_mismatch');
  }

  const budget = trust?.contradictionBudget;
  const allowed = safeCount(budget?.allowed);
  const observed = safeCount(budget?.observed);
  const contradictionItems = Array.isArray(budget?.contradictions) ? budget.contradictions : [];
  const contradictions = aggregateCategories(
    budget?.contradictions,
    contradictionCategory,
    MAX_SOURCE_RECORDS,
    issues,
    'ecosystem_contradictions'
  );
  if (allowed !== 0 || observed === null || budget?.withinBudget !== true
      || observed !== contradictionItems.length || observed !== 0) {
    issues.push('ecosystem_contradiction_budget_failed');
  }

  const trustFreshness = trust?.freshness;
  const trustFreshnessStatus = safeEnum(trustFreshness?.status, FRESHNESS_STATUS);
  const current = safeCount(trustFreshness?.current);
  const stale = safeCount(trustFreshness?.stale);
  const unknown = safeCount(trustFreshness?.unknown);
  const budgetMs = safeCount(trustFreshness?.budgetMs, 3_600_000);
  if ([current, stale, unknown, budgetMs].includes(null) || budgetMs === 0) {
    issues.push('ecosystem_freshness_counts_invalid');
  }
  if (trustFreshnessStatus !== 'current' || stale !== 0 || unknown !== 0 || current === 0) {
    issues.push('ecosystem_freshness_not_current');
  }

  const coverage = trust?.coverage;
  const coverageStatus = safeEnum(coverage?.status, COVERAGE_STATUS);
  const expectedSources = safeCount(coverage?.expectedSources);
  const observedSources = safeCount(coverage?.observedSources);
  const missing = aggregateCategories(
    coverage?.missing,
    sourceCategory,
    MAX_SOURCE_RECORDS,
    issues,
    'ecosystem_missing_sources'
  );
  if ([expectedSources, observedSources].includes(null)) issues.push('ecosystem_coverage_counts_invalid');
  if (coverageStatus !== 'complete' || expectedSources === 0 || observedSources !== expectedSources
      || (Array.isArray(coverage?.missing) && coverage.missing.length !== 0)) {
    issues.push('ecosystem_coverage_incomplete');
  }
  if ([current, stale, unknown, expectedSources, observedSources].every((count) => count !== null)
      && (current + stale + unknown !== expectedSources || current + stale !== observedSources)) {
    issues.push('ecosystem_source_counts_inconsistent');
  }

  const identity = projectEcosystemIdentity(snapshot.identityConsistency, profile, issues);
  const serviceHealth = snapshot.serviceHealth;
  const serviceSummary = Object.freeze({
    status: safeEnum(serviceHealth?.status, HEALTH_STATUS),
    total: safeCount(serviceHealth?.total),
    healthy: safeCount(serviceHealth?.healthy),
    degraded: safeCount(serviceHealth?.degraded),
    down: safeCount(serviceHealth?.down),
  });
  if (Object.values(serviceSummary).includes(null) || serviceSummary.status === 'unknown') {
    issues.push('ecosystem_service_health_invalid');
  } else if (serviceSummary.total !== serviceSummary.healthy + serviceSummary.degraded + serviceSummary.down) {
    issues.push('ecosystem_service_health_inconsistent');
  }
  const clusterHealth = Object.freeze({
    status: safeEnum(snapshot.health?.status, HEALTH_STATUS),
    configured: safeCount(snapshot.health?.configuredHosts),
    online: safeCount(snapshot.health?.onlineHosts),
    offline: safeCount(snapshot.health?.offlineHosts),
    observedModels: safeCount(snapshot.health?.observedModels),
  });
  if (Object.values(clusterHealth).includes(null) || clusterHealth.status === 'unknown') {
    issues.push('ecosystem_cluster_health_invalid');
  } else if (clusterHealth.configured !== clusterHealth.online + clusterHealth.offline) {
    issues.push('ecosystem_cluster_health_inconsistent');
  }

  return Object.freeze({
    availability: 'available',
    schemaVersion: snapshot.schemaVersion === ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION
      ? snapshot.schemaVersion
      : null,
    generatedAt: generated.observedAt,
    ageMs: generated.ageMs,
    freshness: generated.status,
    operationalStatus: safeEnum(snapshot.health?.status, HEALTH_STATUS),
    identity,
    componentHealth: Object.freeze({ services: serviceSummary, cluster: clusterHealth }),
    trust: Object.freeze({
      schemaVersion: trust?.schemaVersion === EVIDENCE_TRUST_SCHEMA_VERSION ? trust.schemaVersion : null,
      status: trustStatus,
      operationalStatus: trustOperationalStatus,
      contradictionBudget: Object.freeze({
        allowed,
        observed,
        withinBudget: budget?.withinBudget === true,
        categories: contradictions,
      }),
      freshness: Object.freeze({
        status: trustFreshnessStatus,
        budgetMs,
        current,
        stale,
        unknown,
      }),
      coverage: Object.freeze({
        status: coverageStatus,
        expectedSources,
        observedSources,
        missingCategories: missing,
      }),
      checks: projectTrustChecks(trust?.checks, issues),
    }),
    reasonCodes: safeReasonCodes(issues),
  });
}

async function collectEcosystem({ fetchImpl, coreBaseUrl, profile, timeoutMs, nowMs, freshnessMs }) {
  if (profile === 'demo') {
    return Object.freeze({
      availability: 'not-applicable',
      reason: 'disabled-by-profile',
      reasonCodes: Object.freeze([]),
    });
  }
  const request = await requestBoundedJson(
    fetchImpl,
    `${coreBaseUrl}/api/nerve-center/ecosystem`,
    timeoutMs
  );
  if (request.code) {
    return Object.freeze({
      availability: 'unavailable',
      reasonCodes: Object.freeze([`ecosystem_${request.code}`]),
    });
  }
  if (request.status < 200 || request.status >= 300 || request.body.status !== 'success') {
    return Object.freeze({
      availability: 'unavailable',
      reasonCodes: Object.freeze(['ecosystem_response_unavailable']),
    });
  }
  return projectEcosystemSnapshot(request.body.data, profile, nowMs, freshnessMs);
}

function collectSurfaceRegistry(profile, registry, registryError) {
  const issues = [];
  if (registryError || !registry) {
    return Object.freeze({
      availability: 'unavailable',
      reasonCodes: Object.freeze(['surface_registry_unavailable']),
    });
  }
  try {
    validateRegistry(registry);
  } catch {
    return Object.freeze({
      availability: 'unavailable',
      reasonCodes: Object.freeze(['surface_registry_invalid']),
    });
  }
  if (registry.surfaces.length > MAX_SURFACES) issues.push('surface_registry_limit_exceeded');
  const selected = selectSurfaces(registry, { profile }).slice(0, MAX_SURFACES);
  const invalidId = selected.some((surface) => !SURFACE_ID_PATTERN.test(surface.id));
  if (invalidId) issues.push('surface_identity_invalid');
  const surfaceIds = selected
    .map((surface) => surface.id)
    .filter((id) => SURFACE_ID_PATTERN.test(id))
    .sort();
  const services = SERVICE_ORDER.map((service) => {
    const matches = selected.filter((surface) => surface.service === service);
    return Object.freeze({
      id: service,
      total: matches.length,
      critical: matches.filter((surface) => surface.critical).length,
    });
  });
  return Object.freeze({
    availability: 'available',
    registrySchemaVersion: registry.schemaVersion,
    profile,
    registeredTotal: Math.min(registry.surfaces.length, MAX_SURFACES),
    selectedTotal: selected.length,
    criticalTotal: selected.filter((surface) => surface.critical).length,
    services: Object.freeze(services),
    surfaceIds: Object.freeze(surfaceIds),
    reasonCodes: safeReasonCodes(issues),
  });
}

function crossEvidenceReasons(runtimeIdentity, ecosystem, profile) {
  const issues = [];
  if (runtimeIdentity.status !== 'consistent') issues.push(...runtimeIdentity.reasonCodes);
  if (profile === 'full' && ecosystem.availability === 'available') {
    if (!ecosystem.identity) issues.push('ecosystem_identity_unavailable');
    else {
      if (ecosystem.identity.profile !== runtimeIdentity.profile) issues.push('runtime_ecosystem_profile_mismatch');
      if (ecosystem.identity.version !== runtimeIdentity.version) issues.push('runtime_ecosystem_version_mismatch');
      if (ecosystem.identity.revision !== runtimeIdentity.revision) issues.push('runtime_ecosystem_revision_mismatch');
    }
  }
  return safeReasonCodes(issues);
}

function gate(id, status, reasonCodes) {
  return Object.freeze({ id, status, blocking: status === 'fail', reasonCodes });
}

function assertReceiptSafe(receipt) {
  const visit = (value, key = '') => {
    if (FORBIDDEN_RECEIPT_KEY.test(key)) throw new Error('support receipt contains a forbidden field');
    if (typeof value === 'string') {
      if (value.length > 160 || UNSAFE_RECEIPT_STRING.test(value)) {
        throw new Error('support receipt contains an unsafe string');
      }
      return;
    }
    if (Array.isArray(value)) {
      if (value.length > MAX_SURFACES) throw new Error('support receipt array exceeds its bound');
      value.forEach((item) => visit(item, key));
      return;
    }
    if (value && typeof value === 'object') {
      Object.entries(value).forEach(([childKey, childValue]) => visit(childValue, childKey));
    }
  };
  visit(receipt);
  const bytes = Buffer.byteLength(JSON.stringify(receipt), 'utf8');
  required(bytes <= MAX_RECEIPT_BYTES, 'support receipt exceeds its byte bound');
  return receipt;
}

async function createSupportReceipt(options = {}, dependencies = {}) {
  const profile = String(options.profile || 'demo').trim().toLowerCase();
  required(PROFILES.has(profile), 'profile must be demo or full');
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const freshnessMs = Number(options.freshnessMs || DEFAULT_FRESHNESS_MS);
  required(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 60_000, 'timeout must be between 1 and 60000ms');
  required(Number.isInteger(freshnessMs) && freshnessMs > 0 && freshnessMs <= 3_600_000, 'freshness must be between 1 and 3600000ms');
  const fetchImpl = dependencies.fetchImpl || options.fetchImpl || fetch;
  const now = dependencies.now || options.now || (() => new Date());
  const nowMs = clockMilliseconds(now);
  const baseUrls = Object.fromEntries(SERVICE_ORDER.map((service) => [
    service,
    normalizedBaseUrl((options.baseUrls || DEFAULT_BASE_URLS)[service]),
  ]));

  let registry = options.registry || null;
  let registryError = null;
  if (!registry) {
    try {
      registry = (dependencies.readRegistryImpl || readRegistry)();
    } catch (error) {
      registryError = error;
    }
  }

  const surfaces = collectSurfaceRegistry(profile, registry, registryError);
  const [componentHealth, ecosystem] = await Promise.all([
    collectComponentHealth({ fetchImpl, baseUrls, profile, timeoutMs, nowMs, freshnessMs }),
    collectEcosystem({
      fetchImpl,
      coreBaseUrl: baseUrls.core,
      profile,
      timeoutMs,
      nowMs,
      freshnessMs,
    }),
  ]);
  const identity = summarizeRuntimeIdentity(componentHealth.services, profile);
  const identityReasons = crossEvidenceReasons(identity, ecosystem, profile);
  const gates = Object.freeze([
    gate('component-health', componentHealth.reasonCodes.length === 0 ? 'pass' : 'fail', componentHealth.reasonCodes),
    gate('runtime-identity', identityReasons.length === 0 ? 'pass' : 'fail', identityReasons),
    gate(
      'ecosystem-evidence',
      profile === 'demo' ? 'skip' : (ecosystem.reasonCodes.length === 0 ? 'pass' : 'fail'),
      ecosystem.reasonCodes
    ),
    gate('surface-registry', surfaces.reasonCodes.length === 0 ? 'pass' : 'fail', surfaces.reasonCodes),
  ]);
  const failed = gates.filter((item) => item.status === 'fail').length;
  const receipt = Object.freeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    generatedAt: new Date(nowMs).toISOString(),
    profile,
    status: failed === 0 ? 'pass' : 'fail',
    summary: Object.freeze({
      passed: gates.filter((item) => item.status === 'pass').length,
      skipped: gates.filter((item) => item.status === 'skip').length,
      failed,
    }),
    gates,
    identity,
    componentHealth,
    ecosystem,
    surfaces,
  });
  return assertReceiptSafe(receipt);
}

function writeReceipt(outputPath, receipt) {
  required(typeof outputPath === 'string' && outputPath.trim().length > 0, 'output is required');
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return resolved;
}

function parseArgs(argv) {
  const options = {
    profile: 'demo',
    baseUrls: { ...DEFAULT_BASE_URLS },
    outputPath: '',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    freshnessMs: DEFAULT_FRESHNESS_MS,
  };
  const valueAfter = (arg, index) => {
    const value = argv[index + 1];
    required(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `${arg} requires a value`);
    return value;
  };
  const positiveIntegerAfter = (arg, index) => {
    const value = Number(valueAfter(arg, index));
    required(Number.isInteger(value) && value > 0, `${arg} must be a positive integer`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--profile') options.profile = valueAfter(arg, index++);
    else if (arg === '--core-url') options.baseUrls.core = valueAfter(arg, index++);
    else if (arg === '--benchmark-url') options.baseUrls.benchmark = valueAfter(arg, index++);
    else if (arg === '--rag-url') options.baseUrls.rag = valueAfter(arg, index++);
    else if (arg === '--output') options.outputPath = valueAfter(arg, index++);
    else if (arg === '--timeout-ms') options.timeoutMs = positiveIntegerAfter(arg, index++);
    else if (arg === '--freshness-ms') options.freshnessMs = positiveIntegerAfter(arg, index++);
    else throw new Error('unknown support receipt argument');
  }
  return options;
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  const receipt = await createSupportReceipt(options, dependencies);
  if (options.outputPath) writeReceipt(options.outputPath, receipt);
  else (dependencies.stdout || process.stdout).write(`${JSON.stringify(receipt, null, 2)}\n`);
  if (receipt.status === 'fail') throw new SupportReceiptError(receipt);
  return receipt;
}

if (require.main === module) {
  runCli()
    .then(() => {})
    .catch((error) => {
      const message = error instanceof SupportReceiptError
        ? error.message
        : 'Agent X support receipt could not be created.';
      process.stderr.write(`${message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_FRESHNESS_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_RECEIPT_BYTES,
  MAX_RESPONSE_BYTES,
  RECEIPT_KIND,
  RECEIPT_SCHEMA_VERSION,
  SupportReceiptError,
  assertReceiptSafe,
  collectSurfaceRegistry,
  createSupportReceipt,
  parseArgs,
  projectEcosystemSnapshot,
  runCli,
  writeReceipt,
};
