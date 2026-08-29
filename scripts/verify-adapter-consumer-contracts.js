#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  cancelResponseBody,
  readBoundedJson,
} = require('./bounded-response');

const REGISTRY_PATH = path.resolve(__dirname, '..', 'config', 'adapter-consumer-contracts.json');
const CONTRACT_HEADER = 'x-agentx-consumer-contract';
const MAX_ADAPTER_RESPONSE_BYTES = 4 * 1024 * 1024;
const SEMVER_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const STABLE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const ABSOLUTE_URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/i;
const PRIVATE_REGISTRY_KEYS = new Set(['baseurl', 'hosturl', 'address', 'token', 'secret', 'authorization']);
const VALIDATORS = new Set([
  'service-health',
  'portal-health',
  'ecosystem-snapshot',
  'consumer-capabilities',
  'consumer-routing',
  'source-status',
  'rag-status',
  'bounded-read',
]);

const CAPABILITY_ALLOWLISTS = Object.freeze({
  generic: new Set(['contract', 'generatedAt', 'agentx', 'inference', 'routing', 'authentication', 'limits']),
  nestor: new Set([
    'contract', 'generatedAt', 'warnings', 'agentx', 'router', 'memory', 'events',
    'panelSummary', 'metrics', 'limits', 'externalExperiences',
  ]),
});

const GENERIC_ROUTING_KEYS = new Set([
  'schemaVersion', 'generatedAt', 'readOnly', 'topology', 'tasks', 'warnings',
]);
const GENERIC_ROUTE_KEYS = new Set([
  'taskType', 'model', 'hostKey', 'available', 'host', 'context', 'qualification',
]);
const NESTOR_ROUTING_KEYS = new Set([
  'generatedAt', 'available', 'readOnly', 'topology', 'modelCatalog',
  'modelCatalogMode', 'effectiveRoute', 'routes',
]);
const NESTOR_ROUTE_KEYS = new Set([
  'taskType', 'default', 'override', 'effective', 'provenance', 'model', 'hostKey',
  'readiness', 'lane', 'routingSource', 'reason', 'available',
]);
const NESTOR_READINESS_KEYS = new Set([
  'stage', 'profiledAt', 'profileDepth', 'benchmarkQualified', 'benchmarkedAt',
  'stale', 'hostId', 'scope', 'isReady',
]);

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readRegistry(filePath = REGISTRY_PATH) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function assertAddressFreeRegistry(value, label = 'registry') {
  if (typeof value === 'string') {
    required(!ABSOLUTE_URL_PATTERN.test(value), `${label} must not embed an absolute URL`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertAddressFreeRegistry(entry, `${label}[${index}]`));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    required(!PRIVATE_REGISTRY_KEYS.has(key.toLowerCase()), `${label}.${key} is deployment-owned and cannot be registered`);
    assertAddressFreeRegistry(entry, `${label}.${key}`);
  }
}

