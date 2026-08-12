'use strict';

jest.mock('../../../config/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn()
}));
jest.mock('../../../models/BenchmarkResult', () => ({}));
jest.mock('../../../models/BenchmarkBatch', () => ({}));
jest.mock('../../../models/BenchmarkTimelineEntry', () => ({}));
jest.mock('../../../models/JudgeQueueEntry', () => ({ create: jest.fn() }));
jest.mock('../../../src/services/qualityScorer', () => ({ JUDGE_CONFIG: { model: 'judge:latest', num_ctx: 8192 } }));
jest.mock('../../../src/services/benchmark/modelWarmup', () => ({ warmupModel: jest.fn() }));
jest.mock('../../../src/services/benchmark/judging', () => ({ judgeResult: jest.fn() }));
jest.mock('../../../src/services/benchmark/judgeHostResolution', () => ({ resolveJudgeHost: jest.fn() }));
jest.mock('../../../src/services/modelContextResolver', () => ({ resolveModelNumCtxDetails: jest.fn() }));
jest.mock('../../../src/services/benchmark/errorClassifier', () => ({ classifyBenchmarkError: jest.fn() }));

const { createJudgeOrchestrator } = require('../../../src/services/benchmark/judgeOrchestration');

describe('live-pipeline multi-judge escalation budget', () => {
  const baseArgs = {
    batchId: 'batch-1',
    judgeQueue: { waitForCapacity: jest.fn(), add: jest.fn() },
    executionConfig: {},
    recordBatchTimelineEvent: jest.fn(),
    setBatchPhase: jest.fn()
  };

  it('initializes _escalation from escalation_budget_percent and expected count', () => {
    const judgeConfig = {
      model: 'judge:latest',
      multi_judge: { enabled: true, judges: ['a', 'b'], escalation_budget_percent: 25 }
    };
    createJudgeOrchestrator({ ...baseArgs, judgeConfig, expectedJudgeCount: 40 });

    expect(judgeConfig.multi_judge._escalation).toEqual({ budget: 10, used: 0 });
  });

  it('defaults to a 20% budget when no percent is configured', () => {
    const judgeConfig = { multi_judge: { enabled: true, judges: ['a', 'b'] } };
    createJudgeOrchestrator({ ...baseArgs, judgeConfig, expectedJudgeCount: 100 });

    expect(judgeConfig.multi_judge._escalation).toEqual({ budget: 20, used: 0 });
  });

  it('uses an unlimited budget at 100 percent', () => {
    const judgeConfig = { multi_judge: { enabled: true, judges: ['a', 'b'], escalation_budget_percent: 100 } };
    createJudgeOrchestrator({ ...baseArgs, judgeConfig, expectedJudgeCount: 100 });

    expect(judgeConfig.multi_judge._escalation.budget).toBe(Infinity);
  });

  it('does not touch disabled or absent multi_judge config', () => {
    const disabled = { multi_judge: { enabled: false } };
    createJudgeOrchestrator({ ...baseArgs, judgeConfig: disabled, expectedJudgeCount: 10 });
    expect(disabled.multi_judge._escalation).toBeUndefined();

    const absent = { model: 'judge:latest' };
    expect(() => createJudgeOrchestrator({ ...baseArgs, judgeConfig: absent, expectedJudgeCount: 10 })).not.toThrow();
  });

  it('preserves an existing _escalation object (idempotent re-init)', () => {
    const escalation = { budget: 5, used: 3 };
    const judgeConfig = { multi_judge: { enabled: true, judges: ['a', 'b'], _escalation: escalation } };
    createJudgeOrchestrator({ ...baseArgs, judgeConfig, expectedJudgeCount: 100 });

    expect(judgeConfig.multi_judge._escalation).toBe(escalation);
  });
});
