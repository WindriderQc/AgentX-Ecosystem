'use strict';

const mockFindLean = jest.fn();

jest.mock('../../../models/JudgeQueueEntry', () => ({
    find: jest.fn(() => ({ lean: mockFindLean })),
    updateOne: jest.fn()
}));
jest.mock('../../../src/services/benchmark/judging', () => ({
    judgeResult: jest.fn()
}));
jest.mock('../../../src/services/benchmark/workloadAdmissionLifecycle', () => ({
    runManagedWorkload: jest.fn()
}));
jest.mock('../../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

const JudgeQueueEntry = require('../../../models/JudgeQueueEntry');
const { judgeResult } = require('../../../src/services/benchmark/judging');
const { runManagedWorkload } = require('../../../src/services/benchmark/workloadAdmissionLifecycle');
const { recoverJudgeQueue } = require('../../../src/services/benchmark/judgeQueueRecovery');

const ENTRY = Object.freeze({
    _id: 'queue-1',
    batchId: 'batch-1',
    resultId: 'result-1',
    status: 'pending',
    judgeConfig: { host: 'http://judge.test:11434', model: 'judge:model' }
});

describe('judge queue startup recovery workload admission', () => {
    let signal;
    let assertActive;

    beforeEach(() => {
        jest.clearAllMocks();
        signal = new AbortController().signal;
        assertActive = jest.fn(() => true);
        mockFindLean.mockResolvedValue([{ ...ENTRY }]);
        JudgeQueueEntry.updateOne.mockResolvedValue({ matchedCount: 1 });
        judgeResult.mockResolvedValue({ quality_score: 8 });
        runManagedWorkload.mockImplementation(async (_id, _options, task) => task({ signal, assertActive }));
    });

    it('acquires a global admission before recovery inference and terminal writes', async () => {
        const outcomes = await recoverJudgeQueue();

        expect(runManagedWorkload).toHaveBeenCalledWith(
            'judge-recovery:queue-1',
            {
                requestId: 'judge-recovery:queue-1',
                kind: 'judge-recovery',
                batchId: 'batch-1',
                hosts: ['http://judge.test:11434']
            },
            expect.any(Function)
        );
        expect(judgeResult).toHaveBeenCalledWith('result-1', {
            host: 'http://judge.test:11434',
            model: 'judge:model',
            cancelSignal: signal
        });
        expect(JudgeQueueEntry.updateOne).toHaveBeenNthCalledWith(
            1,
            { _id: 'queue-1' },
            { $set: { status: 'running', startedAt: expect.any(Date) } },
            { signal }
        );
        expect(JudgeQueueEntry.updateOne).toHaveBeenNthCalledWith(
            2,
            { _id: 'queue-1' },
            { $set: { status: 'completed', completedAt: expect.any(Date), error: null } },
            { signal }
        );
        expect(assertActive).toHaveBeenCalledTimes(4);
        expect(outcomes).toEqual([{ recovered: true, resultId: 'result-1', batchId: 'batch-1' }]);
    });

    it('performs no recovery inference or write when Core admission is unavailable', async () => {
        runManagedWorkload.mockRejectedValueOnce(Object.assign(new Error('maintenance active'), {
            code: 'WORKLOAD_ADMISSION_REJECTED'
        }));

        const outcomes = await recoverJudgeQueue();

        expect(judgeResult).not.toHaveBeenCalled();
        expect(JudgeQueueEntry.updateOne).not.toHaveBeenCalled();
        expect(outcomes).toEqual([expect.objectContaining({
            recovered: false,
            admissionLost: true,
            error: 'maintenance active'
        })]);
    });

    it('persists a judge failure terminally while the same admission is live', async () => {
        judgeResult.mockRejectedValueOnce(new Error('judge unavailable'));

        const outcomes = await recoverJudgeQueue();

        expect(JudgeQueueEntry.updateOne).toHaveBeenNthCalledWith(
            2,
            { _id: 'queue-1' },
            { $set: { status: 'failed', completedAt: expect.any(Date), error: 'judge unavailable' } },
            { signal }
        );
        expect(outcomes).toEqual([{ recovered: false, resultId: 'result-1', batchId: 'batch-1', error: 'judge unavailable' }]);
    });
});

