'use strict';

const {
  buildOllamaTarget,
  buildQualityCohortFingerprint,
  normalizeBatchTargets,
  normalizeBenchmarkTarget,
  normalizeHarnessExecutionResponse,
} = require('../../../shared/benchmarkTargetContract');
const { fingerprint, normalizeWorkerReceipt } = require('../../../shared/workerContract');
const {
  buildHarnessEnvelope,
  buildSpendPlan,
} = require('../../src/services/benchmark/harnessBrokerClient');

const HEX = (character) => character.repeat(64);

function harnessTarget(overrides = {}) {
  return normalizeBenchmarkTarget({
    id: 'openclaw-free-model',
    label: 'Cloud model',
    executionKind: 'harness',
    mode: 'isolated_model',
    tier: 'free_cloud',
    provider: 'openrouter',
    model: 'vendor/model',
    modelVersion: 'provider-version-1',
    harness: { name: 'openclaw', version: '2026.8.1' },
    adapter: { name: 'openclaw-benchmark', version: '1.0.0' },
    profile: { id: 'benchmark-isolated', version: '1', fingerprint: HEX('1') },
    api: { name: 'openclaw-agent-cli', version: '2026.8.1' },
    contextWindow: 131072,
    capabilities: { candidate: true, judge: true },
    pricing: {
      kind: 'free', currency: 'USD', source: 'operator-declared-free', effectiveAt: null,
      inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 0,
    },
    available: true,
    observedAt: '2026-08-31T00:00:00.000Z',
    catalogFingerprint: HEX('a'),
    ...overrides,
  });
}

describe('BenchmarkTarget v1', () => {
  test('normalizes the legacy host + models shape as stable Ollama targets', () => {
    const targets = normalizeBatchTargets({ host: 'http://ollama:11434/', models: ['model-a:latest'] });
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      executionKind: 'ollama', mode: 'direct_model', tier: 'local', provider: 'ollama',
      host: 'http://ollama:11434', model: 'model-a:latest',
    });
    expect(targets[0]).toEqual(buildOllamaTarget('http://ollama:11434', 'model-a:latest'));
  });

  test('has a deterministic fingerprint and rejects catalog or price drift', () => {
    const target = harnessTarget();
    expect(harnessTarget()).toEqual(target);
    expect(target.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(() => normalizeBenchmarkTarget({ ...target, catalogFingerprint: HEX('b') }))
      .toThrow(expect.objectContaining({ code: 'TARGET_FINGERPRINT_MISMATCH' }));
    expect(() => harnessTarget({ tier: 'paid_cloud', pricing: null }))
      .toThrow(expect.objectContaining({ code: 'PAID_PRICE_REQUIRED' }));
    expect(() => harnessTarget({
      tier: 'paid_cloud',
      pricing: { kind: 'manual_per_call', currency: 'USD', source: 'snapshot', effectiveAt: null, callNanodollars: 1 },
    })).toThrow(expect.objectContaining({ code: 'MANUAL_PRICE_DATE_REQUIRED' }));
  });

  test('quality cohort changes with judge identity but not target ordering', () => {
    const common = {
      prompts: [{ _id: '2', name: 'B', level: 2, category: 'reasoning' }, { _id: '1', name: 'A', level: 1, category: 'coding' }],
      scorerVersion: 'scorer-v1',
      executionConfig: { response_max_tokens: 1024, temperature: 0, top_p: 1, seed: 7, think: false },
    };
    const first = buildQualityCohortFingerprint({ ...common, judgeTarget: harnessTarget() });
    const reordered = buildQualityCohortFingerprint({ ...common, prompts: [...common.prompts].reverse(), judgeTarget: harnessTarget() });
    const changed = buildQualityCohortFingerprint({ ...common, judgeTarget: buildOllamaTarget('http://ollama:11434', 'judge') });
    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
  });
});

