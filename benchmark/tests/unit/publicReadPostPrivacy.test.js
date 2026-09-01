'use strict';

const express = require('express');
const request = require('supertest');

jest.mock('../../src/services/judgeValidation', () => {
    const privacy = require('../../src/services/benchmark/publicReadPrivacy');
    return {
        runHealthCheck: jest.fn(async () => ({ publicRead: privacy.isPublicBenchmarkRead() })),
        runConsistencyTest: jest.fn(async () => ({ publicRead: privacy.isPublicBenchmarkRead() }))
    };
});

jest.mock('../../src/services/benchmark/judgeReadiness', () => ({
    resolveReadyJudgeTarget: jest.fn(async () => ({
        ready: true,
        target: { host: 'http://judge.test', model: 'judge:test' }
    })),
    judgeUnavailablePayload: jest.fn()
}));

const app = express();
app.use(express.json());
app.use('/api/benchmark', require('../../routes/benchmark'));

describe('read-only POST Trust privacy routing', () => {
    test.each([
        ['/api/benchmark/judge/health', {}],
        ['/api/benchmark/judge/health/', {}],
        ['/api/benchmark/JUDGE/HEALTH', {}],
        ['/api/benchmark/judge/validate/consistency', {}],
        ['/api/benchmark/judge/validate/consistency/', {}],
        ['/api/benchmark/Judge/Validate/Consistency', {}]
    ])('keeps %s inside the public result boundary', async (path, body) => {
        const response = await request(app).post(path).send(body);
        expect(response.status).toBe(200);
        expect(response.body.data).toEqual({ publicRead: true });
    });
});
