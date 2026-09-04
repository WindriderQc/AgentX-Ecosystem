'use strict';

const crypto = require('crypto');
const ToolCapabilityQualification = require('../../../models/ToolCapabilityQualification');
const { normalizeModelTag } = require('../../../../shared/modelNames');
const {
  exactModelNamesMatch,
  normalizeHostUrl,
  stableSerialize
} = require('../../../../shared/artifactIdentity');
const {
  FIXTURE_VERSION,
  HARNESS_VERSION,
  SCENARIOS_V1,
  fixtureFingerprint
} = require('./toolCallFixtures');

const QUALIFICATION_SCHEMA_VERSION = 'agentx.tool-capability-qualification.v1';
const TOOL_PROTOCOL_VERSION = 'ollama.chat.native-tools.v1';
const MIN_REPETITIONS = 3;
const MAX_REPETITIONS = 20;
const MAX_SCENARIOS_PER_REPETITION = 64;
const DEFAULT_EVIDENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CANONICAL_SCENARIO_IDS = Object.freeze(
  SCENARIOS_V1.map((scenario) => String(scenario.id)).sort()
);
const FINAL_OUTCOMES = new Set(['supported', 'unsupported', 'inconclusive', 'interrupted']);
const CLASSIFICATIONS = new Set([
  'ok',
  'unsupported_no_tool_call_surface',
  'no_final_answer',
  'hallucinated_call',
  'leaked_tool_xml',
  'contract_violation'
]);

class ToolQualificationError extends Error {
  constructor(message, code = 'TOOL_QUALIFICATION_INVALID') {
    super(message);
    this.name = 'ToolQualificationError';
    this.code = code;
  }
}

function cleanString(value, field) {
  const out = String(value || '').trim();
  if (!out) throw new ToolQualificationError(`${field} is required`, 'TOOL_QUALIFICATION_IDENTITY_REQUIRED');
  return out;
}

function positiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new ToolQualificationError(`${field} must be an integer from ${min} to ${max}`);
  }
  return parsed;
}

function currentEvidenceContract() {
  return {
    schemaVersion: QUALIFICATION_SCHEMA_VERSION,
    protocolVersion: TOOL_PROTOCOL_VERSION,
    harnessVersion: HARNESS_VERSION,
    fixtureVersion: FIXTURE_VERSION,
    fixtureFingerprint: fixtureFingerprint()
  };
}

function normalizeIdentity(input = {}) {
  return {
    modelName: normalizeModelTag(cleanString(input.modelName || input.model, 'modelName')),
    hostUrl: normalizeHostUrl(cleanString(input.hostUrl || input.host, 'hostUrl')),
    hostId: cleanString(input.hostId, 'hostId'),
    artifactDigest: cleanString(input.artifactDigest || input.digest, 'artifactDigest'),
    runtimeFingerprint: cleanString(input.runtimeFingerprint, 'runtimeFingerprint'),
    protocolVersion: cleanString(input.protocolVersion, 'protocolVersion'),
    fixtureVersion: cleanString(input.fixtureVersion, 'fixtureVersion'),
    fixtureFingerprint: cleanString(input.fixtureFingerprint, 'fixtureFingerprint')
  };
}

function identityKey(identity) {
  return crypto.createHash('sha256').update(stableSerialize(normalizeIdentity(identity))).digest('hex');
}

function identityFilter(identity) {
  const normalized = normalizeIdentity(identity);
  return { ...normalized, identityKey: identityKey(normalized) };
}

function identitiesMatch(left, right) {
  if (!left || !right) return false;
  const a = normalizeIdentity(left);
  const b = normalizeIdentity(right);
  return exactModelNamesMatch(a.modelName, b.modelName)
    && a.hostUrl === b.hostUrl
    && a.hostId === b.hostId
    && a.artifactDigest === b.artifactDigest
    && a.runtimeFingerprint === b.runtimeFingerprint
    && a.protocolVersion === b.protocolVersion
    && a.fixtureVersion === b.fixtureVersion
    && a.fixtureFingerprint === b.fixtureFingerprint;
}

function asPlain(value) {
  return value && typeof value.toObject === 'function' ? value.toObject() : value;
}

