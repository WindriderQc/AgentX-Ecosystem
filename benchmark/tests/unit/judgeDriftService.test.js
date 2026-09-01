/**
 * 0129 — judgeDriftService unit tests
 *
 * Covers:
 *   - classifyDrift threshold logic (15pp drop, 0.5 floor, insufficient data)
 *   - computeDrift path with mocked sample + baseline
 *   - ratifyBaseline toggles active flag
 */

jest.mock('../../config/logger', () => ({
    info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn()
}));

jest.mock('../../models/JudgeGroundTruth', () => ({
    find: jest.fn()
}));

jest.mock('../../src/services/benchmark/retroCalibration', () => ({
    CATEGORIES: ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'],
    loadQualifiedHumanGroundTruth: jest.fn()
}));

jest.mock('../../models/CalibrationBaseline', () => {
    const fn = jest.fn();
    fn.getActive = jest.fn();
    fn.updateMany = jest.fn().mockResolvedValue({ modifiedCount: 0 });
    fn.findOneAndUpdate = jest.fn();
    return fn;
});

const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const CalibrationBaseline = require('../../models/CalibrationBaseline');
const { loadQualifiedHumanGroundTruth } = require('../../src/services/benchmark/retroCalibration');
const {
    classifyDrift,
    gatherReviewSample,
    computeDrift,
    ratifyBaseline,
    DRIFT_THRESHOLDS
} = require('../../src/services/benchmark/judgeDriftService');

function mockFindChain(docs) {
    return {
        sort: jest.fn().mockReturnValue({
            limit: jest.fn().mockReturnValue({
                lean: jest.fn().mockResolvedValue(docs)
            })
        })
    };
}

beforeEach(() => {
    jest.clearAllMocks();
});

describe('classifyDrift', () => {
    test('returns insufficient_data below min sample size', () => {
        const r = classifyDrift(0.8, 0.9, 3);
        expect(r.status).toBe('insufficient_data');
        expect(r.triggered).toBe(false);
    });

    test('returns insufficient_data when current_rho is null', () => {
        const r = classifyDrift(null, 0.9, 20);
        expect(r.status).toBe('insufficient_data');
    });

    test('fires on 15pp drop', () => {
        const r = classifyDrift(0.60, 0.85, 30);
        expect(r.triggered).toBe(true);
        expect(r.reasons).toContain('drop_15pp');
        expect(r.status).toBe('alert');
    });

    test('fires on absolute floor', () => {
        const r = classifyDrift(0.45, 0.5, 30);
        expect(r.triggered).toBe(true);
        expect(r.reasons).toContain('absolute_floor');
    });

    test('fires on both conditions', () => {
        const r = classifyDrift(0.30, 0.80, 30);
        expect(r.reasons).toEqual(expect.arrayContaining(['drop_15pp', 'absolute_floor']));
    });

    test('does not fire when drop is below 15pp', () => {
        const r = classifyDrift(0.75, 0.85, 30);
        expect(r.triggered).toBe(false);
    });

    test('no_baseline status when baseline is null and above floor', () => {
        const r = classifyDrift(0.70, null, 20);
        expect(r.status).toBe('no_baseline');
        expect(r.triggered).toBe(false);
    });

    test('alert when no baseline but below floor', () => {
        const r = classifyDrift(0.40, null, 20);
        expect(r.status).toBe('alert');
        expect(r.triggered).toBe(true);
    });

    test('uses configured thresholds', () => {
        expect(DRIFT_THRESHOLDS.drop_pp).toBe(0.15);
        expect(DRIFT_THRESHOLDS.absolute_floor).toBe(0.5);
        expect(DRIFT_THRESHOLDS.min_sample_size).toBe(5);
    });
});

describe('gatherReviewSample', () => {
    test('loads only qualified human ground truth per category', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([]);
        await gatherReviewSample(10, ['coding', 'reasoning']);
        expect(loadQualifiedHumanGroundTruth).toHaveBeenCalledTimes(2);
        expect(loadQualifiedHumanGroundTruth).toHaveBeenNthCalledWith(1, { category: 'coding' });
        expect(loadQualifiedHumanGroundTruth).toHaveBeenNthCalledWith(2, { category: 'reasoning' });
    });

    test('returns judge/human arrays for correlation', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            { judge_score_at_review: 7, expert_scores: { overall: 8 } },
            { judge_score_at_review: 6, expert_scores: { overall: 5 } }
        ]);
        const out = await gatherReviewSample(5, ['coding']);
        expect(out.coding.judge).toEqual([7, 6]);
        expect(out.coding.human).toEqual([8, 5]);
    });

    test('reports unioned rows that do not have current judge stamps', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            { judge_score_at_review: 7, expert_scores: { overall: 8 } },
            { source: 'config-goldset', expert_scores: { overall: 5 } }
        ]);

        const out = await gatherReviewSample(5, ['coding']);
        expect(out.coding.scored_count).toBe(1);
        expect(out.coding.unscored_qualified_human_count).toBe(1);
        expect(out.coding.sample_source).toBe('qualified_human_ground_truth');
    });

    test('counts materialized config-goldset rows as scored rows', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            {
                name: 'config-goldset-cal-bad-02',
                source: 'human-validation-sprint-2026-07-02-config-goldset',
                judge_score_at_review: 2,
                expert_scores: { overall: 2 }
            },
            {
                name: 'courthouse-review-math-1',
                source: 'courthouse-review',
                judge_score_at_review: 7,
                expert_scores: { overall: 8 }
            }
        ]);

        const out = await gatherReviewSample(5, ['math']);
        expect(out.math.scored_count).toBe(2);
        expect(out.math.unscored_qualified_human_count).toBe(0);
        expect(out.math.judge).toEqual([2, 7]);
        expect(out.math.human).toEqual([2, 8]);
    });

    test('unscored qualified-human count drops when a qualified row gains a judge stamp', async () => {
        loadQualifiedHumanGroundTruth
            .mockResolvedValueOnce([
                {
                    name: 'config-goldset-cal-bad-02',
                    source: 'config-goldset',
                    expert_scores: { overall: 2 }
                }
            ])
            .mockResolvedValueOnce([
                {
                    name: 'config-goldset-cal-bad-02',
                    source: 'human-validation-sprint-2026-07-02-config-goldset',
                    judge_score_at_review: 2,
                    expert_scores: { overall: 2 }
                }
            ]);

        const before = await gatherReviewSample(5, ['math']);
        const after = await gatherReviewSample(5, ['math']);

        expect(before.math.unscored_qualified_human_count).toBe(1);
        expect(before.math.scored_count).toBe(0);
        expect(after.math.unscored_qualified_human_count).toBe(0);
        expect(after.math.scored_count).toBe(1);
    });
});

