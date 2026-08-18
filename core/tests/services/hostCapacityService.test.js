'use strict';
/**
 * Unit tests for the pure capacity classifier (classifyCapacity).
 * No Mongo/HTTP needed — the verdict function is intentionally pure.
 *
 * `snapshotCount` is supplied alongside `utilSampleCount` so the coverage guard
 * (legacy util-bias protection) sees full coverage when util is meant to be trusted.
 */
const {
  classifyCapacity,
  buildCapacityHostIdentity,
  isCapacityHostCritical,
  collectCapacityAlertIdentities,
  recordCapacityCriticalProbe,
  resolveRecoveredCapacityGpuImbalanceAlerts,
  summarizeGpuImbalance,
  VERDICTS,
} = require('../../src/services/hostCapacityService');
const Alert = require('../../models/Alert');

describe('hostCapacityService.summarizeGpuImbalance', () => {
  const live = [
    { index: 0, utilization: 100 },
    { index: 1, utilization: 0 },
  ];

  test('does not call alternating layer-split work an imbalance', () => {
    const result = summarizeGpuImbalance([
      { gpus: [{ index: 0, utilization: 100 }, { index: 1, utilization: 0 }] },
      { gpus: [{ index: 0, utilization: 0 }, { index: 1, utilization: 100 }] },
      { gpus: [{ index: 0, utilization: 100 }, { index: 1, utilization: 0 }] },
      { gpus: [{ index: 0, utilization: 0 }, { index: 1, utilization: 100 }] },
    ], live);

    expect(result).toEqual(expect.objectContaining({
      evidenceReady: true,
      liveSpread: 100,
      spread: 0,
      imbalanced: false,
    }));
  });

  test('detects a sustained hot-card and idle-card split', () => {
    const result = summarizeGpuImbalance([
      { gpus: [{ index: 0, utilization: 95 }, { index: 1, utilization: 5 }] },
      { gpus: [{ index: 0, utilization: 90 }, { index: 1, utilization: 0 }] },
      { gpus: [{ index: 0, utilization: 100 }, { index: 1, utilization: 10 }] },
    ], live);

    expect(result).toEqual(expect.objectContaining({
      evidenceReady: true,
      spread: 90,
      threshold: 60,
      imbalanced: true,
    }));
  });

  test('requires multiple historical samples before classifying', () => {
    const result = summarizeGpuImbalance([
      { gpus: [{ index: 0, utilization: 100 }, { index: 1, utilization: 0 }] },
    ], live);

    expect(result).toEqual(expect.objectContaining({
      sampleCount: 1,
      evidenceReady: false,
      spread: null,
      imbalanced: false,
    }));
  });
});

