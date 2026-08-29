const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/benchmark/judgeReadiness', () => ({
    resolveReadyJudgeTarget: jest.fn(),
    judgeUnavailablePayload: jest.fn((check, action) => ({
        status: 'error',
        code: 'JUDGE_NOT_READY',
        error: `${action} unavailable: ${check.error}`,
        readiness: check.readiness || null,
        setup: { href: '/setup?focus=judge', label: 'Choose a judge' }
    }))
}));

jest.mock('../../src/services/benchmark/judgeModelValidator', () => ({
    validateJudgeModel: jest.fn(),
    probeJudgeCapability: jest.fn()
}));

jest.mock('../../src/services/benchmark/judging', () => ({
    stopJudging: jest.fn()
}));

const readinessService = require('../../src/services/benchmark/judgeReadiness');
const judgeModelValidator = require('../../src/services/benchmark/judgeModelValidator');
const router = require('../../routes/benchmark/core');

const app = express();
app.use(express.json());
app.use('/api/benchmark', router);

describe('POST /api/benchmark/validate-judge target admission', () => {
    afterEach(() => jest.clearAllMocks());

    test.each([
        ['invalid_judge_target', 400, 'JUDGE_TARGET_REJECTED'],
        ['incomplete_judge_target', 400, 'JUDGE_TARGET_INCOMPLETE'],
        ['judge_host_not_configured', 400, 'JUDGE_HOST_NOT_CONFIGURED'],
        ['judge_model_unavailable', 409, 'JUDGE_MODEL_UNAVAILABLE'],
        ['judge_host_unreachable', 503, 'JUDGE_HOST_UNREACHABLE'],
        ['no_judge_selected', 503, 'JUDGE_NOT_READY']
    ])('maps %s to a stable response before validation', async (admissionCode, status, responseCode) => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: false,
            code: admissionCode,
            error: 'fixture admission failure',
            target: null,
            readiness: null
        });

        const response = await request(app)
            .post('/api/benchmark/validate-judge')
            .send({
                host: 'http://alpha:11434/api/tags#http://169.254.169.254/latest/meta-data',
                model: 'judge:7b'
            });

        expect(response.status).toBe(status);
        expect(response.body).toMatchObject({
            status: 'error',
            code: responseCode,
            admission_code: admissionCode
        });
        expect(judgeModelValidator.validateJudgeModel).not.toHaveBeenCalled();
        expect(judgeModelValidator.probeJudgeCapability).not.toHaveBeenCalled();
    });

    test('uses only the canonical configured judge returned by admission', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: true,
            code: 'ready',
            target: {
                host: 'http://configured-judge:11434',
                model: 'judge:7b',
                source: 'request'
            },
            readiness: { ready: true }
        });
        judgeModelValidator.validateJudgeModel.mockResolvedValue({
            valid: true,
            latency_ms: 17
        });
        judgeModelValidator.probeJudgeCapability.mockResolvedValue({
            ok: true,
            context_length: 32768,
            parameter_size: '7B'
        });

        const response = await request(app)
            .post('/api/benchmark/validate-judge')
            .send({ host: 'http://configured-judge:11434/', model: 'judge:7b' });

        expect(response.status).toBe(200);
        expect(readinessService.resolveReadyJudgeTarget).toHaveBeenCalledWith({
            host: 'http://configured-judge:11434/',
            model: 'judge:7b'
        });
        expect(judgeModelValidator.validateJudgeModel).toHaveBeenCalledWith(
            'http://configured-judge:11434',
            'judge:7b'
        );
        expect(judgeModelValidator.probeJudgeCapability).toHaveBeenCalledWith(
            'http://configured-judge:11434',
            'judge:7b'
        );
        expect(response.body).toMatchObject({
            status: 'success',
            data: {
                valid: true,
                host: 'http://configured-judge:11434',
                model: 'judge:7b',
                context_length: 32768,
                parameter_size: '7B',
                latency_ms: 17
            }
        });
        expect(
            judgeModelValidator.validateJudgeModel.mock.invocationCallOrder[0]
        ).toBeLessThan(
            judgeModelValidator.probeJudgeCapability.mock.invocationCallOrder[0]
        );
    });

    test('returns a conflict when the model disappears after admission', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: true,
            code: 'ready',
            target: { host: 'http://configured-judge:11434', model: 'judge:7b' },
            readiness: { ready: true }
        });
        judgeModelValidator.validateJudgeModel.mockResolvedValue({
            valid: false,
            code: 'JUDGE_MODEL_UNAVAILABLE',
            error: 'Judge model is no longer installed',
            available_models: []
        });

        const response = await request(app)
            .post('/api/benchmark/validate-judge')
            .send({ host: 'http://configured-judge:11434', model: 'judge:7b' });

        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
            status: 'error',
            code: 'JUDGE_MODEL_UNAVAILABLE'
        });
        expect(judgeModelValidator.probeJudgeCapability).not.toHaveBeenCalled();
    });
});