function sanitizeScenario(row) {
  const scenarioId = cleanString(row?.scenarioId, 'scenarioId');
  if (scenarioId.length > 160) {
    throw new ToolQualificationError(
      'scenarioId must be at most 160 characters',
      'TOOL_QUALIFICATION_REPORT_INVALID'
    );
  }
  const classification = cleanString(row?.classification, 'classification');
  if (!CLASSIFICATIONS.has(classification)) {
    throw new ToolQualificationError(`unsupported scenario classification ${classification}`);
  }
  const pass = row?.pass === true;
  if (pass !== (classification === 'ok')) {
    throw new ToolQualificationError(
      'scenario pass must agree with its classification',
      'TOOL_QUALIFICATION_REPORT_INVALID'
    );
  }
  return { scenarioId, classification, pass };
}

function assertCanonicalScenarioSet(scenarios) {
  const observed = scenarios.map((row) => row.scenarioId).sort();
  const exact = observed.length === CANONICAL_SCENARIO_IDS.length
    && observed.every((scenarioId, index) => scenarioId === CANONICAL_SCENARIO_IDS[index]);
  if (!exact) {
    throw new ToolQualificationError(
      'qualification repetitions must contain every canonical fixture scenario exactly once',
      'TOOL_QUALIFICATION_REPORT_SCOPE_DRIFT'
    );
  }
}

function assertReportArtifactIdentity(report, identity) {
  if (!identity) return;
  const artifact = report?.artifact || {};
  const matches = exactModelNamesMatch(artifact.model, identity.modelName)
    && normalizeHostUrl(artifact.host) === identity.hostUrl
    && String(artifact.hostId || '') === identity.hostId
    && String(artifact.digest || '') === identity.artifactDigest
    && String(artifact.runtimeFingerprint || '') === identity.runtimeFingerprint;
  if (!matches) {
    throw new ToolQualificationError(
      'repetition report artifact does not match the campaign identity',
      'TOOL_QUALIFICATION_REPORT_IDENTITY_MISMATCH'
    );
  }
}

function sanitizeRepetitionReport(report, index, now = new Date(), identity = null) {
  const contract = currentEvidenceContract();
  if (report?.harnessVersion !== contract.harnessVersion
    || report?.fixtureVersion !== contract.fixtureVersion
    || report?.fixtureFingerprint !== contract.fixtureFingerprint) {
    throw new ToolQualificationError(
      'repetition report harness or fixture does not match the active evidence contract',
      'TOOL_QUALIFICATION_REPORT_CONTRACT_DRIFT'
    );
  }
  assertReportArtifactIdentity(report, identity);
  const scenarios = Array.isArray(report?.toolCallOutcomes?.scenarios)
    ? report.toolCallOutcomes.scenarios
    : [];
  if (!scenarios.length || scenarios.length > MAX_SCENARIOS_PER_REPETITION) {
    throw new ToolQualificationError(
      `repetition scenarios must include 1 to ${MAX_SCENARIOS_PER_REPETITION} rows`,
      'TOOL_QUALIFICATION_REPORT_INVALID'
    );
  }
  const sanitized = scenarios.map(sanitizeScenario);
  assertCanonicalScenarioSet(sanitized);
  const graded = sanitized.filter((row) => row.classification !== 'unsupported_no_tool_call_surface').length;
  const passed = sanitized.filter((row) => row.pass).length;
  return {
    index,
    recordedAt: now,
    passed,
    graded,
    ratio: graded ? Number((passed / graded).toFixed(4)) : null,
    scenarios: sanitized
  };
}

function deriveOutcome(repetitions, repetitionsRequested, interrupted = false) {
  if (interrupted) return 'interrupted';
  if (!Array.isArray(repetitions)
    || repetitions.length < MIN_REPETITIONS
    || repetitions.length !== repetitionsRequested) {
    return 'inconclusive';
  }
  const scenarios = repetitions.flatMap((entry) => entry.scenarios || []);
  if (!scenarios.length) return 'inconclusive';
  if (scenarios.every((row) => row.classification === 'unsupported_no_tool_call_surface')) {
    return 'unsupported';
  }
  const allCompletedAndPassing = repetitions.every((entry) =>
    entry.graded > 0 && entry.passed === entry.graded
  );
  return allCompletedAndPassing ? 'supported' : 'inconclusive';
}

