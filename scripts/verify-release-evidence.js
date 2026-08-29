#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  cancelResponseBody,
  readBoundedJson,
} = require('./bounded-response');

const {
  DEFAULT_BASE_URLS,
  readRegistry,
  selectSurfaces,
  validateRegistry,
  verifyProductSurfaces,
} = require('./verify-product-surfaces');
const {
  SERVICES,
  VERSION_PATTERN,
  verifyReleaseContract,
} = require('./verify-release-contract');

const RECEIPT_KIND = 'agentx.release-evidence';
const RECEIPT_SCHEMA_VERSION = 1;
const ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION = 2;
const EVIDENCE_TRUST_SCHEMA_VERSION = 1;
const REQUEST_TIMEOUT_MS = 5000;
const ECOSYSTEM_REQUEST_TIMEOUT_MS = 8000;
const MAX_RELEASE_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_EVIDENCE_FRESHNESS_MS = 120_000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5_000;
const REVISION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;
const PROFILES = new Set(['demo', 'full']);
const SERVICE_ORDER = Object.freeze(['core', 'benchmark', 'rag']);
const SERVICE_LABELS = Object.freeze({
  core: 'Core',
  benchmark: 'Benchmark',
  rag: 'RAG',
});

class ReleaseEvidenceError extends Error {
  constructor(receipt) {
    const failures = receipt.gates
      .filter((gate) => gate.status === 'fail')
      .map((gate) => `${gate.id}: ${gate.summary}`);
    super(`Agent X release evidence failed:\n- ${failures.join('\n- ')}`);
    this.name = 'ReleaseEvidenceError';
    this.receipt = receipt;
  }
}

function required(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizedBaseUrl(value, label) {
  let url;
  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`${label} URL is invalid`);
  }
  required(['http:', 'https:'].includes(url.protocol), `${label} URL must use HTTP or HTTPS`);
  url.pathname = url.pathname.replace(/\/+$/, '');
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

async function requestJson(fetchImpl, url, label, timeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      headers: { Accept: 'application/json' },
      redirect: 'manual',
      signal,
    });
  } catch (error) {
    throw new Error(`${label} request failed: ${error.message}`);
  }
  if (!response || response.ok !== true) {
    await cancelResponseBody(response);
    required(false, `${label} returned HTTP ${response?.status ?? 'unknown'}`);
  }
  try {
    return await readBoundedJson(response, {
      maxBytes: MAX_RELEASE_RESPONSE_BYTES,
      signal,
    });
  } catch (error) {
    if (error?.code === 'INVALID_JSON') throw new Error(`${label} did not return valid JSON`);
    throw new Error(`${label} response could not be read: ${error.message}`);
  }
}

