'use strict';

const PERFORMANCE_SCHEMA = 'agentx.pipeline-automation-performance/v1';

function timestamp(value) {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date : null;
}

function elapsed(start, end) {
  const from = timestamp(start);
  const to = timestamp(end);
  if (!from || !to || to.getTime() < from.getTime()) return null;
  return to.getTime() - from.getTime();
}

function observedInteger(value) {
  if (value == null || value === '') return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function ratio(numerator, denominator) {
  return denominator > 0 ? numerator / denominator : null;
}

function distribution(values) {
  const sorted = values.filter((value) => value != null).sort((left, right) => left - right);
  const percentile = (fraction) => {
    if (!sorted.length) return null;
    return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
  };
  return {
    observed: sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
  };
}

function reviewOutcome(attempt) {
  if (['accepted', 'requeued', 'rejected'].includes(attempt?.reviewOutcome)) {
    return attempt.reviewOutcome;
  }
  return attempt?.finalState === 'done' ? 'accepted' : 'pending';
}

function buildPipelineAutomationPerformance(tasks = [], options = {}) {
  const now = timestamp(options.now) || new Date();
  const windowDays = Number(options.windowDays) || 30;
  const from = new Date(now.getTime() - windowDays * 86_400_000);
  const rows = [];

  for (const task of tasks) {
    for (const attempt of task.automationAttempts || []) {
      const acquiredAt = timestamp(attempt.acquiredAt);
      if (!acquiredAt || acquiredAt < from || acquiredAt > now) continue;
      const completedAt = timestamp(attempt.completedAt);
      const reviewedAt = timestamp(attempt.reviewedAt);
      const evidence = attempt.evidence || null;
      const verification = evidence?.verification || {};
      const changes = evidence?.changes || {};
      const usage = evidence?.usage || {};
      const outcome = reviewOutcome(attempt);
      const costNanodollars = observedInteger(usage.costNanodollars);
      const filesChanged = observedInteger(changes.filesChanged);
      const bytesChanged = observedInteger(changes.bytesChanged);
      const executionMs = elapsed(acquiredAt, completedAt);
      const unknown = [];
      if (!['passed', 'failed'].includes(verification.status)) unknown.push('verification');
      if (filesChanged == null || bytesChanged == null) unknown.push('change');
      if (costNanodollars == null) unknown.push('cost');
      if (outcome === 'pending') unknown.push('review');

      rows.push({
        pipelineId: String(task.pipelineId || ''),
        attempt: Number(attempt.attempt) || 0,
        assignee: String(attempt.assignee || ''),
        policyRef: task.automation?.policyRef || null,
        executionProfile: task.automation?.executionProfile || null,
        acquiredAt: acquiredAt.toISOString(),
        completedAt: completedAt?.toISOString() || null,
        reviewedAt: reviewedAt?.toISOString() || null,
        finalState: attempt.finalState || 'active',
        reviewOutcome: outcome,
        verification: {
          status: verification.status || 'unknown',
          durationMs: observedInteger(verification.durationMs),
          testsPassed: observedInteger(verification.testsPassed),
          testsFailed: observedInteger(verification.testsFailed),
        },
        changes: { filesChanged, bytesChanged },
        usage: {
          durationMs: observedInteger(usage.durationMs) ?? executionMs,
          costNanodollars,
        },
        failureCodes: Array.isArray(evidence?.failureCodes) ? evidence.failureCodes.slice(0, 32) : [],
        workerReceiptFingerprint: evidence?.workerReceiptFingerprint || null,
        evidenceObserved: Boolean(evidence),
        timing: {
          queueMs: elapsed(task.createdAt, acquiredAt),
          executionMs,
          reviewMs: elapsed(completedAt, reviewedAt),
          cycleMs: elapsed(task.createdAt, reviewedAt),
        },
        unknown,
      });
    }
  }

  rows.sort((left, right) => right.acquiredAt.localeCompare(left.acquiredAt));
  const accepted = rows.filter((row) => row.reviewOutcome === 'accepted').length;
  const requeued = rows.filter((row) => row.reviewOutcome === 'requeued').length;
  const rejected = rows.filter((row) => row.reviewOutcome === 'rejected').length;
  const decided = accepted + requeued + rejected;
  const firstPassAccepted = rows.filter((row) => row.reviewOutcome === 'accepted' && row.attempt === 1).length;
  const verificationPassed = rows.filter((row) => row.verification.status === 'passed').length;
  const verificationFailed = rows.filter((row) => row.verification.status === 'failed').length;
  const knownCosts = rows.filter((row) => row.usage.costNanodollars != null);
  const knownChanges = rows.filter((row) => row.changes.filesChanged != null && row.changes.bytesChanged != null);
  const safetyBlocks = rows.filter((row) => row.failureCodes.some((code) => (
    /policy|scope|secret|protected|violation/i.test(code)
  ))).length;
  const observedCostNanodollars = knownCosts.reduce((sum, row) => sum + row.usage.costNanodollars, 0);
  const uniqueTasks = new Set(rows.map((row) => row.pipelineId));

  return {
    schema: PERFORMANCE_SCHEMA,
    authority: 'core.pipeline',
    generatedAt: now.toISOString(),
    window: { days: windowDays, from: from.toISOString(), to: now.toISOString() },
    state: rows.length === 0
      ? 'no_data'
      : (rows.every((row) => row.unknown.length === 0) ? 'observed' : 'partial'),
    counts: {
      tasks: uniqueTasks.size,
      attempts: rows.length,
      active: rows.filter((row) => row.finalState === 'active').length,
      awaitingReview: rows.filter((row) => row.finalState === 'review' && row.reviewOutcome === 'pending').length,
      blocked: rows.filter((row) => row.finalState === 'blocked').length,
      accepted,
      requeued,
      rejected,
      leaseExpired: rows.filter((row) => row.finalState === 'expired').length,
    },
    quality: {
      decided,
      acceptanceRate: ratio(accepted, decided),
      firstPassAccepted,
      firstPassShare: ratio(firstPassAccepted, accepted),
      verificationPassed,
      verificationFailed,
      verificationPassRate: ratio(verificationPassed, verificationPassed + verificationFailed),
    },
    autonomy: {
      correctiveHumanInterventions: requeued + rejected,
      mandatoryHumanReviews: decided,
      safetyBlocks,
    },
    timing: {
      queueMs: distribution(rows.map((row) => row.timing.queueMs)),
      executionMs: distribution(rows.map((row) => row.timing.executionMs)),
      reviewMs: distribution(rows.map((row) => row.timing.reviewMs)),
      cycleMs: distribution(rows.map((row) => row.timing.cycleMs)),
    },
    usage: {
      observedCostNanodollars: knownCosts.length ? observedCostNanodollars : null,
      totalCostNanodollars: rows.length > 0 && knownCosts.length === rows.length
        ? observedCostNanodollars
        : null,
      filesChanged: knownChanges.length
        ? knownChanges.reduce((sum, row) => sum + row.changes.filesChanged, 0)
        : null,
      bytesChanged: knownChanges.length
        ? knownChanges.reduce((sum, row) => sum + row.changes.bytesChanged, 0)
        : null,
    },
    coverage: {
      attemptEvidence: rows.filter((row) => row.evidenceObserved).length,
      verification: verificationPassed + verificationFailed,
      changes: knownChanges.length,
      cost: knownCosts.length,
      review: decided,
      total: rows.length,
    },
    unknownSemantics: 'Missing evidence is null and excluded from rates; it is never converted to zero.',
    attempts: rows.slice(0, 50),
  };
}

module.exports = {
  PERFORMANCE_SCHEMA,
  buildPipelineAutomationPerformance,
};
