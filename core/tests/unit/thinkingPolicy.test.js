const {
  normalizeRequestedThink,
  normalizeThinkingMode,
  resolveThinkingPolicy
} = require('../../src/services/thinkingPolicy');

describe('thinkingPolicy', () => {
  const qualifiedThinking = {
    qualification: { qualified: true },
    capabilities: {
      thinking: {
        supported: true,
        recommendedPolicy: 'on',
        source: 'benchmark_model_profile',
        visibleFinalAnswer: { qualified: true }
      }
    }
  };

  it('normalizes string think aliases before auto policy', () => {
    expect(normalizeRequestedThink('true')).toBe(true);
    expect(normalizeRequestedThink('on')).toBe(true);
    expect(normalizeRequestedThink('false')).toBe(false);
    expect(normalizeRequestedThink('off')).toBe(false);
    expect(normalizeRequestedThink('auto')).toBeUndefined();
  });

  it('normalizes explicit booleans before string modes', () => {
    expect(normalizeThinkingMode({ requestedThink: true, thinkingMode: 'off' })).toBe('on');
    expect(normalizeThinkingMode({ requestedThink: false, thinkingMode: 'on' })).toBe('off');
    expect(normalizeThinkingMode({ requestedThink: 'false', thinkingMode: 'on' })).toBe('off');
    expect(normalizeThinkingMode({ requestedThink: 'true', thinkingMode: 'off' })).toBe('on');
    expect(normalizeThinkingMode({ thinkingMode: 'auto' })).toBe('auto');
    expect(normalizeThinkingMode({ thinkingMode: 'force' })).toBe('on');
    expect(normalizeThinkingMode({ thinkingMode: 'never' })).toBe('off');
  });

  it('auto-enables thinking for capable models on reasoning lanes', () => {
    const decision = resolveThinkingPolicy({
      capabilityContract: qualifiedThinking,
      taskType: 'deep_reasoning'
    });

    expect(decision).toMatchObject({
      mode: 'auto',
      think: true,
      source: 'task_policy'
    });
  });

  it('auto-disables thinking for latency and utility lanes', () => {
    const decision = resolveThinkingPolicy({
      capabilityContract: qualifiedThinking,
      taskType: 'quick_chat'
    });

    expect(decision).toMatchObject({
      mode: 'auto',
      think: false,
      source: 'task_policy'
    });
  });

  it('keeps coding auto mode final-only while preserving explicit overrides', () => {
    expect(resolveThinkingPolicy({
      capabilityContract: qualifiedThinking,
      taskType: 'code_generation'
    })).toMatchObject({
      mode: 'auto',
      think: false,
      source: 'task_policy'
    });

    expect(resolveThinkingPolicy({
      capabilityContract: qualifiedThinking,
      taskType: 'code_generation',
      thinkingMode: 'on'
    })).toMatchObject({
      mode: 'on',
      think: true,
      source: 'explicit'
    });
  });

  it('requires an explicit request for the quality-max thinking lane', () => {
    expect(resolveThinkingPolicy({
      capabilityContract: qualifiedThinking,
      taskType: 'master_brain'
    })).toMatchObject({
      mode: 'auto',
      think: false,
      source: 'task_policy',
      reason: 'task master_brain requires an explicit thinking request'
    });

    expect(resolveThinkingPolicy({
      capabilityContract: qualifiedThinking,
      taskType: 'master_brain',
      requestedThink: true
    })).toMatchObject({
      mode: 'on',
      think: true,
      source: 'explicit'
    });
  });

  it('leaves unqualified artifacts unchanged in auto mode regardless of model name', () => {
    const decision = resolveThinkingPolicy({
      capabilityContract: {
        qualification: { qualified: false },
        capabilities: { thinking: { supported: null, source: 'unqualified' } }
      },
      taskType: 'deep_reasoning'
    });

    expect(decision.think).toBeUndefined();
    expect(decision.source).toBe('model_capability');
  });

  it('defaults capable models to thinking off when no auto-on task policy matches', () => {
    const decision = resolveThinkingPolicy({
      capabilityContract: qualifiedThinking
    });

    expect(decision).toMatchObject({
      mode: 'auto',
      think: false,
      source: 'default_off'
    });
  });

  it('honors a qualified disallowed policy before reasoning-lane defaults', () => {
    const decision = resolveThinkingPolicy({
      capabilityContract: {
        qualification: { qualified: true },
        capabilities: {
          thinking: {
            supported: true,
            recommendedPolicy: 'disallowed',
            source: 'benchmark_model_profile',
            visibleFinalAnswer: { qualified: true }
          }
        }
      },
      taskType: 'deep_reasoning'
    });

    expect(decision).toMatchObject({
      think: false,
      source: 'capability_policy'
    });
  });

  it('does not auto-enable thinking when the visible-final contract is unqualified', () => {
    const decision = resolveThinkingPolicy({
      capabilityContract: {
        qualification: { qualified: true },
        capabilities: {
          thinking: {
            supported: true,
            recommendedPolicy: 'on',
            source: 'benchmark_model_profile',
            visibleFinalAnswer: { qualified: false }
          }
        }
      },
      taskType: 'deep_reasoning'
    });

    expect(decision).toMatchObject({
      think: undefined,
      capable: false,
      source: 'model_capability'
    });
  });
});
