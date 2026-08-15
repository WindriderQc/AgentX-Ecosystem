'use strict';

const { aggregateCapability, unitKey, tierRank } = require('../../../src/services/qualification/capabilityAggregator');

const row = (over = {}) => ({
  model: 'qwen3-coder:30b',
  agent: 'candidate-agent',
  task_class: 'code_worker',
  host: 'host-a',
  batch_id: 'batch1',
  timestamp: '2026-06-23T00:00:00Z',
  qualification: { tier: 'C2', passed: true, host: 'host-a' },
  ...over
});

describe('aggregateCapability', () => {
  test('returns the highest PASSED tier per unit', () => {
    const rows = [
      row({ qualification: { tier: 'C1', passed: true, host: 'host-a' } }),
      row({ qualification: { tier: 'C3', passed: true, host: 'host-a' } }),
      row({ qualification: { tier: 'C2', passed: true, host: 'host-a' } })
    ];
    const out = aggregateCapability(rows);
    expect(out).toHaveLength(1);
    expect(out[0].capability_tier).toBe('C3');
    expect(out[0].passed_tiers).toEqual(['C1', 'C2', 'C3']);
    expect(out[0].n).toBe(3);
  });

  test('splits units by host', () => {
    const rows = [
      row({ host: 'host-a', qualification: { tier: 'C3', passed: true, host: 'host-a' } }),
      row({ host: 'host-b', qualification: { tier: 'C2', passed: true, host: 'host-b' } })
    ];
    const out = aggregateCapability(rows);
    expect(out).toHaveLength(2);
    const byHost = Object.fromEntries(out.map((u) => [u.unit.host, u.capability_tier]));
    expect(byHost['host-a']).toBe('C3');
    expect(byHost['host-b']).toBe('C2');
  });

  test('a failed higher-tier probe sets ceiling but not capability_tier', () => {
    const rows = [
      row({ qualification: { tier: 'C2', passed: true, host: 'host-a' } }),
      row({ qualification: { tier: 'C3', passed: false, host: 'host-a' } })
    ];
    const out = aggregateCapability(rows);
    expect(out[0].capability_tier).toBe('C2');
    expect(out[0].ceiling).toBe('C3');
  });

  test('ignores untagged rows', () => {
    const out = aggregateCapability([row({ qualification: null }), row()]);
    expect(out).toHaveLength(1);
    expect(out[0].n).toBe(1);
  });

  test('populates evidence pointers', () => {
    const out = aggregateCapability([row({ batch_id: 'b9', contract_matrix_run: 'run42' })]);
    expect(out[0].evidence.capability_batch).toBe('b9');
    expect(out[0].evidence.contract_matrix_run).toBe('run42');
  });

  test('unitKey and tierRank helpers behave', () => {
    expect(unitKey(row())).toBe('qwen3-coder:30b||candidate-agent||code_worker||host-a');
    expect(tierRank('C3')).toBeGreaterThan(tierRank('C2'));
    expect(tierRank(null)).toBe(-1);
  });
});