describe('computeDrift', () => {
    test('returns per-category rows with baseline comparison', async () => {
        // Perfectly correlated pair across all categories
        const pairs = [
            { judge_score_at_review: 2, expert_scores: { overall: 2 } },
            { judge_score_at_review: 5, expert_scores: { overall: 5 } },
            { judge_score_at_review: 8, expert_scores: { overall: 8 } },
            { judge_score_at_review: 10, expert_scores: { overall: 10 } },
            { judge_score_at_review: 4, expert_scores: { overall: 4 } },
            { judge_score_at_review: 7, expert_scores: { overall: 7 } }
        ];
        loadQualifiedHumanGroundTruth.mockResolvedValue(pairs);
        CalibrationBaseline.getActive.mockResolvedValue({
            label: 'test-baseline',
            overall_rho: 0.9,
            categories: [
                { category: 'coding', rho: 0.85, sample_size: 30 },
                { category: 'reasoning', rho: 0.80, sample_size: 30 }
            ]
        });

        const out = await computeDrift({ perCategory: 10 });
        expect(out.overall_status).toBe('no_baseline');
        expect(out.baseline_label).toBe('test-baseline');
        expect(out.categories).toHaveLength(7); // 7 categories
        const coding = out.categories.find(c => c.category === 'coding');
        expect(coding.current_rho).toBeCloseTo(1.0, 1);
        expect(coding.baseline_rho).toBe(0.85);
        expect(coding.triggered).toBe(false);
    });

    test('triggers alert when category drops 15pp', async () => {
        // Anti-correlated pair
        const pairs = [
            { judge_score_at_review: 1, expert_scores: { overall: 10 } },
            { judge_score_at_review: 2, expert_scores: { overall: 8 } },
            { judge_score_at_review: 5, expert_scores: { overall: 6 } },
            { judge_score_at_review: 7, expert_scores: { overall: 3 } },
            { judge_score_at_review: 9, expert_scores: { overall: 2 } }
        ];
        loadQualifiedHumanGroundTruth.mockResolvedValue(pairs);
        CalibrationBaseline.getActive.mockResolvedValue({
            label: 'test-baseline',
            categories: [{ category: 'coding', rho: 0.90, sample_size: 30 }]
        });

        const out = await computeDrift({ perCategory: 10 });
        const coding = out.categories.find(c => c.category === 'coding');
        expect(coding.triggered).toBe(true);
        expect(coding.status).toBe('alert');
        expect(out.overall_status).toBe('alert');
    });

    test('handles missing baseline gracefully', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([]);
        CalibrationBaseline.getActive.mockResolvedValue(null);
        const out = await computeDrift({ perCategory: 10 });
        expect(out.baseline_label).toBeNull();
        expect(out.overall_status).toBe('insufficient_data');
    });
});

describe('ratifyBaseline', () => {
    test('materializes the target, releases other baselines, and claims the unique active slot', async () => {
        CalibrationBaseline.findOneAndUpdate
            .mockResolvedValueOnce({ _id: 'target-id', label: 'new', active: false })
            .mockResolvedValueOnce({ _id: 'target-id', label: 'new', active: true, active_slot: 'active' });
        const doc = await ratifyBaseline({
            label: 'new',
            categories: [{ category: 'coding', rho: 0.9, sample_size: 30 }],
            overall_rho: 0.9
        });
        expect(CalibrationBaseline.updateMany).toHaveBeenCalledWith(
            { _id: { $ne: 'target-id' }, active: true },
            { $set: { active: false }, $unset: { active_slot: '' } }
        );
        expect(CalibrationBaseline.findOneAndUpdate).toHaveBeenNthCalledWith(
            2,
            { _id: 'target-id' },
            { $set: { active: true, active_slot: 'active' } },
            { new: true }
        );
        expect(doc.label).toBe('new');
    });

    test('fails closed when another baseline wins the unique active slot', async () => {
        CalibrationBaseline.findOneAndUpdate
            .mockResolvedValueOnce({ _id: 'target-id', label: 'new', active: false })
            .mockRejectedValueOnce(Object.assign(new Error('duplicate key'), { code: 11000 }));

        await expect(ratifyBaseline({
            label: 'new',
            categories: []
        })).rejects.toMatchObject({ code: 'CALIBRATION_BASELINE_CONFLICT' });
    });

    test('rejects missing label', async () => {
        await expect(ratifyBaseline({ categories: [] })).rejects.toThrow('label');
    });

    test('rejects missing categories', async () => {
        await expect(ratifyBaseline({ label: 'x' })).rejects.toThrow('categories');
    });
});
