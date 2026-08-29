'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readBoundedJson } = require('./bounded-response');

const {
  ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION,
  EVIDENCE_TRUST_SCHEMA_VERSION,
  assessEcosystemSnapshot,
} = require('./verify-release-evidence');

const RECEIPT_KIND = 'agentx.resilience-evidence';
const RECEIPT_SCHEMA_VERSION = 1;
const PROFILE = 'full';
const SCENARIO = 'rag-unavailable';
const PHASES = new Set(['degraded', 'recovery']);
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_DEGRADED_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_FRESHNESS_MS = 120_000;
const REQUEST_SETTLEMENT_TOLERANCE_MS = 1_000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5_000;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const EXECUTION_MODE_PATTERN = /^[a-z][a-z0-9-]{0,63}$/;
const SERVICE_ORDER = Object.freeze(['core', 'benchmark', 'rag']);
const SERVICE_IDENTITIES = Object.freeze({
  core: 'agentx-core',
  benchmark: 'agentx-benchmark',
  rag: 'agentx-rag',
});
const DEFAULT_BASE_URLS = Object.freeze({
  core: 'http://127.0.0.1:3180',
  benchmark: 'http://127.0.0.1:3181',
  rag: 'http://127.0.0.1:3182',
});
const EXPECTED_VERSION = require('../core/package.json').version;

class ResilienceEvidenceError extends Error {
  constructor(receipt) {
    const failures = receipt.gates
      .filter((gate) => gate.status === 'fail')
      .map((gate) => `${gate.id}: ${gate.summary}`);
    super(`Agent X resilience evidence failed:\n- ${failures.join('\n- ')}`);
    this.name = 'ResilienceEvidenceError';
    this.receipt = receipt;
  }
}

