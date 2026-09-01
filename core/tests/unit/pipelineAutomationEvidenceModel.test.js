const PipelineTask = require('../../models/PipelineTask');

describe('pipeline automation evidence model', () => {
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

  test('indexes the attempt timestamp used by performance windows', () => {
    const indexes = PipelineTask.schema.indexes().map(([keys]) => keys);
    expect(indexes).toContainEqual({ 'automationAttempts.acquiredAt': 1 });
  });
});