function finalizedDigest(row) {
  const payload = JSON.parse(JSON.stringify({
    schemaVersion: row.schemaVersion,
    campaignId: row.campaignId,
    identityKey: row.identityKey,
    modelName: row.modelName,
    hostUrl: row.hostUrl,
    hostId: row.hostId,
    artifactDigest: row.artifactDigest,
    runtimeFingerprint: row.runtimeFingerprint,
    protocolVersion: row.protocolVersion,
    fixtureVersion: row.fixtureVersion,
    fixtureFingerprint: row.fixtureFingerprint,
    contractFingerprint: row.contractFingerprint,
    claim: row.claim,
    outcome: row.outcome,
    repetitionsRequested: row.repetitionsRequested,
    repetitions: row.repetitions,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    validUntil: row.validUntil,
    failureCode: row.failureCode || null
  }));
  return crypto.createHash('sha256').update(stableSerialize(payload)).digest('hex');
}

function assertCampaignIdentity(row, identity) {
  if (!row || !identitiesMatch(row, identity) || row.identityKey !== identityKey(identity)) {
    throw new ToolQualificationError(
      'qualification campaign identity does not match the requested exact artifact',
      'TOOL_QUALIFICATION_IDENTITY_MISMATCH'
    );
  }
}

async function beginQualification(input, deps = {}) {
  const Model = deps.Model || ToolCapabilityQualification;
  const contract = currentEvidenceContract();
  const identity = normalizeIdentity({
    ...input,
    protocolVersion: input.protocolVersion || contract.protocolVersion,
    fixtureVersion: input.fixtureVersion || contract.fixtureVersion,
    fixtureFingerprint: input.fixtureFingerprint || contract.fixtureFingerprint
  });
  if (identity.protocolVersion !== contract.protocolVersion
    || identity.fixtureVersion !== contract.fixtureVersion
    || identity.fixtureFingerprint !== contract.fixtureFingerprint) {
    throw new ToolQualificationError(
      'campaign evidence contract does not match the active harness and fixture',
      'TOOL_QUALIFICATION_CONTRACT_DRIFT'
    );
  }
  const repetitionsRequested = positiveInteger(input.repetitionsRequested, 'repetitionsRequested', {
    min: MIN_REPETITIONS,
    max: MAX_REPETITIONS
  });
  const claimGeneration = cleanString(input.claim?.claimGeneration, 'claim.claimGeneration');
  const batchId = cleanString(input.claim?.batchId, 'claim.batchId');
  if (normalizeHostUrl(input.claim?.hostUrl) !== identity.hostUrl) {
    throw new ToolQualificationError('claim host does not match qualification host', 'TOOL_QUALIFICATION_CLAIM_MISMATCH');
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(claimGeneration)) {
    throw new ToolQualificationError(
      'claim generation must be an exact UUID receipt',
      'TOOL_QUALIFICATION_CLAIM_MISMATCH'
    );
  }
  const contractFingerprint = cleanString(input.contractFingerprint, 'contractFingerprint');
  if (!/^[a-f0-9]{64}$/i.test(contractFingerprint)) {
    throw new ToolQualificationError(
      'contractFingerprint must be a sha256 campaign snapshot fingerprint',
      'TOOL_QUALIFICATION_CONTRACT_DRIFT'
    );
  }
  const startedAt = input.startedAt ? new Date(input.startedAt) : new Date();
  if (!Number.isFinite(startedAt.getTime())) {
    throw new ToolQualificationError('startedAt must be a valid date');
  }
  try {
    const created = await Model.create({
      campaignId: cleanString(input.campaignId, 'campaignId'),
      identityKey: identityKey(identity),
      schemaVersion: contract.schemaVersion,
      ...identity,
      contractFingerprint,
      claim: {
        batchId,
        claimGeneration,
        hostUrl: identity.hostUrl,
        claimedAt: input.claim?.claimedAt || null
      },
      runState: 'running',
      outcome: null,
      repetitionsRequested,
      repetitionsCompleted: 0,
      repetitions: [],
      startedAt
    });
    return asPlain(created);
  } catch (error) {
    if (error?.code === 11000) {
      throw new ToolQualificationError(
        'qualification campaign already exists and cannot be overwritten',
        'TOOL_QUALIFICATION_ALREADY_EXISTS'
      );
    }
    throw error;
  }
}

async function loadCampaign(Model, campaignId) {
  const query = Model.findOne({ campaignId });
  return asPlain(typeof query?.lean === 'function' ? await query.lean() : await query);
}