function validateRegistry(registry) {
  required(registry?.schemaVersion === 1, 'Adapter contract registry schemaVersion must be 1');
  required(SEMVER_PATTERN.test(String(registry.productVersion || '')), 'Adapter contract registry productVersion must be semver');
  required(Array.isArray(registry.services) && registry.services.length > 0, 'Adapter contract registry services are missing');
  required(Array.isArray(registry.checks) && registry.checks.length > 0, 'Adapter contract registry checks are missing');
  assertAddressFreeRegistry(registry);

  const services = new Map();
  for (const service of registry.services) {
    required(isPlainObject(service), 'Every registry service must be an object');
    required(STABLE_ID_PATTERN.test(String(service.id || '')), 'Every registry service needs a stable kebab-case id');
    required(!services.has(service.id), `Duplicate registry service: ${service.id}`);
    required(/^[a-z][a-z0-9._-]+$/.test(String(service.identity || '')), `Invalid service identity for ${service.id}`);
    required(SEMVER_PATTERN.test(String(service.version || '')), `Invalid service version for ${service.id}`);
    required(typeof service.productOwned === 'boolean', `productOwned is missing for ${service.id}`);
    if (service.productOwned) {
      required(/^agentx-[a-z0-9-]+$/.test(service.identity), `${service.id} needs an Agent X product identity`);
      required(service.version === registry.productVersion, `${service.id} version must match productVersion`);
    } else {
      required(!service.identity.startsWith('agentx-'), `${service.id} must not claim an Agent X product identity`);
    }
    services.set(service.id, service);
  }

  const ids = new Set();
  for (const check of registry.checks) {
    required(isPlainObject(check), 'Every conformance check must be an object');
    required(STABLE_ID_PATTERN.test(String(check.id || '')), 'Every conformance check needs a stable kebab-case id');
    required(!ids.has(check.id), `Duplicate conformance check: ${check.id}`);
    ids.add(check.id);
    required(services.has(check.service), `Unknown service for ${check.id}: ${check.service}`);
    required(['GET', 'POST'].includes(check.method), `Unsupported method for ${check.id}: ${check.method}`);
    required(typeof check.path === 'string'
      && check.path.startsWith('/')
      && !check.path.includes('?')
      && !check.path.includes('#'), `Invalid canonical path for ${check.id}`);
    required(VALIDATORS.has(check.validator), `Unknown validator for ${check.id}: ${check.validator}`);
    required(Array.isArray(check.acceptedStatuses) && check.acceptedStatuses.length > 0,
      `acceptedStatuses are missing for ${check.id}`);
    required(check.acceptedStatuses.every((status) => Number.isInteger(status) && status >= 200 && status <= 599),
      `acceptedStatuses are invalid for ${check.id}`);
    required(Number.isInteger(check.maxAgeMs) && check.maxAgeMs > 0 && check.maxAgeMs <= 3600000,
      `maxAgeMs is invalid for ${check.id}`);
    if (check.query !== undefined) required(isPlainObject(check.query), `query must be an object for ${check.id}`);
    if (check.method === 'POST') required(isPlainObject(check.body), `POST body is missing for ${check.id}`);
    else required(check.body === undefined, `GET check ${check.id} must not have a body`);
    if (check.freshnessPath !== undefined) {
      required(typeof check.freshnessPath === 'string' && check.freshnessPath.length > 0,
        `freshnessPath is invalid for ${check.id}`);
    }

    if (['consumer-capabilities', 'consumer-routing'].includes(check.validator)
      || check.contract !== undefined) {
      required(isPlainObject(check.contract), `contract is missing for ${check.id}`);
      required(['generic', 'nestor'].includes(check.contract.flavor), `contract flavor is invalid for ${check.id}`);
      required(SEMVER_PATTERN.test(String(check.contract.version || '')), `contract version is invalid for ${check.id}`);
    }
    if (check.validator === 'consumer-capabilities') {
      required(typeof check.contract.name === 'string' && check.contract.name.length > 0,
        `contract name is missing for ${check.id}`);
      required(typeof check.contract.basePath === 'string' && check.contract.basePath.startsWith('/'),
        `contract basePath is invalid for ${check.id}`);
    }
    if (check.validator === 'bounded-read') {
      required(isPlainObject(check.read), `read contract is missing for ${check.id}`);
      required(typeof check.read.resultPath === 'string' && check.read.resultPath.length > 0,
        `resultPath is invalid for ${check.id}`);
      required(Number.isInteger(check.read.limit) && check.read.limit > 0 && check.read.limit <= 200,
        `read limit is invalid for ${check.id}`);
      required(Array.isArray(check.read.provenance) && check.read.provenance.length > 0,
        `provenance rules are missing for ${check.id}`);
      if (check.read.sourceGroupsPath !== undefined) {
        required(typeof check.read.sourceGroupsPath === 'string' && check.read.sourceGroupsPath.length > 0,
          `sourceGroupsPath is invalid for ${check.id}`);
        required(Array.isArray(check.read.expectedSources) && check.read.expectedSources.length > 0,
          `expectedSources are missing for ${check.id}`);
      }
      for (const rule of check.read.provenance) {
        required(isPlainObject(rule) && Array.isArray(rule.paths) && rule.paths.length > 0,
          `provenance rule is invalid for ${check.id}`);
        required(rule.paths.every((entry) => typeof entry === 'string' && entry.length > 0),
          `provenance paths are invalid for ${check.id}`);
        required(typeof rule.allowNull === 'boolean', `provenance allowNull is missing for ${check.id}`);
      }
    }
  }
  return registry;
}

function valueAt(value, dottedPath) {
  return String(dottedPath || '').split('.').filter(Boolean)
    .reduce((current, key) => (current == null ? undefined : current[key]), value);
}

function pathExists(value, dottedPath) {
  const keys = String(dottedPath || '').split('.').filter(Boolean);
  let current = value;
  for (const key of keys) {
    if (current == null || !Object.prototype.hasOwnProperty.call(Object(current), key)) return false;
    current = current[key];
  }
  return true;
}

function canonicalIsoTimestamp(value, label) {
  required(typeof value === 'string' && value.length > 0, `${label} is missing`);
  const parsed = Date.parse(value);
  required(Number.isFinite(parsed), `${label} must be an ISO-8601 timestamp`);
  required(new Date(parsed).toISOString() === value, `${label} must use canonical ISO-8601 format`);
  return parsed;
}

function nowMilliseconds(now) {
  const value = typeof now === 'function' ? now() : now;
  const parsed = value instanceof Date ? value.getTime() : new Date(value).getTime();
  required(Number.isFinite(parsed), 'Verifier clock is invalid');
  return parsed;
}

function assertFreshTimestamp(value, label, { now, maxAgeMs, canonical = true, futureSkewMs = 5000 }) {
  const observedMs = canonical ? canonicalIsoTimestamp(value, label) : Date.parse(String(value || ''));
  required(Number.isFinite(observedMs), `${label} is not a valid timestamp`);
  const currentMs = nowMilliseconds(now);
  required(observedMs <= currentMs + futureSkewMs, `${label} is implausibly in the future`);
  required(currentMs - observedMs <= maxAgeMs, `${label} is stale by ${currentMs - observedMs}ms`);
  return new Date(observedMs).toISOString();
}

function responseHeader(response, name) {
  return String(response.headers?.get?.(name) || '');
}

