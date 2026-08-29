// Deterministic, statement-free product insights over existing review runs.
// This is a read model only: no second store, model call, or semantic action.

const MemoryReviewRun = require('../../../models/MemoryReviewRun');
const policy = require('./policy');

// Dreaming is expected to be a recurring collection lane. Once a runtime has
// contributed, silence for more than two days is evidence that coverage is
// stale, not evidence that the collector is healthy.
const DEFAULT_RUNTIME_STALE_AFTER_MS = 48 * 60 * 60 * 1000;

function add(bucket, key, amount = 1) {
  if (!key) return;
  bucket[key] = (bucket[key] || 0) + amount;
}

function countCandidateRisk(candidate) {
  const risk = candidate.risk || {};
  return Number(!!risk.secret) + Number(!!risk.promptInjection)
    + ['privacy', 'governance', 'staleness'].filter((key) => risk[key] && risk[key] !== 'none').length;
}

function latestRuntimeState(runs) {
  const latest = {};
  for (const run of runs) {
    for (const collector of run.collectors || []) {
      if (!latest[collector.runtime]) {
        latest[collector.runtime] = {
          runId: run.runId,
          runStatus: run.status,
          at: collector.submittedAt || run.createdAt,
          errors: [...(collector.errors || [])],
          advisories: [...(collector.drift || [])],
        };
      }
    }
  }
  return latest;
}