async function recordRepetition(campaignId, identity, report, deps = {}) {
  const Model = deps.Model || ToolCapabilityQualification;
  const row = await loadCampaign(Model, campaignId);
  if (!row) throw new ToolQualificationError('qualification campaign not found', 'TOOL_QUALIFICATION_NOT_FOUND');
  assertCampaignIdentity(row, identity);
  if (row.runState !== 'running') {
    throw new ToolQualificationError('finalized qualification evidence is immutable', 'TOOL_QUALIFICATION_FINALIZED');
  }
  const index = Number(row.repetitionsCompleted) || 0;
  if (index >= row.repetitionsRequested || index >= MAX_REPETITIONS) {
    throw new ToolQualificationError('qualification repetition bound reached', 'TOOL_QUALIFICATION_REPETITION_BOUND');
  }
  const repetition = sanitizeRepetitionReport(report, index, deps.now || new Date(), normalizeIdentity(identity));
  const filter = {
    campaignId,
    identityKey: row.identityKey,
    runState: 'running',
    repetitionsCompleted: index
  };
  const update = {
    $push: { repetitions: repetition },
    $inc: { repetitionsCompleted: 1 }
  };
  const query = Model.findOneAndUpdate(filter, update, { new: true, runValidators: true });
  const updated = asPlain(typeof query?.lean === 'function' ? await query.lean() : await query);
  if (!updated) {
    throw new ToolQualificationError(
      'qualification repetition append lost its concurrency fence',
      'TOOL_QUALIFICATION_CONCURRENT_WRITE'
    );
  }
  return updated;
}

async function finalizeQualification(campaignId, identity, options = {}, deps = {}) {
  const Model = deps.Model || ToolCapabilityQualification;
  const row = await loadCampaign(Model, campaignId);
  if (!row) throw new ToolQualificationError('qualification campaign not found', 'TOOL_QUALIFICATION_NOT_FOUND');
  assertCampaignIdentity(row, identity);
  if (row.runState !== 'running') {
    throw new ToolQualificationError('finalized qualification evidence is immutable', 'TOOL_QUALIFICATION_FINALIZED');
  }
  const completedAt = options.completedAt ? new Date(options.completedAt) : (deps.now || new Date());
  const outcome = deriveOutcome(row.repetitions || [], row.repetitionsRequested, options.interrupted === true);
  if (!FINAL_OUTCOMES.has(outcome)) throw new ToolQualificationError('invalid final outcome');
  const validUntil = ['supported', 'unsupported'].includes(outcome)
    ? new Date(completedAt.getTime() + (Number(options.ttlMs) || DEFAULT_EVIDENCE_TTL_MS))
    : completedAt;
  const final = {
    ...row,
    runState: 'finalized',
    outcome,
    completedAt,
    validUntil,
    failureCode: options.failureCode ? String(options.failureCode).slice(0, 160) : null
  };
  final.evidenceDigest = finalizedDigest(final);
  const query = Model.findOneAndUpdate(
    {
      campaignId,
      identityKey: row.identityKey,
      runState: 'running',
      repetitionsCompleted: row.repetitionsCompleted
    },
    {
      $set: {
        runState: final.runState,
        outcome: final.outcome,
        completedAt: final.completedAt,
        validUntil: final.validUntil,
        failureCode: final.failureCode,
        evidenceDigest: final.evidenceDigest
      }
    },
    { new: true, runValidators: true }
  );
  const updated = asPlain(typeof query?.lean === 'function' ? await query.lean() : await query);
  if (!updated) {
    throw new ToolQualificationError(
      'qualification finalization lost its concurrency fence',
      'TOOL_QUALIFICATION_CONCURRENT_WRITE'
    );
  }
  return updated;
}

function mismatchReasons(candidate, expected) {
  const reasons = [];
  if (candidate?.schemaVersion !== QUALIFICATION_SCHEMA_VERSION) reasons.push('schema_version_mismatch');
  if (!exactModelNamesMatch(candidate?.modelName, expected.modelName)) reasons.push('model_mismatch');
  if (normalizeHostUrl(candidate?.hostUrl) !== expected.hostUrl) reasons.push('host_url_mismatch');
  if (String(candidate?.hostId || '') !== expected.hostId) reasons.push('host_id_mismatch');
  if (candidate?.artifactDigest !== expected.artifactDigest) reasons.push('artifact_digest_mismatch');
  if (candidate?.runtimeFingerprint !== expected.runtimeFingerprint) reasons.push('runtime_fingerprint_mismatch');
  if (candidate?.protocolVersion !== expected.protocolVersion) reasons.push('protocol_version_mismatch');
  if (candidate?.fixtureVersion !== expected.fixtureVersion) reasons.push('fixture_version_mismatch');
  if (candidate?.fixtureFingerprint !== expected.fixtureFingerprint) reasons.push('fixture_fingerprint_mismatch');
  return reasons;
}