function createGate(id, status, summary) {
  return Object.freeze({ id, status, blocking: status === 'fail', summary });
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function clockMilliseconds(now, label = 'release evidence clock') {
  const value = now();
  const milliseconds = value instanceof Date ? value.getTime() : new Date(value).getTime();
  required(Number.isFinite(milliseconds), `${label} is invalid`);
  return milliseconds;
}

function normalizeExpectedRevision(value) {
  const revision = String(value || '').trim();
  if (!revision) return '';
  required(REVISION_PATTERN.test(revision), 'expected revision is invalid');
  required(revision !== 'unknown', 'expected revision cannot be unknown');
  return revision;
}

function observationFreshness(value, label, nowMs, freshnessMs) {
  const observedMs = typeof value === 'string' ? Date.parse(value) : NaN;
  if (!Number.isFinite(observedMs)) {
    return { observedAt: null, ageMs: null, status: 'invalid', issue: `${label} timestamp is invalid` };
  }
  const ageMs = nowMs - observedMs;
  if (ageMs < -FUTURE_TIMESTAMP_TOLERANCE_MS) {
    return {
      observedAt: value,
      ageMs,
      status: 'future',
      issue: `${label} timestamp is future-dated beyond the ${FUTURE_TIMESTAMP_TOLERANCE_MS}ms tolerance`,
    };
  }
  if (ageMs > freshnessMs) {
    return {
      observedAt: value,
      ageMs,
      status: 'stale',
      issue: `${label} timestamp is stale (${ageMs}ms old; budget ${freshnessMs}ms)`,
    };
  }
  return { observedAt: value, ageMs: Math.max(0, ageMs), status: 'current', issue: null };
}

function serviceDependencyIssues(service, body) {
  const issues = [];
  if (service === 'core' && body?.details?.mongodb !== 'connected') {
    issues.push('Core is not connected to MongoDB');
  }
  if (service === 'benchmark' && body?.db !== 'connected') {
    issues.push('Benchmark is not connected to MongoDB');
  }
  if (service === 'rag') {
    if (body?.db !== 'connected') issues.push('RAG is not connected to MongoDB');
    if (body?.vectorStore?.healthy !== true) issues.push('RAG vector store is not healthy');
  }
  return issues;
}

function assessHealthBody(service, body, profile, { nowMs, freshnessMs }) {
  const label = SERVICE_LABELS[service];
  const expectedService = SERVICES[service];
  const issues = [];
  const freshness = observationFreshness(body?.ts, `${label} health`, nowMs, freshnessMs);
  if (body?.ok !== true) issues.push(`${label} health ok flag is not true`);
  if (body?.status !== 'ok') issues.push(`${label} health status is not ok`);
  if (body?.service !== expectedService) {
    issues.push(`${label} health identity must be ${expectedService}; received ${JSON.stringify(body?.service)}`);
  }
  if (!VERSION_PATTERN.test(String(body?.version || ''))) {
    issues.push(`${label} health version is not valid semver`);
  }
  if (body?.profile !== profile) {
    issues.push(`${label} health profile must be ${profile}; received ${JSON.stringify(body?.profile)}`);
  }
  if (typeof body?.revision !== 'string' || body.revision.length === 0) {
    issues.push(`${label} health revision is missing`);
  } else if (!REVISION_PATTERN.test(body.revision)) {
    issues.push(`${label} health revision is invalid`);
  }
  if (freshness.issue) issues.push(freshness.issue);
  issues.push(...serviceDependencyIssues(service, body));

  return {
    record: {
      id: service,
      service: typeof body?.service === 'string' ? body.service : null,
      version: typeof body?.version === 'string' ? body.version : null,
      profile: typeof body?.profile === 'string' ? body.profile : null,
      revision: typeof body?.revision === 'string' ? body.revision : null,
      observedAt: freshness.observedAt,
      evidenceAgeMs: freshness.ageMs,
      freshness: freshness.status,
      status: body?.status === 'ok' && body?.ok === true ? 'ok' : 'degraded',
      ...(service === 'core' && {
        capabilities: {
          ollama: {
            required: false,
            status: typeof body?.details?.ollama === 'string' ? body.details.ollama : null,
          },
        },
      }),
    },
    issues,
  };
}

function distinctObserved(records, key) {
  return [...new Set(records.map((record) => record[key]).filter((value) => value !== null))];
}

async function collectRuntimeHealth({
  fetchImpl,
  baseUrls,
  profile,
  expectedVersion,
  expectedRevision,
  timeoutMs,
  now,
  freshnessMs,
}) {
  const settled = await Promise.allSettled(SERVICE_ORDER.map(async (service) => {
    const body = await requestJson(
      fetchImpl,
      `${baseUrls[service]}/health`,
      `${SERVICE_LABELS[service]} health`,
      timeoutMs
    );
    const receivedAtMs = clockMilliseconds(now, `${SERVICE_LABELS[service]} health receipt clock`);
    return assessHealthBody(service, body, profile, { nowMs: receivedAtMs, freshnessMs });
  }));

  const records = [];
  const issues = [];
  for (let index = 0; index < settled.length; index += 1) {
    const service = SERVICE_ORDER[index];
    const result = settled[index];
    if (result.status === 'rejected') {
      issues.push(errorMessage(result.reason));
      records.push({
        id: service,
        service: null,
        version: null,
        profile: null,
        revision: null,
        observedAt: null,
        evidenceAgeMs: null,
        freshness: 'unavailable',
        status: 'unavailable',
        ...(service === 'core' && {
          capabilities: { ollama: { required: false, status: null } },
        }),
      });
      continue;
    }
    records.push(result.value.record);
    issues.push(...result.value.issues);
  }

  const observedRecords = records.filter((record) => record.status !== 'unavailable');
  const profiles = distinctObserved(observedRecords, 'profile');
  const versions = distinctObserved(observedRecords, 'version');
  const revisions = distinctObserved(observedRecords, 'revision');
  if (profiles.length > 1) issues.push(`Runtime health reports mixed profiles: ${profiles.join(', ')}`);
  if (versions.length > 1) issues.push(`Runtime health reports mixed versions: ${versions.join(', ')}`);
  if (revisions.length > 1) issues.push(`Runtime health reports mixed revisions: ${revisions.join(', ')}`);
  if (revisions.length === 0) issues.push('Runtime health reports no build revision');
  if (expectedVersion && versions.length > 0 && (versions.length !== 1 || versions[0] !== expectedVersion)) {
    const observed = versions.length === 1 ? versions[0] : versions.join(', ');
    issues.push(`Runtime version evidence (${observed}) does not match release contract ${expectedVersion}`);
  }

  const unknownRevision = revisions.length === 1 && revisions[0] === 'unknown';
  if (unknownRevision) issues.push('Runtime health build revision is unknown');
  if (expectedRevision && (revisions.length !== 1 || revisions[0] !== expectedRevision)) {
    const observed = revisions.length === 1 ? revisions[0] : revisions.join(', ') || 'none';
    issues.push(`Runtime build revision (${observed}) does not match expected revision ${expectedRevision}`);
  }
  const revisionMatchesExpected = Boolean(
    expectedRevision && revisions.length === 1 && revisions[0] === expectedRevision
  );
  const evidence = Object.freeze({
    services: Object.freeze(records),
    consistency: Object.freeze({
      expectedProfile: profile,
      expectedVersion: expectedVersion || null,
      expectedRevision: expectedRevision || null,
      profiles: Object.freeze(profiles),
      versions: Object.freeze(versions),
      revisions: Object.freeze(revisions),
      buildRevisionConsistent: revisions.length === 1 && !unknownRevision,
      buildRevisionVerified: expectedRevision ? revisionMatchesExpected : false,
    }),
    issues: Object.freeze(issues),
  });

  if (issues.length > 0) {
    return {
      gate: createGate('runtime-health', 'fail', issues.join('; ')),
      evidence,
    };
  }
  return {
    gate: createGate('runtime-health', 'pass', 'Canonical service health and runtime identity are consistent'),
    evidence,
  };
}

async function collectSurfaceEvidence({
  registry,
  registryError,
  profile,
  criticalOnly,
  fetchImpl,
  baseUrls,
  timeoutMs,
  verifyProductSurfacesImpl,
}) {
  let selected = [];
  let selectionKnown = false;
  try {
    if (registryError) throw registryError;
    validateRegistry(registry);
    selected = selectSurfaces(registry, { profile, criticalOnly });
    selectionKnown = true;
    const receipt = await verifyProductSurfacesImpl({
      registry,
      profile,
      criticalOnly,
      fetchImpl,
      baseUrls,
      timeoutMs,
    });
    return {
      gate: createGate('product-surfaces', 'pass', `${receipt.total} ${profile} surface(s) rendered successfully`),
      evidence: Object.freeze({
        profile,
        criticalOnly,
        total: receipt.total,
        passed: Object.freeze(receipt.passed.map((surface) => ({ ...surface }))),
        failures: Object.freeze([]),
      }),
    };
  } catch (error) {
    const failures = Array.isArray(error?.failures)
      ? error.failures.map((failure) => ({ id: failure.id, error: failure.error }))
      : [];
    return {
      gate: createGate('product-surfaces', 'fail', errorMessage(error)),
      evidence: Object.freeze({
        profile,
        criticalOnly,
        total: selectionKnown ? selected.length : null,
        passed: null,
        failures: Object.freeze(failures),
      }),
    };
  }
}

function assessEcosystemSnapshot(snapshot, {
  profile,
  expectedVersion,
  expectedRevision,
  nowMs,
  freshnessMs,
}) {
  const issues = [];
  if (!snapshot || typeof snapshot !== 'object') issues.push('Ecosystem snapshot returned no data');
  if (snapshot?.schemaVersion !== ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION) {
    issues.push(`Ecosystem snapshot schemaVersion must be ${ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION}`);
  }
  if (snapshot?.authority !== 'agentx-product') issues.push('Ecosystem snapshot authority is not agentx-product');
  if (snapshot?.readOnly !== true) issues.push('Ecosystem snapshot is not marked read-only');
  const snapshotFreshness = observationFreshness(
    snapshot?.generatedAt,
    'Ecosystem snapshot',
    nowMs,
    freshnessMs
  );
  if (snapshotFreshness.issue) issues.push(snapshotFreshness.issue);

  const trust = snapshot?.evidenceTrust;
  if (!trust || typeof trust !== 'object') {
    issues.push('Ecosystem evidence-trust assessment is missing');
  } else {
    if (trust.schemaVersion !== EVIDENCE_TRUST_SCHEMA_VERSION) {
      issues.push(`Evidence-trust schemaVersion must be ${EVIDENCE_TRUST_SCHEMA_VERSION}`);
    }
    if (trust.status !== 'verified') {
      issues.push(`Ecosystem evidence-trust status must be verified; received ${JSON.stringify(trust.status)}`);
    }
    const budget = trust.contradictionBudget;
    if (!budget || typeof budget !== 'object') {
      issues.push('Evidence contradiction budget is missing');
    } else {
      const contradictions = Array.isArray(budget.contradictions) ? budget.contradictions : [];
      if (!Array.isArray(budget.contradictions)) {
        issues.push('Evidence contradiction list is missing or invalid');
      }
      if (budget.allowed !== 0) issues.push('Evidence contradiction budget must allow zero contradictions');
      if (budget.observed !== 0 || budget.withinBudget !== true || contradictions.length !== 0) {
        issues.push(`Evidence contradiction budget is exceeded (${Number(budget.observed) || contradictions.length} observed, 0 allowed)`);
      }
    }

    const trustFreshness = trust.freshness;
    if (!trustFreshness || typeof trustFreshness !== 'object') {
      issues.push('Ecosystem evidence freshness assessment is missing');
    } else {
      if (trustFreshness.status !== 'current') {
        issues.push(`Ecosystem evidence freshness status must be current; received ${JSON.stringify(trustFreshness.status)}`);
      }
      for (const field of ['current', 'stale', 'unknown']) {
        if (!Number.isInteger(trustFreshness[field]) || trustFreshness[field] < 0) {
          issues.push(`Ecosystem evidence freshness ${field} count must be a non-negative integer`);
        }
      }
      if (trustFreshness.stale !== 0) {
        issues.push(`Ecosystem evidence has ${JSON.stringify(trustFreshness.stale)} stale source(s)`);
      }
      if (trustFreshness.unknown !== 0) {
        issues.push(`Ecosystem evidence has ${JSON.stringify(trustFreshness.unknown)} unknown source(s)`);
      }
      if (trustFreshness.current === 0) {
        issues.push('Ecosystem evidence has no current sources');
      }
    }
  }

  const identity = snapshot?.identityConsistency;
  const profiles = Array.isArray(identity?.profiles) ? identity.profiles : [];
  const versions = Array.isArray(identity?.versions) ? identity.versions : [];
  const revisions = Array.isArray(identity?.revisions) ? identity.revisions : [];
  if (!identity || typeof identity !== 'object') {
    issues.push('Ecosystem identity consistency assessment is missing');
  } else if (identity.status !== 'ok') {
    issues.push(`Ecosystem identity consistency status must be ok; received ${JSON.stringify(identity.status)}`);
  }
  if (profiles.length !== 1 || profiles[0] !== profile) {
    issues.push(`Ecosystem identity profile must be ${profile}; received ${profiles.join(', ') || 'none'}`);
  }
  if (versions.length !== 1 || !VERSION_PATTERN.test(String(versions[0] || ''))) {
    issues.push(`Ecosystem identity must report exactly one valid version; received ${versions.join(', ') || 'none'}`);
  } else if (expectedVersion && versions[0] !== expectedVersion) {
    issues.push(`Ecosystem identity version must be ${expectedVersion}; received ${versions.join(', ') || 'none'}`);
  }
  if (revisions.length !== 1 || !REVISION_PATTERN.test(String(revisions[0] || '')) || revisions[0] === 'unknown') {
    issues.push(`Ecosystem identity must report exactly one known build revision; received ${revisions.join(', ') || 'none'}`);
  } else if (expectedRevision && revisions[0] !== expectedRevision) {
    issues.push(`Ecosystem identity revision must be ${expectedRevision}; received ${revisions[0]}`);
  }

  const evidence = Object.freeze({
    availability: 'available',
    schemaVersion: snapshot?.schemaVersion ?? null,
    generatedAt: snapshotFreshness.observedAt,
    evidenceAgeMs: snapshotFreshness.ageMs,
    freshness: snapshotFreshness.status,
    authority: snapshot?.authority || null,
    operationalStatus: snapshot?.health?.status || trust?.operationalStatus || 'unknown',
    identityConsistency: identity && typeof identity === 'object' ? {
      status: identity.status || 'unknown',
      profiles: Object.freeze([...profiles]),
      versions: Object.freeze([...versions]),
      revisions: Object.freeze([...revisions]),
    } : null,
    evidenceTrust: trust && typeof trust === 'object' ? {
      schemaVersion: trust.schemaVersion ?? null,
      status: trust.status || 'unknown',
      contradictionBudget: trust.contradictionBudget && typeof trust.contradictionBudget === 'object' ? {
        allowed: trust.contradictionBudget.allowed ?? null,
        observed: trust.contradictionBudget.observed ?? null,
        withinBudget: trust.contradictionBudget.withinBudget === true,
        contradictions: Object.freeze(
          Array.isArray(trust.contradictionBudget.contradictions)
            ? trust.contradictionBudget.contradictions.map((item) => ({ ...item }))
            : []
        ),
      } : null,
      freshness: trust.freshness && typeof trust.freshness === 'object' ? {
        status: trust.freshness.status || 'unknown',
        current: Number.isFinite(Number(trust.freshness.current)) ? Number(trust.freshness.current) : null,
        stale: Number.isFinite(Number(trust.freshness.stale)) ? Number(trust.freshness.stale) : null,
        unknown: Number.isFinite(Number(trust.freshness.unknown)) ? Number(trust.freshness.unknown) : null,
      } : null,
    } : null,
    issues: Object.freeze(issues),
  });

  if (issues.length > 0) {
    return { gate: createGate('ecosystem-evidence', 'fail', issues.join('; ')), evidence };
  }
  return {
    gate: createGate('ecosystem-evidence', 'pass', 'Ecosystem evidence is trusted and within the zero-contradiction budget'),
    evidence,
  };
}

async function collectEcosystemEvidence({
  fetchImpl,
  coreBaseUrl,
  profile,
  expectedVersion,
  expectedRevision,
  timeoutMs,
  now,
  freshnessMs,
}) {
  if (profile === 'demo') {
    return {
      gate: createGate(
        'ecosystem-evidence',
        'skip',
        'The operator ecosystem snapshot is outside the supported demo profile'
      ),
      evidence: Object.freeze({
        availability: 'not-applicable',
        reason: 'disabled-by-demo-profile',
      }),
    };
  }

  try {
    const envelope = await requestJson(
      fetchImpl,
      `${coreBaseUrl}/api/nerve-center/ecosystem`,
      'Ecosystem snapshot',
      timeoutMs
    );
    required(envelope?.status === 'success', 'Ecosystem snapshot response status is not success');
    const receivedAtMs = clockMilliseconds(now, 'Ecosystem snapshot receipt clock');
    return assessEcosystemSnapshot(envelope.data, {
      profile,
      expectedVersion,
      expectedRevision,
      nowMs: receivedAtMs,
      freshnessMs,
    });
  } catch (error) {
    return {
      gate: createGate('ecosystem-evidence', 'fail', errorMessage(error)),
      evidence: Object.freeze({
        availability: 'unavailable',
        reason: errorMessage(error),
      }),
    };
  }
}

function collectReleaseContract({ root, tag, verifyReleaseContractImpl }) {
  try {
    const evidence = verifyReleaseContractImpl({ root, tag });
    return {
      gate: createGate('release-contract', 'pass', `Release contract is consistent at ${evidence.version}`),
      evidence,
    };
  } catch (error) {
    return {
      gate: createGate('release-contract', 'fail', errorMessage(error)),
      evidence: null,
    };
  }
}

function receiptSummary(gates) {
  const count = (status) => gates.filter((gate) => gate.status === status).length;
  return Object.freeze({
    passed: count('pass'),
    warned: count('warn'),
    skipped: count('skip'),
    failed: count('fail'),
  });
}

async function verifyReleaseEvidence(options = {}, dependencies = {}) {
  const profile = String(options.profile || 'demo').trim().toLowerCase();
  required(PROFILES.has(profile), `profile must be demo or full; received ${JSON.stringify(options.profile)}`);
  const timeoutMs = Number.isFinite(Number(options.timeoutMs)) && Number(options.timeoutMs) > 0
    ? Math.floor(Number(options.timeoutMs))
    : REQUEST_TIMEOUT_MS;
  const ecosystemTimeoutMs = Number.isFinite(Number(options.ecosystemTimeoutMs))
    && Number(options.ecosystemTimeoutMs) > 0
    ? Math.floor(Number(options.ecosystemTimeoutMs))
    : ECOSYSTEM_REQUEST_TIMEOUT_MS;
  const freshnessMs = Number.isFinite(Number(options.freshnessMs)) && Number(options.freshnessMs) > 0
    ? Math.floor(Number(options.freshnessMs))
    : DEFAULT_EVIDENCE_FRESHNESS_MS;
  const configuredNow = dependencies.now ?? options.now;
  const now = typeof configuredNow === 'function'
    ? configuredNow
    : (configuredNow === undefined ? () => new Date() : () => configuredNow);
  clockMilliseconds(now);
  const expectedRevision = normalizeExpectedRevision(options.expectedRevision);
  const root = path.resolve(options.root || path.resolve(__dirname, '..'));
  const fetchImpl = dependencies.fetchImpl || options.fetchImpl || fetch;
  const verifyReleaseContractImpl = dependencies.verifyReleaseContractImpl || verifyReleaseContract;
  const verifyProductSurfacesImpl = dependencies.verifyProductSurfacesImpl || verifyProductSurfaces;
  let registry = options.registry || null;
  let registryError = null;
  if (!registry) {
    try {
      registry = (dependencies.readRegistryImpl || readRegistry)();
    } catch (error) {
      registryError = error;
    }
  }
  const baseUrls = Object.fromEntries(SERVICE_ORDER.map((service) => [
    service,
    normalizedBaseUrl((options.baseUrls || DEFAULT_BASE_URLS)[service], SERVICE_LABELS[service]),
  ]));

  const releaseResult = collectReleaseContract({
    root,
    tag: options.tag || '',
    verifyReleaseContractImpl,
  });
  const expectedVersion = releaseResult.evidence?.version || null;
  const [runtimeResult, surfaceResult] = await Promise.all([
    collectRuntimeHealth({
      fetchImpl,
      baseUrls,
      profile,
      expectedVersion,
      expectedRevision,
      timeoutMs,
      now,
      freshnessMs,
    }),
    collectSurfaceEvidence({
      registry,
      registryError,
      profile,
      criticalOnly: options.criticalOnly === true,
      fetchImpl,
      baseUrls,
      timeoutMs,
      verifyProductSurfacesImpl,
    }),
  ]);
  const runtimeRevisions = runtimeResult.evidence.consistency.revisions;
  const runtimeRevision = runtimeRevisions.length === 1 && runtimeRevisions[0] !== 'unknown'
    ? runtimeRevisions[0]
    : '';
  const ecosystemResult = await collectEcosystemEvidence({
    fetchImpl,
    coreBaseUrl: baseUrls.core,
    profile,
    expectedVersion,
    expectedRevision: expectedRevision || runtimeRevision,
    timeoutMs: ecosystemTimeoutMs,
    now,
    freshnessMs,
  });

  const coreHealth = runtimeResult.evidence.services.find((service) => service.id === 'core');
  const ollamaStatus = coreHealth?.capabilities?.ollama?.status ?? null;
  const ollamaGate = createGate(
    'optional-ollama',
    'skip',
    'Ollama is optional and its availability is not a release prerequisite'
  );
  const gates = Object.freeze([
    releaseResult.gate,
    runtimeResult.gate,
    surfaceResult.gate,
    ecosystemResult.gate,
    ollamaGate,
  ]);
  const summary = receiptSummary(gates);
  const completedAtMs = clockMilliseconds(now, 'release evidence completion clock');
  const receipt = Object.freeze({
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    kind: RECEIPT_KIND,
    generatedAt: new Date(completedAtMs).toISOString(),
    profile,
    status: summary.failed === 0 ? 'pass' : 'fail',
    summary,
    gates,
    evidence: Object.freeze({
      release: releaseResult.evidence,
      runtime: runtimeResult.evidence,
      surfaces: surfaceResult.evidence,
      ecosystem: ecosystemResult.evidence,
      ollama: Object.freeze({
        required: false,
        observedStatus: ollamaStatus,
        outcome: 'non-blocking',
      }),
    }),
  });

  if (receipt.status === 'fail') throw new ReleaseEvidenceError(receipt);
  return receipt;
}

function writeReceipt(outputPath, receipt) {
  const resolved = path.resolve(String(outputPath || ''));
  required(String(outputPath || '').trim().length > 0, 'output path is required');
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  fs.writeFileSync(resolved, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return resolved;
}

function parseArgs(argv) {
  const options = {
    root: path.resolve(__dirname, '..'),
    tag: process.env.AGENTX_RELEASE_TAG || '',
    expectedRevision: process.env.AGENTX_EXPECTED_REVISION || '',
    profile: 'demo',
    criticalOnly: false,
    baseUrls: { ...DEFAULT_BASE_URLS },
    outputPath: '',
    timeoutMs: REQUEST_TIMEOUT_MS,
    ecosystemTimeoutMs: ECOSYSTEM_REQUEST_TIMEOUT_MS,
    freshnessMs: DEFAULT_EVIDENCE_FRESHNESS_MS,
  };
  const valueAfter = (arg, index) => {
    const value = argv[index + 1];
    required(typeof value === 'string' && value.length > 0 && !value.startsWith('--'), `${arg} requires a value`);
    return value;
  };
  const positiveIntegerAfter = (arg, index) => {
    const raw = valueAfter(arg, index);
    const value = Number(raw);
    required(Number.isInteger(value) && value > 0, `${arg} must be a positive integer`);
    return value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--root') options.root = path.resolve(valueAfter(arg, index++));
    else if (arg === '--tag') options.tag = valueAfter(arg, index++);
    else if (arg === '--expected-revision') options.expectedRevision = valueAfter(arg, index++);
    else if (arg === '--profile') options.profile = valueAfter(arg, index++);
    else if (arg === '--critical-only') options.criticalOnly = true;
    else if (arg === '--core-url') options.baseUrls.core = valueAfter(arg, index++);
    else if (arg === '--benchmark-url') options.baseUrls.benchmark = valueAfter(arg, index++);
    else if (arg === '--rag-url') options.baseUrls.rag = valueAfter(arg, index++);
    else if (arg === '--output') options.outputPath = valueAfter(arg, index++);
    else if (arg === '--timeout-ms') options.timeoutMs = positiveIntegerAfter(arg, index++);
    else if (arg === '--ecosystem-timeout-ms') options.ecosystemTimeoutMs = positiveIntegerAfter(arg, index++);
    else if (arg === '--freshness-ms') options.freshnessMs = positiveIntegerAfter(arg, index++);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return options;
}

async function runCli(argv = process.argv.slice(2), dependencies = {}) {
  const options = parseArgs(argv);
  try {
    const receipt = await verifyReleaseEvidence(options, dependencies);
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
        `release evidence ok: profile=${receipt.profile} gates=${receipt.summary.passed} warnings=${receipt.summary.warned} skipped=${receipt.summary.skipped}\n`
      );
    })
    .catch((error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  ECOSYSTEM_SNAPSHOT_SCHEMA_VERSION,
  EVIDENCE_TRUST_SCHEMA_VERSION,
  MAX_RELEASE_RESPONSE_BYTES,
  RECEIPT_KIND,
  RECEIPT_SCHEMA_VERSION,
  ReleaseEvidenceError,
  assessEcosystemSnapshot,
  collectRuntimeHealth,
  parseArgs,
  runCli,
  verifyReleaseEvidence,
  writeReceipt,
};
