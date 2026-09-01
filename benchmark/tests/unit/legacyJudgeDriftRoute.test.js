'use strict';

const mongoose = require('mongoose');

jest.mock('../../config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn()
}));
jest.mock('../../src/services/judgeValidation', () => ({}));
jest.mock('../../models/JudgeGroundTruth', () => ({}));
jest.mock('../../src/services/benchmark/calibrationRunner', () => ({}));
jest.mock('../../models/JudgeAccuracyMatrix', () => ({}));
jest.mock('../../src/services/benchmark/driftDetector', () => ({
    detectDrift: jest.fn(() => ({ drifted: false, reasons: [] }))
}));
jest.mock('../../src/services/benchmark/retroCalibration', () => ({}));
jest.mock('../../src/services/judgeFeedbackLoop', () => ({}));
jest.mock('../../src/services/judgeGovernance', () => ({}));
jest.mock('../../models/BenchmarkBatch', () => ({ findOne: jest.fn() }));
jest.mock('../../models/BenchmarkResult', () => ({ aggregate: jest.fn() }));
jest.mock('../../src/services/benchmark/judgeReadiness', () => ({
    resolveReadyJudgeTarget: jest.fn(),
    judgeUnavailablePayload: jest.fn()
}));

const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const diagnosticsRouter = require('../../routes/benchmark/diagnostics');

const driftHandler = diagnosticsRouter.stack.find(layer => (
    layer.route?.path === '/judge/drift' && layer.route.methods.get
)).route.stack[0].handle;

async function invokeDrift(query = {}) {
    const response = {
        statusCode: 200,
        body: null,
        status(code) {
            this.statusCode = code;
            return this;
        },
        json(body) {
            this.body = body;
            return this;
        }
    };
    await driftHandler({ query }, response);
    return response;
}

describe('GET /judge/drift canonical batch identity', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    test('rejects a non-canonical batch id before aggregation', async () => {
        const response = await invokeDrift({ batch_id: 'not-an-object-id' });

        expect(response.statusCode).toBe(400);
        expect(response.body.code).toBe('BENCHMARK_DRIFT_BATCH_ID_INVALID');
        expect(BenchmarkResult.aggregate).not.toHaveBeenCalled();
    });

    test('uses ObjectId for both current selection and historical exclusion', async () => {
        const batchId = '0123456789abcdef01234567';
        BenchmarkResult.aggregate
            .mockResolvedValueOnce([{ mean: 8, stddev: 1, count: 20 }])
            .mockResolvedValueOnce([{ mean: 7.5, stddev: 1.2, count: 50 }]);

        const response = await invokeDrift({ batch_id: batchId });

        expect(response.statusCode).toBe(200);
        const currentId = BenchmarkResult.aggregate.mock.calls[0][0][0].$match.batch_id;
        const historicalId = BenchmarkResult.aggregate.mock.calls[1][0][0].$match.batch_id.$ne;
        expect(currentId).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(historicalId).toBeInstanceOf(mongoose.Types.ObjectId);
        expect(BenchmarkResult.aggregate.mock.calls[0][0][0].$match.$nor).toEqual(expect.any(Array));
        expect(BenchmarkResult.aggregate.mock.calls[1][0][0].$match.$nor).toEqual(expect.any(Array));
        expect(currentId.toHexString()).toBe(batchId);
        expect(historicalId.toHexString()).toBe(batchId);
        expect(response.body.data.batch_id).toBe(batchId);
    });

    test('selects only a non-Trust latest batch and reports absence as unknown', async () => {
        BenchmarkBatch.findOne.mockReturnValue({
            sort: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(null)
            })
        });

        const response = await invokeDrift();

        expect(response.statusCode).toBe(200);
        expect(BenchmarkBatch.findOne).toHaveBeenCalledWith({
            judge_status: 'completed',
            trust_campaign_spec_id: null,
            trust_evidence_context: null
        });
        expect(response.body.data).toEqual({
            drifted: null,
            insufficient_data: true
        });
        expect(BenchmarkResult.aggregate).not.toHaveBeenCalled();
    });
});