function assertFreshObservation(check, body, response, now, defaultPath) {
  const freshnessPath = check.freshnessPath || defaultPath;
  const bodyValue = freshnessPath ? valueAt(body, freshnessPath) : undefined;
  if (bodyValue !== undefined && bodyValue !== null) {
    return assertFreshTimestamp(bodyValue, `${check.id} ${freshnessPath}`, {
      now,
      maxAgeMs: check.maxAgeMs,
      canonical: true,
    });
  }
  const dateHeader = responseHeader(response, 'date');
  required(dateHeader, `${check.id} has no freshness evidence`);
  return assertFreshTimestamp(dateHeader, `${check.id} Date header`, {
    now,
    maxAgeMs: check.maxAgeMs,
    canonical: false,
  });
}

function assertAllowedKeys(value, allowed, label) {
  required(isPlainObject(value), `${label} must be an object`);
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  required(unexpected.length === 0, `${label} contains unversioned fields: ${unexpected.join(', ')}`);
}

function assertNoAbsoluteLocations(value, label, ignoredKeys = new Set()) {
  if (typeof value === 'string') {
    required(!ABSOLUTE_URL_PATTERN.test(value), `${label} exposes an absolute URL`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoAbsoluteLocations(entry, `${label}[${index}]`, ignoredKeys));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of Object.entries(value)) {
    if (ignoredKeys.has(key)) continue;
    const normalizedKey = key.toLowerCase();
    required(!normalizedKey.endsWith('url') && normalizedKey !== 'address', `${label}.${key} exposes a location field`);
    assertNoAbsoluteLocations(entry, `${label}.${key}`, ignoredKeys);
  }
}

function assertContractHeader(check, response) {
  if (!check.contract) return null;
  const version = responseHeader(response, CONTRACT_HEADER);
  required(version === check.contract.version,
    `${check.id} contract header must be ${check.contract.version}, received ${version || 'none'}`);
  return version;
}

function assertSuccessEnvelope(body, label) {
  required(isPlainObject(body), `${label} response must be an object`);
  required(body.ok === true, `${label} must set ok=true`);
  if (body.status !== undefined) required(body.status === 'success', `${label} status must be success`);
  required(pathExists(body, 'data'), `${label} data is missing`);
  return body.data;
}

function assertErrorEnvelope(body, label, { publicProjection = false } = {}) {
  required(isPlainObject(body), `${label} degraded response must be an object`);
  if (body.ok !== undefined) required(body.ok === false, `${label} degraded response must set ok=false`);
  if (body.status !== undefined) required(body.status === 'error', `${label} degraded status must be error`);
  const message = body.error || body.message;
  required(typeof message === 'string' && message.length > 0, `${label} degraded response needs an error message`);
  if (body.code !== undefined) required(typeof body.code === 'string' && body.code.length > 0,
    `${label} degraded code is invalid`);
  if (publicProjection) assertNoAbsoluteLocations(body, `${label} degraded response`);
}

function assertServiceIdentity(identity, expected, check, now, label) {
  required(isPlainObject(identity), `${label} identity is missing`);
  required(identity.service === expected.identity,
    `${label} service identity must be ${expected.identity}, received ${identity.service || 'none'}`);
  required(identity.version === expected.version,
    `${label} version must be ${expected.version}, received ${identity.version || 'none'}`);
  required(['demo', 'full'].includes(identity.profile), `${label} profile is invalid`);
  required(typeof identity.revision === 'string' && REVISION_PATTERN.test(identity.revision), `${label} revision is invalid`);
  const observedAt = assertFreshTimestamp(identity.ts, `${label} ts`, {
    now,
    maxAgeMs: check.maxAgeMs,
    canonical: true,
  });
  return { service: identity.service, version: identity.version, profile: identity.profile, revision: identity.revision, observedAt };
}

function validateServiceHealth(context) {
  const { check, service, body, response, now } = context;
  required(isPlainObject(body), `${check.id} response must be an object`);
  const identity = assertServiceIdentity(body, service, check, now, check.id);
  required(typeof body.ok === 'boolean', `${check.id} ok must be boolean`);
  required(['ok', 'degraded'].includes(body.status), `${check.id} status must be ok or degraded`);
  const healthy = response.status === 200;
  required(body.ok === healthy, `${check.id} ok contradicts HTTP ${response.status}`);
  required(body.status === (healthy ? 'ok' : 'degraded'), `${check.id} status contradicts HTTP ${response.status}`);
  assertNoAbsoluteLocations(body, check.id);
  return { state: healthy ? 'ok' : 'degraded', observedAt: identity.observedAt, identity };
}

