const PipelineTask = require('../../models/PipelineTask');

describe('pipeline automation evidence model', () => {
  test('Mongo preserves independent local route and retry receipts with unknown money', async () => {
    const task = await PipelineTask.create({ pipelineId: '0777', title: 'Local route receipt fixture',
      automationAttempts: [{ leaseId: 'local-lease', assignee: 'worker', attempt: 1,
        acquiredAt: new Date(), heartbeatAt: new Date(), expiresAt: new Date(Date.now() + 60000),
        evidence: { schema: 'agentx.pipeline-automation-evidence/v1', verification: { status: 'passed' },
          changes: { filesChanged: 1, bytesChanged: 20 }, usage: { costNanodollars: null, costStatus: 'unknown' },
          routing: { status: 'verified', provider: 'ollama', effectiveModel: 'model', requestCount: 2,
            sessionCallCount: 2, evidenceFingerprint: 'a'.repeat(64) },
          inference: { state: 'completed', attempts: 2, history: [{ attempt: 1, cause: 'inference_active', delayMs: 2000 }] },
          workerReceiptFingerprint: 'b'.repeat(64), failureCodes: [] } }] });
    const saved = await PipelineTask.findById(task._id).lean();
    expect(saved.automationAttempts[0].evidence).toMatchObject({ usage: { costNanodollars: null, costStatus: 'unknown' },
      routing: { provider: 'ollama', requestCount: 2, sessionCallCount: 2 }, inference: { state: 'completed', attempts: 2 } });
    await PipelineTask.deleteOne({ _id: task._id });
  });

  test('persists partial evidence without inventing missing measurements', () => {
    const task = new PipelineTask({
      pipelineId: '0576',
      title: 'Coding Dispatcher v1',
      automationAttempts: [{
        leaseId: 'lease-1',
        assignee: 'worker-1',
        attempt: 1,
        acquiredAt: new Date('2026-09-01T00:00:00.000Z'),
        heartbeatAt: new Date('2026-09-01T00:01:00.000Z'),
        expiresAt: new Date('2026-09-01T00:10:00.000Z'),
        evidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: {
            status: 'passed',
            durationMs: 1200,
            testsPassed: null,
            testsFailed: null,
          },
          changes: { filesChanged: 3, bytesChanged: null },
          usage: { durationMs: 4500, costNanodollars: null },
          failureCodes: [],
        },
      }],
    });

    expect(task.validateSync()).toBeUndefined();
    const evidence = task.toObject().automationAttempts[0].evidence;
    expect(evidence.usage.costNanodollars).toBeNull();
    expect(evidence.usage.costKind).toBeNull();
    expect(evidence.verification.testsPassed).toBeNull();
    expect(evidence.failureCodes).toEqual([]);
  });

  test('persists the explicit nature and provenance of complete cost evidence', () => {
    const task = new PipelineTask({
      pipelineId: '0581',
      title: 'Zero-provider-spend canary',
      automationAttempts: [{
        leaseId: 'lease-2',
        assignee: 'worker-1',
        attempt: 1,
        acquiredAt: new Date('2026-09-01T00:00:00.000Z'),
        heartbeatAt: new Date('2026-09-01T00:01:00.000Z'),
        expiresAt: new Date('2026-09-01T00:10:00.000Z'),
        evidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'passed' },
          changes: {},
          usage: {
            costNanodollars: 0,
            costKind: 'provider-spend',
            costSource: 'openclaw-local-provider-spend/v1',
            costEvidenceFingerprint: 'a'.repeat(64),
          },
          failureCodes: [],
        },
      }],
    });

    expect(task.validateSync()).toBeUndefined();
    expect(task.toObject().automationAttempts[0].evidence.usage).toMatchObject({
      costNanodollars: 0,
      costKind: 'provider-spend',
      costSource: 'openclaw-local-provider-spend/v1',
    });
  });

  test('persists local energy separately from an optional currency-bound tariff', () => {
    const task = new PipelineTask({
      pipelineId: '0592',
      title: 'Measured coding energy',
      automationAttempts: [{
        leaseId: 'lease-energy',
        assignee: 'worker-1',
        attempt: 1,
        acquiredAt: new Date('2026-09-01T00:00:00.000Z'),
        heartbeatAt: new Date('2026-09-01T00:01:00.000Z'),
        expiresAt: new Date('2026-09-01T00:10:00.000Z'),
        evidence: {
          schema: 'agentx.pipeline-automation-evidence/v1',
          verification: { status: 'passed' },
          changes: {},
          usage: {
            localEnergy: {
              measurementScope: 'gpu-incremental-lower-bound',
              energyMillijoules: 3_600_000,
              measurementDurationMs: 60_000,
              sampleCount: 60,
              baselineMilliwatts: 48_000,
              source: 'nvidia-smi-baseline-integral/v1',
              evidenceFingerprint: 'b'.repeat(64),
              tariff: {
                currency: 'CAD',
                rateNanoCurrencyUnitsPerKwh: 100_000_000,
                estimatedCostNanoCurrencyUnits: 100_000,
                source: 'operator-configured-electricity-tariff/v1',
                evidenceFingerprint: 'c'.repeat(64),
              },
            },
          },
          failureCodes: [],
        },
      }],
    });

    expect(task.validateSync()).toBeUndefined();
    expect(task.toObject().automationAttempts[0].evidence.usage.localEnergy).toMatchObject({
      energyMillijoules: 3_600_000,
      tariff: { currency: 'CAD', estimatedCostNanoCurrencyUnits: 100_000 },
    });
  });

  test('indexes the attempt timestamp used by performance windows', () => {
    const indexes = PipelineTask.schema.indexes().map(([keys]) => keys);
    expect(indexes).toContainEqual({ 'automationAttempts.acquiredAt': 1 });
  });
});
