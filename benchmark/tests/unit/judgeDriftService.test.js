/**
 * 0129 — judgeDriftService unit tests
 *
 * Covers:
 *   - classifyDrift threshold logic (15pp drop, 0.5 floor, insufficient data)
 *   - computeDrift path with mocked sample + baseline
 *   - ratifyBaseline delegates to the controlled model authority
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
    fn.ratifyExactIdentity = jest.fn();
    return fn;
});

const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const CalibrationBaseline = require('../../models/CalibrationBaseline');
const { loadQualifiedHumanGroundTruth } = require('../../src/services/benchmark/retroCalibration');
const {
    requireJudgeIdentityFingerprint,
    classifyDrift,
    gatherReviewSample,
    computeDrift,
    ratifyBaseline,
    DRIFT_THRESHOLDS
} = require('../../src/services/benchmark/judgeDriftService');

const JUDGE_IDENTITY_FINGERPRINT = 'a'.repeat(64);
const OTHER_JUDGE_IDENTITY_FINGERPRINT = 'b'.repeat(64);
const DRIFT_CATEGORIES = ['coding', 'reasoning', 'math', 'knowledge', 'instruction', 'creative', 'translation'];

function canonicalBaseline(overrides = {}) {
    const categoryRhos = overrides.categoryRhos || {};
    const categories = DRIFT_CATEGORIES.map(category => ({
        category,
        rho: categoryRhos[category] ?? 0.9,
        sample_size: 5
    }));
    const { categoryRhos: _categoryRhos, ...rest } = overrides;
    return {
        label: 'test-baseline',
        judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
        overall_rho: 0.9,
        overall_sample_size: 35,
        categories,
        ...rest
    };
}

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
    test('requires an exact lowercase SHA-256 judge identity', () => {
        expect(requireJudgeIdentityFingerprint(JUDGE_IDENTITY_FINGERPRINT))
            .toBe(JUDGE_IDENTITY_FINGERPRINT);
        expect(() => requireJudgeIdentityFingerprint()).toThrow(/judge_identity_fingerprint/);
        expect(() => requireJudgeIdentityFingerprint('A'.repeat(64)))
            .toThrow(/judge_identity_fingerprint/);
    });

    test('returns insufficient_data below min sample size', () => {
        const r = classifyDrift(0.8, 0.9, 3);
        expect(r.status).toBe('insufficient_data');
        expect(r.triggered).toBe(false);
    });

    test('returns insufficient_data when current_rho is null', () => {
        const r = classifyDrift(null, 0.9, 20);
        expect(r.status).toBe('insufficient_data');
    });

    test.each([
        [Number.NaN, 0.9, 20, 'invalid_current_correlation'],
        [Number.POSITIVE_INFINITY, 0.9, 20, 'invalid_current_correlation'],
        [0.8, Number.NEGATIVE_INFINITY, 20, 'invalid_baseline_correlation'],
        [0.8, 2, 20, 'invalid_baseline_correlation'],
        [0.8, 0.9, Number.NaN, 'invalid_sample_size']
    ])('fails closed on non-finite or out-of-domain drift input %#', (current, baseline, size, reason) => {
        const result = classifyDrift(current, baseline, size);
        expect(result.status).toBe('insufficient_data');
        expect(result.triggered).toBe(false);
        expect(result.reasons).toContain(reason);
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

    test('does not claim drift when no exact-identity baseline exists', () => {
        const r = classifyDrift(0.40, null, 20);
        expect(r.status).toBe('no_baseline');
        expect(r.triggered).toBe(false);
    });

    test('uses configured thresholds', () => {
        expect(DRIFT_THRESHOLDS.drop_pp).toBe(0.15);
        expect(DRIFT_THRESHOLDS.absolute_floor).toBe(0.5);
        expect(DRIFT_THRESHOLDS.min_sample_size).toBe(5);
    });
});

describe('gatherReviewSample', () => {
    test.each([-1, 4, 5.5, Number.NaN, 1001])(
        'rejects invalid direct sample window %p',
        async perCategory => {
            await expect(gatherReviewSample(
                perCategory,
                ['coding'],
                JUDGE_IDENTITY_FINGERPRINT
            )).rejects.toMatchObject({ code: 'INVALID_DRIFT_SAMPLE_SIZE', statusCode: 400 });
            expect(loadQualifiedHumanGroundTruth).not.toHaveBeenCalled();
        }
    );

    test('loads only qualified human ground truth per category', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([]);
        await gatherReviewSample(10, ['coding', 'reasoning'], JUDGE_IDENTITY_FINGERPRINT);
        expect(loadQualifiedHumanGroundTruth).toHaveBeenCalledTimes(2);
        expect(loadQualifiedHumanGroundTruth).toHaveBeenNthCalledWith(1, {
            category: 'coding',
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        expect(loadQualifiedHumanGroundTruth).toHaveBeenNthCalledWith(2, {
            category: 'reasoning',
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
    });

    test('returns judge/human arrays for correlation', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            { judge_score_at_review: 7, expert_scores: { overall: 8 } },
            { judge_score_at_review: 6, expert_scores: { overall: 5 } }
        ]);
        const out = await gatherReviewSample(5, ['coding'], JUDGE_IDENTITY_FINGERPRINT);
        expect(out.coding.judge).toEqual([7, 6]);
        expect(out.coding.human).toEqual([8, 5]);
    });

    test('reports unioned rows that do not have current judge stamps', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            { judge_score_at_review: 7, expert_scores: { overall: 8 } },
            { source: 'config-goldset', expert_scores: { overall: 5 } }
        ]);

        const out = await gatherReviewSample(5, ['coding'], JUDGE_IDENTITY_FINGERPRINT);
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

        const out = await gatherReviewSample(5, ['math'], JUDGE_IDENTITY_FINGERPRINT);
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

        const before = await gatherReviewSample(5, ['math'], JUDGE_IDENTITY_FINGERPRINT);
        const after = await gatherReviewSample(5, ['math'], JUDGE_IDENTITY_FINGERPRINT);

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
        CalibrationBaseline.getActive.mockResolvedValue(canonicalBaseline({
            categoryRhos: { coding: 0.85, reasoning: 0.80 }
        }));

        const out = await computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        expect(out.overall_status).toBe('ok');
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
        CalibrationBaseline.getActive.mockResolvedValue(canonicalBaseline());

        const out = await computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        const coding = out.categories.find(c => c.category === 'coding');
        expect(coding.triggered).toBe(true);
        expect(coding.status).toBe('alert');
        expect(out.overall_status).toBe('alert');
    });

    test('handles missing baseline gracefully', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([]);
        CalibrationBaseline.getActive.mockResolvedValue(null);
        const out = await computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        expect(CalibrationBaseline.getActive).toHaveBeenCalledWith(JUDGE_IDENTITY_FINGERPRINT);
        expect(out.baseline_label).toBeNull();
        expect(out.overall_status).toBe('insufficient_data');
    });

    test('fails closed when active baseline state is internally inconsistent', async () => {
        CalibrationBaseline.getActive.mockRejectedValue(Object.assign(
            new Error('active calibration baseline state is inconsistent'),
            { code: 'CALIBRATION_BASELINE_CONFLICT', statusCode: 409 }
        ));

        await expect(computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        })).rejects.toMatchObject({
            code: 'CALIBRATION_BASELINE_CONFLICT',
            statusCode: 409
        });
        expect(loadQualifiedHumanGroundTruth).not.toHaveBeenCalled();
    });

    test.each([
        [
            'judge',
            [
                { judge_score_at_review: 7, expert_scores: { overall: 1 } },
                { judge_score_at_review: 7, expert_scores: { overall: 2 } },
                { judge_score_at_review: 7, expert_scores: { overall: 3 } },
                { judge_score_at_review: 7, expert_scores: { overall: 4 } },
                { judge_score_at_review: 7, expert_scores: { overall: 5 } }
            ],
            'constant_judge_series'
        ],
        [
            'human',
            [
                { judge_score_at_review: 1, expert_scores: { overall: 7 } },
                { judge_score_at_review: 2, expert_scores: { overall: 7 } },
                { judge_score_at_review: 3, expert_scores: { overall: 7 } },
                { judge_score_at_review: 4, expert_scores: { overall: 7 } },
                { judge_score_at_review: 5, expert_scores: { overall: 7 } }
            ],
            'constant_human_series'
        ]
    ])('treats a constant %s score series as insufficient data', async (_label, pairs, reason) => {
        loadQualifiedHumanGroundTruth.mockResolvedValue(pairs);
        CalibrationBaseline.getActive.mockResolvedValue(canonicalBaseline());

        const out = await computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        const coding = out.categories.find(c => c.category === 'coding');

        expect(coding.current_rho).toBeNull();
        expect(coding.status).toBe('insufficient_data');
        expect(coding.triggered).toBe(false);
        expect(coding.reasons).toContain(reason);
        expect(out.overall_status).toBe('insufficient_data');
    });

    test('rejects a drift computation without an exact judge identity', async () => {
        await expect(computeDrift({ perCategory: 10 }))
            .rejects.toMatchObject({ code: 'INVALID_JUDGE_IDENTITY_FINGERPRINT', statusCode: 400 });
        expect(CalibrationBaseline.getActive).not.toHaveBeenCalled();
        expect(loadQualifiedHumanGroundTruth).not.toHaveBeenCalled();
    });

    test('rejects every caller-supplied baseline, including a forged same-identity baseline', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            { judge_score_at_review: 1, expert_scores: { overall: 5 } },
            { judge_score_at_review: 2, expert_scores: { overall: 4 } },
            { judge_score_at_review: 3, expert_scores: { overall: 3 } },
            { judge_score_at_review: 4, expert_scores: { overall: 2 } },
            { judge_score_at_review: 5, expert_scores: { overall: 1 } }
        ]);
        CalibrationBaseline.getActive.mockResolvedValue(canonicalBaseline());

        const canonical = await computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        expect(canonical.categories.find(c => c.category === 'coding').status).toBe('alert');

        await expect(computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
            baseline: {
                ...canonicalBaseline({ label: 'forged-ok-baseline' }),
                categories: canonicalBaseline().categories.map(row => ({ ...row, rho: -1 })),
                overall_rho: -1
            }
        })).rejects.toMatchObject({
            code: 'CALLER_SUPPLIED_CALIBRATION_BASELINE_FORBIDDEN',
            statusCode: 400
        });
        expect(CalibrationBaseline.getActive).toHaveBeenCalledTimes(1);
    });

    test('does not compare evidence with a canonical row for another judge identity', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            { judge_score_at_review: 1, expert_scores: { overall: 5 } },
            { judge_score_at_review: 2, expert_scores: { overall: 4 } },
            { judge_score_at_review: 3, expert_scores: { overall: 3 } },
            { judge_score_at_review: 4, expert_scores: { overall: 2 } },
            { judge_score_at_review: 5, expert_scores: { overall: 1 } }
        ]);
        CalibrationBaseline.getActive.mockResolvedValue(canonicalBaseline({
            judge_identity_fingerprint: OTHER_JUDGE_IDENTITY_FINGERPRINT
        }));

        const out = await computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        const coding = out.categories.find(c => c.category === 'coding');

        expect(out.baseline_label).toBeNull();
        expect(coding.baseline_rho).toBeNull();
        expect(coding.status).toBe('no_baseline');
        expect(coding.triggered).toBe(false);
        expect(coding.reasons).toContain('baseline_identity_mismatch');
    });

    test.each([-1, 0, 4, 5.5, Number.NaN, Number.POSITIVE_INFINITY, 1001])(
        'rejects invalid perCategory value %p before database reads',
        async perCategory => {
            await expect(computeDrift({
                perCategory,
                judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
            })).rejects.toMatchObject({ code: 'INVALID_DRIFT_SAMPLE_SIZE', statusCode: 400 });
            expect(CalibrationBaseline.getActive).not.toHaveBeenCalled();
            expect(loadQualifiedHumanGroundTruth).not.toHaveBeenCalled();
        }
    );

    test('taints a category when any selected qualified score is non-finite or out of range', async () => {
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            { judge_score_at_review: 1, expert_scores: { overall: 1 } },
            { judge_score_at_review: 2, expert_scores: { overall: 2 } },
            { judge_score_at_review: 3, expert_scores: { overall: 3 } },
            { judge_score_at_review: 4, expert_scores: { overall: 4 } },
            { judge_score_at_review: 5, expert_scores: { overall: 5 } },
            { judge_score_at_review: Number.NaN, expert_scores: { overall: 6 } },
            { judge_score_at_review: 7, expert_scores: { overall: Number.POSITIVE_INFINITY } },
            { judge_score_at_review: 11, expert_scores: { overall: 7 } }
        ]);
        CalibrationBaseline.getActive.mockResolvedValue(canonicalBaseline());

        const out = await computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        const coding = out.categories.find(c => c.category === 'coding');
        expect(coding.current_rho).toBeNull();
        expect(coding.invalid_numeric_sample_size).toBe(3);
        expect(coding.status).toBe('insufficient_data');
        expect(coding.reasons).toContain('invalid_score_series');
        expect(out.overall_status).toBe('insufficient_data');
    });

    test.each([
        ['non-finite rho', baseline => { baseline.categories[0].rho = Number.NaN; }],
        ['out-of-range rho', baseline => { baseline.categories[0].rho = -2; }],
        ['negative sample', baseline => { baseline.categories[0].sample_size = -7; }],
        ['duplicate category', baseline => { baseline.categories[1].category = 'coding'; }],
        ['unknown category', baseline => { baseline.categories[1].category = 'factual'; }],
        ['missing category', baseline => { baseline.categories.pop(); baseline.overall_sample_size = 30; }],
        ['inconsistent total', baseline => { baseline.overall_sample_size = 34; }],
        ['non-finite overall', baseline => { baseline.overall_rho = Number.POSITIVE_INFINITY; }]
    ])('fails closed on a raw legacy baseline with %s', async (_label, mutate) => {
        const baseline = canonicalBaseline();
        mutate(baseline);
        CalibrationBaseline.getActive.mockResolvedValue(baseline);
        loadQualifiedHumanGroundTruth.mockResolvedValue([
            { judge_score_at_review: 1, expert_scores: { overall: 1 } },
            { judge_score_at_review: 2, expert_scores: { overall: 2 } },
            { judge_score_at_review: 3, expert_scores: { overall: 3 } },
            { judge_score_at_review: 4, expert_scores: { overall: 4 } },
            { judge_score_at_review: 5, expert_scores: { overall: 5 } }
        ]);

        const out = await computeDrift({
            perCategory: 10,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        expect(out.overall_status).toBe('insufficient_data');
        expect(out.categories.every(row => row.status === 'insufficient_data')).toBe(true);
    });
});

describe('ratifyBaseline', () => {
    test('delegates the exact identity transition to the controlled model authority', async () => {
        CalibrationBaseline.ratifyExactIdentity.mockResolvedValue({
            _id: 'target-id',
            label: 'new',
            active: true,
            identity_active_slot: JUDGE_IDENTITY_FINGERPRINT,
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        });
        const doc = await ratifyBaseline({
            label: 'new',
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
            categories: [{ category: 'coding', rho: 0.9, sample_size: 30 }],
            overall_rho: 0.9
        });
        expect(CalibrationBaseline.ratifyExactIdentity).toHaveBeenCalledWith({
            label: 'new',
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
            categories: [{ category: 'coding', rho: 0.9, sample_size: 30 }],
            overall_rho: 0.9
        });
        expect(doc.label).toBe('new');
    });

    test('passes judge B to the model without substituting judge A', async () => {
        CalibrationBaseline.ratifyExactIdentity.mockResolvedValue({
            _id: 'target-b',
            label: 'judge-b',
            active: true,
            identity_active_slot: OTHER_JUDGE_IDENTITY_FINGERPRINT,
            judge_identity_fingerprint: OTHER_JUDGE_IDENTITY_FINGERPRINT
        });

        await ratifyBaseline({
            label: 'judge-b',
            judge_identity_fingerprint: OTHER_JUDGE_IDENTITY_FINGERPRINT,
            categories: []
        });

        expect(CalibrationBaseline.ratifyExactIdentity).toHaveBeenCalledWith({
            label: 'judge-b',
            judge_identity_fingerprint: OTHER_JUDGE_IDENTITY_FINGERPRINT,
            categories: []
        });
    });

    test('fails closed when another baseline wins the unique active slot', async () => {
        CalibrationBaseline.ratifyExactIdentity.mockRejectedValue(
            Object.assign(new Error('conflict'), { code: 'CALIBRATION_BASELINE_CONFLICT' })
        );

        await expect(ratifyBaseline({
            label: 'new',
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
            categories: []
        })).rejects.toMatchObject({ code: 'CALIBRATION_BASELINE_CONFLICT' });
    });

    test('rejects missing label', async () => {
        await expect(ratifyBaseline({
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
            categories: []
        })).rejects.toThrow('label');
    });

    test('rejects missing categories', async () => {
        await expect(ratifyBaseline({
            label: 'x',
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT
        })).rejects.toThrow('categories');
    });

    test('rejects a missing judge identity before writing a baseline', async () => {
        await expect(ratifyBaseline({ label: 'x', categories: [] }))
            .rejects.toMatchObject({ code: 'INVALID_JUDGE_IDENTITY_FINGERPRINT' });
        expect(CalibrationBaseline.ratifyExactIdentity).not.toHaveBeenCalled();
    });

    test('rejects reusing a baseline label from another judge identity', async () => {
        CalibrationBaseline.ratifyExactIdentity.mockRejectedValue(
            Object.assign(new Error('identity mismatch'), {
                code: 'CALIBRATION_BASELINE_IDENTITY_MISMATCH',
                statusCode: 409
            })
        );

        await expect(ratifyBaseline({
            label: 'existing',
            judge_identity_fingerprint: JUDGE_IDENTITY_FINGERPRINT,
            categories: []
        })).rejects.toMatchObject({
            code: 'CALIBRATION_BASELINE_IDENTITY_MISMATCH',
            statusCode: 409
        });
    });
});