function validatePortalHealth(context) {
  const { registry, check, body, response, now } = context;
  required(response.status === 200, `${check.id} does not expose a stable degraded snapshot`);
  required(isPlainObject(body), `${check.id} response must be an object`);
  const observedAt = assertFreshObservation(check, body, response, now, 'generatedAt');
  required(body.generated_at === body.generatedAt, `${check.id} timestamp aliases disagree`);
  required(isPlainObject(body.summary), `${check.id} summary is missing`);
  required(isPlainObject(body.consistency), `${check.id} consistency evidence is missing`);
  required(Array.isArray(body.services), `${check.id} services must be an array`);
  const expectedIds = check.expectedServiceIds || [];
  required(body.services.length === expectedIds.length, `${check.id} service count does not match the registry`);
  required(body.summary.total === body.services.length, `${check.id} summary.total is inconsistent`);
  for (const key of ['healthy', 'degraded', 'down']) {
    required(Number.isInteger(body.summary[key]) && body.summary[key] >= 0, `${check.id} summary.${key} is invalid`);
  }
  required(body.summary.healthy + body.summary.degraded + body.summary.down === body.summary.total,
    `${check.id} summary counts do not add up`);
  required(['ok', 'degraded', 'down'].includes(body.summary.status), `${check.id} summary status is invalid`);
  required(body.summary.identityStatus === body.consistency.status, `${check.id} identity summary is inconsistent`);

  const byId = new Map(body.services.map((entry) => [entry?.id, entry]));
  required(byId.size === body.services.length, `${check.id} contains duplicate service ids`);
  for (const id of expectedIds) {
    const entry = byId.get(id);
    required(entry, `${check.id} is missing service ${id}`);
    required(['ok', 'degraded', 'down'].includes(entry.status), `${check.id} ${id} status is invalid`);
    required(Array.isArray(entry.issues), `${check.id} ${id} issues must be an array`);
    if (entry.status === 'down') {
      required(entry.identity == null, `${check.id} ${id} cannot attest identity while down`);
      required(entry.issues.length > 0, `${check.id} ${id} down state needs evidence`);
      continue;
    }
    assertServiceIdentity(entry.identity, {
      identity: `agentx-${id}`,
      version: registry.productVersion,
    }, check, now, `${check.id} ${id}`);
    if (entry.status === 'degraded') required(entry.issues.length > 0, `${check.id} ${id} degraded state needs issues`);
  }

  if (body.summary.status === 'ok') {
    required(body.summary.degraded === 0 && body.summary.down === 0, `${check.id} ok summary contradicts service states`);
  } else if (body.summary.status === 'down') {
    required(body.summary.down > 0, `${check.id} down summary has no down service`);
  } else {
    required(body.summary.degraded > 0 || body.consistency.status === 'degraded',
      `${check.id} degraded summary has no degraded evidence`);
  }
  return { state: body.summary.status, observedAt, serviceCount: body.services.length };
}

function validateEcosystemSnapshot(context) {
  const { check, body, response, now } = context;
  if (response.status !== 200) {
    required(body?.status === 'error', `${check.id} degraded status must be error`);
    required(body?.code === 'ECOSYSTEM_SNAPSHOT_UNAVAILABLE', `${check.id} degraded code is unstable`);
    required(typeof body?.message === 'string' && body.message.length > 0, `${check.id} degraded message is missing`);
    const observedAt = assertFreshObservation(check, body, response, now, 'data.generatedAt');
    return { state: 'degraded', observedAt, code: body.code };
  }

  required(body?.status === 'success', `${check.id} response status must be success`);
  const data = body.data;
  required(isPlainObject(data), `${check.id} data is missing`);
  const observedAt = assertFreshObservation(check, body, response, now, 'data.generatedAt');
  required(data.schemaVersion === check.schemaVersion, `${check.id} schema version is incompatible`);
  required(data.authority === 'agentx-product', `${check.id} authority is invalid`);
  required(data.readOnly === true, `${check.id} must be read-only`);
  required(isPlainObject(data.health), `${check.id} health is missing`);
  required(['ok', 'degraded'].includes(data.health.status), `${check.id} health status is invalid`);
  for (const key of ['configuredHosts', 'onlineHosts', 'offlineHosts', 'observedModels']) {
    required(Number.isInteger(data.health[key]) && data.health[key] >= 0, `${check.id} health.${key} is invalid`);
  }
  required(data.health.onlineHosts + data.health.offlineHosts === data.health.configuredHosts,
    `${check.id} host counts are inconsistent`);
  required(isPlainObject(data.serviceHealth), `${check.id} serviceHealth is missing`);
  required(Array.isArray(data.services), `${check.id} services are missing`);
  required(isPlainObject(data.identityConsistency), `${check.id} identity consistency is missing`);
  required(isPlainObject(data.evidence), `${check.id} evidence is missing`);
  required(data.evidence.snapshotObservedAt === data.generatedAt, `${check.id} snapshot evidence timestamp disagrees`);
  assertFreshTimestamp(data.evidence.servicesObservedAt, `${check.id} evidence.servicesObservedAt`, {
    now,
    maxAgeMs: check.maxAgeMs,
    canonical: true,
  });
  if (data.health.status === 'ok') {
    required(data.health.offlineHosts === 0 && data.serviceHealth.status === 'ok',
      `${check.id} ok state contradicts its evidence`);
  } else {
    required(data.health.offlineHosts > 0
      || data.health.configuredHosts === 0
      || data.serviceHealth.status !== 'ok'
      || data.identityConsistency.status === 'degraded',
    `${check.id} degraded state has no supporting evidence`);
  }
  return { state: data.health.status, observedAt, schemaVersion: data.schemaVersion };
}

