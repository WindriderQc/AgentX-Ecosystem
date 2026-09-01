'use strict';

const {
  PERFORMANCE_SCHEMA,
  buildPipelineAutomationPerformance,
} = require('../../src/services/pipelineAutomationPerformanceService');

describe('pipeline automation performance service', () => {
  test('aggregates accepted and blocked attempts while keeping partial cost unknown', () => {
    const performance = buildPipelineAutomationPerformance([
      {
        pipelineId: '0700',
        createdAt: '2026-08-20T09:00:00.000Z',
        automation: { policyRef: 'default.low-risk/v1', executionProfile: 'worker/v1' },
        automationAttempts: [{
          leaseId: 'lease-1',
          assignee: 'worker-a',
          attempt: 1,
          acquiredAt: '2026-08-20T10:00:00.000Z',
          completedAt: '2026-08-20T10:10:00.000Z',
          reviewedAt: '2026-08-20T10:20:00.000Z',
          finalState: 'review',
          reviewOutcome: 'accepted',
          evidence: {
            verification: { status: 'passed', durationMs: 120000, testsPassed: 20, testsFailed: 0 },
            changes: { filesChanged: 2, bytesChanged: 3000 },
            usage: {
              durationMs: 600000,
              costNanodollars: 0,
              costKind: 'provider-spend',
              costSource: 'openclaw-local-provider-spend/v1',
              costEvidenceFingerprint: 'a'.repeat(64),
            },
            failureCodes: [],
          },
        }],
      },
      {
        pipelineId: '0701',
        createdAt: '2026-08-21T09:00:00.000Z',
        automationAttempts: [{
          leaseId: 'lease-2',
          assignee: 'worker-b',
          attempt: 1,
          acquiredAt: '2026-08-21T09:05:00.000Z',
          completedAt: '2026-08-21T09:15:00.000Z',
          finalState: 'blocked',
          evidence: {
            verification: { status: 'failed', durationMs: 1000 },
            changes: { filesChanged: null, bytesChanged: null },
            usage: { durationMs: 600000, costNanodollars: null },
            failureCodes: ['protected_scope'],
          },
        }],
      },
    ], { now: '2026-09-01T00:00:00.000Z', windowDays: 30 });

    expect(performance.schema).toBe(PERFORMANCE_SCHEMA);
    expect(performance.state).toBe('partial');
    expect(performance.counts).toMatchObject({
      tasks: 2,
      attempts: 2,
      accepted: 1,
      blocked: 1,
    });
    expect(performance.quality).toMatchObject({
      decided: 1,
      acceptanceRate: 1,
      firstPassAccepted: 1,
      firstPassShare: 1,
      verificationPassed: 1,
      verificationFailed: 1,
      verificationPassRate: 0.5,
    });
    expect(performance.autonomy).toMatchObject({ safetyBlocks: 1, correctiveHumanInterventions: 0 });
    expect(performance.timing).toMatchObject({
      queueMs: { observed: 2, p50: 300000, p95: 3600000 },
      executionMs: { observed: 2, p50: 600000, p95: 600000 },
      reviewMs: { observed: 1, p50: 600000, p95: 600000 },
      cycleMs: { observed: 1, p50: 4800000, p95: 4800000 },
    });
    expect(performance.usage).toMatchObject({
      observedCostNanodollars: 0,
      totalCostNanodollars: null,
      costAggregateKind: 'provider-spend',
      observedProviderSpendNanodollars: 0,
      observedSessionEstimateNanodollars: null,
      filesChanged: 2,
      bytesChanged: 3000,
    });
    expect(performance.coverage).toEqual({
      attemptEvidence: 2,
      verification: 2,
      changes: 1,
      cost: 1,
      providerSpend: 1,
      sessionEstimate: 0,
      review: 1,
      total: 2,
    });
    expect(performance.attempts[0].unknown).toEqual(['change', 'cost', 'review']);
  });

  test('keeps provider spend separate from billing-unverified session estimates', () => {
    const attempts = [
      {
        pipelineId: '0702',
        createdAt: '2026-08-22T09:00:00.000Z',
        automationAttempts: [{
          assignee: 'worker-a', attempt: 1,
          acquiredAt: '2026-08-22T10:00:00.000Z',
          completedAt: '2026-08-22T10:01:00.000Z',
          finalState: 'review',
          evidence: {
            verification: { status: 'passed' }, changes: {}, failureCodes: [],
            usage: {
              costNanodollars: 0,
              costKind: 'provider-spend',
              costSource: 'openclaw-local-provider-spend/v1',
              costEvidenceFingerprint: 'b'.repeat(64),
            },
          },
        }],
      },
      {
        pipelineId: '0703',
        createdAt: '2026-08-23T09:00:00.000Z',
        automationAttempts: [{
          assignee: 'worker-b', attempt: 1,
          acquiredAt: '2026-08-23T10:00:00.000Z',
          completedAt: '2026-08-23T10:01:00.000Z',
          finalState: 'review',
          evidence: {
            verification: { status: 'passed' }, changes: {}, failureCodes: [],
            usage: {
              costNanodollars: 125971320,
              costKind: 'session-estimate',
              costSource: 'openclaw-session-usage/v1',
              costEvidenceFingerprint: 'c'.repeat(64),
            },
          },
        }],
      },
    ];
    const performance = buildPipelineAutomationPerformance(attempts, {
      now: '2026-09-01T00:00:00.000Z', windowDays: 30,
    });

    expect(performance.usage).toMatchObject({
      costAggregateKind: 'mixed',
      observedCostNanodollars: null,
      totalCostNanodollars: null,
      observedProviderSpendNanodollars: 0,
      observedSessionEstimateNanodollars: 125971320,
    });
    expect(performance.coverage).toMatchObject({
      cost: 2,
      providerSpend: 1,
      sessionEstimate: 1,
    });
  });

  test('reports no data without fabricating rates, timings, or costs', () => {
    const performance = buildPipelineAutomationPerformance([], {
      now: '2026-09-01T00:00:00.000Z',
      windowDays: 7,
    });

    expect(performance.state).toBe('no_data');
    expect(performance.counts.attempts).toBe(0);
    expect(performance.quality.acceptanceRate).toBeNull();
    expect(performance.timing.cycleMs.p50).toBeNull();
    expect(performance.usage.totalCostNanodollars).toBeNull();
    expect(performance.usage.observedCostNanodollars).toBeNull();
  });
});