describe('hostCapacityService.classifyCapacity', () => {
  test('VRAM p95 ≥ 90% → VRAM_CONSTRAINED', () => {
    const r = classifyCapacity({ vramP95Pct: 94, utilSampleCount: 200, snapshotCount: 200, utilP95: 30, utilMean: 20, errorRate: 1 });
    expect(r.verdict).toBe(VERDICTS.VRAM_CONSTRAINED);
  });

  test('a single card ≥ 95% → VRAM_CONSTRAINED even with low fleet VRAM p95', () => {
    const r = classifyCapacity({ vramP95Pct: 70, maxCardVramPct: 96, utilSampleCount: 200, snapshotCount: 200, utilP95: 30, errorRate: 1 });
    expect(r.verdict).toBe(VERDICTS.VRAM_CONSTRAINED);
  });

  test('high error rate + latency spike → VRAM_CONSTRAINED (load failures)', () => {
    const r = classifyCapacity({ vramP95Pct: 60, utilSampleCount: 200, snapshotCount: 200, utilP95: 50, utilMean: 30, errorRate: 15, latencyP95Ms: 40000 });
    expect(r.verdict).toBe(VERDICTS.VRAM_CONSTRAINED);
  });

  test('GPU-util p95 ≥ 85% with full coverage → COMPUTE_SATURATED', () => {
    const r = classifyCapacity({ vramP95Pct: 50, utilSampleCount: 200, snapshotCount: 200, utilP95: 92, utilMean: 70, errorRate: 0 });
    expect(r.verdict).toBe(VERDICTS.COMPUTE_SATURATED);
  });

  test('low util + VRAM headroom + no errors → UNDERUSED (util-based)', () => {
    const r = classifyCapacity({ vramP95Pct: 30, utilSampleCount: 200, snapshotCount: 200, utilP95: 18, utilMean: 4, errorRate: 0, callSharePct: 19 });
    expect(r.verdict).toBe(VERDICTS.UNDERUSED);
  });

  test('util history sparse but low call share + VRAM headroom → UNDERUSED (fallback)', () => {
    // Mirrors Host Gamma before the util zero-preservation fix accrues clean data.
    const r = classifyCapacity({ vramP95Pct: 30, maxCardVramPct: 60, utilSampleCount: 0, snapshotCount: 100, errorRate: 0, callSharePct: 19 });
    expect(r.verdict).toBe(VERDICTS.UNDERUSED);
    expect(r.reasons.join(' ')).toMatch(/call share/i);
  });

  test('COVERAGE GUARD: biased high util p95 but low coverage → NOT saturated (Host Gamma legacy data)', () => {
    // Only 8 of 200 snapshots had non-null util (idle 0% dropped pre-fix) → p95 100 is
    // an artifact. With low call share + VRAM headroom the host is actually UNDERUSED.
    const r = classifyCapacity({ vramP95Pct: 36, utilSampleCount: 8, snapshotCount: 200, utilP95: 100, utilMean: 50, errorRate: 0, callSharePct: 5 });
    expect(r.verdict).toBe(VERDICTS.UNDERUSED);
    expect(r.reasons.join(' ')).toMatch(/coverage/i);
  });

  test('COVERAGE GUARD: high util p95 WITH high coverage → genuinely COMPUTE_SATURATED', () => {
    const r = classifyCapacity({ vramP95Pct: 50, utilSampleCount: 190, snapshotCount: 200, utilP95: 90, utilMean: 75, errorRate: 0, callSharePct: 60 });
    expect(r.verdict).toBe(VERDICTS.COMPUTE_SATURATED);
  });

  test('util sparse but HIGH call share → not UNDERUSED (falls to BALANCED)', () => {
    const r = classifyCapacity({ vramP95Pct: 30, utilSampleCount: 0, snapshotCount: 100, errorRate: 0, callSharePct: 80 });
    expect(r.verdict).toBe(VERDICTS.BALANCED);
  });

  test('mid-range signals → BALANCED', () => {
    const r = classifyCapacity({ vramP95Pct: 55, utilSampleCount: 200, snapshotCount: 200, utilP95: 60, utilMean: 45, errorRate: 0, callSharePct: 40 });
    expect(r.verdict).toBe(VERDICTS.BALANCED);
  });

  test('VRAM constrained takes priority over low utilization', () => {
    const r = classifyCapacity({ vramP95Pct: 95, utilSampleCount: 200, snapshotCount: 200, utilP95: 10, utilMean: 3, errorRate: 0, callSharePct: 5 });
    expect(r.verdict).toBe(VERDICTS.VRAM_CONSTRAINED);
  });

  test('VRAM headroom gate blocks UNDERUSED when VRAM p95 is high-ish', () => {
    // VRAM p95 75% (> headroom 70) with otherwise-idle util → not UNDERUSED.
    const r = classifyCapacity({ vramP95Pct: 75, utilSampleCount: 200, snapshotCount: 200, utilP95: 10, utilMean: 3, errorRate: 0, callSharePct: 5 });
    expect(r.verdict).toBe(VERDICTS.BALANCED);
  });

  test('custom thresholds are honored', () => {
    // Tighten saturation to 50% → util p95 60 now saturates.
    const r = classifyCapacity({ vramP95Pct: 50, utilSampleCount: 200, snapshotCount: 200, utilP95: 60, utilMean: 45 }, { utilSaturatedP95: 50 });
    expect(r.verdict).toBe(VERDICTS.COMPUTE_SATURATED);
  });
});

