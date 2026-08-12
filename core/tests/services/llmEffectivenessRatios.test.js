'use strict';

jest.mock('../../models/LlmOutcome', () => ({ find: () => ({ lean: async () => [] }) }));
jest.mock('../../models/PipelineTask', () => ({ find: () => ({ lean: async () => [] }) }));
jest.mock('../../models/InferenceLog', () => ({ find: () => ({ lean: async () => [] }) }));

const { buildEffectivenessSnapshot } = require('../../src/services/llmEffectivenessService');

const window = { key: '30d', from: new Date('2026-07-01'), to: new Date('2026-08-01') };
const task = (pipelineId) => ({
  pipelineId, assignee: 'codex', status: 'done', updatedAt: new Date('2026-07-15')
});
let seq = 0;
const log = (workItemId, tokensIn, tokensOut, durationMs, extra = {}) => ({
  _id: `log-${++seq}`, workItemId, correlationId: null, model: 'm', caller: 'proxy',
  tokensIn, tokensOut, durationMs, status: 'success',
  timestamp: new Date('2026-07-15'), ...extra
});

const build = (tasks, logs) => buildEffectivenessSnapshot({
  outcomes: [], pipelineTasks: tasks, inferenceLogs: logs, window
}).summary;

describe('per-outcome effectiveness ratios', () => {
  const tasks = ['0301', '0302', '0303', '0304'].map(task);

  test('reports a ratio over the attributed subset instead of demanding full coverage', () => {
    // Two of four productive outcomes carry matching inference logs. The old
    // gate required attributedOutcomes === combined.length and rendered null.
    const s = build(tasks, [log('0301', 1000, 500, 60_000), log('0302', 3000, 1500, 120_000)]);

    expect(s.productiveOutcomes).toBe(4);
    expect(s.attributionCoveragePct).toBe(50);
    expect(s.perOutcomeSampleSize).toBe(2);
    // 6000 tokens over the 2 outcomes that actually have usage — not over all 4,
    // which would understate the real cost of an outcome by half.
    expect(s.tokensPerProductiveOutcome).toBe(3000);
    expect(s.inferenceMinutesPerProductiveOutcome).toBe(1.5);
  });

  test('stays null with no attribution rather than reporting 0', () => {
    const s = build(tasks, []);
    expect(s.perOutcomeSampleSize).toBe(0);
    expect(s.tokensPerProductiveOutcome).toBeNull();
    expect(s.inferenceMinutesPerProductiveOutcome).toBeNull();
    expect(s.attributionCoveragePct).toBe(0);
  });

  test('cost stays null when no outcome reports a cost, and says so via the sample size', () => {
    // derivePipelineOutcomes hard-codes costUsd null, so this is the live case.
    const s = build(tasks, [log('0301', 10, 10, 1000)]);
    expect(s.costSampleSize).toBe(0);
    expect(s.costPerProductiveOutcomeUsd).toBeNull();
  });

  test('separates infrastructure tokens from real unlinked work', () => {
    const s = buildEffectivenessSnapshot({
      outcomes: [], pipelineTasks: tasks, window,
      inferenceLogs: [
        log('0301', 1000, 500, 60_000),                        // attributed
        log(null, 40, 0, 500, { caller: 'embedding' }),         // infrastructure
        log(null, 60, 0, 500, { caller: 'classification' }),    // infrastructure
        log(null, 2000, 1000, 30_000)                           // real work, unlinked
      ]
    }).waste;

    expect(s.unattributedTokens).toBe(3100);
    expect(s.unattributableTokens).toBe(100);
    // The number worth acting on: work that could carry a work item and doesn't.
    expect(s.unlinkedWorkTokens).toBe(3000);
  });
});
