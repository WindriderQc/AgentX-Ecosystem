'use strict';

const express = require('express');
const request = require('supertest');

const JUDGE_IDENTITY_FINGERPRINT = 'a'.repeat(64);

jest.mock('../../config/logger', () => ({
    error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn()
}));

jest.mock('../../src/services/benchmark/judgeDriftService', () => ({
    computeDrift: jest.fn(),
    ratifyBaseline: jest.fn(),
    requireJudgeIdentityFingerprint: jest.fn((value) => {
        if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
            const error = new Error('judge_identity_fingerprint must be exact');
            error.code = 'INVALID_JUDGE_IDENTITY_FINGERPRINT';
            error.statusCode = 400;
            throw error;
        }
        return value;
    })
}));

jest.mock('../../models/CalibrationBaseline', () => ({
    getActive: jest.fn()
}));

const {
    computeDrift,
    ratifyBaseline
} = require('../../src/services/benchmark/judgeDriftService');
const CalibrationBaseline = require('../../models/CalibrationBaseline');
const router = require('../../routes/benchmark/drift');

function createApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/benchmark', router);
    return app;
}

describe('Judge drift route identity binding', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        computeDrift.mockResolvedValue({ overall_status: 'no_baseline' });
        ratifyBaseline.mockResolvedValue({ label: 'baseline' });
        CalibrationBaseline.getActive.mockResolvedValue(null);
    });

    test('rejects GET drift without an exact judge identity', async () => {
        const response = await request(createApp()).get('/api/benchmark/drift').expect(400);
        expect(response.body.code).toBe('INVALID_JUDGE_IDENTITY_FINGERPRINT');
        expect(computeDrift).not.toHaveBeenCalled();
    });

    test('passes the exact GET identity to the drift service', async () => {
        await request(createApp())
            .get('/api/benchmark/drift')
            .query({ judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT, per_category: 12 })
            .expect(200);

        expect(computeDrift).toHaveBeenCalledWith({
            perCategory: 12,
            emitEvents: false,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
    });

    test('passes the exact POST identity to compute and ratification', async () => {
        await request(createApp())
            .post('/api/benchmark/drift/compute')
            .send({
                judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
                per_category: 8,
                emit: false
            })
            .expect(200);
        expect(computeDrift).toHaveBeenCalledWith({
            perCategory: 8,
            emitEvents: false,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });

        await request(createApp())
            .post('/api/benchmark/drift/baseline')
            .send({
                label: 'baseline',
                categories: [],
                judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
            })
            .expect(201);
        expect(ratifyBaseline).toHaveBeenCalledWith({
            label: 'baseline',
            categories: [],
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
    });

    test('fetches only the exact identity baseline', async () => {
        await request(createApp())
            .get('/api/benchmark/drift/baseline')
            .query({ judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT })
            .expect(200);

        expect(CalibrationBaseline.getActive).toHaveBeenCalledWith(JUDGE_IDENTITY_FINGERPRINT);
    });

    test('rejects baseline ratification without an exact judge identity', async () => {
        const response = await request(createApp())
            .post('/api/benchmark/drift/baseline')
            .send({ label: 'baseline', categories: [] })
            .expect(400);

        expect(response.body.code).toBe('INVALID_JUDGE_IDENTITY_FINGERPRINT');
        expect(ratifyBaseline).not.toHaveBeenCalled();
    });
});
