'use strict';

const { aggregateCalibration, unitKey, isKTier, K_FLOOR } = require('../../../src/services/qualification/calibrationAggregator');

const row = (over = {}) => ({
  model: 'qwen3-coder:30b',
  agent: 'clawdx_coder',
  task_class: 'code_worker',
  host: 'host-gamma',
  batch_id: 'batchK',
  timestamp: '2026-06-24T00:00:00Z',
  qualification: { tier: 'K1', passed: true, host: 'host-gamma' },
  ...over
});

describe('aggregateCalibration — per-unit K + hard-fail (criterion 4)', () => {
  test('a calibrated unit reports K=1, no hard-fail, meets the floor', () => {
    const rows = [
      row({ qualification: { tier: 'K1', passed: true, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K2', passed: true, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K3', passed: true, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K4', passed: true, host: 'host-gamma' } })
    ];
    const out = aggregateCalibration(rows);
    expect(out).toHaveLength(1);
    expect(out[0].K).toBe(1);
    expect(out[0].k1_k2_hardfail).toBe(false);
    expect(out[0].meets_floor).toBe(true);
    expect(out[0].probes_passed).toEqual(['K1', 'K2', 'K3', 'K4']);
    expect(out[0].unit).toEqual({ model: 'qwen3-coder:30b', agent: 'clawdx_coder', task_class: 'code_worker', host: 'host-gamma' });
  });

  test('a K1 catastrophic miss sets k1_k2_hardfail and fails the floor despite K>floor', () => {
    const rows = [
      row({ qualification: { tier: 'K1', passed: false, reason: 'fabricated artifact', host: 'host-gamma' } }),
      row({ qualification: { tier: 'K2', passed: true, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K3', passed: true, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K4', passed: true, host: 'host-gamma' } })
    ];
    const out = aggregateCalibration(rows);
    expect(out[0].K).toBe(0.75);
    expect(out[0].k1_k2_hardfail).toBe(true);
    expect(out[0].probes_hardfailed).toEqual(['K1']);
    expect(out[0].meets_floor).toBe(false);
    expect(out[0].per_probe.K1.reason).toBe('fabricated artifact');
  });

  test('a K3 miss lowers K but is NOT a catastrophic hard-fail', () => {
    const rows = [
      row({ qualification: { tier: 'K1', passed: true, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K2', passed: true, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K3', passed: false, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K4', passed: true, host: 'host-gamma' } })
    ];
    const out = aggregateCalibration(rows);
    expect(out[0].K).toBe(0.75);
    expect(out[0].k1_k2_hardfail).toBe(false);
    expect(out[0].meets_floor).toBe(false); // 0.75 < 0.80 floor
  });

  test('explicit k_hardfail flag is honored', () => {
    const out = aggregateCalibration([
      row({ qualification: { tier: 'K2', passed: false, host: 'host-gamma' }, k_hardfail: true })
    ]);
    expect(out[0].k1_k2_hardfail).toBe(true);
  });

  test('repeats collapse worst-case: one catastrophic miss among passes still hard-fails', () => {
    const rows = [
      row({ qualification: { tier: 'K1', passed: true, host: 'host-gamma' } }),
      row({ qualification: { tier: 'K1', passed: false, reason: 'fabricated on retry', host: 'host-gamma' } })
    ];
    const out = aggregateCalibration(rows);
    expect(out[0].per_probe.K1.passed).toBe(false); // passed only if passed on EVERY run
    expect(out[0].k1_k2_hardfail).toBe(true);
    expect(out[0].n).toBe(2);
  });

  test('splits units by (model, agent, task_class, host)', () => {
    const rows = [
      row({ host: 'host-gamma', qualification: { tier: 'K1', passed: true, host: 'host-gamma' } }),
      row({ host: 'host-beta', qualification: { tier: 'K1', passed: false, host: 'host-beta' } }),
      row({ agent: 'other_agent', qualification: { tier: 'K1', passed: true, host: 'host-gamma' } })
    ];
    const out = aggregateCalibration(rows);
    expect(out).toHaveLength(3);
  });

  test('ignores non-K (capability) rows and untagged rows', () => {
    const rows = [
      row({ qualification: { tier: 'C2', passed: true, host: 'host-gamma' } }), // capability, ignored
      row({ qualification: null }),                                          // untagged, ignored
      row({ qualification: { tier: 'K1', passed: true, host: 'host-gamma' } })
    ];
    const out = aggregateCalibration(rows);
    expect(out).toHaveLength(1);
    expect(out[0].probes_seen).toEqual(['K1']);
  });

  test('evidence pointers + last_tested are populated', () => {
    const out = aggregateCalibration([
      row({ batch_id: 'bK9', contract_matrix_run: 'kr-42', timestamp: '2026-06-24T10:00:00Z' })
    ]);
    expect(out[0].evidence.calibration_batch).toBe('bK9');
    expect(out[0].evidence.contract_matrix_run).toBe('kr-42');
    expect(out[0].last_tested).toBe('2026-06-24T10:00:00.000Z');
  });

  test('helpers behave', () => {
    expect(unitKey(row())).toBe('qwen3-coder:30b||clawdx_coder||code_worker||host-gamma');
    expect(isKTier('K1')).toBe(true);
    expect(isKTier('C2')).toBe(false);
    expect(K_FLOOR).toBe(0.80);
  });
});
