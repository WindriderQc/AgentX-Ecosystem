'use strict';

const {
  projectBackupPolicy,
  summarizeInventory
} = require('../../src/services/backupEvidenceService');

describe('backupEvidenceService', () => {
  test('reports the bounded product defaults without implying scheduled creation', () => {
    const policy = projectBackupPolicy(
      { retentionDays: 30, retentionDaysSource: 'default' },
      {
        enabled: false,
        enabledSource: 'default',
        intervalMs: 86400000,
        intervalMsSource: 'default',
        retryDelayMs: 3600000,
        retryDelayMsSource: 'default',
        startupDelayMs: 300000,
        startupDelayMsSource: 'default'
      },
      '2026-08-28T12:00:00.000Z'
    );

    expect(policy.schedule).toMatchObject({
      enabled: false,
      normalEveryMs: 86400000,
      normalCyclesPerDay: 0,
      logicalOperationsPerDay: 0
    });
    expect(policy.retention).toMatchObject({
      days: 30,
      mode: 'bounded',
      automaticCleanup: true,
      enforcement: 'after each successful backup operation'
    });
    expect(policy.growthRisk.level).toBe('low');
  });

  test('makes scheduled unbounded growth and shorter failure retries explicit', () => {
    const policy = projectBackupPolicy(
      { retentionDays: 0, retentionDaysSource: 'runtime' },
      {
        enabled: true,
        enabledSource: 'env',
        intervalMs: 40 * 60 * 1000,
        intervalMsSource: 'env',
        retryDelayMs: 20 * 60 * 1000,
        retryDelayMsSource: 'env',
        startupDelayMs: 1000,
        startupDelayMsSource: 'env',
        lastStatus: 'partial'
      }
    );

    expect(policy.schedule).toMatchObject({
      normalCyclesPerDay: 36,
      logicalOperationsPerDay: 108,
      failureRetryEveryMs: 1200000
    });
    expect(policy.retention.mode).toBe('unbounded');
    expect(policy.growthRisk.level).toBe('high');
    expect(policy.growthRisk.warnings.join(' ')).toMatch(/accumulate/i);
    expect(policy.growthRisk.warnings.join(' ')).toMatch(/retry cadence/i);
  });

  test('summarizes the complete recognized inventory and labels known-size coverage', () => {
    const inventory = summarizeInventory([
      { date: '2026-08-20T00:00:00.000Z', size: 100 },
      { date: '2026-08-28T00:00:00.000Z', size: 300 },
      { date: null, size: null }
    ], {
      authority: 'core.backup-inventory.mongo',
      source: 'Core backup filesystem'
    }, '2026-08-28T12:00:00.000Z');

    expect(inventory).toMatchObject({
      count: 3,
      knownSizeCount: 2,
      totalKnownBytes: 400,
      oldestAt: '2026-08-20T00:00:00.000Z',
      newestAt: '2026-08-28T00:00:00.000Z',
      observedAt: '2026-08-28T12:00:00.000Z'
    });
    expect(inventory.countBasis).toMatch(/no date window or pagination/i);
  });
});