function evidenceProjection(row) {
  if (!row) return null;
  return {
    campaignId: row.campaignId,
    schemaVersion: row.schemaVersion,
    identityKey: row.identityKey,
    modelName: row.modelName,
    hostUrl: row.hostUrl,
    hostId: row.hostId,
    artifactDigest: row.artifactDigest,
    runtimeFingerprint: row.runtimeFingerprint,
    protocolVersion: row.protocolVersion,
    fixtureVersion: row.fixtureVersion,
    fixtureFingerprint: row.fixtureFingerprint,
    outcome: row.outcome,
    repetitionsRequested: row.repetitionsRequested,
    repetitionsCompleted: row.repetitionsCompleted,
    completedAt: row.completedAt || null,
    validUntil: row.validUntil || null,
    evidenceDigest: row.evidenceDigest || null
  };
}

function resolution(state, reasons, row = null) {
  const qualified = ['supported', 'unsupported'].includes(state);
  return {
    contract: QUALIFICATION_SCHEMA_VERSION,
    state,
    supported: state === 'supported' ? true : state === 'unsupported' ? false : null,
    qualified,
    reasons,
    expected: currentEvidenceContract(),
    evidence: row ? evidenceProjection(row) : null
  };
}

async function leanOne(query) {
  return asPlain(typeof query?.lean === 'function' ? await query.lean() : await query);
}

async function resolveQualification(input, deps = {}) {
  const Model = deps.Model || ToolCapabilityQualification;
  const contract = currentEvidenceContract();
  const expected = normalizeIdentity({
    ...input,
    protocolVersion: contract.protocolVersion,
    fixtureVersion: contract.fixtureVersion,
    fixtureFingerprint: contract.fixtureFingerprint
  });
  const exactQuery = Model.findOne({
    ...expected,
    identityKey: identityKey(expected),
    schemaVersion: contract.schemaVersion,
    runState: 'finalized'
  });
  if (typeof exactQuery?.sort === 'function') exactQuery.sort({ completedAt: -1 });
  const exact = await leanOne(exactQuery);
  const now = deps.now || new Date();
  if (exact) {
    if (!/^[a-f0-9]{64}$/i.test(String(exact.evidenceDigest || ''))
      || exact.evidenceDigest !== finalizedDigest(exact)) {
      return resolution('stale', ['evidence_integrity_mismatch'], exact);
    }
    if (exact.outcome !== 'supported' && exact.outcome !== 'unsupported') {
      return resolution('unknown', [`evidence_${exact.outcome || 'incomplete'}`], exact);
    }
    const completedAt = exact.completedAt ? new Date(exact.completedAt) : null;
    const validUntil = exact.validUntil ? new Date(exact.validUntil) : null;
    if (!completedAt
      || !Number.isFinite(completedAt.getTime())
      || !validUntil
      || !Number.isFinite(validUntil.getTime())
      || validUntil.getTime() <= now.getTime()) {
      return resolution('stale', ['evidence_expired'], exact);
    }
    return resolution(exact.outcome, [], exact);
  }

  const latestQuery = Model.findOne({
    modelName: expected.modelName,
    runState: 'finalized'
  });
  if (typeof latestQuery?.sort === 'function') latestQuery.sort({ completedAt: -1 });
  const latest = await leanOne(latestQuery);
  if (!latest) return resolution('unknown', ['evidence_missing']);
  const reasons = mismatchReasons(latest, expected);
  return resolution('stale', reasons.length ? reasons : ['exact_evidence_missing']);
}

module.exports = {
  DEFAULT_EVIDENCE_TTL_MS,
  MAX_REPETITIONS,
  MIN_REPETITIONS,
  QUALIFICATION_SCHEMA_VERSION,
  TOOL_PROTOCOL_VERSION,
  ToolQualificationError,
  beginQualification,
  currentEvidenceContract,
  deriveOutcome,
  evidenceProjection,
  finalizeQualification,
  identitiesMatch,
  identityFilter,
  identityKey,
  mismatchReasons,
  normalizeIdentity,
  recordRepetition,
  resolveQualification,
  sanitizeRepetitionReport
};