describe('harness envelope, receipt, and spend contracts', () => {
  test('builds a one-turn isolated envelope with no tools or filesystem access', () => {
    const prompt = 'x'.repeat(300);
    const envelope = buildHarnessEnvelope({
      batchId: 'batch-1', cellId: 'cell-1', target: harnessTarget(), promptText: prompt,
      timeoutMs: 120000, maxTokens: 50, role: 'judge',
    });
    expect(envelope).toMatchObject({
      executionProfile: 'portable',
      tools: { allowed: [] },
      budgets: { maxTurns: 1, maxToolCalls: 0 },
      policies: { filesystem: { mode: 'none', allowedOperations: [] } },
      resultContract: { format: 'json' },
    });
    expect(envelope.budgets.maxTokens).toBeGreaterThan(50);
  });

  test('accepts an exact receipt and rejects missing receipt, fallback, and output mismatch', () => {
    const target = harnessTarget();
    const envelope = buildHarnessEnvelope({
      batchId: 'batch-1', cellId: 'cell-1', target, promptText: 'private prompt',
      timeoutMs: 120000, maxTokens: 50, role: 'candidate',
    });
    const output = 'bounded answer';
    const receipt = normalizeWorkerReceipt({
      schema: 'agentx.worker-receipt/v1', schemaVersion: 1, executionProfile: 'portable',
      identity: {
        harness: target.harness, adapter: target.adapter,
        provider: { name: target.provider, version: 'api-v1' },
        model: { name: target.model, version: target.modelVersion, digest: null, runtimeFingerprint: null },
        api: target.api,
        environment: { id: target.profile.id, version: target.profile.version, fingerprint: target.profile.fingerprint },
      },
      fingerprints: {
        prompt: envelope.prompt.fingerprint, tools: envelope.tools.schemaFingerprint,
        policies: envelope.policies.fingerprint, envelope: envelope.fingerprint,
      },
      finalState: 'succeeded', failure: { classification: null, code: null },
      usage: { durationMs: 25, inputTokens: 4, outputTokens: 2, totalTokens: 6, costNanodollars: 0, turns: 1, toolCalls: 0 },
      toolErrors: [], humanInterventions: [], evidence: { patches: [], artifacts: [], tests: [] }, violations: [],
      result: { contractSatisfied: true, fingerprint: fingerprint(output) },
    }, { envelope });
    const valid = { schema: 'agentx.harness-execution/v1', schemaVersion: 1, output, fallbackUsed: false, receipt };
    expect(normalizeHarnessExecutionResponse(valid, { envelope, target }).output).toBe(output);
    expect(() => normalizeHarnessExecutionResponse({ ...valid, receipt: undefined }, { envelope, target })).toThrow();
    expect(() => normalizeHarnessExecutionResponse({ ...valid, fallbackUsed: true }, { envelope, target }))
      .toThrow(expect.objectContaining({ code: 'HARNESS_FALLBACK_USED' }));
    expect(() => normalizeHarnessExecutionResponse({ ...valid, output: 'tampered' }, { envelope, target }))
      .toThrow(expect.objectContaining({ code: 'HARNESS_OUTPUT_FINGERPRINT_MISMATCH' }));
  });

  test('requires explicit paid approval and builds a broker-issued frozen spend plan', () => {
    const paid = harnessTarget({
      id: 'hermes-paid-model', tier: 'paid_cloud', provider: 'provider', model: 'model',
      pricing: {
        kind: 'manual_per_call', currency: 'USD', source: 'operator snapshot', effectiveAt: '2026-08-31T00:00:00.000Z',
        inputNanodollarsPerMillion: 0, outputNanodollarsPerMillion: 0, callNanodollars: 1000,
      },
    });
    expect(() => buildSpendPlan({
      batchId: 'batch-paid', batchFingerprint: HEX('f'), targets: [paid], promptCount: 2, repeats: 1,
      executionConfig: { response_max_tokens: 10, input_token_ceiling: 10 }, approval: null,
    })).toThrow(expect.objectContaining({ code: 'PAID_APPROVAL_REQUIRED' }));
    const request = buildSpendPlan({
      batchId: 'batch-paid', batchFingerprint: HEX('f'), targets: [paid], promptCount: 2, repeats: 1,
      executionConfig: { response_max_tokens: 10, input_token_ceiling: 10 },
      approval: { confirmed: true, maxCalls: 2, maxTokens: 40, maxCostNanodollars: 2000 },
    });
    expect(request).toMatchObject({
      schema: 'agentx.spend-grant-request/v1', batchId: 'batch-paid',
      approval: { maxCalls: 2, maxTokens: 40, maxCostNanodollars: 2000 },
    });
    expect(request).not.toHaveProperty('signature');
  });
});
