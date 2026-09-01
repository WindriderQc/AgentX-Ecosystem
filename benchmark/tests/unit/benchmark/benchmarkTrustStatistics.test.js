const {
    POWER_ANALYSIS_SCHEMA,
    STATISTICS_METHOD,
    buildBenchmarkTrustPowerAnalysisFields,
    studentTQuantile,
    evaluateBenchmarkTrustStatistics,
    buildBenchmarkTrustStatisticsReceiptFields
} = require('../../../src/services/benchmark/benchmarkTrustStatistics');

function preregistration(overrides = {}) {
    const defaults = {
        alpha: 0.05,
        mde: 1,
        equivalenceMargin: 0.25,
        repeatCount: 1,
        candidateIds: ['a', 'b'],
        promptIds: ['p1', 'p2', 'p3'],
        targetPowerBasisPoints: 8000,
        assumedMaxPairedStdDevMicros: 50000
    };
    const policy = { ...defaults, ...overrides };
    const powerFields = buildBenchmarkTrustPowerAnalysisFields({
        alpha: typeof policy.alpha === 'number' && policy.alpha > 0 && policy.alpha < 1
            ? policy.alpha
            : defaults.alpha,
        mde: typeof policy.mde === 'number' && policy.mde > 0 ? policy.mde : defaults.mde,
        candidateIds: Array.isArray(policy.candidateIds) && policy.candidateIds.length >= 2
            ? policy.candidateIds
            : defaults.candidateIds,
        targetPowerBasisPoints: Number.isSafeInteger(policy.targetPowerBasisPoints)
            && policy.targetPowerBasisPoints >= 8000
            && policy.targetPowerBasisPoints <= 9999
            ? policy.targetPowerBasisPoints
            : defaults.targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros: Number.isSafeInteger(policy.assumedMaxPairedStdDevMicros)
            && policy.assumedMaxPairedStdDevMicros > 0
            ? policy.assumedMaxPairedStdDevMicros
            : defaults.assumedMaxPairedStdDevMicros
    });
    return { ...policy, ...powerFields, ...overrides };
}

function rowsFor(candidateScores) {
    const rows = [];
    for (const [candidateId, promptScores] of Object.entries(candidateScores)) {
        for (const [promptId, scores] of Object.entries(promptScores)) {
            const attempts = Array.isArray(scores) ? scores : [scores];
            for (let repeatIndex = 0; repeatIndex < attempts.length; repeatIndex += 1) {
                rows.push({ candidateId, promptId, score: attempts[repeatIndex], repeatIndex });
            }
        }
    }
    return rows;
}

function comparison(result, leftCandidateId, rightCandidateId) {
    return result.comparisons.find(row => (
        row.leftCandidateId === leftCandidateId && row.rightCandidateId === rightCandidateId
    ));
}

