'use strict';

jest.mock('../../config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn()
}));
jest.mock('../../src/services/judgeValidation', () => ({}));
jest.mock('../../models/JudgeGroundTruth', () => ({ findByIdAndDelete: jest.fn() }));
jest.mock('../../src/services/benchmark/calibrationRunner', () => ({}));
jest.mock('../../models/JudgeAccuracyMatrix', () => ({}));
jest.mock('../../src/services/benchmark/driftDetector', () => ({}));
jest.mock('../../src/services/benchmark/retroCalibration', () => ({}));
jest.mock('../../src/services/judgeFeedbackLoop', () => ({}));
jest.mock('../../src/services/judgeGovernance', () => ({}));
jest.mock('../../models/BenchmarkBatch', () => ({}));
jest.mock('../../models/BenchmarkResult', () => ({}));
jest.mock('../../src/services/benchmark/judgeReadiness', () => ({
    resolveReadyJudgeTarget: jest.fn(),
    judgeUnavailablePayload: jest.fn()
}));

const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const diagnosticsRouter = require('../../routes/benchmark/diagnostics');

const ID = '507f1f77bcf86cd799439011';
const CONFIRMATION = `DELETE GROUND TRUTH ${ID}`;
const deleteHandler = diagnosticsRouter.stack.find(candidate => (
    candidate.route?.path === '/judge/ground-truth/:id' && candidate.route.methods.delete
)).route.stack.at(-1).handle;

function createResponse() {
    const response = { statusCode: 200, body: undefined };
    response.status = jest.fn((statusCode) => {
        response.statusCode = statusCode;
        return response;
    });
    response.json = jest.fn((body) => {
        response.body = body;
        return response;
    });
    return response;
}

describe('DELETE /judge/ground-truth/:id exact confirmation', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        JudgeGroundTruth.findByIdAndDelete.mockResolvedValue({ _id: ID });
    });

    it('rejects a missing phrase before deleting', async () => {
        const response = createResponse();
        await deleteHandler({ params: { id: ID }, body: {} }, response);

        expect(response.statusCode).toBe(400);
        expect(response.body).toMatchObject({
            status: 'error',
            code: 'DESTRUCTIVE_CONFIRMATION_REQUIRED',
            confirmation: {
                kind: 'exact-phrase',
                field: 'confirm',
                expected: CONFIRMATION
            }
        });
        expect(JudgeGroundTruth.findByIdAndDelete).not.toHaveBeenCalled();
    });

    it('rejects a wrong phrase before deleting', async () => {
        const response = createResponse();
        await deleteHandler({
            params: { id: ID },
            body: { confirm: 'DELETE GROUND TRUTH' }
        }, response);

        expect(response.statusCode).toBe(400);
        expect(response.body.code).toBe('DESTRUCTIVE_CONFIRMATION_REQUIRED');
        expect(JudgeGroundTruth.findByIdAndDelete).not.toHaveBeenCalled();
    });

    it('deletes only with the target-bound exact phrase', async () => {
        const response = createResponse();
        await deleteHandler({
            params: { id: ID },
            body: { confirm: CONFIRMATION }
        }, response);

        expect(response.statusCode).toBe(200);
        expect(response.body.status).toBe('success');
        expect(JudgeGroundTruth.findByIdAndDelete).toHaveBeenCalledWith(ID);
    });
});
