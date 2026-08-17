const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');

afterEach(() => {
    jest.restoreAllMocks();
});

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
        const matrix = new JudgeAccuracyMatrix(validMatrix);
        expect(matrix.validateSync()).toBeUndefined();
        expect(matrix.judge_model).toBe('qwen2.5:7b-instruct-q5_K_M');
        expect(matrix.cells).toHaveLength(2);
        expect(matrix.pass_rate).toBe(50);
    });

    it('should require judge_model and reference_model', async () => {
        const error = new JudgeAccuracyMatrix({ cells: [] }).validateSync();
        expect(error.errors).toEqual(expect.objectContaining({
            judge_model: expect.anything(),
            reference_model: expect.anything(),
            overall_avg_deviation: expect.anything()
        }));
    });

    it('should find latest matrix for a judge model', async () => {
        const expected = { ...validMatrix, overall_avg_deviation: 1.0 };
        const sort = jest.fn().mockResolvedValue(expected);
        jest.spyOn(JudgeAccuracyMatrix, 'findOne').mockReturnValue({ sort });

        const latest = await JudgeAccuracyMatrix.getLatest('qwen2.5:7b-instruct-q5_K_M');
        expect(JudgeAccuracyMatrix.findOne).toHaveBeenCalledWith({ judge_model: 'qwen2.5:7b-instruct-q5_K_M' });
        expect(sort).toHaveBeenCalledWith({ calibrated_at: -1 });
        expect(latest.overall_avg_deviation).toBe(1.0);
    });

    it('should return null when no matrix exists', async () => {
        jest.spyOn(JudgeAccuracyMatrix, 'findOne').mockReturnValue({
            sort: jest.fn().mockResolvedValue(null)
        });
        const latest = await JudgeAccuracyMatrix.getLatest('nonexistent-model');
        expect(latest).toBeNull();
    });

    it('should check if a judge is calibrated', async () => {
        jest.spyOn(JudgeAccuracyMatrix, 'countDocuments')
            .mockResolvedValueOnce(1)
            .mockResolvedValueOnce(0);
        const calibrated = await JudgeAccuracyMatrix.isCalibrated('qwen2.5:7b-instruct-q5_K_M');
        expect(calibrated).toBe(true);

        const uncalibrated = await JudgeAccuracyMatrix.isCalibrated('unknown-model');
        expect(uncalibrated).toBe(false);
    });
});
