'use strict';

const { RETIRED_BUILT_IN_RULE_IDS } = require('./alertRuleSeeder');

const RETIRED = new Set(RETIRED_BUILT_IN_RULE_IDS);

function detectorState(rule) {
  if (rule?.builtIn && RETIRED.has(rule.ruleId)) return 'retired_by_design';
  return rule?.enabled ? 'active' : 'disabled';
}

function presentRule(rule) {
  const state = detectorState(rule);
  return {
    ...rule,
    detectorState: state,
    producerAvailable: state !== 'retired_by_design',
    stateReason: state === 'retired_by_design'
      ? 'The product-owned producer was removed; this persisted rule is retained as historical configuration.'
      : state === 'disabled'
        ? 'The detector is configured but not evaluating events.'
        : 'The detector is enabled and evaluating matching producer events.'
  };
}

function summarizeRuleStates(rules) {
  return (rules || []).reduce((summary, rule) => {
    const state = rule.detectorState || detectorState(rule);
    summary.total += 1;
    summary[state] += 1;
    return summary;
  }, { total: 0, active: 0, disabled: 0, retired_by_design: 0 });
}

function isRetiredBuiltIn(ruleId) {
  return RETIRED.has(ruleId);
}

module.exports = { detectorState, presentRule, summarizeRuleStates, isRetiredBuiltIn };
