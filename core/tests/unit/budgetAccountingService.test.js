/**
 * Unit tests for cloud-vs-local budget accounting (0455).
 *
 * The regression being locked down: a benchmark campaign burning ~1M FREE
 * local tokens used to push budget_health to red and deny Nestor's cloud
 * escalation, even though no cloud money had been spent.
 */

const {
  modelProvider,
  isCloudModel,
  healthFromRatio,
  splitUsageByModel,
  buildCloudBudget
} = require('../../src/services/budgetAccountingService');

const {
  recommendEscalation,
  resolveGateHealth
} = require('../../src/services/nestorEscalationPolicyService');

afterEach(() => {
  delete process.env.BUDGET_CLOUD_PROVIDERS;
});

describe('model classification', () => {
  test('recognises cloud providers by prefix', () => {
    expect(isCloudModel('openrouter/z-ai/glm-5.2')).toBe(true);
    expect(isCloudModel('anthropic/claude-sonnet-4-6')).toBe(true);
    expect(isCloudModel('openai-codex/gpt-5.6-sol')).toBe(true);
    expect(modelProvider('openrouter/z-ai/glm-5.2')).toBe('openrouter');
  });

  test('namespaced LOCAL models are not cloud — the slash trap', () => {
    // These all contain a slash; a naive "has a slash means cloud" heuristic
    // would misclassify the entire local fleet and invert the bug.
    expect(isCloudModel('ax/gemma4:26b-a4b-it-qat')).toBe(false);
    expect(isCloudModel('qllama/bge-m3:f16')).toBe(false);
    expect(isCloudModel('hf.co/Jackrong/Qwopus3.6-27B-Coder-MTP-GGUF:Q5_K_M')).toBe(false);
    expect(isCloudModel('ollama/ax/gemma4:e4b')).toBe(false);
  });

  test('bare model names are local', () => {
    expect(isCloudModel('qwen2.5:14b-instruct-q4_K_M')).toBe(false);
    expect(isCloudModel('nomic-embed-text:v1.5')).toBe(false);
    expect(isCloudModel('')).toBe(false);
    expect(isCloudModel(null)).toBe(false);
  });

  test('provider list is extensible via env', () => {
    expect(isCloudModel('acme/private-model')).toBe(false);
    process.env.BUDGET_CLOUD_PROVIDERS = 'acme';
    expect(isCloudModel('acme/private-model')).toBe(true);
  });
});

describe('splitUsageByModel', () => {
  test('separates billable from free traffic', () => {
    const { cloud, local } = splitUsageByModel([
      { _id: 'qwen2.5:14b-instruct-q4_K_M', requests: 1158, tokens: 1014638 },
      { _id: 'ax/gemma4:26b-a4b-it-qat', requests: 126, tokens: 41279 },
      { _id: 'openrouter/z-ai/glm-5.2', requests: 12, tokens: 8000 }
    ]);
    expect(local.tokens).toBe(1055917);
    expect(cloud.tokens).toBe(8000);
    expect(cloud.models).toEqual(['openrouter/z-ai/glm-5.2']);
  });

  test('tolerates empty and malformed rows', () => {
    const { cloud, local } = splitUsageByModel([null, {}, undefined]);
    expect(cloud.tokens).toBe(0);
    expect(local.tokens).toBe(0);
    expect(splitUsageByModel().cloud.requests).toBe(0);
  });
});

describe('buildCloudBudget — the actual regression', () => {
  // Reproduces the observed 2026-07-27 window: ~1.05M local benchmark tokens,
  // zero cloud calls, against a 500k limit.
  const BENCHMARK_DAY = [
    { _id: 'qwen2.5:14b-instruct-q4_K_M', requests: 1158, tokens: 1014638 },
    { _id: 'ax/gemma4:26b-a4b-it-qat', requests: 126, tokens: 41279 },
    { _id: 'nomic-embed-text:v1.5', requests: 350, tokens: 336 }
  ];

  test('a heavy LOCAL benchmark day no longer trips the cloud gate', () => {
    const budget = buildCloudBudget({ rows: BENCHMARK_DAY, hours: 24, cloudDailyLimit: 500000 });
    expect(budget.local_tokens).toBeGreaterThan(1000000);
    expect(budget.cloud_tokens).toBe(0);
    expect(budget.cloud_health).toBe('green');
    expect(budget.cloud_spend_observability).toBe('none-recorded');

    // and the gate now allows escalation where it previously denied
    const gate = recommendEscalation({ budget_health: 'red', ...budget });
    expect(gate.recommendation).toBe('allow');
    expect(gate.cloud_allowed).toBe(true);
    expect(gate.gate_basis).toBe('cloud_spend');
  });

  test('real cloud spend still escalates the health properly', () => {
    const rows = [...BENCHMARK_DAY, { _id: 'openrouter/z-ai/glm-5.2', requests: 200, tokens: 480000 }];
    const budget = buildCloudBudget({ rows, hours: 24, cloudDailyLimit: 500000 });
    expect(budget.cloud_tokens).toBe(480000);
    expect(budget.cloud_usage_ratio).toBeCloseTo(0.96, 2);
    expect(budget.cloud_health).toBe('red');
    expect(budget.cloud_spend_observability).toBe('agentx-routed-calls');
    expect(recommendEscalation({ ...budget }).recommendation).toBe('deny');
  });

  test('yellow band requires a complexity justification', () => {
    const rows = [{ _id: 'anthropic/claude-sonnet-4-6', requests: 50, tokens: 400000 }];
    const budget = buildCloudBudget({ rows, hours: 24, cloudDailyLimit: 500000 });
    expect(budget.cloud_health).toBe('yellow');
    const gate = recommendEscalation(budget);
    expect(gate.recommendation).toBe('limited');
    expect(gate.requires_complexity_justification).toBe(true);
  });

  test('scales the limit to the requested window', () => {
    const budget = buildCloudBudget({ rows: [], hours: 12, cloudDailyLimit: 500000 });
    expect(budget.cloud_scaled_limit).toBe(250000);
  });
});

describe('healthFromRatio', () => {
  test('bands and invalid input', () => {
    expect(healthFromRatio(0)).toBe('green');
    expect(healthFromRatio(0.75)).toBe('yellow');
    expect(healthFromRatio(1.5)).toBe('red');
    expect(healthFromRatio(NaN)).toBe('red');
  });
});

describe('resolveGateHealth — backward compatibility', () => {
  test('prefers cloud_health when present', () => {
    expect(resolveGateHealth({ budget_health: 'red', cloud_health: 'green' }))
      .toEqual({ health: 'green', basis: 'cloud_spend' });
  });

  test('falls back to budget_health for callers without a cloud split', () => {
    // the synthetic ?budget_health= probe used by deterministic policy checks
    expect(resolveGateHealth({ budget_health: 'yellow' }))
      .toEqual({ health: 'yellow', basis: 'total_tokens' });
    expect(recommendEscalation({ budget_health: 'red' }).recommendation).toBe('deny');
  });

  test('fails closed on missing or garbage health', () => {
    expect(resolveGateHealth({}).health).toBe('red');
    expect(resolveGateHealth({ cloud_health: 'banana' }).health).toBe('red');
    expect(recommendEscalation({}).recommendation).toBe('deny');
  });
});
