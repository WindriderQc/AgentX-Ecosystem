'use strict';

const {
  buildEffectivenessSnapshot,
  derivePipelineOutcomes,
  normalizeOutcomeInput,
  normalizeWindow,
  pipelineRuntime,
} = require('../../src/services/llmEffectivenessService');
const { telemetryContextFromRequest } = require('../../src/helpers/llmTelemetryContext');

function outcome(overrides = {}) {
  return {
    outcomeId: 'outcome-1',
    workItemId: '0401',
    correlationId: 'corr-1',
    runtime: 'codex',
    source: 'test',
    outcomeType: 'task',
    verdict: 'success',
    verified: true,
    verificationMethod: 'automated-tests',
    attempts: 1,
    reworkCount: 0,
    humanInterventionMinutes: 2,
    usage: { source: 'none', totalTokens: 0, inferenceMs: 0, costUsd: null },
    completedAt: new Date('2026-07-17T12:00:00Z'),
    ...overrides,
  };
}

const window = normalizeWindow('7d', Date.parse('2026-07-17T13:00:00Z'));

describe('llmEffectivenessService', () => {
  test('uses source-owned reported usage instead of adding matching AgentX logs', () => {
    const snapshot = buildEffectivenessSnapshot({
      window,
      outcomes: [outcome({
        usage: { source: 'codex', totalTokens: 100, inferenceMs: 1_000, costUsd: 0.01 },
      })],
      inferenceLogs: [{
        _id: 'log-1',
        runtime: 'codex',
        correlationId: 'corr-1',
        workItemId: '0401',
        tokensIn: 80,
        tokensOut: 20,
        durationMs: 1_000,
        status: 'success',
      }],
    });

    expect(snapshot.summary.tokensPerProductiveOutcome).toBe(100);
    expect(snapshot.summary.costPerProductiveOutcomeUsd).toBe(0.01);
    expect(snapshot.waste.totalInferenceTokens).toBe(100);
    expect(snapshot.waste.unattributedTokens).toBe(100);
    expect(snapshot.coverage.usageAttribution).toMatch(/never both/);
  });

  test('attributes matching inference logs once across outcomes', () => {
    const snapshot = buildEffectivenessSnapshot({
      window,
      outcomes: [
        outcome(),
        outcome({ outcomeId: 'outcome-2', workItemId: '0402', correlationId: 'corr-1' }),
      ],
      inferenceLogs: [{
        _id: 'log-1',
        runtime: 'codex',
        correlationId: 'corr-1',
        tokensIn: 50,
        tokensOut: 10,
        durationMs: 2_000,
        status: 'success',
      }],
    });

    expect(snapshot.summary.attributionCoveragePct).toBe(50);
    expect(snapshot.byRuntime[0].tokens).toBe(60);
    expect(snapshot.waste.unattributedTokens).toBe(0);
  });

  test('keeps pipeline-derived outcomes verified but out of first-pass samples', () => {
    const tasks = [{
      pipelineId: '0403',
      status: 'done',
      assignee: 'codex-worker',
      updatedAt: new Date('2026-07-17T12:00:00Z'),
    }];
    const derived = derivePipelineOutcomes(tasks, new Set());
    const snapshot = buildEffectivenessSnapshot({ window, pipelineTasks: tasks });

    expect(derived).toHaveLength(1);
    expect(derived[0].runtime).toBe('codex');
    expect(snapshot.summary.productiveOutcomes).toBe(1);
    expect(snapshot.summary.firstPassSuccessRatePct).toBeNull();
    expect(snapshot.coverage.pipelineDerivedOutcomes).toBe(1);
  });

  test('joins OpenClaw pipeline work to server-attested external-runtime inference', () => {
    const tasks = [{
      pipelineId: '0404',
      status: 'done',
      assignee: 'clawdx-coder',
      updatedAt: new Date('2026-07-17T12:00:00Z'),
    }];
    const snapshot = buildEffectivenessSnapshot({
      window,
      pipelineTasks: tasks,
      inferenceLogs: [{
        _id: 'log-openclaw',
        runtime: 'external',
        callerDetail: 'openclaw-pipeline-runtime-bridge',
        workItemId: '0404',
        correlationId: 'pipeline:0404:lease-1',
        tokensIn: 90,
        tokensOut: 10,
        durationMs: 1_500,
        status: 'success',
      }],
    });

    expect(snapshot.summary.reportedOutcomes).toBe(1);
    expect(snapshot.summary.attributionCoveragePct).toBe(100);
    expect(snapshot.waste.unattributedTokens).toBe(0);
    expect(snapshot.byRuntime).toEqual(expect.arrayContaining([
      expect.objectContaining({ runtime: 'external', tokens: 100 }),
    ]));
  });

  test('includes review and blocked pipeline work without pretending it is verified success', () => {
    const tasks = [
      { pipelineId: '0405', status: 'review', assignee: 'codex', updatedAt: new Date() },
      { pipelineId: '0406', status: 'blocked', assignee: 'claude-code', updatedAt: new Date() },
    ];
    const snapshot = buildEffectivenessSnapshot({ window, pipelineTasks: tasks });
    expect(snapshot.summary.reportedOutcomes).toBe(2);
    expect(snapshot.summary.verifiedOutcomes).toBe(0);
    expect(snapshot.summary.productiveOutcomes).toBe(0);
    expect(snapshot.summary.verificationRatePct).toBe(0);
  });

  test('measures productivity across all outcomes and leaves unattributed efficiency unknown', () => {
    const snapshot = buildEffectivenessSnapshot({
      window,
      outcomes: [
        outcome(),
        outcome({ outcomeId: 'outcome-2', verdict: 'failure', verified: false }),
      ],
    });

    expect(snapshot.summary.productivityRatePct).toBe(50);
    expect(snapshot.summary.tokensPerProductiveOutcome).toBeNull();
    expect(snapshot.summary.inferenceMinutesPerProductiveOutcome).toBeNull();
    expect(snapshot.byRuntime[0].productivityRatePct).toBe(50);
  });

  test('reports rework, failures, fallbacks, and attribution confidence separately', () => {
    const snapshot = buildEffectivenessSnapshot({
      window,
      outcomes: [outcome({ verdict: 'partial', reworkCount: 2, attempts: 3 })],
      inferenceLogs: [{
        _id: 'log-1',
        runtime: 'codex',
        workItemId: '0401',
        tokensIn: 10,
        tokensOut: 5,
        durationMs: 300,
        status: 'error',
        fallbackUsed: true,
      }],
    });

    expect(snapshot.summary.reworkRatePct).toBe(100);
    expect(snapshot.waste.failedInferenceRatePct).toBe(100);
    expect(snapshot.waste.fallbackRatePct).toBe(100);
    expect(snapshot.signal.signal).toBe('needs-attention');
  });

  test('normalizes an idempotent privacy-safe outcome and rejects prompt content', () => {
    const normalized = normalizeOutcomeInput({
      outcomeId: 'deploy:abc',
      runtime: 'agentx',
      verdict: 'success',
      verified: true,
      verificationMethod: 'deployment',
      usage: { totalTokens: 50 },
    });
    expect(normalized.usage.source).toBe('reported');
    expect(normalized.usage.totalTokens).toBe(50);
    expect(() => normalizeOutcomeInput({
      outcomeId: 'bad', runtime: 'agentx', verdict: 'success', prompt: 'private',
    })).toThrow(/must not include prompt/);
  });

  test('classifies only product-recognized runtime ownership', () => {
    expect(pipelineRuntime('codex')).toBe('codex');
    expect(pipelineRuntime('claude-code')).toBe('claude-code');
    expect(pipelineRuntime('terminal-ops')).toBe('agentx');
    expect(pipelineRuntime('clawdx-coder')).toBe('external');
    expect(pipelineRuntime('openclaw-worker')).toBe('external');
    expect(pipelineRuntime('external-worker')).toBe('other');
    expect(pipelineRuntime('Example User')).toBe('other');
  });

  test('extracts correlation metadata while the route remains runtime authority', () => {
    const req = {
      body: { telemetry: { workItemId: '0404', attempt: 2 } },
      correlationId: 'corr-4',
      get: () => null,
    };
    expect(telemetryContextFromRequest(req, 'external')).toEqual({
      runtime: 'external',
      correlationId: 'corr-4',
      workItemId: '0404',
      attempt: 2,
    });
  });
});
