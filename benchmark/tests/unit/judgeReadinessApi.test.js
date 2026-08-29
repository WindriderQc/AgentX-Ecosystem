const express = require('express');
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');

const originalDefaultsPath = process.env.JUDGE_DEFAULTS_PATH;
const defaultsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agentx-judge-defaults-'));
const defaultsPath = path.join(defaultsDirectory, 'judge-host-defaults.json');
process.env.JUDGE_DEFAULTS_PATH = defaultsPath;

jest.mock('../../src/services/benchmark/judgeReadiness', () => {
    const actual = jest.requireActual('../../src/services/benchmark/judgeReadiness');
    return {
        ...actual,
        getJudgeReadiness: jest.fn(),
        resolveReadyJudgeTarget: jest.fn()
    };
});

const readinessService = require('../../src/services/benchmark/judgeReadiness');
const router = require('../../routes/benchmark/judgeDefaults');

const app = express();
app.use(express.json());
app.use('/api/benchmark', router);

const blockedReadiness = {
    ready: false,
    status: 'blocked',
    code: 'no_judge_selected',
    summary: '0/3 configured hosts have a selected, reachable judge.',
    hosts: [],
    evidence_modes: {
        deterministic: { status: 'available' },
        judge_scored: { status: 'blocked' }
    },
    setup: { href: '#the-bench', label: 'Choose a judge' }
};

describe('judge readiness API', () => {
    afterEach(() => jest.clearAllMocks());
    afterAll(() => {
        if (originalDefaultsPath === undefined) delete process.env.JUDGE_DEFAULTS_PATH;
        else process.env.JUDGE_DEFAULTS_PATH = originalDefaultsPath;
        fs.rmSync(defaultsDirectory, { recursive: true, force: true });
    });

    test('returns a blocked readiness observation as a non-cacheable 200', async () => {
        readinessService.getJudgeReadiness.mockResolvedValue(blockedReadiness);

        const response = await request(app).get('/api/benchmark/judge/readiness');

        expect(response.status).toBe(200);
        expect(response.headers['cache-control']).toBe('no-store');
        expect(response.body).toEqual({ status: 'success', data: blockedReadiness });
    });

    test('refuses to persist a default that is not currently ready', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: false,
            error: 'Judge model missing:14b is not installed.',
            readiness: blockedReadiness
        });

        const response = await request(app)
            .put('/api/benchmark/judge-defaults')
            .send({ hostUrl: 'http://alpha:11434', judgeModel: 'missing:14b' });

        expect(response.status).toBe(503);
        expect(response.body).toMatchObject({
            status: 'error',
            code: 'JUDGE_NOT_READY'
        });
        expect(response.body.error).toMatch(/not installed/i);
    });

    test('persists a ready selection at the configured durable path', async () => {
        readinessService.resolveReadyJudgeTarget.mockResolvedValue({
            ready: true,
            target: { host: 'http://alpha:11434', model: 'judge:7b' },
            readiness: { ...blockedReadiness, ready: true }
        });

        const response = await request(app)
            .put('/api/benchmark/judge-defaults')
            .send({ hostUrl: 'http://alpha:11434', judgeModel: 'judge:7b' });

        expect(response.status).toBe(200);
        expect(JSON.parse(fs.readFileSync(defaultsPath, 'utf8'))).toEqual({
            'http://alpha:11434': 'judge:7b'
        });
    });

    test('does not expose internal errors when readiness calculation fails', async () => {
        readinessService.getJudgeReadiness.mockRejectedValue(new Error('secret topology detail'));

        const response = await request(app).get('/api/benchmark/judge/readiness');

        expect(response.status).toBe(500);
        expect(response.body).toEqual({
            status: 'error',
            error: 'Judge readiness check failed'
        });
    });
});
