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

afterEach(async () => {
    await mongoose.connection.db.dropDatabase();
});

const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');

describe('JudgeAccuracyMatrix', () => {
    const validMatrix = {
        judge_model: 'qwen2.5:7b-instruct-q5_K_M',
        judge_host: 'http://192.0.2.99:11434',
        reference_model: 'qwq:32b',
        reference_host: 'http://192.0.2.66:11434',
        cells: [
            { category: 'coding', difficulty: 3, avg_deviation: 0.8, sample_count: 12, pass: true },
            { category: 'creative', difficulty: 4, avg_deviation: 2.3, sample_count: 8, pass: false }
        ],
        overall_avg_deviation: 1.55,
        pass_threshold: 1.5,
        pass_rate: 50,
        ground_truth_count: 20
    };

    it('should create a valid accuracy matrix', async () => {
        const matrix = await JudgeAccuracyMatrix.create(validMatrix);
        expect(matrix.judge_model).toBe('qwen2.5:7b-instruct-q5_K_M');
        expect(matrix.cells).toHaveLength(2);
        expect(matrix.pass_rate).toBe(50);
    });

    it('should require judge_model and reference_model', async () => {
        await expect(JudgeAccuracyMatrix.create({ cells: [] }))
            .rejects.toThrow();
    });

    it('should find latest matrix for a judge model', async () => {
        await JudgeAccuracyMatrix.create(validMatrix);
        await JudgeAccuracyMatrix.create({
            ...validMatrix,
            overall_avg_deviation: 1.0,
            calibrated_at: new Date()
        });

        const latest = await JudgeAccuracyMatrix.getLatest('qwen2.5:7b-instruct-q5_K_M');
        expect(latest).not.toBeNull();
        expect(latest.overall_avg_deviation).toBe(1.0);
    });

    it('should return null when no matrix exists', async () => {
        const latest = await JudgeAccuracyMatrix.getLatest('nonexistent-model');
        expect(latest).toBeNull();
    });

    it('should check if a judge is calibrated', async () => {
        await JudgeAccuracyMatrix.create(validMatrix);
        const calibrated = await JudgeAccuracyMatrix.isCalibrated('qwen2.5:7b-instruct-q5_K_M');
        expect(calibrated).toBe(true);

        const uncalibrated = await JudgeAccuracyMatrix.isCalibrated('unknown-model');
        expect(uncalibrated).toBe(false);
    });
});