function validateConsumerCapabilities(context) {
  const { check, body, response, now } = context;
  assertContractHeader(check, response);
  const data = assertSuccessEnvelope(body, check.id);
  const allowlist = CAPABILITY_ALLOWLISTS[check.contract.flavor];
  assertAllowedKeys(data, allowlist, `${check.id} data`);
  assertNoAbsoluteLocations(data, `${check.id} data`);
  const observedAt = assertFreshObservation(check, body, response, now, 'data.generatedAt');
  required(data.contract?.name === check.contract.name, `${check.id} contract name is incompatible`);
  required(data.contract?.version === check.contract.version, `${check.id} contract version is incompatible`);
  required(data.contract?.basePath === check.contract.basePath, `${check.id} contract base path is incompatible`);
  required(typeof data.agentx?.available === 'boolean', `${check.id} Agent X availability is missing`);

  let degraded = data.agentx.available === false;
  if (check.contract.flavor === 'generic') {
    required(data.inference?.routed === true && data.inference?.stateless === true,
      `${check.id} generic inference boundary is invalid`);
    required(data.inference?.persistence === false, `${check.id} generic contract must not persist`);
    required(data.routing?.readOnly === true && data.routing?.topology === 'opaque',
      `${check.id} generic routing boundary is invalid`);
  } else {
    required(Array.isArray(data.warnings), `${check.id} warnings must be an array`);
    required(typeof data.router?.available === 'boolean', `${check.id} router availability is missing`);
    required(Array.isArray(data.memory?.sources) && data.memory.sources.length > 0,
      `${check.id} memory source allowlist is missing`);
    required(Array.isArray(data.memory?.warnings), `${check.id} memory warnings are missing`);
    required(data.panelSummary?.available === false && data.panelSummary?.code === 'ADAPTER_REQUIRED',
      `${check.id} panel boundary is invalid`);
    required(data.externalExperiences?.supported === false
      && data.externalExperiences?.code === 'ADAPTER_REQUIRED',
    `${check.id} external-experience boundary is invalid`);
    degraded = degraded
      || data.router.available === false
      || data.warnings.length > 0
      || data.memory.warnings.length > 0;
  }
  required(isPlainObject(data.limits)
    && Object.values(data.limits).every((value) => Number.isFinite(value) && value > 0),
  `${check.id} limits are invalid`);
  return { state: degraded ? 'degraded' : 'ok', observedAt, contractVersion: data.contract.version };
}

function validateGenericRouting(data, check) {
  assertAllowedKeys(data, GENERIC_ROUTING_KEYS, `${check.id} generic routing`);
  required(data.schemaVersion === 1, `${check.id} generic routing schema is incompatible`);
  required(data.readOnly === true && data.topology === 'opaque', `${check.id} generic routing is not opaque/read-only`);
  required(isPlainObject(data.tasks), `${check.id} generic tasks are missing`);
  required(Array.isArray(data.warnings), `${check.id} generic warnings are invalid`);
  let degraded = data.warnings.length > 0 || Object.keys(data.tasks).length === 0;
  for (const [taskType, route] of Object.entries(data.tasks)) {
    assertAllowedKeys(route, GENERIC_ROUTE_KEYS, `${check.id} task ${taskType}`);
    required(route.taskType === taskType, `${check.id} task identity mismatch for ${taskType}`);
    required(typeof route.available === 'boolean', `${check.id} ${taskType} availability is missing`);
    required(isPlainObject(route.host), `${check.id} ${taskType} host evidence is missing`);
    required(route.host.key === route.hostKey, `${check.id} ${taskType} host evidence disagrees`);
    required(isPlainObject(route.context) && pathExists(route.context, 'source'),
      `${check.id} ${taskType} context provenance is missing`);
    required(isPlainObject(route.qualification) && pathExists(route.qualification, 'state'),
      `${check.id} ${taskType} qualification provenance is missing`);
    if (route.available) {
      required(typeof route.model === 'string' && route.model.length > 0, `${check.id} ${taskType} model is missing`);
      required(typeof route.hostKey === 'string' && route.hostKey.length > 0, `${check.id} ${taskType} host key is missing`);
      required(typeof route.context.source === 'string' && route.context.source.length > 0,
        `${check.id} ${taskType} context source is missing`);
      required(typeof route.qualification.state === 'string' && route.qualification.state.length > 0,
        `${check.id} ${taskType} qualification state is missing`);
    } else degraded = true;
  }
  return degraded;
}

function validateNestorRouting(data, check) {
  assertAllowedKeys(data, NESTOR_ROUTING_KEYS, `${check.id} Nestor routing`);
  required(data.readOnly === true && data.topology === 'opaque', `${check.id} Nestor routing is not opaque/read-only`);
  required(isPlainObject(data.routes), `${check.id} Nestor routes are missing`);
  const expected = { chat: 'buddy_chat', react: 'buddy_reaction', analyze: 'analysis' };
  required(Object.keys(data.routes).length === Object.keys(expected).length,
    `${check.id} Nestor operation allowlist changed without a contract version`);
  let availableCount = 0;
  for (const [operation, taskType] of Object.entries(expected)) {
    const route = data.routes[operation];
    assertAllowedKeys(route, NESTOR_ROUTE_KEYS, `${check.id} operation ${operation}`);
    required(route.taskType === taskType, `${check.id} operation ${operation} maps to the wrong task`);
    required(['router-default', 'operator-override'].includes(route.provenance),
      `${check.id} operation ${operation} provenance is invalid`);
    required(typeof route.available === 'boolean', `${check.id} operation ${operation} availability is missing`);
    for (const key of ['default', 'override', 'effective']) {
      if (route[key] !== null) assertAllowedKeys(route[key], new Set(['model', 'host']), `${check.id} ${operation}.${key}`);
    }
    if (route.readiness !== null) assertAllowedKeys(route.readiness, NESTOR_READINESS_KEYS, `${check.id} ${operation}.readiness`);
    if (route.available) {
      availableCount += 1;
      required(typeof route.model === 'string' && route.model.length > 0, `${check.id} ${operation} model is missing`);
      required(typeof route.hostKey === 'string' && route.hostKey.length > 0, `${check.id} ${operation} host key is missing`);
      required(typeof route.routingSource === 'string' && route.routingSource.length > 0,
        `${check.id} ${operation} routing source is missing`);
    } else {
      required(typeof route.reason === 'string' && route.reason.length > 0,
        `${check.id} ${operation} degraded route needs a reason`);
    }
  }
  required(data.available === (availableCount > 0), `${check.id} aggregate availability is inconsistent`);
  return availableCount !== Object.keys(expected).length;
}

