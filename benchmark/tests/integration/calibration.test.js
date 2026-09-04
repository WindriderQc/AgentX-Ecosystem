const request = require('supertest');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri());
});

afterAll(async () => {
    await mongoose.disconnect();
    await mongoServer.stop();
});

jest.mock('../../src/services/qualityScorer', () => ({
    scoreResponse: jest.fn(async () => ({
        quality_score: 7.5,
        breakdown: { correctness: 8 },
        scoring_method: 'decomposed',
        judge_confidence: 0.9,
        needs_review: false
    })),
    JUDGE_CONFIG: { model: 'test', host: 'http://localhost:11434' },
    ENHANCED_SCORING_CONFIGS: {}
}));

jest.mock('../../src/services/judgeValidation', () => ({
    runHealthCheck: jest.fn(async () => ({})),
    runConsistencyTest: jest.fn(async () => ({})),
    runGroundTruthEvaluation: jest.fn(async () => ({})),
    runBiasDetection: jest.fn(async () => ({})),
    runCalibrationAnalysis: jest.fn(async () => ({})),
    runFailureModeAnalysis: jest.fn(async () => ({}))
}));

jest.mock('../../src/services/benchmark/workloadAdmissionLifecycle', () => {
    const actual = jest.requireActual('../../src/services/benchmark/workloadAdmissionLifecycle');
    return {
        ...actual,
        withManagedWorkloadRoute: (_kind, _options, handler) => handler
    };
});

const app = require('../../server');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');

afterEach(async () => {
    try {
        await JudgeGroundTruth.deleteMany({});
        await JudgeAccuracyMatrix.deleteMany({});
    } catch (_) {}
});

describe('POST /api/benchmark/judge/matrix-calibrate', () => {
    it('should return 400 when required fields are missing', async () => {
        const res = await request(app)
            .post('/api/benchmark/judge/matrix-calibrate')
            .send({});
        expect(res.status).toBe(400);
    });

    it('should return 400 when no ground truth entries exist', async () => {
        const res = await request(app)
            .post('/api/benchmark/judge/matrix-calibrate')
            .send({
                judge_model: 'qwen2.5:7b-instruct-q5_K_M',
                judge_host: 'http://192.0.2.99:11434',
                reference_model: 'qwq:32b',
                reference_host: 'http://192.0.2.66:11434'
            });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/ground truth/i);
    });
});

describe('GET /api/benchmark/judge/calibration-status', () => {
    it('should return calibration status for all judges', async () => {
        const res = await request(app)
            .get('/api/benchmark/judge/calibration-status');
        expect(res.status).toBe(200);
        expect(res.body.data).toBeDefined();
    });
});
