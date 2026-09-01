'use strict';

const mockExecuteHarnessTarget = jest.fn();

jest.mock('../../../config/logger', () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
}));
jest.mock('../../../src/services/benchmark/harnessBrokerClient', () => ({
    executeHarnessTarget: mockExecuteHarnessTarget
}));

const { scoreResponse } = require('../../../src/services/qualityScorer');

const judgeTarget = {
    executionKind: 'harness',
    harness: { name: 'qualified-judge-harness' },
    model: 'qualified-judge'
};

const privateReceipt = { fingerprint: 'a'.repeat(64), private: true };

function successfulJudgeExecution(overrides = {}) {
    return {
        output: JSON.stringify({ overall: 8, explanation: 'bounded judge result' }),
        finishReason: 'stop',
        receipt: privateReceipt,
        publicReceipt: { fingerprint: 'b'.repeat(64) },
        outputFingerprint: 'c'.repeat(64),
        ...overrides
    };
}

beforeEach(() => {
    mockExecuteHarnessTarget.mockReset();
    mockExecuteHarnessTarget.mockResolvedValue(successfulJudgeExecution());
});

test('strict Trust scoring bypasses deterministic routing and retains the private judge receipt', async () => {
    const result = await scoreResponse({
        response: '6',
        prompt: {
            name: 'deterministic-math-control',
            prompt: 'Solve 7x = 42.',
            scoring_type: 'math',
            category: 'math',
            expected_answer: '6',
            level: 3
        },
        judgeConfig: {
            target: judgeTarget,
            batch_id: 'batch-id',
            batch_contract_fingerprint: 'd'.repeat(64),
            require_trust_worker_receipt: true,
            max_retries: 0
        }
    });

    expect(mockExecuteHarnessTarget).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
        scoring_method: 'llm_judge',
        trust_judge_receipt: privateReceipt,
        judge_target: judgeTarget
    });
});

test('strict Trust scoring fails closed when the harness omits its private receipt', async () => {
    mockExecuteHarnessTarget.mockResolvedValue(successfulJudgeExecution({ receipt: null }));

    await expect(scoreResponse({
        response: 'candidate response',
        prompt: { prompt: 'Evaluate this.', scoring_type: 'knowledge' },
        judgeConfig: {
            target: judgeTarget,
            batch_id: 'batch-id',
            batch_contract_fingerprint: 'd'.repeat(64),
            require_trust_worker_receipt: true,
            max_retries: 0
        }
    })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_JUDGE_RECEIPT_MISSING' });
});