function validateConsumerRouting(context) {
  const { check, body, response, now } = context;
  assertContractHeader(check, response);
  if (response.status !== 200) {
    assertErrorEnvelope(body, check.id, { publicProjection: true });
    const observedAt = assertFreshObservation(check, body, response, now, 'data.generatedAt');
    return { state: 'degraded', observedAt, contractVersion: check.contract.version };
  }
  const data = assertSuccessEnvelope(body, check.id);
  assertNoAbsoluteLocations(data, `${check.id} data`);
  const observedAt = assertFreshObservation(check, body, response, now, 'data.generatedAt');
  const degraded = check.contract.flavor === 'generic'
    ? validateGenericRouting(data, check)
    : validateNestorRouting(data, check);
  return { state: degraded ? 'degraded' : 'ok', observedAt, contractVersion: check.contract.version };
}

function validateSourceStatus(context) {
  const { check, body, response, now } = context;
  assertContractHeader(check, response);
  if (response.status !== 200) {
    assertErrorEnvelope(body, check.id, { publicProjection: true });
    const observedAt = assertFreshObservation(check, body, response, now, check.freshnessPath);
    return { state: 'degraded', observedAt };
  }
  const data = assertSuccessEnvelope(body, check.id);
  assertAllowedKeys(data, new Set(['generatedAt', 'readOnly', 'sources', 'available', 'warnings']), `${check.id} data`);
  assertNoAbsoluteLocations(data, `${check.id} data`);
  const observedAt = assertFreshObservation(check, body, response, now, check.freshnessPath);
  required(data.readOnly === true, `${check.id} must be read-only`);
  required(isPlainObject(data.sources), `${check.id} sources are missing`);
  required(Array.isArray(data.available), `${check.id} available source list is missing`);
  required(Array.isArray(data.warnings), `${check.id} warnings are missing`);
  const expectedSources = check.expectedSources || [];
  required(Object.keys(data.sources).length === expectedSources.length, `${check.id} returned an unbounded source set`);
  let degraded = false;
  for (const source of expectedSources) {
    const status = data.sources[source];
    required(isPlainObject(status), `${check.id} source ${source} is missing`);
    required(status.source === source, `${check.id} source provenance disagrees for ${source}`);
    required(typeof status.available === 'boolean', `${check.id} source ${source} availability is missing`);
    required(data.available.includes(source) === status.available, `${check.id} available list disagrees for ${source}`);
    const warning = data.warnings.find((entry) => entry?.source === source);
    if (status.available) required(!warning, `${check.id} available source ${source} has a failure warning`);
    else {
      degraded = true;
      required(warning?.code === 'MEMORY_SOURCE_UNAVAILABLE'
        && typeof warning.message === 'string'
        && warning.message.length > 0, `${check.id} unavailable source ${source} lacks evidence`);
    }
  }
  return { state: degraded ? 'degraded' : 'ok', observedAt, sourceCount: expectedSources.length };
}

function validateRagStatus(context) {
  const { check, body, response, now } = context;
  if (response.status !== 200) {
    assertErrorEnvelope(body, check.id, { publicProjection: true });
    const observedAt = assertFreshObservation(check, body, response, now, check.freshnessPath);
    return { state: 'degraded', observedAt };
  }
  const data = assertSuccessEnvelope(body, check.id);
  assertNoAbsoluteLocations(data, `${check.id} data`);
  const observedAt = assertFreshObservation(check, body, response, now, check.freshnessPath);
  required(typeof data.healthy === 'boolean', `${check.id} healthy is missing`);
  required(isPlainObject(data.dependencies) && Object.keys(data.dependencies).length > 0,
    `${check.id} dependencies are missing`);
  const statuses = Object.values(data.dependencies).map((dependency) => dependency?.healthy);
  required(statuses.every((value) => typeof value === 'boolean'), `${check.id} dependency health must be boolean`);
  required(data.healthy === statuses.every(Boolean), `${check.id} aggregate health contradicts dependencies`);
  return { state: data.healthy ? 'ok' : 'degraded', observedAt, dependencyCount: statuses.length };
}

function meaningfulProvenance(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  return typeof value === 'number' || typeof value === 'boolean' || isPlainObject(value);
}

