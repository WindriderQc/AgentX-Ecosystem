'use strict';

const PERFORMANCE_SCHEMA = 'agentx.pipeline-automation-performance/v1';
const COST_SOURCES_BY_KIND = Object.freeze({
  'provider-spend': 'openclaw-local-provider-spend/v1',
  'session-estimate': 'openclaw-session-usage/v1',
});
const LOCAL_ENERGY_SOURCE = 'nvidia-smi-baseline-integral/v1';
const LOCAL_ENERGY_SCOPE = 'gpu-incremental-lower-bound';
const ELECTRICITY_TARIFF_SOURCE = 'operator-configured-electricity-tariff/v1';

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
      const costKind = ['provider-spend', 'session-estimate'].includes(usage.costKind)
        ? usage.costKind
        : null;
      const costSource = typeof usage.costSource === 'string' && usage.costSource
        ? usage.costSource
        : null;
      const costEvidenceFingerprint = /^[a-f0-9]{64}$/.test(String(usage.costEvidenceFingerprint || ''))
        ? usage.costEvidenceFingerprint
        : null;
      const costEvidenceComplete = costNanodollars != null
        && costKind != null
        && costSource === COST_SOURCES_BY_KIND[costKind]
        && costEvidenceFingerprint != null;
      const localEnergyRaw = usage.localEnergy || {};
      const energyMillijoules = observedInteger(localEnergyRaw.energyMillijoules);
      const measurementDurationMs = observedInteger(localEnergyRaw.measurementDurationMs);
      const sampleCount = observedInteger(localEnergyRaw.sampleCount);
      const baselineMilliwatts = observedInteger(localEnergyRaw.baselineMilliwatts);
      const localEnergyFingerprint = /^[a-f0-9]{64}$/.test(String(localEnergyRaw.evidenceFingerprint || ''))
        ? localEnergyRaw.evidenceFingerprint
        : null;
      const localEnergyEvidenceComplete = energyMillijoules != null
        && measurementDurationMs != null && measurementDurationMs > 0
        && sampleCount != null && sampleCount > 0
        && baselineMilliwatts != null
        && localEnergyRaw.measurementScope === LOCAL_ENERGY_SCOPE
        && localEnergyRaw.source === LOCAL_ENERGY_SOURCE
        && localEnergyFingerprint != null;
      const tariffRaw = localEnergyRaw.tariff || {};
      const tariffCurrency = /^[A-Z]{3}$/.test(String(tariffRaw.currency || ''))
        ? tariffRaw.currency
        : null;
      const tariffRate = observedInteger(tariffRaw.rateNanoCurrencyUnitsPerKwh);
      const electricityCost = observedInteger(tariffRaw.estimatedCostNanoCurrencyUnits);
      const tariffFingerprint = /^[a-f0-9]{64}$/.test(String(tariffRaw.evidenceFingerprint || ''))
        ? tariffRaw.evidenceFingerprint
        : null;
      const expectedElectricityCost = energyMillijoules != null && tariffRate != null
        ? (BigInt(energyMillijoules) * BigInt(tariffRate) + 1_800_000_000n) / 3_600_000_000n
        : null;
      const tariffEvidenceComplete = localEnergyEvidenceComplete
        && tariffCurrency != null
        && tariffRate != null
        && electricityCost != null
        && tariffRaw.source === ELECTRICITY_TARIFF_SOURCE
        && tariffFingerprint != null
        && BigInt(electricityCost) === expectedElectricityCost;
      const filesChanged = observedInteger(changes.filesChanged);
      const bytesChanged = observedInteger(changes.bytesChanged);
      const executionMs = elapsed(acquiredAt, completedAt);
      const unknown = [];
      if (!['passed', 'failed'].includes(verification.status)) unknown.push('verification');
      if (filesChanged == null || bytesChanged == null) unknown.push('change');
      if (costNanodollars == null) unknown.push('cost');
      else if (!costEvidenceComplete) unknown.push('cost_provenance');
      if (!localEnergyEvidenceComplete) unknown.push('local_energy');
      else if (!tariffEvidenceComplete) unknown.push('electricity_cost');
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
          costKind,
          costSource,
          costEvidenceFingerprint,
          costEvidenceComplete,
          localEnergy: localEnergyEvidenceComplete ? {
            measurementScope: LOCAL_ENERGY_SCOPE,
            energyMillijoules,
            measurementDurationMs,
            sampleCount,
            baselineMilliwatts,
            source: LOCAL_ENERGY_SOURCE,
            evidenceFingerprint: localEnergyFingerprint,
            tariff: tariffEvidenceComplete ? {
              currency: tariffCurrency,
              rateNanoCurrencyUnitsPerKwh: tariffRate,
              estimatedCostNanoCurrencyUnits: electricityCost,
              source: ELECTRICITY_TARIFF_SOURCE,
              evidenceFingerprint: tariffFingerprint,
            } : null,
          } : null,
          localEnergyEvidenceComplete,
          tariffEvidenceComplete,
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
  const knownCosts = rows.filter((row) => row.usage.costEvidenceComplete);
  const providerSpendCosts = knownCosts.filter((row) => row.usage.costKind === 'provider-spend');
  const sessionEstimateCosts = knownCosts.filter((row) => row.usage.costKind === 'session-estimate');
  const knownLocalEnergy = rows.filter((row) => row.usage.localEnergyEvidenceComplete);
  const knownElectricityCosts = rows.filter((row) => row.usage.tariffEvidenceComplete);
  const knownChanges = rows.filter((row) => row.changes.filesChanged != null && row.changes.bytesChanged != null);
  const safetyBlocks = rows.filter((row) => row.failureCodes.some((code) => (
    /policy|scope|secret|protected|violation/i.test(code)
  ))).length;
  const observedProviderSpendNanodollars = providerSpendCosts.reduce(
    (sum, row) => sum + row.usage.costNanodollars,
    0
  );
  const observedSessionEstimateNanodollars = sessionEstimateCosts.reduce(
    (sum, row) => sum + row.usage.costNanodollars,
    0
  );
  const observedCostKinds = new Set(knownCosts.map((row) => row.usage.costKind));
  const costAggregateKind = observedCostKinds.size === 1 ? [...observedCostKinds][0] : (
    observedCostKinds.size > 1 ? 'mixed' : null
  );
  const energyScopes = new Set(knownLocalEnergy.map((row) => row.usage.localEnergy.measurementScope));
  const energyAggregateScope = energyScopes.size === 1 ? [...energyScopes][0] : (
    energyScopes.size > 1 ? 'mixed' : null
  );
  const electricityByCurrency = [...knownElectricityCosts.reduce((groups, row) => {
    const tariff = row.usage.localEnergy.tariff;
    const current = groups.get(tariff.currency) || { currency: tariff.currency, attempts: 0, costNanoCurrencyUnits: 0 };
    current.attempts += 1;
    current.costNanoCurrencyUnits += tariff.estimatedCostNanoCurrencyUnits;
    groups.set(tariff.currency, current);
    return groups;
  }, new Map()).values()].sort((left, right) => left.currency.localeCompare(right.currency));
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
      costAggregateKind,
      observedCostNanodollars: providerSpendCosts.length
        ? observedProviderSpendNanodollars
        : null,
      totalCostNanodollars: rows.length > 0
        && providerSpendCosts.length === rows.length
        ? observedProviderSpendNanodollars
        : null,
      observedProviderSpendNanodollars: providerSpendCosts.length
        ? observedProviderSpendNanodollars
        : null,
      observedSessionEstimateNanodollars: sessionEstimateCosts.length
        ? observedSessionEstimateNanodollars
        : null,
      energyAggregateScope,
      observedEnergyMillijoules: knownLocalEnergy.length
        ? knownLocalEnergy.reduce((sum, row) => sum + row.usage.localEnergy.energyMillijoules, 0)
        : null,
      electricityByCurrency,
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
      providerSpend: providerSpendCosts.length,
      sessionEstimate: sessionEstimateCosts.length,
      localEnergy: knownLocalEnergy.length,
      electricityCost: knownElectricityCosts.length,
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
