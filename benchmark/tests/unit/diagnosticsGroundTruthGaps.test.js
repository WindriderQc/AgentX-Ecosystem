const express = require('express');
const request = require('supertest');

jest.mock('../../config/logger', () => ({
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn()
}));

jest.mock('../../src/services/judgeValidation', () => ({}));
jest.mock('../../models/JudgeGroundTruth', () => ({ aggregate: jest.fn() }));
jest.mock('../../src/services/benchmark/calibrationRunner', () => ({}));
jest.mock('../../models/JudgeAccuracyMatrix', () => ({}));
jest.mock('../../src/services/benchmark/driftDetector', () => ({}));
jest.mock('../../src/services/benchmark/retroCalibration', () => ({}));
jest.mock('../../src/services/judgeFeedbackLoop', () => ({}));
jest.mock('../../src/services/judgeGovernance', () => ({}));
jest.mock('../../models/BenchmarkBatch', () => ({}));
jest.mock('../../models/BenchmarkResult', () => ({}));

const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const diagnosticsRouter = require('../../routes/benchmark/diagnostics');

function createApp() {
    const app = express();
    app.use(diagnosticsRouter);
    return app;
}

describe('GET /judge/ground-truth/gaps', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it('excludes retro-calibration rows from human coverage', async () => {
        JudgeGroundTruth.aggregate.mockResolvedValue([
            {
                _id: { category: 'coding', difficulty: 1 },
                count: 3,
                retro_count: 3
            },
            {
                _id: { category: 'math', difficulty: 2 },
                count: 4,
                retro_count: 1
            }
        ]);

        const response = await request(createApp())
            .get('/judge/ground-truth/gaps')
            .expect(200);

        expect(response.body.status).toBe('success');
        expect(response.body.data).toMatchObject({
            total_entries: 3,
            total_all_entries: 7,
            retro_entries: 4,
            total_cells: 35,
            empty_cells: 34,
            coverage_pct: 3
        });

        expect(response.body.data.grid).toEqual(expect.arrayContaining([
            { category: 'coding', difficulty: 1, count: 0, all_count: 3, retro: 3 },
            { category: 'math', difficulty: 2, count: 3, all_count: 4, retro: 1 }
        ]));

        const pipeline = JudgeGroundTruth.aggregate.mock.calls[0][0];
        expect(pipeline[1].$group.retro_count).toEqual({
            $sum: { $cond: [{ $eq: ['$created_by', 'retro-calibration'] }, 1, 0] }
        });
    });
});