describe('hostCapacityService critical reachability guard', () => {
  test('capacity host identity prefers configured machine name over stale Host hostId', () => {
    const identity = buildCapacityHostIdentity(
      { id: 'tertiary', name: 'Host Gamma' },
      { hostId: 'primary', hostname: 'Host Gamma' }
    );

    expect(identity).toEqual(expect.objectContaining({
      hostId: 'host-gamma',
      hostname: 'Host Gamma',
      persistedHostId: 'primary',
      hostIdentitySource: 'configured_host_name',
      hostIdentityDrift: expect.objectContaining({
        type: 'host_id_mismatch',
        persisted: 'primary',
        configured: 'host-gamma'
      })
    }));
  });

  test('healthy Ollama probe suppresses stale host-agent offline/service status', () => {
    const report = {
      host: {
        online: true,
        hostAgentOnline: false,
        ollamaReachable: true,
        ollamaUrl: 'http://192.0.2.105:11434',
        hostStatus: 'offline',
        ollamaServiceStatus: 'failed',
      },
    };

    expect(isCapacityHostCritical(report)).toBe(false);
  });

  test('configured Ollama probe failure is critical even if host-agent is online', () => {
    const report = {
      host: {
        online: true,
        hostAgentOnline: true,
        ollamaReachable: false,
        ollamaUrl: 'http://192.0.2.105:11434',
        hostStatus: 'online',
        ollamaServiceStatus: 'running',
      },
    };

    expect(isCapacityHostCritical(report)).toBe(true);
  });

  test('stale critical cleanup includes configured id and host identity aliases', () => {
    const report = {
      input: 'primary',
      host: {
        configId: 'primary',
        hostId: 'host-alpha',
        hostname: 'Host Alpha',
        ollamaUrl: 'http://192.0.2.105:11434',
      },
    };

    expect(collectCapacityAlertIdentities(report, 'primary')).toEqual([
      'primary',
      'host-alpha',
      'Host Alpha',
      'http://192.0.2.105:11434',
    ]);
  });

  test('critical alert emission waits for consecutive down probes and clears on recovery', () => {
    const key = 'unit-transient-host';

    expect(recordCapacityCriticalProbe(key, true, 2)).toEqual({ count: 1, shouldEmit: false });
    expect(recordCapacityCriticalProbe(key, true, 2)).toEqual({ count: 2, shouldEmit: true });
    expect(recordCapacityCriticalProbe(key, false, 2)).toEqual({ count: 0, shouldEmit: false });
    expect(recordCapacityCriticalProbe(key, true, 2)).toEqual({ count: 1, shouldEmit: false });
  });

  test('recovered sustained GPU balance resolves the matching active incident', async () => {
    const updateMany = jest.spyOn(Alert, 'updateMany').mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    const now = new Date('2026-08-18T00:20:00Z');
    const report = {
      input: 'primary',
      host: {
        configId: 'primary',
        hostId: 'ugalien',
        hostname: 'UGAlien',
        ollamaUrl: 'http://192.0.2.199:11434',
      },
    };

    try {
      await expect(resolveRecoveredCapacityGpuImbalanceAlerts(report, 'primary', now))
        .resolves.toEqual({ matchedCount: 1, modifiedCount: 1 });
      expect(updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          ruleId: 'capacity-gpu-imbalance',
          source: 'host-capacity',
          status: 'active',
        }),
        expect.objectContaining({
          $set: expect.objectContaining({
            status: 'resolved',
            'resolution.resolvedAt': now,
            'resolution.resolutionMethod': 'auto-recovery',
          }),
        })
      );
    } finally {
      updateMany.mockRestore();
    }
  });
});