function validateBoundedRead(context) {
  const { check, body, response, now } = context;
  if (check.contract) assertContractHeader(check, response);
  if (response.status !== 200) {
    assertErrorEnvelope(body, check.id, { publicProjection: Boolean(check.contract) });
    const observedAt = assertFreshObservation(check, body, response, now, check.freshnessPath);
    return { state: 'degraded', observedAt, resultCount: 0 };
  }
  const data = assertSuccessEnvelope(body, check.id);
  if (check.contract?.flavor === 'nestor') required(data.readOnly === true, `${check.id} must be read-only`);
  const observedAt = assertFreshObservation(check, body, response, now, check.freshnessPath);
  const results = valueAt(body, check.read.resultPath);
  required(Array.isArray(results), `${check.id} results are missing at ${check.read.resultPath}`);
  required(results.length <= check.read.limit, `${check.id} returned ${results.length} results above its ${check.read.limit} limit`);
  if (check.read.limitPath) {
    required(valueAt(body, check.read.limitPath) === check.read.limit, `${check.id} limit echo is inconsistent`);
  }
  if (check.read.queryPath) {
    required(valueAt(body, check.read.queryPath) === check.read.queryValue, `${check.id} query echo is inconsistent`);
  }
  if (check.read.countPath) {
    const count = valueAt(body, check.read.countPath);
    required(Number.isInteger(count) && count >= results.length, `${check.id} count is inconsistent`);
    if (check.read.countExact === true) required(count === results.length, `${check.id} exact count is inconsistent`);
  }
  if (check.read.sourceGroupsPath) {
    const groups = valueAt(body, check.read.sourceGroupsPath);
    required(isPlainObject(groups), `${check.id} source groups are missing`);
    required(Object.keys(groups).length === check.read.expectedSources.length,
      `${check.id} returned an unbounded source group set`);
    const groupedResults = [];
    for (const source of check.read.expectedSources) {
      required(Array.isArray(groups[source]), `${check.id} source group ${source} is missing`);
      required(groups[source].length <= check.read.limit,
        `${check.id} source group ${source} exceeds its ${check.read.limit} limit`);
      groupedResults.push(...groups[source]);
    }
    required(JSON.stringify(groupedResults) === JSON.stringify(results),
      `${check.id} flattened results disagree with source groups`);
  }
  results.forEach((result, index) => {
    required(isPlainObject(result), `${check.id} result ${index} must be an object`);
    for (const rule of check.read.provenance) {
      const existing = rule.paths.filter((candidate) => pathExists(result, candidate));
      required(existing.length > 0, `${check.id} result ${index} lacks provenance (${rule.paths.join(' or ')})`);
      if (!rule.allowNull) {
        required(existing.some((candidate) => meaningfulProvenance(valueAt(result, candidate))),
          `${check.id} result ${index} has empty provenance (${rule.paths.join(' or ')})`);
      }
    }
    assertNoAbsoluteLocations(result, `${check.id} result ${index}`, new Set(['text', 'snippet']));
  });
  const warnings = Array.isArray(data?.warnings) ? data.warnings : [];
  warnings.forEach((warning, index) => {
    required(typeof warning?.source === 'string'
      && typeof warning?.code === 'string'
      && typeof warning?.message === 'string', `${check.id} warning ${index} is invalid`);
  });
  return { state: warnings.length ? 'degraded' : 'ok', observedAt, resultCount: results.length };
}

const VALIDATOR_FUNCTIONS = Object.freeze({
  'service-health': validateServiceHealth,
  'portal-health': validatePortalHealth,
  'ecosystem-snapshot': validateEcosystemSnapshot,
  'consumer-capabilities': validateConsumerCapabilities,
  'consumer-routing': validateConsumerRouting,
  'source-status': validateSourceStatus,
  'rag-status': validateRagStatus,
  'bounded-read': validateBoundedRead,
});

function normalizedBaseUrl(value, label) {
  let url;
  try { url = new URL(String(value || '')); } catch { throw new Error(`${label} base URL is required`); }
  required(['http:', 'https:'].includes(url.protocol), `${label} base URL must use HTTP or HTTPS`);
  required(!url.username && !url.password, `${label} base URL must not contain credentials`);
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/+$/, '');
}

function buildRequestUrl(baseUrl, check) {
  const url = new URL(`${baseUrl}${check.path}`);
  for (const [key, value] of Object.entries(check.query || {})) url.searchParams.set(key, String(value));
  return url.toString();
}

async function readJsonResponse(response, check, signal) {
  const contentType = responseHeader(response, 'content-type');
  if (!contentType.toLowerCase().includes('application/json')) {
    await cancelResponseBody(response);
    required(false, `${check.id} returned ${contentType || 'an unknown content type'}, not JSON`);
  }
  try {
    return await readBoundedJson(response, {
      maxBytes: MAX_ADAPTER_RESPONSE_BYTES,
      signal,
    });
  } catch (error) {
    if (error?.code !== 'INVALID_JSON') {
      throw new Error(`${check.id} response could not be read: ${error.message}`);
    }
    throw new Error(`${check.id} returned invalid JSON: ${error.message}`);
  }
}

