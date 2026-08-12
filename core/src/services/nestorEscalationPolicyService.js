const ESCALATION_TARGETS = ['cloudx', 'anthropicx'];

function normalizeBudgetHealth(value) {
  const health = String(value || '').trim().toLowerCase();
  if (health === 'green' || health === 'yellow' || health === 'red') {
    return health;
  }
  return 'red';
}

/**
 * Pick the health signal the gate should act on.
 *
 * `cloud_health` reflects BILLABLE traffic only and is preferred whenever the
 * caller supplies it (0455): the previous behaviour keyed off whole-fleet
 * `budget_health`, so a benchmark campaign burning free local tokens would
 * deny cloud escalation despite zero cloud spend. `budget_health` remains the
 * fallback for callers that do not compute the cloud split (e.g. the synthetic
 * ?budget_health= probe used by deterministic policy checks).
 */
function resolveGateHealth(budgetStatus = {}) {
  const cloud = budgetStatus.cloud_health ?? budgetStatus.cloudHealth;
  if (cloud !== undefined && cloud !== null && String(cloud).trim() !== '') {
    return { health: normalizeBudgetHealth(cloud), basis: 'cloud_spend' };
  }
  return {
    health: normalizeBudgetHealth(budgetStatus.budget_health || budgetStatus.budgetHealth),
    basis: 'total_tokens'
  };
}

function recommendEscalation(budgetStatus = {}) {
  const { health: budgetHealth, basis } = resolveGateHealth(budgetStatus);

  if (budgetHealth === 'green') {
    return {
      recommendation: 'allow',
      budget_health: budgetHealth,
      gate_basis: basis,
      cloud_allowed: true,
      targets: ESCALATION_TARGETS,
      requires_complexity_justification: false,
      fallback: null,
      policy: 'Answer-Heavy may delegate to cloud specialists for genuinely complex answers.',
    };
  }

  if (budgetHealth === 'yellow') {
    return {
      recommendation: 'limited',
      budget_health: budgetHealth,
      gate_basis: basis,
      cloud_allowed: true,
      targets: ESCALATION_TARGETS,
      requires_complexity_justification: true,
      fallback: 'local_answer_or_todo',
      policy: 'Answer-Heavy may delegate only when the request is genuinely complex and worth the spend.',
    };
  }

  return {
    recommendation: 'deny',
    budget_health: budgetHealth,
    gate_basis: basis,
    cloud_allowed: false,
    targets: [],
    requires_complexity_justification: false,
    fallback: 'local_answer_or_todo',
    policy: 'Cloud escalation is blocked; answer locally or write a TODO for Lane 2.',
  };
}

module.exports = {
  ESCALATION_TARGETS,
  normalizeBudgetHealth,
  resolveGateHealth,
  recommendEscalation,
};
