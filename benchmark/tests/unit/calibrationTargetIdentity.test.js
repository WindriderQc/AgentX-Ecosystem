const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn()
}));
jest.mock('../../src/services/judgeValidation', () => ({}));
jest.mock('../../models/JudgeGroundTruth', () => ({
    getForValidation: jest.fn(async () => [{ _id: 'gt-1' }])
}));
jest.mock('../../src/services/benchmark/calibrationRunner', () => ({
    runCalibrationBatch: jest.fn(),
    buildAccuracyMatrix: jest.fn()
}));
jest.mock('../../models/JudgeAccuracyMatrix', () => ({}));
jest.mock('../../src/services/benchmark/driftDetector', () => ({}));
jest.mock('../../src/services/benchmark/retroCalibration', () => ({}));
jest.mock('../../src/services/judgeFeedbackLoop', () => ({}));
jest.mock('../../src/services/judgeGovernance', () => ({}));
jest.mock('../../models/BenchmarkBatch', () => ({}));
jest.mock('../../models/BenchmarkResult', () => ({}));
jest.mock('../../src/services/benchmark/judgeReadiness', () => ({
    resolveReadyJudgeTarget: jest.fn(async ({ host, model }) => ({
        ready: true,
        target: { host, model }
    })),
    judgeUnavailablePayload: jest.fn()
}));
jest.mock('../../src/services/benchmark/workloadAdmissionLifecycle', () => {
    const actual = jest.requireActual('../../src/services/benchmark/workloadAdmissionLifecycle');
    return {
        ...actual,
        withManagedWorkloadRoute: (_kind, _options, handler) => handler
    };
});

const { runCalibrationBatch } = require('../../src/services/benchmark/calibrationRunner');
const diagnosticsRouter = require('../../routes/benchmark/diagnostics');

function createApp() {
    const app = express();
    app.use(express.json());
    app.use(diagnosticsRouter);
    return app;
}

describe('POST /judge/matrix-calibrate target identity', () => {
    test('rejects self-comparison after normalizing host and model identity', async () => {
        const response = await request(createApp())
            .post('/judge/matrix-calibrate')
            .send({
                judge_model: 'Qwen2.5:14B',
                judge_host: 'http://judge.example:11434/',
                reference_model: 'qwen2.5:14b',
                reference_host: 'http://judge.example:11434'
            })
            .expect(400);

        expect(response.body).toMatchObject({
            code: 'CALIBRATION_TARGETS_IDENTICAL'
        });
        expect(runCalibrationBatch).not.toHaveBeenCalled();
    });
});