class RequestDeadlineError extends Error {
  constructor(timeoutMs) {
    super(`request deadline exceeded after ${timeoutMs}ms`);
    this.name = 'RequestDeadlineError';
    this.code = 'REQUEST_DEADLINE_EXCEEDED';
  }
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizedBaseUrl(value, label) {
  let parsed;
  try {
    parsed = new URL(String(value || ''));
  } catch {
    throw new Error(`${label} base URL is invalid`);
  }
  required(['http:', 'https:'].includes(parsed.protocol), `${label} base URL must use HTTP or HTTPS`);
  required(!parsed.username && !parsed.password, `${label} base URL must not contain credentials`);
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function clockMilliseconds(now, label = 'resilience evidence clock') {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  required(Number.isFinite(milliseconds), `${label} is invalid`);
  return milliseconds;
}

function canonicalTimestamp(now) {
  return new Date(clockMilliseconds(now)).toISOString();
}

function observationIssue(value, label, nowMs, freshnessMs) {
  const observedMs = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(observedMs)) return `${label} timestamp is invalid`;
  const ageMs = nowMs - observedMs;
  if (ageMs < -FUTURE_TIMESTAMP_TOLERANCE_MS) {
    return `${label} timestamp is future-dated beyond the ${FUTURE_TIMESTAMP_TOLERANCE_MS}ms tolerance`;
  }
  if (ageMs > freshnessMs) return `${label} timestamp is stale (${ageMs}ms old; budget ${freshnessMs}ms)`;
  return null;
}

function createGate(id, issues, passSummary) {
  const failures = issues.filter(Boolean);
  return Object.freeze({
    id,
    status: failures.length ? 'fail' : 'pass',
    blocking: failures.length > 0,
    summary: failures.length ? failures.join('; ') : passSummary,
  });
}

function classifyTransportFailure(error) {
  if (error?.code === 'REQUEST_DEADLINE_EXCEEDED'
      || error?.code === 'RESPONSE_ABORTED'
      || error?.name === 'AbortError'
      || error?.name === 'TimeoutError') return 'timeout';
  return 'network-error';
}

async function boundedJsonRequest({
  fetchImpl,
  baseUrl,
  service,
  requestPath,
  timeoutMs,
  monotonicNow,
}) {
  const controller = new AbortController();
  const started = monotonicNow();
  let deadlineId;
  const deadline = new Promise((_, reject) => {
    deadlineId = setTimeout(() => {
      controller.abort();
      reject(new RequestDeadlineError(timeoutMs));
    }, timeoutMs);
  });

  let response;
  let body;
  let outcome = 'http-response';
  let failureClass = null;
  try {
    response = await Promise.race([
      Promise.resolve().then(() => fetchImpl(`${baseUrl}${requestPath}`, {
        headers: { Accept: 'application/json' },
        redirect: 'manual',
        signal: controller.signal,
      })),
      deadline,
    ]);
    try {
      body = await Promise.race([
        readBoundedJson(response, {
          maxBytes: MAX_DEGRADED_RESPONSE_BYTES,
          signal: controller.signal,
        }),
        deadline,
      ]);
    } catch (error) {
      if (classifyTransportFailure(error) === 'timeout') {
        outcome = 'transport-unavailable';
        failureClass = 'timeout';
      } else {
        outcome = 'invalid-response';
        failureClass = error?.code === 'RESPONSE_TOO_LARGE' ? 'response-too-large' : 'invalid-json';
      }
    }
  } catch (error) {
    outcome = 'transport-unavailable';
    failureClass = classifyTransportFailure(error);
  } finally {
    clearTimeout(deadlineId);
  }

  const durationMs = Math.max(0, Math.round(monotonicNow() - started));
  return Object.freeze({
    state: outcome === 'http-response' ? 'response' : outcome,
    body,
    httpStatus: Number.isInteger(response?.status) ? response.status : null,
    timing: Object.freeze({
      service,
      path: requestPath,
      outcome,
      failureClass,
      httpStatus: Number.isInteger(response?.status) ? response.status : null,
      durationMs,
      budgetMs: timeoutMs,
      withinBudget: durationMs <= timeoutMs + REQUEST_SETTLEMENT_TOLERANCE_MS,
    }),
  });
}

function identityIssues(identity, service, expectedRevision, expectedVersion, nowMs, freshnessMs, label) {
  const issues = [];
  if (!isPlainObject(identity)) return [`${label} identity is missing`];
  if (identity.service !== SERVICE_IDENTITIES[service]) {
    issues.push(`${label} service identity must be ${SERVICE_IDENTITIES[service]}`);
  }
  if (identity.version !== expectedVersion) issues.push(`${label} version must be ${expectedVersion}`);
  if (identity.profile !== PROFILE) issues.push(`${label} profile must be ${PROFILE}`);
  if (identity.revision !== expectedRevision) issues.push(`${label} revision must be ${expectedRevision}`);
  issues.push(observationIssue(identity.ts, `${label} identity`, nowMs, freshnessMs));
  return issues.filter(Boolean);
}

function healthAssessment(service, request, options) {
  const label = service === 'core' ? 'Core' : service === 'benchmark' ? 'Benchmark' : 'RAG';
  const issues = [];
  if (request.state !== 'response') {
    issues.push(`${label} health transport is unavailable`);
  } else {
    if (request.httpStatus !== 200) issues.push(`${label} health must return HTTP 200`);
    if (request.body?.ok !== true || request.body?.status !== 'ok') issues.push(`${label} health is not ok`);
    issues.push(...identityIssues(
      request.body,
      service,
      options.expectedRevision,
      options.expectedVersion,
      options.nowMs,
      options.freshnessMs,
      `${label} health`
    ));
    if (service === 'core' && request.body?.details?.mongodb !== 'connected') {
      issues.push('Core is not connected to MongoDB');
    }
    if (service === 'benchmark' && request.body?.db !== 'connected') {
      issues.push('Benchmark is not connected to MongoDB');
    }
    if (service === 'rag') {
      if (request.body?.db !== 'connected') issues.push('RAG is not connected to MongoDB');
      if (request.body?.vectorStore?.healthy !== true) issues.push('RAG vector store is not healthy');
    }
  }
  if (!request.timing.withinBudget) issues.push(`${label} health exceeded its request budget`);

  const body = request.body || {};
  const gate = createGate(`${service}-health`, issues, `${label} health and identity are current`);
  return {
    gate,
    evidence: Object.freeze({
      state: gate.status === 'pass'
        ? 'healthy'
        : (request.state === 'response' ? 'unhealthy-response' : request.state),
      httpStatus: request.httpStatus,
      identity: request.state === 'response' ? Object.freeze({
        service: body.service || null,
        version: body.version || null,
        profile: body.profile || null,
        revision: body.revision || null,
        observedAt: body.ts || null,
      }) : null,
      dependencies: request.state === 'response' ? Object.freeze({
        ...(service === 'core' && { mongodb: body.details?.mongodb || null }),
        ...(service === 'benchmark' && { mongodb: body.db || null }),
        ...(service === 'rag' && {
          mongodb: body.db || null,
          vectorStoreHealthy: body.vectorStore?.healthy === true,
        }),
      }) : null,
    }),
  };
}

function ragUnavailableAssessment(request) {
  const issues = [];
  if (request.state !== 'transport-unavailable') {
    issues.push(`RAG must be transport-unavailable during the ${SCENARIO} degraded phase`);
  }
  if (request.httpStatus !== null) {
    issues.push('RAG transport-unavailable evidence must not contain an HTTP response');
  }
  if (!request.timing.withinBudget) issues.push('RAG transport failure exceeded its request budget');
  return {
    gate: createGate(
      'rag-transport-unavailable',
      issues,
      'RAG is unavailable at the transport boundary within the configured deadline'
    ),
    evidence: Object.freeze({
      state: request.state,
      httpStatus: request.httpStatus,
      failureClass: request.timing.failureClass,
      identity: null,
    }),
  };
}

function sameMembers(value, expected) {
  return Array.isArray(value)
    && value.length === expected.length
    && [...value].sort().every((entry, index) => entry === [...expected].sort()[index]);
}

function exactSummaryIssues(summary, expected, label) {
  if (!isPlainObject(summary)) return [`${label} summary is missing`];
  const issues = [];
  for (const [key, value] of Object.entries(expected)) {
    if (summary[key] !== value) issues.push(`${label} summary ${key} must be ${JSON.stringify(value)}`);
  }
  return issues;
}

function projectServiceSummary(summary) {
  if (!isPlainObject(summary)) return null;
  return Object.freeze({
    status: summary.status || null,
    total: Number.isInteger(summary.total) ? summary.total : null,
    healthy: Number.isInteger(summary.healthy) ? summary.healthy : null,
    degraded: Number.isInteger(summary.degraded) ? summary.degraded : null,
    down: Number.isInteger(summary.down) ? summary.down : null,
    ...(Object.hasOwn(summary, 'identityStatus') && {
      identityStatus: summary.identityStatus || null,
    }),
  });
}

function portalAssessment(request, options) {
  const issues = [];
  const body = request.body;
  if (request.state !== 'response') issues.push('Portal health transport is unavailable');
  else if (request.httpStatus !== 200) issues.push('Portal health must return HTTP 200');
  if (!request.timing.withinBudget) issues.push('Portal health exceeded its request budget');
  if (!isPlainObject(body)) issues.push('Portal health response is missing');

  const services = Array.isArray(body?.services) ? body.services : [];
  if (!sameMembers(services.map((service) => service?.id), SERVICE_ORDER)) {
    issues.push('Portal health must report exactly Core, Benchmark, and RAG');
  }
  const byId = Object.fromEntries(services.map((service) => [service?.id, service]));
  const nowMs = options.nowMs;
  issues.push(observationIssue(
    body?.generatedAt || body?.generated_at,
    'Portal health',
    nowMs,
    options.freshnessMs
  ));

  for (const service of ['core', 'benchmark']) {
    if (byId[service]?.status !== 'ok') issues.push(`Portal must report ${service} as ok`);
    issues.push(...identityIssues(
      byId[service]?.identity,
      service,
      options.expectedRevision,
      options.expectedVersion,
      nowMs,
      options.freshnessMs,
      `Portal ${service}`
    ));
  }

  const consistency = body?.consistency;
  if (options.phase === 'degraded') {
    issues.push(...exactSummaryIssues(body?.summary, {
      status: 'down', total: 3, healthy: 2, degraded: 0, down: 1, identityStatus: 'degraded',
    }, 'Portal'));
    if (byId.rag?.status !== 'down') issues.push('Portal must report RAG as down');
    if (byId.rag?.identity !== null) issues.push('Portal must not invent a RAG identity');
    if (byId.rag?.latency_ms !== null) issues.push('Portal must not invent RAG latency');
    if (!Array.isArray(byId.rag?.issues) || byId.rag.issues.length === 0) {
      issues.push('Portal RAG outage needs an issue reason');
    }
    if (consistency?.status !== 'degraded') issues.push('Portal identity consistency must be degraded');
    if (!sameMembers(consistency?.missing, ['rag'])) issues.push('Portal identity evidence must be missing only RAG');
    if (!Array.isArray(consistency?.issues)
        || !consistency.issues.some((issue) => /Identity unavailable:\s*rag/i.test(String(issue)))) {
      issues.push('Portal consistency must name the missing RAG identity');
    }
  } else {
    issues.push(...exactSummaryIssues(body?.summary, {
      status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0, identityStatus: 'ok',
    }, 'Portal'));
    for (const service of SERVICE_ORDER) {
      if (byId[service]?.status !== 'ok') issues.push(`Recovered Portal must report ${service} as ok`);
      issues.push(...identityIssues(
        byId[service]?.identity,
        service,
        options.expectedRevision,
        options.expectedVersion,
        nowMs,
        options.freshnessMs,
        `Recovered Portal ${service}`
      ));
    }
    if (consistency?.status !== 'ok') issues.push('Recovered Portal identity consistency must be ok');
    if (!sameMembers(consistency?.missing, [])) issues.push('Recovered Portal must have no missing identities');
  }

  if (!sameMembers(consistency?.profiles, [PROFILE])) issues.push('Portal identity profile must be full');
  if (!sameMembers(consistency?.versions, [options.expectedVersion])) {
    issues.push(`Portal identity version must be ${options.expectedVersion}`);
  }
  if (!sameMembers(consistency?.revisions, [options.expectedRevision])) {
    issues.push(`Portal identity revision must be ${options.expectedRevision}`);
  }

  return {
    gate: createGate(
      options.phase === 'degraded' ? 'portal-rag-unavailable' : 'portal-recovered',
      issues,
      options.phase === 'degraded'
        ? 'Portal reports exactly two healthy services and one identity-missing RAG service'
        : 'Portal reports all three services healthy with consistent identities'
    ),
    evidence: Object.freeze({
      generatedAt: body?.generatedAt || body?.generated_at || null,
      summary: projectServiceSummary(body?.summary),
      consistency: isPlainObject(consistency) ? Object.freeze({
        status: consistency.status || null,
        profiles: Object.freeze([...(consistency.profiles || [])]),
        versions: Object.freeze([...(consistency.versions || [])]),
        revisions: Object.freeze([...(consistency.revisions || [])]),
        missing: Object.freeze([...(consistency.missing || [])]),
      }) : null,
      services: Object.freeze(services.map((service) => Object.freeze({
        id: service?.id || null,
        status: service?.status || null,
        identityPresent: isPlainObject(service?.identity),
        observedAt: service?.identity?.ts || null,
        issueCount: Array.isArray(service?.issues) ? service.issues.length : 0,
      }))),
    }),
  };
}

function commonEcosystemIssues(snapshot, options) {
  const issues = [];
  if (!isPlainObject(snapshot)) return ['Ecosystem snapshot data is missing'];
  if (snapshot.schemaVersion !== ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION) {
    issues.push(`Ecosystem schemaVersion must be ${ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (snapshot.authority !== 'agentx-product') issues.push('Ecosystem authority must be agentx-product');
  if (snapshot.readOnly !== true) issues.push('Ecosystem snapshot must be read-only');
  issues.push(observationIssue(
    snapshot.generatedAt,
    'Ecosystem snapshot',
    options.nowMs,
    options.freshnessMs
  ));
  return issues.filter(Boolean);
}

function projectedEcosystemEvidence(snapshot) {
  const trust = snapshot?.evidenceTrust;
  const consistency = snapshot?.identityConsistency;
  return Object.freeze({
    generatedAt: snapshot?.generatedAt || null,
    schemaVersion: snapshot?.schemaVersion ?? null,
    authority: snapshot?.authority || null,
    operationalStatus: snapshot?.health?.status || trust?.operationalStatus || 'unknown',
    serviceHealth: projectServiceSummary(snapshot?.serviceHealth),
    identityConsistency: isPlainObject(consistency) ? Object.freeze({
      status: consistency.status || null,
      profiles: Object.freeze([...(consistency.profiles || [])]),
      versions: Object.freeze([...(consistency.versions || [])]),
      revisions: Object.freeze([...(consistency.revisions || [])]),
      missing: Object.freeze([...(consistency.missing || [])]),
    }) : null,
    evidenceTrust: isPlainObject(trust) ? Object.freeze({
      schemaVersion: trust.schemaVersion ?? null,
      status: trust.status || null,
      operationalStatus: trust.operationalStatus || null,
      contradictionBudget: isPlainObject(trust.contradictionBudget) ? Object.freeze({
        allowed: trust.contradictionBudget.allowed ?? null,
        observed: trust.contradictionBudget.observed ?? null,
        withinBudget: trust.contradictionBudget.withinBudget === true,
      }) : null,
      freshness: isPlainObject(trust.freshness) ? Object.freeze({
        status: trust.freshness.status || null,
        current: trust.freshness.current ?? null,
        stale: trust.freshness.stale ?? null,
        unknown: trust.freshness.unknown ?? null,
      }) : null,
      coverage: isPlainObject(trust.coverage) ? Object.freeze({
        status: trust.coverage.status || null,
        expectedSources: trust.coverage.expectedSources ?? null,
        observedSources: trust.coverage.observedSources ?? null,
        missing: Object.freeze(
          ['service:core', 'service:benchmark', 'service:rag']
            .filter((source) => trust.coverage.missing?.includes(source))
        ),
      }) : null,
    }) : null,
  });
}

function ecosystemAssessment(request, options) {
  const issues = [];
  if (request.state !== 'response') issues.push('Ecosystem snapshot transport is unavailable');
  else if (request.httpStatus !== 200) issues.push('Ecosystem snapshot must return HTTP 200');
  if (!request.timing.withinBudget) issues.push('Ecosystem snapshot exceeded its request budget');
  if (request.body?.status !== 'success') issues.push('Ecosystem snapshot envelope status must be success');
  const snapshot = request.body?.data;
  issues.push(...commonEcosystemIssues(snapshot, options));

  const services = Array.isArray(snapshot?.services) ? snapshot.services : [];
  if (!sameMembers(services.map((service) => service?.id), SERVICE_ORDER)) {
    issues.push('Ecosystem snapshot must report exactly Core, Benchmark, and RAG');
  }
  const byId = Object.fromEntries(services.map((service) => [service?.id, service]));
  const trust = snapshot?.evidenceTrust;
  const consistency = snapshot?.identityConsistency;

  if (options.phase === 'degraded') {
    issues.push(...exactSummaryIssues(snapshot?.serviceHealth, {
      status: 'down', total: 3, healthy: 2, degraded: 0, down: 1,
    }, 'Ecosystem service health'));
    if (byId.core?.status !== 'ok' || byId.benchmark?.status !== 'ok') {
      issues.push('Ecosystem must retain healthy Core and Benchmark service evidence');
    }
    if (byId.rag?.status !== 'down' || byId.rag?.identity !== null) {
      issues.push('Ecosystem must report RAG down without inventing identity evidence');
    }
    if (consistency?.status !== 'degraded') issues.push('Ecosystem identity consistency must be degraded');
    if (!sameMembers(consistency?.missing, ['rag'])) issues.push('Ecosystem identity evidence must be missing only RAG');
    if (!sameMembers(consistency?.profiles, [PROFILE])) issues.push('Ecosystem identity profile must remain full');
    if (!sameMembers(consistency?.versions, [options.expectedVersion])) {
      issues.push(`Ecosystem observed version must remain ${options.expectedVersion}`);
    }
    if (!sameMembers(consistency?.revisions, [options.expectedRevision])) {
      issues.push(`Ecosystem observed revision must remain ${options.expectedRevision}`);
    }
    if (!isPlainObject(trust)) issues.push('Ecosystem evidence trust is missing');
    else {
      if (trust.schemaVersion !== EVIDENCE_TRUST_SCHEMA_VERSION) {
        issues.push(`Ecosystem evidence trust schemaVersion must be ${EVIDENCE_TRUST_SCHEMA_VERSION}`);
      }
      if (trust.status === 'verified') issues.push('Degraded ecosystem evidence must not be verified');
      if (trust.status !== 'inconsistent') {
        issues.push(`Degraded ecosystem trust must be inconsistent; received ${JSON.stringify(trust.status)}`);
      }
      const budget = trust.contradictionBudget;
      if (budget?.allowed !== 0 || budget?.observed !== 0 || budget?.withinBudget !== true
          || !Array.isArray(budget?.contradictions) || budget.contradictions.length !== 0) {
        issues.push('Degraded ecosystem must retain a zero-observed zero-allowed contradiction budget');
      }
      if (trust.freshness?.status !== 'partial' || Number(trust.freshness?.unknown) < 1) {
        issues.push('Degraded ecosystem freshness must be partial with unknown evidence');
      }
      if (trust.coverage?.status !== 'partial'
          || !Array.isArray(trust.coverage?.missing)
          || !trust.coverage.missing.includes('service:rag')) {
        issues.push('Degraded ecosystem coverage must name service:rag as missing');
      }
      if (trust.coverage?.missing?.includes('service:core')
          || trust.coverage?.missing?.includes('service:benchmark')) {
        issues.push('Degraded ecosystem must retain Core and Benchmark evidence coverage');
      }
      const checks = Array.isArray(trust.checks) ? trust.checks : [];
      if (!checks.some((check) => check?.id === 'internal-consistency' && check.status === 'pass')) {
        issues.push('Degraded ecosystem internal-consistency check must pass');
      }
      if (!checks.some((check) => check?.id === 'runtime-identity' && check.status === 'fail')) {
        issues.push('Degraded ecosystem runtime-identity check must fail honestly');
      }
    }
  } else if (isPlainObject(snapshot)) {
    issues.push(...exactSummaryIssues(snapshot.serviceHealth, {
      status: 'ok', total: 3, healthy: 3, degraded: 0, down: 0,
    }, 'Recovered ecosystem service health'));
    for (const service of SERVICE_ORDER) {
      if (byId[service]?.status !== 'ok') issues.push(`Recovered ecosystem must report ${service} as ok`);
      issues.push(...identityIssues(
        byId[service]?.identity,
        service,
        options.expectedRevision,
        options.expectedVersion,
        options.nowMs,
        options.freshnessMs,
        `Recovered ecosystem ${service}`
      ));
    }
    const strict = assessEcosystemSnapshot(snapshot, {
      profile: PROFILE,
      expectedVersion: options.expectedVersion,
      expectedRevision: options.expectedRevision,
      nowMs: options.nowMs,
      freshnessMs: options.freshnessMs,
    });
    if (strict.gate.status !== 'pass') issues.push(...strict.evidence.issues);
  }

  return {
    gate: createGate(
      options.phase === 'degraded' ? 'ecosystem-rag-unavailable' : 'ecosystem-recovered',
      issues,
      options.phase === 'degraded'
        ? 'Ecosystem has zero contradictions and explicitly non-verified trust caused by missing RAG evidence'
        : 'Ecosystem identity, freshness, and zero-contradiction trust are verified again'
    ),
    evidence: projectedEcosystemEvidence(snapshot),
  };
}

function normalizeOptions(options = {}) {
  const phase = String(options.phase || '').trim().toLowerCase();
  required(PHASES.has(phase), 'phase must be degraded or recovery');
  const scenario = String(options.scenario || SCENARIO).trim().toLowerCase();
  required(scenario === SCENARIO, `scenario must be ${SCENARIO}`);
  const expectedRevision = String(options.expectedRevision || process.env.AGENTX_EXPECTED_REVISION || '').trim();
  required(REVISION_PATTERN.test(expectedRevision) && expectedRevision !== 'unknown', 'expected revision is required and must be known');
  const executionMode = String(options.executionMode || 'direct-http').trim().toLowerCase();
  required(EXECUTION_MODE_PATTERN.test(executionMode), 'execution mode must be a bounded lowercase identifier');
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  required(Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 120_000, 'timeoutMs must be between 1 and 120000');
  const freshnessMs = Number(options.freshnessMs || DEFAULT_FRESHNESS_MS);
  required(Number.isInteger(freshnessMs) && freshnessMs > 0 && freshnessMs <= 3_600_000,
    'freshnessMs must be between 1 and 3600000');
  const expectedVersion = String(options.expectedVersion || EXPECTED_VERSION);
  const scenarioRunId = String(options.scenarioRunId || `${scenario}:${expectedRevision}`).trim();
  required(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,191}$/.test(scenarioRunId), 'scenario run id is invalid');
  const baseUrls = Object.fromEntries(SERVICE_ORDER.map((service) => [
    service,
    normalizedBaseUrl(options.baseUrls?.[service] || DEFAULT_BASE_URLS[service], service),
  ]));
  return Object.freeze({
    phase,
    scenario,
    expectedRevision,
    expectedVersion,
    executionMode,
    scenarioRunId,
    timeoutMs,
    freshnessMs,
    baseUrls: Object.freeze(baseUrls),
  });
}

async function verifyDegradedRelease(options = {}, dependencies = {}) {
  const config = normalizeOptions(options);
  const fetchImpl = dependencies.fetchImpl || fetch;
  const now = dependencies.now || (() => new Date());
  const monotonicNow = dependencies.monotonicNow || (() => Number(process.hrtime.bigint()) / 1e6);
  const startedAt = canonicalTimestamp(now);
  const startedMonotonic = monotonicNow();
  const request = (service, requestPath) => boundedJsonRequest({
    fetchImpl,
    baseUrl: config.baseUrls[service],
    service,
    requestPath,
    timeoutMs: config.timeoutMs,
    monotonicNow,
  });

  const [healthRequests, portalRequest, ecosystemRequest] = await Promise.all([
    Promise.all(SERVICE_ORDER.map((service) => request(service, '/health'))),
    request('core', '/api/portal/health'),
    request('core', '/api/nerve-center/ecosystem'),
  ]);
  const receivedAtMs = clockMilliseconds(now, 'resilience evidence receipt clock');
  const assessmentOptions = {
    phase: config.phase,
    expectedRevision: config.expectedRevision,
    expectedVersion: config.expectedVersion,
    freshnessMs: config.freshnessMs,
    nowMs: receivedAtMs,
  };

  const core = healthAssessment('core', healthRequests[0], assessmentOptions);
  const benchmark = healthAssessment('benchmark', healthRequests[1], assessmentOptions);
  const rag = config.phase === 'degraded'
    ? ragUnavailableAssessment(healthRequests[2])
    : healthAssessment('rag', healthRequests[2], assessmentOptions);
  const portal = portalAssessment(portalRequest, assessmentOptions);
  const ecosystem = ecosystemAssessment(ecosystemRequest, assessmentOptions);
  const generatedAt = canonicalTimestamp(now);
  const elapsedMs = Math.max(0, Math.round(monotonicNow() - startedMonotonic));
  const overallBudgetMs = config.timeoutMs + REQUEST_SETTLEMENT_TOLERANCE_MS;
  const requests = Object.freeze([
    ...healthRequests.map((entry) => entry.timing),
    portalRequest.timing,
    ecosystemRequest.timing,
  ]);
  const timingIssues = [];
  if (requests.some((entry) => entry.withinBudget !== true)) {
    timingIssues.push('At least one resilience probe exceeded its request budget');
  }
  if (elapsedMs > overallBudgetMs) {
    timingIssues.push(`Parallel resilience collection exceeded its ${overallBudgetMs}ms overall budget`);
  }
  const timingGate = createGate(
    'bounded-collection',
    timingIssues,
    'All resilience probes settled within the parallel collection deadline'
  );
  const gates = Object.freeze([
    timingGate,
    core.gate,
    benchmark.gate,
    rag.gate,
    portal.gate,
    ecosystem.gate,
  ]);
  const failed = gates.filter((gate) => gate.status === 'fail').length;
  const receipt = Object.freeze({
    kind: RECEIPT_KIND,
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    generatedAt,
    startedAt,
    status: failed ? 'fail' : 'pass',
    executionMode: config.executionMode,
    profile: PROFILE,
    scenario: config.scenario,
    scenarioRunId: config.scenarioRunId,
    phase: config.phase,
    relatedPhases: Object.freeze(['degraded', 'recovery']),
    expectedRevision: config.expectedRevision,
    expectedVersion: config.expectedVersion,
    collectionMode: 'parallel',
    requestBudgetMs: config.timeoutMs,
    overallBudgetMs,
    elapsedMs,
    summary: Object.freeze({ passed: gates.length - failed, failed, total: gates.length }),
    gates,
    requests,
    evidence: Object.freeze({
      services: Object.freeze({ core: core.evidence, benchmark: benchmark.evidence, rag: rag.evidence }),
      portal: portal.evidence,
      ecosystem: ecosystem.evidence,
    }),
  });

  if (failed) throw new ResilienceEvidenceError(receipt);
  return receipt;
}

function writeReceipt(outputPath, receipt) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return resolved;
}

function parseArgs(argv) {
  const options = {
    scenario: SCENARIO,
    executionMode: 'direct-http',
    baseUrls: { ...DEFAULT_BASE_URLS },
    timeoutMs: DEFAULT_TIMEOUT_MS,
    freshnessMs: DEFAULT_FRESHNESS_MS,
  };
  const valueAfter = (arg, index) => {
    const value = argv[index + 1];
    required(value !== undefined && !String(value).startsWith('--'), `${arg} requires a value`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--phase') options.phase = valueAfter(arg, index++);
    else if (arg === '--scenario') options.scenario = valueAfter(arg, index++);
    else if (arg === '--scenario-run-id') options.scenarioRunId = valueAfter(arg, index++);
    else if (arg === '--execution-mode') options.executionMode = valueAfter(arg, index++);
    else if (arg === '--expected-revision') options.expectedRevision = valueAfter(arg, index++);
    else if (arg === '--core-url') options.baseUrls.core = valueAfter(arg, index++);
    else if (arg === '--benchmark-url') options.baseUrls.benchmark = valueAfter(arg, index++);
    else if (arg === '--rag-url') options.baseUrls.rag = valueAfter(arg, index++);
    else if (arg === '--timeout-ms') options.timeoutMs = Number(valueAfter(arg, index++));
    else if (arg === '--freshness-ms') options.freshnessMs = Number(valueAfter(arg, index++));
    else if (arg === '--output') options.outputPath = valueAfter(arg, index++);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  try {
    const receipt = await verifyDegradedRelease(options, dependencies);
    if (options.outputPath) writeReceipt(options.outputPath, receipt);
    return receipt;
  } catch (error) {
    if (options.outputPath && error?.receipt) writeReceipt(options.outputPath, error.receipt);
    throw error;
  }
}

if (require.main === module) {
  runCli()
    .then((receipt) => {
      process.stdout.write(
        `resilience evidence ok: scenario=${receipt.scenario} phase=${receipt.phase} mode=${receipt.executionMode} gates=${receipt.summary.passed}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  DEFAULT_BASE_URLS,
  DEFAULT_FRESHNESS_MS,
  DEFAULT_TIMEOUT_MS,
  MAX_DEGRADED_RESPONSE_BYTES,
  PROFILE,
  RECEIPT_KIND,
  RECEIPT_SCHEMA_VERSION,
  REQUEST_SETTLEMENT_TOLERANCE_MS,
  ResilienceEvidenceError,
  SCENARIO,
  boundedJsonRequest,
  normalizeOptions,
  parseArgs,
  runCli,
  verifyDegradedRelease,
  writeReceipt,
};
