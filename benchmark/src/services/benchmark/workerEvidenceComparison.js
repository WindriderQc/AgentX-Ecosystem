'use strict';

const {
  EXECUTION_PROFILES,
  fingerprint,
  normalizeWorkerReceipt,
  projectWorkerReceiptPublic,
} = require('../../../../shared/workerContract');

const WORKER_EVIDENCE_SCHEMA = 'agentx.worker-evidence-comparison/v1';
const SCHEMA_VERSION = 1;

function comparisonError(code, message) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = 400;
  return error;
}

function requiredProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  if (!EXECUTION_PROFILES.includes(profile)) {
    throw comparisonError('INVALID_COMPARISON_PROFILE', `profile must be one of: ${EXECUTION_PROFILES.join(', ')}`);
  }
  return profile;
}

function isoTimestamp(value) {
  const date = new Date(value || Date.now());
  if (Number.isNaN(date.getTime())) {
    throw comparisonError('INVALID_TIMESTAMP', 'generatedAt must be an ISO-8601 timestamp');
  }
  return date.toISOString();
}

function modelIdentity(receipt) {
  return {
    provider: receipt.identity.provider,
    model: receipt.identity.model,
    api: receipt.identity.api,
  };
}

function harnessIdentity(receipt) {
  return {
    harness: receipt.identity.harness,
    adapter: receipt.identity.adapter,
    environment: receipt.identity.environment,
  };
}

function portableBaseline(receipt) {
  return {
    profile: 'portable',
    model: modelIdentity(receipt),
    envelopeFingerprint: receipt.fingerprints.envelope,
    promptFingerprint: receipt.fingerprints.prompt,
    toolsFingerprint: receipt.fingerprints.tools,
    policiesFingerprint: receipt.fingerprints.policies,
  };
}

function nativePair(receipt) {
  return {
    model: modelIdentity(receipt),
    harness: receipt.identity.harness,
    adapter: receipt.identity.adapter,
  };
}

function sum(rows, field) {
  return rows.reduce((total, receipt) => {
    const next = total + receipt.usage[field];
    if (!Number.isSafeInteger(next)) {
      throw comparisonError('METRIC_OVERFLOW', `${field} aggregate exceeds the safe integer range`);
    }
    return next;
  }, 0);
}

function average(rows, field) {
  return rows.length ? Math.round((sum(rows, field) / rows.length) * 1000) / 1000 : 0;
}

function countEntries(rows, field) {
  return rows.reduce((total, receipt) => receipt[field].reduce((subtotal, entry) => {
    const next = subtotal + entry.count;
    if (!Number.isSafeInteger(next)) {
      throw comparisonError('METRIC_OVERFLOW', `${field} aggregate exceeds the safe integer range`);
    }
    return next;
  }, total), 0);
}

function summarizeTuple(rows) {
  const first = rows[0];
  const successes = rows.filter((receipt) => receipt.finalState === 'succeeded').length;
  return {
    executionTupleFingerprint: first.executionTupleFingerprint,
    modelFingerprint: fingerprint(modelIdentity(first)),
    harnessFingerprint: fingerprint(harnessIdentity(first)),
    nativePairFingerprint: fingerprint(nativePair(first)),
    identity: projectWorkerReceiptPublic(first).identity,
    receiptFingerprints: rows.map((receipt) => receipt.fingerprint).sort(),
    runs: rows.length,
    successes,
    failures: rows.length - successes,
    successRate: Math.round((successes / rows.length) * 1_000_000) / 1_000_000,
    averageDurationMs: average(rows, 'durationMs'),
    totalTokens: sum(rows, 'totalTokens'),
    totalCostNanodollars: sum(rows, 'costNanodollars'),
    totalTurns: sum(rows, 'turns'),
    totalToolCalls: sum(rows, 'toolCalls'),
    toolErrorCount: countEntries(rows, 'toolErrors'),
    humanInterventionCount: countEntries(rows, 'humanInterventions'),
    policyViolationCount: countEntries(rows, 'violations'),
    evidence: {
      patches: rows.reduce((total, receipt) => total + receipt.evidence.patches.length, 0),
      artifacts: rows.reduce((total, receipt) => total + receipt.evidence.artifacts.length, 0),
      tests: rows.reduce((total, receipt) => total + receipt.evidence.tests.length, 0),
      failedTests: rows.reduce(
        (total, receipt) => total + receipt.evidence.tests.filter((test) => test.status === 'failed').length,
        0
      ),
    },
  };
}

function compareWorkerEvidence(raw = {}) {
  const profile = requiredProfile(raw.profile);
  const receipts = (Array.isArray(raw.receipts) ? raw.receipts : []).map((receipt) => normalizeWorkerReceipt(receipt));
  if (receipts.length < 2) {
    throw comparisonError('WORKER_RECEIPTS_REQUIRED', 'a worker evidence comparison requires at least two receipts');
  }
  if (receipts.some((receipt) => receipt.executionProfile !== profile)) {
    throw comparisonError('PROFILE_MISMATCH', 'every receipt executionProfile must match the comparison profile');
  }

  let portableBaselineFingerprint = null;
  if (profile === 'portable') {
    const baselines = new Set(receipts.map((receipt) => fingerprint(portableBaseline(receipt))));
    if (baselines.size !== 1) {
      throw comparisonError(
        'PORTABLE_CONTRACT_MISMATCH',
        'portable comparisons require the same exact model, API, envelope, prompt, tools, and policies'
      );
    }
    portableBaselineFingerprint = [...baselines][0];
  }

  const groups = new Map();
  for (const receipt of receipts) {
    if (!groups.has(receipt.executionTupleFingerprint)) groups.set(receipt.executionTupleFingerprint, []);
    groups.get(receipt.executionTupleFingerprint).push(receipt);
  }
  const tuples = [...groups.values()]
    .map(summarizeTuple)
    .sort((left, right) => left.executionTupleFingerprint.localeCompare(right.executionTupleFingerprint));
  const report = {
    schema: WORKER_EVIDENCE_SCHEMA,
    schemaVersion: SCHEMA_VERSION,
    generatedAt: isoTimestamp(raw.generatedAt),
    profile,
    receiptCount: receipts.length,
    tupleCount: tuples.length,
    portableBaselineFingerprint,
    tuples,
    exactTupleFingerprints: tuples.map((tuple) => tuple.executionTupleFingerprint),
    policy: {
      harnessExecution: false,
      providerExecution: false,
      routeMutation: false,
      candidatePromotion: false,
      transcriptRetention: false,
      universalWinner: null,
      portableRequiresFrozenInputs: true,
      nativeCeilingPreservesNativeOptimizations: true,
      crossTupleRanking: false,
    },
  };
  return { ...report, fingerprint: fingerprint(report) };
}

function validateWorkerEvidenceReport(raw = {}) {
  if (!raw || typeof raw !== 'object') throw comparisonError('REPORT_REQUIRED', 'report must be an object');
  const supplied = String(raw.fingerprint || '').toLowerCase();
  const unsigned = { ...raw };
  delete unsigned.fingerprint;
  const computed = fingerprint(unsigned);
  if (!/^[a-f0-9]{64}$/.test(supplied) || supplied !== computed) {
    throw comparisonError('WORKER_REPORT_FINGERPRINT_MISMATCH', 'worker evidence report fingerprint does not match its contents');
  }
  return raw;
}

module.exports = {
  SCHEMA_VERSION,
  WORKER_EVIDENCE_SCHEMA,
  compareWorkerEvidence,
  validateWorkerEvidenceReport,
};
