const {
    STATISTICS_METHOD,
    studentTQuantile,
    evaluateBenchmarkTrustStatistics,
    buildBenchmarkTrustStatisticsReceiptFields
} = require('../../../src/services/benchmark/benchmarkTrustStatistics');

function preregistration(overrides = {}) {
    return {
        alpha: 0.05,
        mde: 1,
        equivalenceMargin: 0.25,
        repeatCount: 1,
        ...overrides
    };
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

    test('returns not_evaluated for zero candidates', () => {
        const result = evaluateBenchmarkTrustStatistics({ rows: [], preregistration: preregistration() });

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
            preregistration: preregistration()
        });

        expect(result.decision.outcome).toBe('not_evaluated');
        expect(result.reasons).toContain('insufficient_candidates');
    });

    test('does not estimate uncertainty from a single independent prompt', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: [8, 10, 9] }, b: { p1: [4, 5, 6] } }),
            preregistration: preregistration({ repeatCount: 3 })
        });
        const pair = comparison(result, 'a', 'b');

        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.reasons).toContain('insufficient_independent_prompts');
        expect(pair).toMatchObject({ n: 1, effect: 4, lower: null, upper: null });
    });

    test('fails closed when repetitions are imbalanced against the preregistered count', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: [8, 10], p2: 6 },
                b: { p1: 7, p2: [3, 5, 7] }
            }),
            preregistration: preregistration({ mde: 0, repeatCount: 2 })
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
            preregistration: preregistration({ repeatCount: 2 })
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
                a: { p1: [8, 10, 9], p2: [5, 6, 7] },
                b: { p1: [6, 7, 8], p2: [3, 4, 5] }
            }),
            preregistration: preregistration({ mde: 1, repeatCount: 3 })
        });
        const pair = comparison(result, 'a', 'b');

        expect(result.matrix).toMatchObject({ complete: true, repeatCountMismatches: [] });
        expect(result.candidateSummaries).toEqual(expect.arrayContaining([
            expect.objectContaining({ candidateId: 'a', overallMean: 7.5, totalRows: 6, repetitionsBalanced: true }),
            expect.objectContaining({ candidateId: 'b', overallMean: 5.5, totalRows: 6, repetitionsBalanced: true })
        ]));
        expect(pair).toMatchObject({ n: 2, effect: 2, lower: 2, upper: 2 });
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
                b: { p1: 7, p2: 8, p3: 9 },
                c: { p1: 5, p2: 6, p3: 7 }
            }),
            preregistration: preregistration({ mde: 2 })
        });

        expect(result.method).toMatchObject({ familySize: 3, adjustedAlpha: 0.05 / 3 });
        expect(result.comparisons).toHaveLength(6);
        expect(result.comparisons.every(row => row.n === 3 && row.adjustedAlpha === 0.05 / 3)).toBe(true);
        expect(result.decision).toMatchObject({
            outcome: 'winner',
            winner: 'a',
            equivalenceSet: []
        });
        expect(comparison(result, 'a', 'b').lower).toBe(3);
        expect(comparison(result, 'a', 'c').lower).toBe(5);
    });

    test('requires a strict lower-bound inequality at the MDE boundary', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 5, p2: 6 }, b: { p1: 3, p2: 4 } }),
            preregistration: preregistration({ mde: 2, equivalenceMargin: 0.5 })
        });
        const pair = comparison(result, 'a', 'b');

        expect(pair).toMatchObject({ effect: 2, lower: 2, upper: 2, strictSuperiority: false });
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.decision.winner).toBeNull();
    });

    test('treats equality at both equivalence bounds as equivalent', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 5.5, p2: 6.5 }, b: { p1: 5, p2: 6 } }),
            preregistration: preregistration({ mde: 1, equivalenceMargin: 0.5 })
        });

        expect(comparison(result, 'a', 'b')).toMatchObject({
            lower: 0.5,
            upper: 0.5,
            equivalent: true,
            strictSuperiority: false
        });
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
                b: { p1: 10, p2: 9, p3: 11 },
                c: { p1: 6, p2: 5, p3: 7 }
            }),
            preregistration: preregistration({ mde: 1, equivalenceMargin: 0 })
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
            rows: rowsFor({ a: { p1: 6, p2: 7 }, b: { p1: 5, p2: 6 } }),
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
            preregistration: preregistration()
        });
        const three = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ ...common, c: { p1: 1, p2: 2, p3: 3, p4: 4, p5: 5 } }),
            preregistration: preregistration()
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
            z: { p2: [9, 7, 8], p1: [8, 6, 10] },
            a: { p2: [5, 7, 6], p1: [4, 6, 5] },
            m: { p2: [2, 4, 3], p1: [1, 3, 2] }
        });
        const policy = preregistration({ mde: 1, equivalenceMargin: 0.1, repeatCount: 3 });

        expect(evaluateBenchmarkTrustStatistics({ rows, preregistration: policy }))
            .toEqual(evaluateBenchmarkTrustStatistics({ rows: [...rows].reverse(), preregistration: policy }));
    });

    test('projects the decision into the exact v1 receipt statistical contract', () => {
        const candidateA = `candidate_${'a'.repeat(32)}`;
        const candidateB = `candidate_${'b'.repeat(32)}`;
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                [candidateA]: { p1: 5, p2: 6 },
                [candidateB]: { p1: 2, p2: 3 }
            }),
            preregistration: preregistration({ mde: 0.25 })
        });

        const projection = buildBenchmarkTrustStatisticsReceiptFields(result, {
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
        const invalidScale = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                [candidateA]: { p1: 5, p2: 6 },
                [candidateB]: { p1: 2, p2: 3 }
            }),
            preregistration: preregistration({ alpha: 0.05001 })
        });
        expect(() => buildBenchmarkTrustStatisticsReceiptFields(invalidScale, {
            analysisPlanFingerprint: 'a'.repeat(64),
            rankingPolicyFingerprint: 'b'.repeat(64)
        })).toThrow(/receipt scale/);

        const valid = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                [candidateA]: { p1: 5, p2: 6 },
                [candidateB]: { p1: 2, p2: 3 }
            }),
            preregistration: preregistration()
        });
        expect(() => buildBenchmarkTrustStatisticsReceiptFields(valid, {
            analysisPlanFingerprint: 'not-a-fingerprint',
            rankingPolicyFingerprint: 'b'.repeat(64)
        })).toThrow(/analysisPlanFingerprint/);
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
