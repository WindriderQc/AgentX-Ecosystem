const {
  PIPELINE_AUTOMATION_SCHEMA,
  PIPELINE_AUTOMATION_EVIDENCE_SCHEMA,
  normalizePipelineAutomationIntent,
  normalizePipelineAutomationEvidence,
  automationAdmissionReasons,
} = require('../../../shared/pipelineAutomationContract');

function intent(overrides = {}) {
  return {
    schema: PIPELINE_AUTOMATION_SCHEMA,
    mode: 'review_only',
    policyRef: 'default.low-risk/v1',
    dataClassification: 'public',
    operations: ['create', 'update'],
    scope: ['core/src/example.js'],
    lockKeys: ['repo:core/example'],
    executionProfile: 'workspace-write/v1',
    verificationProfile: 'core-unit/v1',
    budgets: {
      maxDurationMs: 60000,
      maxAttempts: 2,
      maxCostNanodollars: 0,
    },
    humanGates: ['review', 'merge', 'deploy'],
    ...overrides,
  };
}

describe('pipeline automation contract', () => {
  test('normalizes stable set-like fields and verifies the fingerprint', () => {
    const normalized = normalizePipelineAutomationIntent(intent({
      humanGates: ['review', 'deploy', 'merge'],
      scope: ['core/tests/example.test.js', 'core/src/example.js'],
    }));
    const replay = normalizePipelineAutomationIntent({ ...normalized });

    expect(replay).toEqual(normalized);
    expect(normalized.scope).toEqual(['core/src/example.js', 'core/tests/example.test.js']);
    expect(normalized.fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  test('manual intent is explicit and carries no executable policy', () => {
    expect(normalizePipelineAutomationIntent({
      schema: PIPELINE_AUTOMATION_SCHEMA,
      mode: 'manual',
    })).toMatchObject({ mode: 'manual' });
  });

  test('matches the deployment-side canonical fingerprint fixture', () => {
    const normalized = normalizePipelineAutomationIntent({
      schema: PIPELINE_AUTOMATION_SCHEMA,
      mode: 'review_only',
      policyRef: 'aiops.low-risk-code/v1',
      dataClassification: 'internal',
      operations: ['update', 'create'],
      scope: ['scripts/coding-dispatcher.py', 'docs/operations/CODING_DISPATCHER_V1.md'],
      lockKeys: ['repo:aiops:dispatcher'],
      executionProfile: 'clawdx-file-tools/v1',
      verificationProfile: 'aiops-dispatcher-tests/v1',
      budgets: { maxDurationMs: 900000, maxAttempts: 2, maxCostNanodollars: 0 },
      humanGates: ['review', 'merge', 'deploy'],
    });

    expect(normalized.fingerprint).toBe('ddb06a9a4ea23df1f31972a5ac004b14a7ae1cfa10ef3f1af815eb0523a62d04');
  });

  test('rejects path traversal, duplicate locks, missing human gates, and fingerprint drift', () => {
    expect(() => normalizePipelineAutomationIntent(intent({ scope: ['../secret'] })))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTOMATION_INTENT' }));
    expect(() => normalizePipelineAutomationIntent(intent({ lockKeys: ['repo:a', 'repo:a'] })))
      .toThrow(expect.objectContaining({ code: 'INVALID_AUTOMATION_INTENT' }));
    expect(() => normalizePipelineAutomationIntent(intent({ humanGates: ['review', 'merge', 'protected_change'] })))
      .toThrow(expect.objectContaining({ code: 'AUTOMATION_HUMAN_GATE_REQUIRED' }));

    const normalized = normalizePipelineAutomationIntent(intent());
    expect(() => normalizePipelineAutomationIntent({ ...normalized, policyRef: 'changed/v1' }))
      .toThrow(expect.objectContaining({ code: 'AUTOMATION_FINGERPRINT_MISMATCH' }));
  });

  test('returns machine-readable fail-closed admission reasons', () => {
    const automation = normalizePipelineAutomationIntent(intent({
      scope: ['config/release.env'],
      lockKeys: ['repo:release'],
    }));
    const reasons = automationAdmissionReasons({
      pipelineId: '0700',
      status: 'queued',
      assignee: null,
      risk: 'medium',
      dependsOn: ['0699'],
      automation,
      automationAttemptCount: 2,
    }, {
      dependencyStatuses: { '0699': 'review' },
      activeLockKeys: ['repo:release'],
      protectedPathPrefixes: ['config/'],
      now: new Date('2026-09-01T00:00:00Z'),
    });

    expect(reasons.map((reason) => reason.code)).toEqual([
      'risk_not_low',
      'dependencies_incomplete',
      'attempt_budget_exhausted',
      'resource_lock_conflict',
      'protected_scope',
    ]);
  });

  test('normalizes partial attempt evidence without converting unknown metrics to zero', () => {
    const evidence = normalizePipelineAutomationEvidence({
      schema: PIPELINE_AUTOMATION_EVIDENCE_SCHEMA,
      verification: { status: 'passed', durationMs: 1200, testsPassed: 18 },
      changes: { filesChanged: 2, bytesChanged: 4096 },
      usage: { durationMs: 65000 },
      failureCodes: [],
      source: 'clawdx-guarded/v1',
    });

    expect(evidence).toMatchObject({
      verification: { status: 'passed', durationMs: 1200, testsPassed: 18, testsFailed: null },
      changes: { filesChanged: 2, bytesChanged: 4096 },
      usage: { durationMs: 65000, costNanodollars: null },
      workerReceiptFingerprint: null,
    });
  });

  test('rejects malformed attempt metrics, failure codes, and receipt fingerprints', () => {
    const base = {
      schema: PIPELINE_AUTOMATION_EVIDENCE_SCHEMA,
      verification: { status: 'unknown' },
      changes: {},
      usage: {},
    };
    expect(() => normalizePipelineAutomationEvidence({
      ...base,
      changes: { filesChanged: -1 },
    })).toThrow(/filesChanged/);
    expect(() => normalizePipelineAutomationEvidence({
      ...base,
      failureCodes: ['raw failure with spaces'],
    })).toThrow(/bounded identifier/);
    expect(() => normalizePipelineAutomationEvidence({
      ...base,
      workerReceiptFingerprint: 'not-a-digest',
    })).toThrow(/SHA-256/);
  });
});
