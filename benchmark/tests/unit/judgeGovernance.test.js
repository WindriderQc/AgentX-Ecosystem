/**
 * Unit tests for the judge governance loop (TODO 0125).
 *
 * Covers:
 *  - orchestrator calls each sub-step in order
 *  - partial failures are captured without erasing sibling outputs
 *  - summary headline reflects sub-step outputs
 *  - persist: false returns an unsaved doc; persist: true writes via model
 */

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

// Model mocks --------------------------------------------------------------

jest.mock('../../models/JudgeGovernanceRun', () => {
    const create = jest.fn();
    const getLatest = jest.fn();
    const updateOne = jest.fn();
    return { create, getLatest, updateOne };
});

jest.mock('../../models/BenchmarkBatch', () => ({
    findOne: jest.fn(),
    findById: jest.fn()
}));

jest.mock('../../models/BenchmarkResult', () => ({
    aggregate: jest.fn()
}));

jest.mock('../../models/JudgeGroundTruth', () => ({
    getForValidation: jest.fn()
}));

jest.mock('../../models/JudgeAccuracyMatrix', () => ({
    create: jest.fn(),
    updateOne: jest.fn()
}));

// Service mocks ------------------------------------------------------------

jest.mock('../../src/services/judgeFeedbackLoop', () => ({
    getJudgeFeedbackStats: jest.fn(),
    autoPromoteGroundTruth: jest.fn()
}));

jest.mock('../../src/services/benchmark/retroCalibration', () => ({
    runRetroCalibration: jest.fn()
}));

jest.mock('../../src/services/benchmark/calibrationRunner', () => ({
    runCalibrationBatch: jest.fn(),
    buildAccuracyMatrix: jest.fn()
}));

jest.mock('../../src/services/benchmark/driftDetector', () => ({
    detectDrift: jest.fn()
}));

const JudgeGovernanceRun = require('../../models/JudgeGovernanceRun');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const JudgeAccuracyMatrix = require('../../models/JudgeAccuracyMatrix');
const feedbackLoop = require('../../src/services/judgeFeedbackLoop');
const retro = require('../../src/services/benchmark/retroCalibration');
const calibration = require('../../src/services/benchmark/calibrationRunner');
const drift = require('../../src/services/benchmark/driftDetector');
const mongoose = require('mongoose');

const { runJudgeGovernanceLoop, getLatestGovernanceRun } =
    require('../../src/services/judgeGovernance');

// --- helpers --------------------------------------------------------------

const BATCH_1 = '507f1f77bcf86cd799439011';
const BATCH_2 = '507f1f77bcf86cd799439012';
const BATCH_3 = '507f1f77bcf86cd799439013';

function mockBatchFound(batchId = BATCH_1) {
    BenchmarkBatch.findOne.mockReturnValue({
        sort: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({ _id: { toString: () => batchId } })
            })
        })
    });
}

function mockNoBatch() {
    BenchmarkBatch.findOne.mockReturnValue({
        sort: jest.fn().mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(null)
            })
        })
    });
}

function mockDriftAggregates(current, historical) {
    // Two aggregate() calls are issued in Promise.all — deterministic order.
    BenchmarkResult.aggregate
        .mockResolvedValueOnce(current ? [current] : [])
        .mockResolvedValueOnce(historical ? [historical] : []);
}

function defaultFeedback() {
    feedbackLoop.getJudgeFeedbackStats.mockResolvedValue({
        byCategory: { coding: { count: 5, avgDeviation: 0.4 } },
        overall: { count: 20, highDivergenceCount: 2, highDivergenceRate: 0.1 }
    });
    feedbackLoop.autoPromoteGroundTruth.mockResolvedValue({ promoted: 3, skipped: 7 });
}

// --- tests ----------------------------------------------------------------

beforeEach(() => {
    jest.clearAllMocks();
    JudgeGovernanceRun.create.mockImplementation(async (doc) => ({
        ...doc,
        _id: 'gov-run-1',
        toObject: () => ({ ...doc, _id: 'gov-run-1' })
    }));
});