describe('Benchmark Trust statistical decision', () => {
    test('versions the independent unit, interval and multiplicity method explicitly', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: 3, p2: 4 },
                b: { p1: 1, p2: 2 }
            }),
            preregistration: preregistration()
        });

        expect(result.method).toMatchObject({
            ...STATISTICS_METHOD,
            familySize: 1,
            adjustedAlpha: 0.05
        });
        expect(result.method.version).toBe('agentx.benchmark-trust-statistics/paired-prompt-bonferroni-t/v1');
        expect(result.method.powerAnalysis).toBe('student-t-critical-normal-shift-bound-v1');
        expect(POWER_ANALYSIS_SCHEMA).toBe('agentx.benchmark-trust-power-analysis/student-t-critical-normal-shift-bound/v1');
        expect(result).not.toHaveProperty('inputFingerprint');
    });

    test('computes a Student-t critical value rather than reusing the existing coarse CI table', () => {
        expect(studentTQuantile(0.975, 9)).toBeCloseTo(2.262157, 5);
        expect(studentTQuantile(0.025, 9)).toBeCloseTo(-2.262157, 5);
    });

    test.each([
        [{ alpha: 0, mde: 1, equivalenceMargin: 0.2, repeatCount: 1 }, 'alpha_invalid'],
        [{ alpha: 1, mde: 1, equivalenceMargin: 0.2, repeatCount: 1 }, 'alpha_invalid'],
        [{ alpha: 0.05, mde: -1, equivalenceMargin: 0.2, repeatCount: 1 }, 'mde_invalid'],
        [{ alpha: 0.05, mde: 1, equivalenceMargin: -0.2, repeatCount: 1 }, 'equivalence_margin_invalid'],
        [{ alpha: '0.05', mde: 1, equivalenceMargin: 0.2, repeatCount: 1 }, 'alpha_invalid'],
        [{ alpha: 0.05, mde: 1, equivalenceMargin: 0.2, repeatCount: 0 }, 'repeat_count_invalid'],
        [{ alpha: 0.05, mde: 1, equivalenceMargin: 0.2, repeatCount: 1.5 }, 'repeat_count_invalid']
    ])('fails closed on invalid preregistration %#', (policy, reason) => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 4, p2: 4 }, b: { p1: 1, p2: 1 } }),
            preregistration: policy
        });

        expect(result.eligibleForDecision).toBe(false);
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.decision.reasons).toContain(reason);
        expect(result.comparisons.every(row => row.lower === null && row.upper === null)).toBe(true);
        expect(result.comparisons.every(row => row.reasons.includes('invalid_preregistration'))).toBe(true);
        expect(result.comparisons.every(row => !row.reasons.includes('incomplete_matrix'))).toBe(true);
    });

    test('fails closed when rows is not an array', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: null,
            preregistration: preregistration({ candidateIds: ['a', 'b'], promptIds: ['p1', 'p2'] })
        });

        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.matrix.invalidRows).toEqual([{ index: null, reasons: ['rows_not_array'] }]);
        expect(result.reasons).toEqual(expect.arrayContaining(['invalid_rows', 'incomplete_matrix']));
    });

    test('cannot derive a decision from an observed population that was not preregistered', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 9, p2: 10 }, b: { p1: 1, p2: 2 } }),
            preregistration: {
                alpha: 0.05,
                mde: 1,
                equivalenceMargin: 0.25,
                repeatCount: 1
            }
        });

        expect(result.eligibleForDecision).toBe(false);
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.reasons).toEqual(expect.arrayContaining([
            'candidate_scope_missing',
            'prompt_scope_missing'
        ]));
    });

    test('returns not_evaluated for zero candidates', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: [],
            preregistration: preregistration({ candidateIds: [], promptIds: [] })
        });

        expect(result.decision).toMatchObject({
            outcome: 'not_evaluated',
            winner: null,
            equivalenceSet: []
        });
        expect(result.reasons).toEqual(expect.arrayContaining(['no_candidates', 'no_prompts']));
        expect(result.comparisons).toEqual([]);
    });

    test('returns not_evaluated for one candidate even with multiple prompts', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ only: { p1: 3, p2: 4 } }),
            preregistration: preregistration({ candidateIds: ['only'] })
        });

        expect(result.decision.outcome).toBe('not_evaluated');
        expect(result.reasons).toContain('insufficient_candidates');
    });

    test('does not estimate uncertainty from a single independent prompt', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: [8, 10, 9] }, b: { p1: [4, 5, 6] } }),
            preregistration: preregistration({ repeatCount: 3, promptIds: ['p1'] })
        });
        const pair = comparison(result, 'a', 'b');

        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.reasons).toContain('insufficient_independent_prompts');
        expect(pair).toMatchObject({ n: 1, effect: 4, lower: null, upper: null });
    });

    test('enforces the versioned preregistered power bound and its exact fingerprint', () => {
        const fields = buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            candidateIds: ['a', 'b'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: 50000
        });
        expect(fields).toMatchObject({
            requiredIndependentPromptCount: 3,
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: 50000
        });
        expect(fields.powerAnalysisFingerprint).toMatch(/^[0-9a-f]{64}$/);

        const largerVariance = buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            candidateIds: ['a', 'b'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: 1_000_000
        });
        const largerFamily = buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            candidateIds: ['a', 'b', 'c'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: 1_000_000
        });
        expect(largerVariance.requiredIndependentPromptCount).toBeGreaterThan(3);
        expect(largerFamily.requiredIndependentPromptCount)
            .toBeGreaterThanOrEqual(largerVariance.requiredIndependentPromptCount);
        expect(largerFamily.powerAnalysisFingerprint).not.toBe(largerVariance.powerAnalysisFingerprint);

        const underpowered = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 5, p2: 6 }, b: { p1: 2, p2: 3 } }),
            preregistration: preregistration({ mde: 0.25, promptIds: ['p1', 'p2'] })
        });
        expect(underpowered.eligibleForDecision).toBe(false);
        expect(underpowered.decision.outcome).toBe('inconclusive');
        expect(underpowered.reasons).toContain('underpowered_prompt_count');

        const portableA = `candidate_${'a'.repeat(32)}`;
        const portableB = `candidate_${'b'.repeat(32)}`;
        const underpoweredPolicy = preregistration({
            mde: 0.25,
            candidateIds: [portableA, portableB],
            promptIds: ['p1', 'p2']
        });
        const underpoweredProjection = buildBenchmarkTrustStatisticsReceiptFields({
            rows: rowsFor({
                [portableA]: { p1: 5, p2: 6 },
                [portableB]: { p1: 2, p2: 3 }
            }),
            preregistration: underpoweredPolicy
        }, {
            analysisPlanFingerprint: 'a'.repeat(64),
            rankingPolicyFingerprint: 'b'.repeat(64)
        });
        expect(underpoweredProjection).toMatchObject({
            winnerCandidateId: null,
            equivalenceCandidateIds: [],
            preregistration: { requiredIndependentPromptCount: 3 }
        });

        const falsifiedRequiredCount = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 5, p2: 6, p3: 7 }, b: { p1: 2, p2: 3, p3: 4 } }),
            preregistration: preregistration({
                mde: 0.25,
                requiredIndependentPromptCount: 4
            })
        });
        expect(falsifiedRequiredCount.eligibleForDecision).toBe(false);
        expect(falsifiedRequiredCount.reasons).toContain('required_prompt_count_mismatch');
    });

    test('withholds point intervals and decisions for degenerate paired variance', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: 5, p2: 6, p3: 7 },
                b: { p1: 2, p2: 3, p3: 4 }
            }),
            preregistration: preregistration({ mde: 0.25 })
        });
        const pair = comparison(result, 'a', 'b');

        expect(result.eligibleForDecision).toBe(false);
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.reasons).toContain('degenerate_paired_variance');
        expect(pair).toMatchObject({
            n: 3,
            standardError: null,
            lower: null,
            upper: null,
            complete: false,
            strictSuperiority: false
        });
    });

    test('fails closed when repetitions are imbalanced against the preregistered count', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: [8, 10], p2: 6 },
                b: { p1: 7, p2: [3, 5, 7] }
            }),
            preregistration: preregistration({ mde: 0, repeatCount: 2, promptIds: ['p1', 'p2'] })
        });
        const pair = comparison(result, 'a', 'b');
        const a = result.candidateSummaries.find(row => row.candidateId === 'a');
        const b = result.candidateSummaries.find(row => row.candidateId === 'b');

        expect(result.matrix.complete).toBe(false);
        expect(result.matrix.repeatCountMismatches).toEqual([
            { candidateId: 'a', promptId: 'p2', expected: 2, actual: 1 },
            { candidateId: 'b', promptId: 'p1', expected: 2, actual: 1 },
            { candidateId: 'b', promptId: 'p2', expected: 2, actual: 3 }
        ]);
        expect(a).toMatchObject({ overallMean: 7.5, totalRows: 3, repetitionsBalanced: false });
        expect(b).toMatchObject({ overallMean: 6, totalRows: 4, repetitionsBalanced: false });
        expect(pair.n).toBe(2);
        expect(pair.effect).toBe(1.5);
        expect(pair).toMatchObject({ lower: null, upper: null, complete: false });
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.reasons).toContain('repeat_count_mismatch');
    });

    test('fails closed when duplicate repeat indexes satisfy the row count', () => {
        const rows = rowsFor({
            a: { p1: [8, 10], p2: [7, 9] },
            b: { p1: [4, 6], p2: [3, 5] }
        });
        rows[1].repeatIndex = 0;

        const result = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({ repeatCount: 2, promptIds: ['p1', 'p2'] })
        });

        expect(result.matrix.repeatCountMismatches).toEqual([]);
        expect(result.matrix.repeatIndexMismatches).toEqual([{
            candidateId: 'a',
            promptId: 'p1',
            expected: [0, 1],
            actual: [0, 0]
        }]);
        expect(result.matrix.complete).toBe(false);
        expect(result.eligibleForDecision).toBe(false);
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.reasons).toContain('repeat_index_mismatch');
        expect(result.comparisons.every(row => row.lower === null && row.upper === null)).toBe(true);
    });

    test('aggregates balanced repetitions without promoting attempts to independent n', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: [8, 9, 10], p2: [5, 6, 7], p3: [7, 8, 9] },
                b: { p1: [6.9, 7, 7.1], p2: [3.8, 3.9, 4], p3: [6, 6.1, 6.2] }
            }),
            preregistration: preregistration({ mde: 1, repeatCount: 3 })
        });
        const pair = comparison(result, 'a', 'b');

        expect(result.matrix).toMatchObject({ complete: true, repeatCountMismatches: [] });
        expect(result.candidateSummaries).toEqual(expect.arrayContaining([
            expect.objectContaining({ candidateId: 'a', totalRows: 9, repetitionsBalanced: true }),
            expect.objectContaining({ candidateId: 'b', totalRows: 9, repetitionsBalanced: true })
        ]));
        expect(pair.n).toBe(3);
        expect(pair.effect).toBeCloseTo(2, 12);
        expect(pair.lower).toBeGreaterThan(1);
        expect(result.decision).toMatchObject({ outcome: 'winner', winner: 'a' });
    });

    test('fails the entire interval family closed when one candidate/prompt cell is missing', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 5, p2: 6 }, b: { p1: 3 } }),
            preregistration: preregistration({
                candidateIds: ['a', 'b'],
                promptIds: ['p1', 'p2']
            })
        });

        expect(result.matrix).toMatchObject({
            complete: false,
            missingCells: [{ candidateId: 'b', promptId: 'p2' }]
        });
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.reasons).toContain('incomplete_matrix');
        expect(result.comparisons.every(row => row.lower === null && row.upper === null)).toBe(true);
    });

    test('detects a preregistered candidate that is wholly absent', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 5, p2: 6 } }),
            preregistration: preregistration({
                candidateIds: ['a', 'b'],
                promptIds: ['p1', 'p2']
            })
        });

        expect(result.matrix.missingCells).toEqual([
            { candidateId: 'b', promptId: 'p1' },
            { candidateId: 'b', promptId: 'p2' }
        ]);
        expect(result.decision.outcome).toBe('inconclusive');
    });

    test('rejects invalid rows instead of silently dropping them from an otherwise complete matrix', () => {
        const rows = rowsFor({ a: { p1: 5, p2: 6 }, b: { p1: 3, p2: 4 } });
        rows.push({ candidateId: 'a', promptId: 'p1', score: '10', repeatIndex: 0 });
        const result = evaluateBenchmarkTrustStatistics({ rows, preregistration: preregistration() });

        expect(result.matrix.complete).toBe(false);
        expect(result.matrix.invalidRows).toEqual([{ index: 4, reasons: ['score_invalid'] }]);
        expect(result.reasons).toContain('invalid_rows');
        expect(result.comparisons.every(row => row.lower === null && row.upper === null)).toBe(true);
    });

    test('compares every candidate against every competitor with one family adjustment', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: 10, p2: 11, p3: 12 },
                b: { p1: 7.1, p2: 8, p3: 8.9 },
                c: { p1: 5.2, p2: 6, p3: 6.8 }
            }),
            preregistration: preregistration({
                mde: 2,
                candidateIds: ['a', 'b', 'c'],
                promptIds: ['p1', 'p2', 'p3']
            })
        });

        expect(result.method).toMatchObject({ familySize: 3, adjustedAlpha: 0.05 / 3 });
        expect(result.comparisons).toHaveLength(6);
        expect(result.comparisons.every(row => row.n === 3 && row.adjustedAlpha === 0.05 / 3)).toBe(true);
        expect(result.decision).toMatchObject({
            outcome: 'winner',
            winner: 'a',
            equivalenceSet: []
        });
        expect(comparison(result, 'a', 'b').lower).toBeGreaterThan(2);
        expect(comparison(result, 'a', 'c').lower).toBeGreaterThan(2);
    });

    test('requires a strict lower-bound inequality at the MDE boundary', () => {
        const rows = rowsFor({
            a: { p1: 5, p2: 6.1, p3: 6.9 },
            b: { p1: 3, p2: 4, p3: 5 }
        });
        const probe = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({ mde: 1, equivalenceMargin: 0.5 })
        });
        const boundary = comparison(probe, 'a', 'b').lower;
        const result = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({ mde: boundary, equivalenceMargin: 0.5 })
        });
        const pair = comparison(result, 'a', 'b');

        expect(pair.lower).toBeCloseTo(boundary, 12);
        expect(pair.strictSuperiority).toBe(false);
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.decision.winner).toBeNull();
    });

    test('treats equality at both equivalence bounds as equivalent', () => {
        const rows = rowsFor({
            a: { p1: 5.49, p2: 6.5, p3: 7.51 },
            b: { p1: 5, p2: 6, p3: 7 }
        });
        const probe = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({ mde: 1, equivalenceMargin: 1 })
        });
        const boundary = comparison(probe, 'a', 'b').upper;
        const result = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({ mde: 1, equivalenceMargin: boundary })
        });

        expect(comparison(result, 'a', 'b')).toMatchObject({
            equivalent: true,
            strictSuperiority: false
        });
        expect(comparison(result, 'a', 'b').upper).toBeCloseTo(boundary, 12);
        expect(result.decision).toMatchObject({
            outcome: 'equivalence_set',
            winner: null,
            equivalenceSet: ['a', 'b']
        });
    });

    test('returns an equivalent top set while excluding a candidate it demonstrably dominates', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: 10, p2: 9, p3: 11 },
                b: { p1: 9.99, p2: 9.01, p3: 11 },
                c: { p1: 6, p2: 5.1, p3: 6.9 }
            }),
            preregistration: preregistration({
                mde: 1,
                equivalenceMargin: 0.1,
                candidateIds: ['a', 'b', 'c'],
                promptIds: ['p1', 'p2', 'p3']
            })
        });

        expect(result.decision).toMatchObject({
            outcome: 'equivalence_set',
            winner: null,
            equivalenceSet: ['a', 'b']
        });
        expect(comparison(result, 'a', 'c').strictSuperiority).toBe(true);
        expect(comparison(result, 'b', 'c').strictSuperiority).toBe(true);
    });

    test('returns inconclusive when evidence proves neither superiority nor equivalence', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 6, p2: 7.1, p3: 7.9 }, b: { p1: 5, p2: 6, p3: 7 } }),
            preregistration: preregistration({ mde: 2, equivalenceMargin: 0.5 })
        });

        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.decision.reasons).toContain('no_strict_winner_or_equivalence');
    });

    test('widens the same pair interval when a third candidate joins the simultaneous family', () => {
        const common = {
            a: { p1: 5, p2: 8, p3: 6, p4: 9, p5: 7 },
            b: { p1: 4, p2: 6, p3: 7, p4: 7, p5: 5 }
        };
        const two = evaluateBenchmarkTrustStatistics({
            rows: rowsFor(common),
            preregistration: preregistration({ promptIds: ['p1', 'p2', 'p3', 'p4', 'p5'] })
        });
        const three = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ ...common, c: { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5 } }),
            preregistration: preregistration({
                candidateIds: ['a', 'b', 'c'],
                promptIds: ['p1', 'p2', 'p3', 'p4', 'p5']
            })
        });
        const twoPair = comparison(two, 'a', 'b');
        const threePair = comparison(three, 'a', 'b');

        expect(two.method.familySize).toBe(1);
        expect(three.method.familySize).toBe(3);
        expect(threePair.adjustedAlpha).toBeLessThan(twoPair.adjustedAlpha);
        expect(threePair.upper - threePair.lower).toBeGreaterThan(twoPair.upper - twoPair.lower);
    });

    test('is deterministic under row reordering, including repeated attempts', () => {
        const rows = rowsFor({
            z: { p3: [10, 8, 9], p2: [9, 7, 8], p1: [8, 6, 10] },
            a: { p3: [6, 8, 7], p2: [5, 7, 6], p1: [4, 6, 5] },
            m: { p3: [3, 5, 4], p2: [2, 4, 3], p1: [1, 3, 2] }
        });
        const policy = preregistration({
            mde: 1,
            equivalenceMargin: 0.1,
            repeatCount: 3,
            candidateIds: ['a', 'm', 'z']
        });

        expect(evaluateBenchmarkTrustStatistics({ rows, preregistration: policy }))
            .toEqual(evaluateBenchmarkTrustStatistics({ rows: [...rows].reverse(), preregistration: policy }));
    });

    test('projects the decision into the exact v1 receipt statistical contract', () => {
        const candidateA = `candidate_${'a'.repeat(32)}`;
        const candidateB = `candidate_${'b'.repeat(32)}`;
        const rows = rowsFor({
            [candidateA]: { p1: 5, p2: 6.1, p3: 6.9 },
            [candidateB]: { p1: 2, p2: 3, p3: 4 }
        });
        const policy = preregistration({
            mde: 0.25,
            candidateIds: [candidateA, candidateB]
        });

        const projection = buildBenchmarkTrustStatisticsReceiptFields({ rows, preregistration: policy }, {
            analysisPlanFingerprint: 'a'.repeat(64),
            rankingPolicyFingerprint: 'b'.repeat(64)
        });

        expect(projection).toMatchObject({
            unit: 'prompt',
            method: 'paired-prompt-t-v1',
            alphaBasisPoints: 500,
            multiplicityCorrection: 'bonferroni',
            minimumEffectMicros: 250000,
            preregistration: {
                repeatCount: 1,
                requiredIndependentPromptCount: 3,
                targetPowerBasisPoints: 8000,
                assumedMaxPairedStdDevMicros: 50000,
                powerAnalysisFingerprint: policy.powerAnalysisFingerprint,
                analysisPlanFingerprint: 'a'.repeat(64)
            },
            rankingPolicyFingerprint: 'b'.repeat(64),
            winnerCandidateId: candidateA,
            equivalenceCandidateIds: []
        });
        expect(projection.decisionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    test('refuses unrepresentable policy numbers or caller-supplied non-fingerprints', () => {
        const candidateA = `candidate_${'a'.repeat(32)}`;
        const candidateB = `candidate_${'b'.repeat(32)}`;
        const rows = rowsFor({
            [candidateA]: { p1: 5, p2: 6.1, p3: 6.9 },
            [candidateB]: { p1: 2, p2: 3, p3: 4 }
        });
        const invalidScale = {
            rows,
            preregistration: preregistration({
                alpha: 0.05001,
                candidateIds: [candidateA, candidateB]
            })
        };
        expect(() => buildBenchmarkTrustStatisticsReceiptFields(invalidScale, {
            analysisPlanFingerprint: 'a'.repeat(64),
            rankingPolicyFingerprint: 'b'.repeat(64)
        })).toThrow(/receipt scale/);

        const valid = {
            rows,
            preregistration: preregistration({ candidateIds: [candidateA, candidateB] })
        };
        expect(() => buildBenchmarkTrustStatisticsReceiptFields(valid, {
            analysisPlanFingerprint: 'not-a-fingerprint',
            rankingPolicyFingerprint: 'b'.repeat(64)
        })).toThrow(/analysisPlanFingerprint/);
    });

    test('never projects a caller-supplied or mutated evaluation object', () => {
        const candidateA = `candidate_${'a'.repeat(32)}`;
        const candidateB = `candidate_${'b'.repeat(32)}`;
        const forged = {
            method: { name: STATISTICS_METHOD.name, multiplicity: STATISTICS_METHOD.multiplicity },
            preregistration: preregistration({ candidateIds: [candidateA, candidateB] }),
            candidateSummaries: [{ candidateId: candidateA }, { candidateId: candidateB }],
            decision: { outcome: 'winner', winner: candidateA, equivalenceSet: [] }
        };

        expect(() => buildBenchmarkTrustStatisticsReceiptFields(forged, {
            analysisPlanFingerprint: 'a'.repeat(64),
            rankingPolicyFingerprint: 'b'.repeat(64)
        })).toThrow(/raw rows/);

        const rows = rowsFor({
            [candidateA]: { p1: 5, p2: 6.1, p3: 6.9 },
            [candidateB]: { p1: 2, p2: 3, p3: 4 }
        });
        const genuine = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({ candidateIds: [candidateA, candidateB] })
        });
        genuine.decision.winner = candidateB;
        expect(() => buildBenchmarkTrustStatisticsReceiptFields(genuine, {
            analysisPlanFingerprint: 'a'.repeat(64),
            rankingPolicyFingerprint: 'b'.repeat(64)
        })).toThrow(/raw rows/);
    });

    test('fails closed on undeclared candidates or prompts in a preregistered scope', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: 4, p2: 5, extra: 6 },
                b: { p1: 2, p2: 3 },
                c: { p1: 1, p2: 1 }
            }),
            preregistration: preregistration({
                candidateIds: ['a', 'b'],
                promptIds: ['p1', 'p2']
            })
        });

        expect(result.matrix).toMatchObject({
            complete: false,
            undeclaredCandidateIds: ['c'],
            undeclaredPromptIds: ['extra']
        });
        expect(result.reasons).toEqual(expect.arrayContaining(['undeclared_candidates', 'undeclared_prompts']));
        expect(result.decision.outcome).toBe('inconclusive');
    });
});
