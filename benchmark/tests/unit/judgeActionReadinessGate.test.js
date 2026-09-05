const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/benchmark/judgeReadiness', () => {
    const actual = jest.requireActual('../../src/services/benchmark/judgeReadiness');
    return {
        ...actual,
        resolveReadyJudgeTarget: jest.fn()
    };
});

jest.mock('../../src/services/benchmark/judging', () => ({
    judgeResult: jest.fn(),
    stopJudging: jest.fn()
}));

jest.mock('../../src/services/benchmark/workloadAdmissionLifecycle', () => ({
    runManagedWorkload: jest.fn(async (_id, _options, task) => task({ signal: undefined, assertActive: () => true })),
    withManagedWorkloadRoute: (_kind, _resolveOptions, handler) => handler
}));

jest.mock('../../models/BenchmarkResult', () => ({
    findById: jest.fn(() => ({
        select: jest.fn(() => ({
            lean: jest.fn(async () => ({
                _id: '507f1f77bcf86cd799439011',
                batch_id: null,
                trust_candidate_id: null,
                trust_prompt_id: null
            }))
        }))
    }))
}));

jest.mock('../../src/services/benchmark/executionHostValidator', () => ({
    validateExecutionHost: jest.fn(async () => ({ valid: true, available_models: [] }))
}));

jest.mock('../../src/services/benchmark/sweepRunner', () => ({
    runSweep: jest.fn()
}));

const readinessService = require('../../src/services/benchmark/judgeReadiness');
const { judgeResult } = require('../../src/services/benchmark/judging');
const { validateExecutionHost } = require('../../src/services/benchmark/executionHostValidator');
const resultsRouter = require('../../routes/benchmark/results');
const coreRouter = require('../../routes/benchmark/core');
const sweepsRouter = require('../../routes/benchmark/sweeps');

const app = express();
app.use(express.json());
app.use('/api/benchmark', resultsRouter);
app.use('/api/benchmark', coreRouter);
app.use('/api/benchmark', sweepsRouter);

const blocked = {
    ready: false,
    code: 'no_judge_selected',
    error: 'No selected, reachable judge is ready.',
    readiness: {
        ready: false,
        status: 'blocked',
        setup: { href: '#the-bench', label: 'Choose a judge' }
    }
};

describe('judge-required API action gates', () => {
    afterEach(() => jest.clearAllMocks());

    test('blocks re-judge before invoking the judge service', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue(blocked);

        const response = await request(app)
            .post('/api/benchmark/results/507f1f77bcf86cd799439011/rejudge')
            .send({});

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'JUDGE_NOT_READY' });
        expect(judgeResult).not.toHaveBeenCalled();
    });

    test('passes the probed target to re-judge when ready', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: true,
            target: { host: 'http://judge:11434', model: 'judge:7b', source: 'request' },
            readiness: { ready: true }
        });
        judgeResult.mockResolvedValue({ _id: '507f1f77bcf86cd799439011', quality_score: 8 });

        const response = await request(app)
            .post('/api/benchmark/results/507f1f77bcf86cd799439011/rejudge')
            .send({ judge_host: 'http://judge:11434', judge_model: 'judge:7b' });

        expect(response.status).toBe(200);
        expect(judgeResult).toHaveBeenCalledWith('507f1f77bcf86cd799439011', {
            host: 'http://judge:11434',
            model: 'judge:7b'
        });
    });

    test('blocks benchmark launch before execution-host work begins', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue(blocked);

        const response = await request(app)
            .post('/api/benchmark/batch')
            .send({
                host: 'http://exec:11434',
                models: ['candidate:7b'],
                levels: [1]
            });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'JUDGE_NOT_READY' });
        expect(validateExecutionHost).not.toHaveBeenCalled();
    });

    test('blocks an executing sweep before its runner can launch a batch', async () => {
        const { runSweep } = require('../../src/services/benchmark/sweepRunner');
        readinessService.resolveReadyJudgeTarget.mockResolvedValue(blocked);

        const response = await request(app)
            .post('/api/benchmark/sweeps/run')
            .send({ execute: true, host: 'alpha', candidates: [{ model: 'candidate:7b' }] });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({ code: 'JUDGE_NOT_READY' });
        expect(runSweep).not.toHaveBeenCalled();
    });
});