describe('judgeGovernance — orchestrator', () => {
    it('rejects an explicit strict Trust batch before every legacy sub-step', async () => {
        BenchmarkBatch.findById.mockReturnValue({
            select: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue({
                    _id: { toString: () => 'strict-batch' },
                    trust_campaign_spec_id: 'a'.repeat(64)
                })
            })
        });

        await expect(runJudgeGovernanceLoop({
            batchId: 'strict-batch',
            runRetroCalibration: true,
            persist: false
        })).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_GOVERNANCE_BATCH_FORBIDDEN',
            statusCode: 409
        });
        expect(feedbackLoop.getJudgeFeedbackStats).not.toHaveBeenCalled();
        expect(feedbackLoop.autoPromoteGroundTruth).not.toHaveBeenCalled();
        expect(retro.runRetroCalibration).not.toHaveBeenCalled();
    });

    it('runs all sub-steps in the documented order and records ok status', async () => {
        mockBatchFound(BATCH_1);
        defaultFeedback();
        retro.runRetroCalibration.mockResolvedValue({
            samples: 10, results: { created: 4, skipped: 6, errors: 0, total: 10 }
        });
        JudgeGroundTruth.getForValidation.mockResolvedValue([
            { _id: 'gt1', category: 'coding', difficulty: 3, prompt: 'p', response: 'r' }
        ]);
        calibration.runCalibrationBatch
            .mockResolvedValueOnce([{ entry: { category: 'coding', difficulty: 3 }, score: 8 }])
            .mockResolvedValueOnce([{ entry: { category: 'coding', difficulty: 3 }, score: 7.5 }]);
        calibration.buildAccuracyMatrix.mockReturnValue({
            cells: [{ category: 'coding', difficulty: 3, avg_deviation: 0.5, sample_count: 1, pass: true }],
            overall_avg_deviation: 0.5,
            pass_rate: 100
        });
        JudgeAccuracyMatrix.create.mockResolvedValue({ _id: { toString: () => 'mat-1' } });
        mockDriftAggregates(
            { mean: 7, stddev: 1.2, count: 30 },
            { mean: 7.1, stddev: 1.1, count: 300 }
        );
        drift.detectDrift.mockReturnValue({ drifted: false, reasons: [], mean_delta: 0.1, variance_ratio: 1.2, insufficient_data: false });

        const out = await runJudgeGovernanceLoop({
            judgeModel: 'judge-a', judgeHost: 'h1',
            referenceModel: 'ref-b', referenceHost: 'h2',
            runRetroCalibration: true,
            persist: true
        });

        expect(feedbackLoop.getJudgeFeedbackStats).toHaveBeenCalledTimes(1);
        expect(feedbackLoop.autoPromoteGroundTruth).toHaveBeenCalledTimes(1);
        expect(retro.runRetroCalibration).toHaveBeenCalledTimes(1);
        expect(calibration.runCalibrationBatch).toHaveBeenCalledTimes(2); // ref + challenger
        expect(drift.detectDrift).toHaveBeenCalledTimes(1);
        expect(BenchmarkResult.aggregate).toHaveBeenNthCalledWith(1, expect.arrayContaining([
            expect.objectContaining({
                $match: expect.objectContaining({
                    batch_id: new mongoose.Types.ObjectId(BATCH_1),
                    $nor: expect.arrayContaining([
                        { trust_candidate_id: { $ne: null } },
                        { trust_prompt_id: { $ne: null } },
                        { trust_evidence_sealed: true }
                    ])
                })
            })
        ]));
        expect(BenchmarkResult.aggregate).toHaveBeenNthCalledWith(2, expect.arrayContaining([
            expect.objectContaining({
                $match: expect.objectContaining({
                    batch_id: { $ne: new mongoose.Types.ObjectId(BATCH_1) },
                    $nor: expect.any(Array)
                })
            })
        ]));

        const names = out.sub_steps.map(s => s.name);
        expect(names).toEqual([
            'feedback_stats',
            'auto_promote',
            'retro_calibration',
            'matrix_calibration',
            'drift_detection'
        ]);
        expect(out.status).toBe('ok');
        expect(out.headline.auto_promoted).toBe(3);
        expect(out.headline.retro_created).toBe(4);
        expect(out.headline.matrix_pass_rate).toBe(100);
        expect(out.headline.drift_status).toBe('ok');
        expect(out.headline.drift_detected).toBe(false);

        expect(JudgeGovernanceRun.create).toHaveBeenCalledTimes(1);
    });

    it('captures a partial failure without erasing sibling outputs', async () => {
        mockBatchFound(BATCH_2);
        defaultFeedback();
        // auto_promote fails; all other sub-steps continue.
        feedbackLoop.autoPromoteGroundTruth.mockRejectedValue(new Error('db down'));
        JudgeGroundTruth.getForValidation.mockResolvedValue([]);  // → matrix skipped
        mockDriftAggregates(null, null);  // insufficient_data

        const out = await runJudgeGovernanceLoop({
            judgeModel: 'j', judgeHost: 'h', referenceModel: 'r', referenceHost: 'h',
            persist: false
        });

        expect(out.status).toBe('partial');

        const promote = out.sub_steps.find(s => s.name === 'auto_promote');
        expect(promote.status).toBe('failed');
        expect(promote.error).toMatch(/db down/);

        // siblings are intact
        const feedback = out.sub_steps.find(s => s.name === 'feedback_stats');
        expect(feedback.status).toBe('ok');
        expect(feedback.output.overall.count).toBe(20);

        const matrix = out.sub_steps.find(s => s.name === 'matrix_calibration');
        expect(matrix.status).toBe('skipped');

        // headline falls back to defaults for the failed step
        expect(out.headline.auto_promoted).toBe(0);
        expect(out.headline.feedback_overall_count).toBe(20);
    });

    it('skips retro-calibration when not requested and skips matrix when models missing', async () => {
        mockNoBatch();
        defaultFeedback();
        mockDriftAggregates(null, null);

        const out = await runJudgeGovernanceLoop({ persist: false });

        const retroStep = out.sub_steps.find(s => s.name === 'retro_calibration');
        expect(retroStep.status).toBe('skipped');

        const matrixStep = out.sub_steps.find(s => s.name === 'matrix_calibration');
        expect(matrixStep.status).toBe('skipped');

        // drift sub-step receives no batch_id → skipped
        const driftStep = out.sub_steps.find(s => s.name === 'drift_detection');
        expect(driftStep.status).toBe('skipped');

        expect(out.status).toBe('partial');
        expect(out.headline.drift_status).toBe('skipped');
        expect(out.headline.drift_detected).toBeNull();
        expect(retro.runRetroCalibration).not.toHaveBeenCalled();
        expect(calibration.runCalibrationBatch).not.toHaveBeenCalled();
    });

    it('keeps insufficient drift evidence unknown rather than reporting no drift', async () => {
        mockBatchFound(BATCH_2);
        defaultFeedback();
        JudgeGroundTruth.getForValidation.mockResolvedValue([]);
        mockDriftAggregates(null, null);

        const out = await runJudgeGovernanceLoop({ persist: false });

        expect(out.status).toBe('partial');
        expect(out.headline.drift_status).toBe('insufficient_data');
        expect(out.headline.drift_detected).toBeNull();
    });

    it('persists the summary doc so a single read replaces five manual endpoints', async () => {
        mockBatchFound(BATCH_3);
        defaultFeedback();
        mockDriftAggregates(null, null);

        const out = await runJudgeGovernanceLoop({ persist: true, triggeredBy: 'api' });

        expect(JudgeGovernanceRun.create).toHaveBeenCalledTimes(1);
        const persisted = JudgeGovernanceRun.create.mock.calls[0][0];
        expect(persisted.triggered_by).toBe('api');
        expect(persisted.sub_steps).toHaveLength(5);
        expect(persisted.headline).toBeDefined();
        expect(out._id).toBe('gov-run-1');
    });

    it('invalidates a summary create that races workload admission loss', async () => {
        mockNoBatch();
        defaultFeedback();
        mockDriftAggregates(null, null);
        const controller = new AbortController();
        const lost = Object.assign(new Error('governance admission lost'), { code: 'BENCHMARK_CLAIM_LOST' });
        JudgeGovernanceRun.create.mockImplementationOnce(async documents => {
            controller.abort(lost);
            return [{ ...documents[0], _id: 'gov-lost' }];
        });
        JudgeGovernanceRun.updateOne.mockResolvedValue({ matchedCount: 1 });

        await expect(runJudgeGovernanceLoop({
            persist: true,
            cancelSignal: controller.signal
        })).rejects.toMatchObject({
            code: 'BENCHMARK_BATCH_STOPPED',
            authorityCompensated: true
        });

        expect(JudgeGovernanceRun.updateOne).toHaveBeenCalledWith(
            expect.objectContaining({ _id: expect.any(mongoose.Types.ObjectId) }),
            { $set: expect.objectContaining({ status: 'failed', authority_state: 'authority_invalidated' }) },
            { upsert: true }
        );
    });

    it('retains admission when a raced governance summary cannot be invalidated', async () => {
        mockNoBatch();
        defaultFeedback();
        mockDriftAggregates(null, null);
        const controller = new AbortController();
        const lost = Object.assign(new Error('governance admission lost'), { code: 'BENCHMARK_CLAIM_LOST' });
        JudgeGovernanceRun.create.mockImplementationOnce(async documents => {
            controller.abort(lost);
            return [{ ...documents[0], _id: 'gov-lost' }];
        });
        JudgeGovernanceRun.updateOne.mockRejectedValueOnce(new Error('summary invalidation unavailable'));

        await expect(runJudgeGovernanceLoop({
            persist: true,
            cancelSignal: controller.signal
        })).rejects.toMatchObject({
            code: 'JUDGE_GOVERNANCE_RECONCILIATION_PENDING',
            retainAdmission: true,
            compensationError: expect.any(Error)
        });
    });
});

describe('judgeGovernance — getLatestGovernanceRun', () => {
    it('returns null when no run exists', async () => {
        JudgeGovernanceRun.getLatest.mockResolvedValue(null);
        const out = await getLatestGovernanceRun();
        expect(out).toBeNull();
    });

    it('returns a plain object when a run exists', async () => {
        JudgeGovernanceRun.getLatest.mockResolvedValue({
            toObject: () => ({ _id: 'r1', status: 'ok' })
        });
        const out = await getLatestGovernanceRun();
        expect(out).toEqual({ _id: 'r1', status: 'ok' });
    });

    it('filters by judge model when supplied', async () => {
        JudgeGovernanceRun.getLatest.mockResolvedValue(null);
        await getLatestGovernanceRun('judge-x');
        expect(JudgeGovernanceRun.getLatest).toHaveBeenCalledWith('judge-x');
    });
});
