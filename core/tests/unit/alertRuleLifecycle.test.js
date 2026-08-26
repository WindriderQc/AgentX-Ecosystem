'use strict';

const {
  presentRule,
  summarizeRuleStates,
  isRetiredBuiltIn,
} = require('../../src/services/alertRuleLifecycle');

describe('alert rule detector lifecycle', () => {
  test('distinguishes active, accidentally disabled, and retired-by-design detectors', () => {
    const rules = [
      presentRule({ ruleId: 'inference-error', enabled: true, builtIn: true }),
      presentRule({ ruleId: 'latency-spike', enabled: false, builtIn: true }),
      presentRule({ ruleId: 'capacity-host-critical', enabled: false, builtIn: true }),
    ];

    expect(rules.map(rule => rule.detectorState)).toEqual([
      'active',
      'disabled',
      'retired_by_design',
    ]);
    expect(rules[1].producerAvailable).toBe(true);
    expect(rules[2].producerAvailable).toBe(false);
    expect(summarizeRuleStates(rules)).toEqual({
      total: 3,
      active: 1,
      disabled: 1,
      retired_by_design: 1,
    });
    expect(isRetiredBuiltIn('capacity-host-critical')).toBe(true);
  });

  test('does not label an operator-created rule retired solely because its ID collides', () => {
    expect(presentRule({
      ruleId: 'capacity-host-critical',
      enabled: false,
      builtIn: false,
    }).detectorState).toBe('disabled');
  });
});