function summarizeRuns(runs, limit, now = new Date(), {
  runtimeStaleAfterMs = DEFAULT_RUNTIME_STALE_AFTER_MS,
} = {}) {
  runs = [...runs].sort((left, right) => new Date(right.createdAt || 0) - new Date(left.createdAt || 0));
  const totals = {
    runs: runs.length, completedRuns: 0, activeRuns: 0, failedRuns: 0,
    candidates: 0, pending: 0, reviewed: 0, applied: 0,
    sourceEvents: 0, eligibleObservations: 0, filteredObservations: 0,
    modelCalls: 0, modelSkips: 0, errors: 0, advisories: 0,
  };
  const distributions = { candidateTypes: {}, targets: {}, statuses: {} };
  const quality = { approved: 0, rejected: 0, deferred: 0, conflicts: 0, riskFlags: 0, crossRuntime: 0 };
  const runtimes = Object.fromEntries(policy.RUNTIMES.map((runtime) => [runtime, {
    runtime, runs: 0, sourceFiles: 0, sourceEvents: 0, eligible: 0, filtered: 0,
  }]));
  const rejectionReasons = {};

  for (const run of runs) {
    if (run.status === 'completed') totals.completedRuns += 1;
    else if (run.status === 'failed') totals.failedRuns += 1;
    else totals.activeRuns += 1;
    if (run.summary?.modelCalled) totals.modelCalls += 1;
    else if (run.summary?.noEligibleObservations) totals.modelSkips += 1;

    for (const collector of run.collectors || []) {
      const runtime = runtimes[collector.runtime] || (runtimes[collector.runtime] = {
        runtime: collector.runtime, runs: 0, sourceFiles: 0, sourceEvents: 0, eligible: 0, filtered: 0,
      });
      runtime.runs += 1;
      runtime.sourceFiles += collector.sourceFilesSeen || 0;
      runtime.sourceEvents += collector.sourceEventsSeen || 0;
      runtime.eligible += collector.eligibleObservations || 0;
      runtime.filtered += collector.rejectedObservations || 0;
      totals.sourceEvents += collector.sourceEventsSeen || 0;
      totals.eligibleObservations += collector.eligibleObservations || 0;
      totals.filteredObservations += collector.rejectedObservations || 0;
      totals.errors += (collector.errors || []).length;
      totals.advisories += (collector.drift || []).length;
      Object.entries(collector.rejectionCounts || {}).forEach(([reason, count]) => add(rejectionReasons, reason, Number(count) || 0));
    }

    for (const candidate of run.candidates || []) {
      totals.candidates += 1;
      add(distributions.candidateTypes, candidate.type);
      add(distributions.targets, candidate.target?.kind);
      add(distributions.statuses, candidate.status);
      if (['proposed', 'deferred'].includes(candidate.status)) totals.pending += 1;
      if (['approved', 'rejected', 'applied', 'apply_failed'].includes(candidate.status)) totals.reviewed += 1;
      if (['approved', 'applied', 'apply_failed'].includes(candidate.status)) quality.approved += 1;
      if (candidate.status === 'rejected') quality.rejected += 1;
      if (candidate.status === 'deferred') quality.deferred += 1;
      if (candidate.status === 'applied') { totals.applied += 1; }
      quality.conflicts += (candidate.conflicts || []).length;
      quality.riskFlags += countCandidateRisk(candidate);
      if ((candidate.recurrence?.independentRuntimes || 0) > 1) quality.crossRuntime += 1;
    }
  }

  const latestByRuntime = latestRuntimeState(runs);
  Object.values(runtimes).forEach((runtime) => {
    const current = latestByRuntime[runtime.runtime];
    runtime.lastSeen = current?.at || null;
    runtime.lastRunId = current?.runId || null;
    runtime.currentErrors = current?.errors?.length || 0;
    runtime.currentAdvisories = [...new Set(current?.advisories || [])].length;
    const lastSeenMs = new Date(runtime.lastSeen || 0).getTime();
    runtime.ageMs = Number.isFinite(lastSeenMs) && lastSeenMs > 0
      ? Math.max(0, now.getTime() - lastSeenMs)
      : null;
    runtime.staleAfterMs = runtimeStaleAfterMs;
    runtime.health = runtime.currentErrors
      ? 'attention'
      : runtime.ageMs === null
        ? 'not_seen'
        : runtime.ageMs > runtimeStaleAfterMs
          ? 'stale'
          : 'healthy';
  });

  const currentErrors = Object.values(runtimes).reduce((sum, runtime) => sum + runtime.currentErrors, 0);
  const currentAdvisories = Object.values(runtimes).reduce((sum, runtime) => sum + runtime.currentAdvisories, 0);
  const staleRuntimes = Object.values(runtimes)
    .filter((runtime) => runtime.health === 'stale')
    .map((runtime) => runtime.runtime);
  const activeRuns = runs.filter((run) => ['collecting', 'synthesizing'].includes(run.status));
  const activeRun = activeRuns[0] || null;
  const activeReconciliation = activeRun ? policy.reconciliationStatus(activeRun, now) : null;
  const overdue = activeRuns.filter((run) => policy.reconciliationStatus(run, now).overdue).length;
  const latest = runs.find((run) => ['ready_for_review', 'partially_reviewed', 'completed'].includes(run.status)) || runs[0] || null;
  const decided = quality.approved + quality.rejected;
  const observed = totals.eligibleObservations + totals.filteredObservations;

  return {
    window: {
      limit,
      from: runs.length ? runs[runs.length - 1].createdAt : null,
      to: runs.length ? runs[0].createdAt : null,
    },
    health: {
      state: !runs.length ? 'waiting' : (currentErrors || overdue || staleRuntimes.length) ? 'attention' : 'healthy',
      errors: currentErrors,
      advisories: currentAdvisories,
      stale: staleRuntimes.length,
      staleRuntimes,
      runtimeStaleAfterMs,
      collecting: activeRuns.length > 0,
      overdue,
      activeRun: activeRun ? {
        runId: activeRun.runId,
        status: activeRun.status,
        createdAt: activeRun.createdAt,
        reconciliation: activeReconciliation,
      } : null,
    },
    latest: latest ? {
      runId: latest.runId,
      status: latest.status,
      createdAt: latest.createdAt,
      completedAt: latest.completedAt,
      candidates: (latest.candidates || []).length,
      pending: (latest.candidates || []).filter((candidate) => ['proposed', 'deferred'].includes(candidate.status)).length,
      modelCalled: !!latest.summary?.modelCalled,
      quiet: !!latest.summary?.noEligibleObservations,
    } : null,
    totals,
    quality: {
      ...quality,
      approvalPrecision: decided ? Math.round((quality.approved / decided) * 100) : null,
      filterRate: observed ? Math.round((totals.filteredObservations / observed) * 100) : null,
    },
    runtimes: Object.values(runtimes),
    distributions,
    rejectionReasons,
    safeDigest: latest
      ? `Dreaming Review: ${totals.pending} awaiting review across ${totals.runs} recent runs; ${currentErrors ? `${currentErrors} collector error(s)` : overdue ? `${overdue} overdue reconciliation(s)` : staleRuntimes.length ? `${staleRuntimes.length} stale collector(s)` : 'collectors healthy'}; ${totals.applied} applied safely.`
      : 'Dreaming Review: no runs recorded yet.',
  };
}

async function buildInsights({ limit = 30 } = {}) {
  const bounded = Math.min(Math.max(Math.trunc(Number(limit) || 30), 1), 100);
  const runs = await MemoryReviewRun.find({}, {
    runId: 1, status: 1, createdAt: 1, completedAt: 1, summary: 1,
    'collectors.runtime': 1, 'collectors.submittedAt': 1,
    'collectors.sourceFilesSeen': 1, 'collectors.sourceEventsSeen': 1,
    'collectors.eligibleObservations': 1, 'collectors.rejectedObservations': 1,
    'collectors.rejectionCounts': 1, 'collectors.errors': 1, 'collectors.drift': 1,
    'candidates.type': 1, 'candidates.status': 1, 'candidates.target.kind': 1,
    'candidates.recurrence': 1, 'candidates.conflicts': 1, 'candidates.risk': 1,
  }).sort({ createdAt: -1 }).limit(bounded).lean();
  return summarizeRuns(runs, bounded);
}

module.exports = { DEFAULT_RUNTIME_STALE_AFTER_MS, buildInsights, summarizeRuns };