async function verifyCheck(check, options) {
  const { registry, services, fetchImpl, baseUrls, headersByService, consumerToken, timeoutMs, now } = options;
  const url = buildRequestUrl(baseUrls[check.service], check);
  const signal = AbortSignal.timeout(timeoutMs);
  const request = {
    method: check.method,
    redirect: 'manual',
    headers: {
      Accept: 'application/json',
      ...(headersByService[check.service] || {}),
      ...(consumerToken && check.contract?.flavor === 'generic'
        ? { 'X-AgentX-Consumer-Token': consumerToken }
        : {}),
    },
    signal,
  };
  if (check.body) {
    request.headers['Content-Type'] = 'application/json';
    request.body = JSON.stringify(check.body);
  }

  let response;
  try { response = await fetchImpl(url, request); }
  catch (error) { throw new Error(`${check.id} request failed: ${error.message}`); }
  if (!check.acceptedStatuses.includes(response.status)) {
    await cancelResponseBody(response);
    required(false, `${check.id} returned unexpected HTTP ${response.status}`);
  }
  const body = await readJsonResponse(response, check, signal);
  let evidence;
  try {
    evidence = VALIDATOR_FUNCTIONS[check.validator]({
      registry,
      check,
      service: services.get(check.service),
      body,
      response,
      now,
    });
  } catch (error) {
    throw new Error(`${check.id}: ${error.message}`);
  }
  return Object.freeze({
    id: check.id,
    service: check.service,
    method: check.method,
    path: check.path,
    httpStatus: response.status,
    ...evidence,
  });
}

async function verifyAdapterConsumerContracts({
  registry = readRegistry(),
  fetchImpl = fetch,
  baseUrls = {},
  headersByService = {},
  consumerToken = '',
  timeoutMs = 5000,
  now = () => new Date(),
} = {}) {
  validateRegistry(registry);
  required(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120000, 'timeoutMs must be between 1 and 120000');
  const services = new Map(registry.services.map((service) => [service.id, service]));
  const resolvedBaseUrls = Object.fromEntries(registry.services.map((service) => [
    service.id,
    normalizedBaseUrl(baseUrls[service.id], service.id),
  ]));
  const settled = await Promise.allSettled(registry.checks.map((check) => verifyCheck(check, {
    registry,
    services,
    fetchImpl,
    baseUrls: resolvedBaseUrls,
    headersByService,
    consumerToken,
    timeoutMs,
    now,
  })));
  const passed = settled.filter((entry) => entry.status === 'fulfilled').map((entry) => entry.value);
  const failed = settled
    .map((entry, index) => ({ entry, check: registry.checks[index] }))
    .filter(({ entry }) => entry.status === 'rejected')
    .map(({ entry, check }) => ({ id: check.id, error: entry.reason.message }));
  if (failed.length) {
    const error = new Error(
      `Adapter-consumer conformance failed (${failed.length}/${registry.checks.length}): ${failed.map((item) => item.error).join('; ')}`
    );
    error.failures = failed;
    throw error;
  }
  return Object.freeze({
    total: passed.length,
    ok: passed.filter((entry) => entry.state === 'ok').length,
    degraded: passed.filter((entry) => entry.state !== 'ok').length,
    passed,
  });
}

function parseArgs(argv) {
  const options = { registryPath: REGISTRY_PATH, baseUrls: {}, timeoutMs: 5000, tokenEnv: 'AGENTX_EXTERNAL_CONSUMER_TOKEN' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--registry') options.registryPath = path.resolve(argv[++index] || '');
    else if (arg === '--core-url') options.baseUrls.core = argv[++index] || '';
    else if (arg === '--rag-url') options.baseUrls.rag = argv[++index] || '';
    else if (arg === '--base-url') {
      const assignment = argv[++index] || '';
      const separator = assignment.indexOf('=');
      required(separator > 0, '--base-url must use service=URL');
      options.baseUrls[assignment.slice(0, separator)] = assignment.slice(separator + 1);
    } else if (arg === '--timeout-ms') {
      options.timeoutMs = Number(argv[++index]);
    } else if (arg === '--consumer-token-env') {
      options.tokenEnv = argv[++index] || '';
      required(/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.tokenEnv), '--consumer-token-env must name an environment variable');
    } else if (arg === '--help') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/verify-adapter-consumer-contracts.js --core-url <url> --rag-url <url>',
    '       [--base-url service=url] [--registry path] [--timeout-ms 5000]',
    '       [--consumer-token-env AGENTX_EXTERNAL_CONSUMER_TOKEN]',
    '',
    'Base URLs and credentials are runtime inputs and are never stored in the registry.',
  ].join('\n');
}

if (require.main === module) {
  Promise.resolve().then(async () => {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return;
    }
    const registry = readRegistry(options.registryPath);
    const baseUrls = {
      core: process.env.AGENTX_CORE_URL,
      rag: process.env.AGENTX_RAG_URL,
      ...options.baseUrls,
    };
    const token = options.tokenEnv ? process.env[options.tokenEnv] : '';
    const receipt = await verifyAdapterConsumerContracts({
      registry,
      baseUrls,
      consumerToken: token,
      timeoutMs: options.timeoutMs,
    });
    process.stdout.write(`adapter-consumer contracts ok: checks=${receipt.total} degraded=${receipt.degraded}\n`);
  }).catch((error) => {
    process.stderr.write(`Agent X adapter-consumer verification failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  CAPABILITY_ALLOWLISTS,
  CONTRACT_HEADER,
  MAX_ADAPTER_RESPONSE_BYTES,
  REGISTRY_PATH,
  VALIDATORS,
  assertAddressFreeRegistry,
  assertFreshTimestamp,
  assertNoAbsoluteLocations,
  buildRequestUrl,
  canonicalIsoTimestamp,
  parseArgs,
  readRegistry,
  usage,
  validateRegistry,
  verifyAdapterConsumerContracts,
  verifyCheck,
};
