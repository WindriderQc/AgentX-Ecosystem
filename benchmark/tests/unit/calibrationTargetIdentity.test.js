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
jest.mock('../../models/JudgeAccuracyMatrix', () => ({
    create: jest.fn(),
    deleteOne: jest.fn().mockResolvedValue({ deletedCount: 1 })
}));
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
let mockAdmissionController;
let mockAdmissionAssert;
jest.mock('../../src/services/benchmark/workloadAdmissionLifecycle', () => {
    const actual = jest.requireActual('../../src/services/benchmark/workloadAdmissionLifecycle');
    return {
        ...actual,
        withManagedWorkloadRoute: (_kind, _options, handler) => async (req, res, next) => {
            mockAdmissionController = new AbortController();
            mockAdmissionAssert = jest.fn(() => {
                if (mockAdmissionController.signal.aborted) {
                    const error = new Error('workload admission lost');
                    error.code = 'BENCHMARK_CLAIM_LOST';
                    throw error;
                }
                return true;
            });
            req.workloadAdmissionSignal = mockAdmissionController.signal;
            req.assertWorkloadAdmissionActive = mockAdmissionAssert;
            return handler(req, res, next);
        }
    };
});

const { runCalibrationBatch, buildAccuracyMatrix } = require('../../src/services/benchmark/calibrationRunner');
const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');
const diagnosticsRouter = require('../../routes/benchmark/diagnostics');

function createApp() {
    const app = express();
    app.use(express.json());
    app.use(diagnosticsRouter);
    return app;
}

describe('POST /judge/matrix-calibrate target identity', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        runCalibrationBatch.mockResolvedValue([{ score: 8 }]);
        buildAccuracyMatrix.mockReturnValue({
            cells: [], overall_avg_deviation: 0.5, pass_rate: 1,
            cell_pass_rate: 1, scored_entry_count: 1
        });
    });

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

    test('deletes an ambiguously created calibration when admission is lost during persistence', async () => {
        JudgeAccuracyMatrix.create.mockImplementationOnce(async ([payload]) => {
            mockAdmissionController.abort(new Error('heartbeat rejected'));
            return [payload];
        });

        const response = await request(createApp())
            .post('/judge/matrix-calibrate')
            .send({
                judge_model: 'judge:14b',
                judge_host: 'http://judge.example:11434',
                reference_model: 'reference:14b',
                reference_host: 'http://reference.example:11434'
            })
            .expect(500);

        expect(response.body).toMatchObject({ status: 'error' });
        expect(JudgeAccuracyMatrix.create).toHaveBeenCalledWith(
            [expect.objectContaining({ _id: expect.anything(), judge_model: 'judge:14b' })],
            { signal: mockAdmissionController.signal }
        );
        expect(JudgeAccuracyMatrix.deleteOne).toHaveBeenCalledWith({ _id: expect.anything() });
        expect(mockAdmissionAssert).toHaveBeenCalledTimes(2);
    });
});
