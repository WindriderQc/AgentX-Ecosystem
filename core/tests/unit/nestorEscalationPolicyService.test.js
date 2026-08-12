const {
  ESCALATION_TARGETS,
  normalizeBudgetHealth,
  recommendEscalation,
} = require('../../src/services/nestorEscalationPolicyService');

describe('nestorEscalationPolicyService', () => {
  test('maps green budget health to allow', () => {
    const result = recommendEscalation({ budget_health: 'green' });

    expect(result.recommendation).toBe('allow');
    expect(result.cloud_allowed).toBe(true);
    expect(result.requires_complexity_justification).toBe(false);
    expect(result.targets).toEqual(ESCALATION_TARGETS);
  });

  test('maps yellow budget health to limited', () => {
    const result = recommendEscalation({ budget_health: 'yellow' });

    expect(result.recommendation).toBe('limited');
    expect(result.cloud_allowed).toBe(true);
    expect(result.requires_complexity_justification).toBe(true);
    expect(result.targets).toEqual(ESCALATION_TARGETS);
    expect(result.fallback).toBe('local_answer_or_todo');
  });

  test('maps red budget health to deny', () => {
    const result = recommendEscalation({ budget_health: 'red' });

    expect(result.recommendation).toBe('deny');
    expect(result.cloud_allowed).toBe(false);
    expect(result.targets).toEqual([]);
    expect(result.fallback).toBe('local_answer_or_todo');
  });

  test('normalizes unknown budget health to red', () => {
    expect(normalizeBudgetHealth('unknown')).toBe('red');
    expect(recommendEscalation({ budget_health: 'unknown' }).recommendation).toBe('deny');
  });
});
