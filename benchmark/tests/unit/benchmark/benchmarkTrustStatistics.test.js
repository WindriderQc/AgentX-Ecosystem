const {
    POWER_ANALYSIS_SCHEMA,
    STATISTICS_METHOD,
    buildBenchmarkTrustPowerAnalysisFields,
    buildBenchmarkTrustVarianceBasis,
    boundedHoeffdingConfidenceRadius,
    boundedHoeffdingFamilyMissUpperBound,
    chiSquareQuantile,
    evaluateBenchmarkTrustStatistics,
    buildBenchmarkTrustStatisticsReceiptFields
} = require('../../../src/services/benchmark/benchmarkTrustStatistics');

function varianceBasis(observedPairedStdDevMicros = 150000, candidateCount = 2, overrides = {}) {
    const candidatePairCount = candidateCount * (candidateCount - 1) / 2;
    return buildBenchmarkTrustVarianceBasis({
        schema: 'agentx.benchmark-trust-variance-basis/independent-pilot-upper-bound/v1',
        provenance: 'independent_pilot',
        cohortFingerprint: 'e'.repeat(64),
        candidateSetFingerprint: 'c'.repeat(64),
        rubricFingerprint: 'd'.repeat(64),
        repeatCount: 1,
        candidateInferenceContractFingerprint: 'a'.repeat(64),
        promptSamplingPolicyFingerprint: 'b'.repeat(64),
        candidatePairCount,
        pairwiseObservedStdDevs: Array.from({ length: candidatePairCount }, (_, index) => ({
            pairFingerprint: String(index + 1).padStart(64, '0'),
            observedPairedStdDevMicros: Math.max(1, observedPairedStdDevMicros - index)
        })),
        method: 'chi-square-one-sided-upper-confidence-bound-v1',
        independentPromptCount: 30,
        confidenceBasisPoints: 9500,
        observedPairedStdDevMicros,
        ...overrides
    });
}

function variancePolicy(observedPairedStdDevMicros = 150000, candidateCount = 2) {
    const basis = varianceBasis(observedPairedStdDevMicros, candidateCount);
    return {
        assumedMaxPairedStdDevMicros: basis.upperConfidenceBoundMicros,
        varianceBasis: basis
    };
}

function preregistration(overrides = {}) {
    const defaults = {
        alpha: 0.05,
        mde: 1,
        poweredAlternativeEffect: 2,
        equivalenceMargin: 0.25,
        repeatCount: 1,
        candidateIds: ['a', 'b'],
        promptIds: ['p1', 'p2', 'p3'],
        targetPowerBasisPoints: 8000,
        variancePilotAttestationId: 'f'.repeat(64)
    };
    const policy = { ...defaults, ...overrides };
    if (!Object.prototype.hasOwnProperty.call(overrides, 'poweredAlternativeEffect')) {
        policy.poweredAlternativeEffect = typeof policy.mde === 'number' && policy.mde > 0
            ? policy.mde * 2
            : defaults.poweredAlternativeEffect;
    }
    const effectiveCandidateIds = Array.isArray(policy.candidateIds) && policy.candidateIds.length >= 2
        ? policy.candidateIds
        : defaults.candidateIds;
    const frozenVarianceBasis = policy.varianceBasis
        || varianceBasis(150000, effectiveCandidateIds.length, {
            repeatCount: Number.isSafeInteger(policy.repeatCount) && policy.repeatCount >= 1
                ? policy.repeatCount
                : defaults.repeatCount
        });
    const effectiveAssumedStdDev = Number.isSafeInteger(policy.assumedMaxPairedStdDevMicros)
        && policy.assumedMaxPairedStdDevMicros > 0
        ? policy.assumedMaxPairedStdDevMicros
        : frozenVarianceBasis.upperConfidenceBoundMicros;
    const powerFields = buildBenchmarkTrustPowerAnalysisFields({
        alpha: typeof policy.alpha === 'number' && policy.alpha > 0 && policy.alpha < 1
            ? policy.alpha
            : defaults.alpha,
        mde: typeof policy.mde === 'number' && policy.mde > 0 ? policy.mde : defaults.mde,
        poweredAlternativeEffect: typeof policy.poweredAlternativeEffect === 'number'
            && policy.poweredAlternativeEffect > (typeof policy.mde === 'number' ? policy.mde : defaults.mde)
            ? policy.poweredAlternativeEffect
            : defaults.poweredAlternativeEffect,
        candidateIds: effectiveCandidateIds,
        targetPowerBasisPoints: Number.isSafeInteger(policy.targetPowerBasisPoints)
            && policy.targetPowerBasisPoints >= 8000
            && policy.targetPowerBasisPoints <= 9999
            ? policy.targetPowerBasisPoints
            : defaults.targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros: effectiveAssumedStdDev,
        varianceBasis: frozenVarianceBasis
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

function makePromptIds(count) {
    return Array.from({ length: count }, (_, index) => `p${String(index + 1).padStart(5, '0')}`);
}

function constantPromptScores(promptIds, score) {
    return Object.fromEntries(promptIds.map(promptId => [promptId, score]));
}

function poweredPreregistration(overrides = {}) {
    const provisional = preregistration({
        mde: 0.25,
        poweredAlternativeEffect: 10,
        ...overrides
    });
    const promptIds = makePromptIds(provisional.requiredIndependentPromptCount);
    return preregistration({
        mde: 0.25,
        poweredAlternativeEffect: 10,
        ...overrides,
        promptIds
    });
}

function comparison(result, leftCandidateId, rightCandidateId) {
    return result.comparisons.find(row => (
        row.leftCandidateId === leftCandidateId && row.rightCandidateId === rightCandidateId
    ));
}

describe('Benchmark Trust statistical decision', () => {
    test('versions the independent unit, interval and multiplicity method explicitly', () => {
        const policy = poweredPreregistration();
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: constantPromptScores(policy.promptIds, 10),
                b: constantPromptScores(policy.promptIds, 0)
            }),
            preregistration: policy
        });

        expect(result.method).toMatchObject({
            ...STATISTICS_METHOD,
            familySize: 1,
            adjustedAlpha: 0.05
        });
        expect(result.method.version).toBe('agentx.benchmark-trust-statistics/paired-prompt-bonferroni-hoeffding/v1');
        expect(result.method.powerAnalysis).toBe('bounded-hoeffding-superiority-power-v1');
        expect(POWER_ANALYSIS_SCHEMA).toBe('agentx.benchmark-trust-power-analysis/bounded-hoeffding-superiority/v1');
        expect(chiSquareQuantile(0.05, 29)).toBeCloseTo(17.708366, 5);
        expect(result).not.toHaveProperty('inputFingerprint');
    });

    test('computes the bounded Hoeffding radius from the full paired-score range', () => {
        expect(boundedHoeffdingConfidenceRadius(100, 0.05, 1)).toBeCloseTo(
            20 * Math.sqrt(Math.log(40) / 200),
            12
        );
    });

    test.each([
        { alpha: 0.05, candidateCount: 2 },
        { alpha: 0.05, candidateCount: 3 },
        { alpha: 0.01, candidateCount: 5 }
    ])('finds the minimal powered count for alpha=$alpha and $candidateCount candidates', ({ alpha, candidateCount }) => {
        const candidateIds = Array.from({ length: candidateCount }, (_, index) => `candidate-${index}`);
        const basis = varianceBasis(780000, candidateCount);
        const fields = buildBenchmarkTrustPowerAnalysisFields({
            alpha,
            mde: 0.25,
            poweredAlternativeEffect: 0.75,
            candidateIds,
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: basis.upperConfidenceBoundMicros,
            varianceBasis: basis
        });
        const familySize = candidateCount * (candidateCount - 1) / 2;
        const missBoundAt = count => boundedHoeffdingFamilyMissUpperBound(
            count,
            alpha,
            familySize,
            0.5
        );

        expect(missBoundAt(fields.requiredIndependentPromptCount)).toBeLessThanOrEqual(0.2);
        if (fields.requiredIndependentPromptCount > 3) {
            expect(missBoundAt(fields.requiredIndependentPromptCount - 1)).toBeGreaterThan(0.2);
        }
    });

    test.each([
        { alpha: 0.05, candidateCount: 2, mde: 0.25, alternative: 10, power: 8000, expectedN: 22, missAtN: 0.178327, missBefore: 0.215582 },
        { alpha: 0.05, candidateCount: 3, mde: 1, alternative: 10, power: 8000, expectedN: 37, missAtN: 0.176591, missBefore: 0.210261 },
        { alpha: 0.01, candidateCount: 5, mde: 2, alternative: 9, power: 9000, expectedN: 99, missAtN: 0.090947, missBefore: 0.101269 }
    ])('matches an independent bounded-power oracle for %#', ({
        alpha,
        candidateCount,
        mde,
        alternative,
        power,
        expectedN,
        missAtN,
        missBefore
    }) => {
        const candidateIds = Array.from({ length: candidateCount }, (_, index) => `candidate-${index}`);
        const basis = varianceBasis(780000, candidateCount);
        const fields = buildBenchmarkTrustPowerAnalysisFields({
            alpha,
            mde,
            poweredAlternativeEffect: alternative,
            candidateIds,
            targetPowerBasisPoints: power,
            assumedMaxPairedStdDevMicros: basis.upperConfidenceBoundMicros,
            varianceBasis: basis
        });
        const familySize = candidateCount * (candidateCount - 1) / 2;
        const excess = alternative - mde;
        const oracleMissBound = (count) => {
            const radius = 20 * Math.sqrt(Math.log((2 * familySize) / alpha) / (2 * count));
            if (excess <= radius) return 1;
            return Math.min(1, familySize * Math.exp(
                (-2 * count * ((excess - radius) ** 2)) / (20 ** 2)
            ));
        };

        expect(fields.requiredIndependentPromptCount).toBe(expectedN);
        expect(oracleMissBound(expectedN)).toBeCloseTo(missAtN, 6);
        expect(oracleMissBound(expectedN - 1)).toBeCloseTo(missBefore, 6);
        expect(oracleMissBound(expectedN)).toBeLessThanOrEqual(1 - (power / 10000));
        expect(oracleMissBound(expectedN - 1)).toBeGreaterThan(1 - (power / 10000));
    });

    test.each([
        [{ alpha: 0, mde: 1, equivalenceMargin: 0.2, repeatCount: 1 }, 'alpha_invalid'],
        [{ alpha: 1, mde: 1, equivalenceMargin: 0.2, repeatCount: 1 }, 'alpha_invalid'],
        [{ alpha: 0.05, mde: -1, equivalenceMargin: 0.2, repeatCount: 1 }, 'mde_invalid'],
        [{ alpha: 0.05, mde: 10, poweredAlternativeEffect: 10.1, equivalenceMargin: 0.2, repeatCount: 1 }, 'mde_invalid'],
        [{ alpha: 0.05, mde: 1, poweredAlternativeEffect: 10.1, equivalenceMargin: 0.2, repeatCount: 1 }, 'powered_alternative_effect_invalid'],
        [{ alpha: 0.05, mde: 1, equivalenceMargin: -0.2, repeatCount: 1 }, 'equivalence_margin_invalid'],
        [{ alpha: 0.05, mde: 1, equivalenceMargin: 1.01, repeatCount: 1 }, 'equivalence_margin_exceeds_mde'],
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
        const frozenBasis = varianceBasis(39000);
        const fields = buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            poweredAlternativeEffect: 10,
            candidateIds: ['a', 'b'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: frozenBasis.upperConfidenceBoundMicros,
            varianceBasis: frozenBasis
        });
        expect(fields).toMatchObject({
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: frozenBasis.upperConfidenceBoundMicros,
            varianceBasis: frozenBasis,
            varianceBasisFingerprint: frozenBasis.artifactFingerprint
        });
        expect(fields.powerAnalysisFingerprint).toMatch(/^[0-9a-f]{64}$/);
        expect(fields.requiredIndependentPromptCount).toBeGreaterThanOrEqual(3);
        expect(fields.poweredAlternativeEffect).toBe(10);
        expect(frozenBasis.upperConfidenceBoundMicros).toBeGreaterThan(
            frozenBasis.observedPairedStdDevMicros
        );
        expect(() => buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            poweredAlternativeEffect: 10,
            candidateIds: ['a', 'b'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: frozenBasis.upperConfidenceBoundMicros - 1,
            varianceBasis: frozenBasis
        })).toThrow(/must equal the frozen variance upper bound/);
        expect(() => buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            poweredAlternativeEffect: 10,
            candidateIds: ['a', 'b'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: frozenBasis.upperConfidenceBoundMicros,
            varianceBasis: { ...frozenBasis, artifactFingerprint: '0'.repeat(64) }
        })).toThrow(/fingerprint does not match/);

        const largerVarianceBasis = varianceBasis(780000);
        const largerVariance = buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            poweredAlternativeEffect: 10,
            candidateIds: ['a', 'b'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: largerVarianceBasis.upperConfidenceBoundMicros,
            varianceBasis: largerVarianceBasis
        });
        const largerFamilyBasis = varianceBasis(780000, 3);
        const largerFamily = buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            poweredAlternativeEffect: 10,
            candidateIds: ['a', 'b', 'c'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: largerFamilyBasis.upperConfidenceBoundMicros,
            varianceBasis: largerFamilyBasis
        });
        expect(largerVariance.requiredIndependentPromptCount)
            .toBe(fields.requiredIndependentPromptCount);
        expect(largerFamily.requiredIndependentPromptCount)
            .toBeGreaterThanOrEqual(largerVariance.requiredIndependentPromptCount);
        expect(largerFamily.powerAnalysisFingerprint).not.toBe(largerVariance.powerAnalysisFingerprint);

        const narrowerPoweredGap = buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            poweredAlternativeEffect: 9,
            candidateIds: ['a', 'b'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: largerVarianceBasis.upperConfidenceBoundMicros,
            varianceBasis: largerVarianceBasis
        });
        expect(narrowerPoweredGap.requiredIndependentPromptCount)
            .toBeGreaterThan(largerVariance.requiredIndependentPromptCount);
        expect(narrowerPoweredGap.powerAnalysisFingerprint)
            .not.toBe(largerVariance.powerAnalysisFingerprint);
        expect(() => buildBenchmarkTrustPowerAnalysisFields({
            alpha: 0.05,
            mde: 0.25,
            poweredAlternativeEffect: 0.25,
            candidateIds: ['a', 'b'],
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: largerVarianceBasis.upperConfidenceBoundMicros,
            varianceBasis: largerVarianceBasis
        })).toThrow(/cannot produce a bounded required independent prompt count/);

        const poweredGap = largerVariance.poweredAlternativeEffect - 0.25;
        const requiredN = largerVariance.requiredIndependentPromptCount;
        expect(boundedHoeffdingFamilyMissUpperBound(
            requiredN,
            0.05,
            1,
            poweredGap
        )).toBeLessThanOrEqual(0.2);
        if (requiredN > 3) {
            expect(boundedHoeffdingFamilyMissUpperBound(
                requiredN - 1,
                0.05,
                1,
                poweredGap
            )).toBeGreaterThan(0.2);
        }

        const tamperedAlternative = preregistration({ mde: 0.25, poweredAlternativeEffect: 10 });
        tamperedAlternative.poweredAlternativeEffect = 0.4;
        const tamperedValidation = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 5, p2: 6, p3: 7 }, b: { p1: 2, p2: 3, p3: 4 } }),
            preregistration: tamperedAlternative
        });
        expect(tamperedValidation.eligibleForDecision).toBe(false);
        expect(tamperedValidation.reasons).toEqual(expect.arrayContaining([
            'required_prompt_count_mismatch',
            'power_analysis_fingerprint_mismatch'
        ]));

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
            promptIds: ['p1', 'p2'],
            ...variancePolicy(39000)
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
            preregistration: {
                requiredIndependentPromptCount: underpoweredPolicy.requiredIndependentPromptCount
            }
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

    test('rejects reusing a low-variance pilot under a different repeat contract', () => {
        const fiveRepeatBasis = varianceBasis(39000, 2, { repeatCount: 5 });
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 5, p2: 6, p3: 7 }, b: { p1: 2, p2: 3, p3: 4 } }),
            preregistration: preregistration({
                repeatCount: 1,
                varianceBasis: fiveRepeatBasis,
                assumedMaxPairedStdDevMicros: fiveRepeatBasis.upperConfidenceBoundMicros
            })
        });
        expect(result.eligibleForDecision).toBe(false);
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.reasons).toContain('variance_basis_repeat_mismatch');
    });

    test('fails closed when campaign variance exceeds the frozen independent-pilot upper bound', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: { p1: 10, p2: 9, p3: 8 },
                b: { p1: 0, p2: 0, p3: 0 }
            }),
            preregistration: preregistration({
                ...variancePolicy(1)
            })
        });

        expect(result.eligibleForDecision).toBe(false);
        expect(result.decision).toMatchObject({ outcome: 'inconclusive', winner: null });
        expect(result.reasons).toContain('observed_variance_exceeds_preregistered_bound');
        expect(comparison(result, 'a', 'b')).toMatchObject({
            observedPairedStdDevMicros: 1000000,
            complete: false,
            lower: null,
            upper: null
        });
    });

    test('uses distribution-free intervals for degenerate paired variance once powered', () => {
        const policy = poweredPreregistration({ ...variancePolicy(39000) });
        const promptIds = policy.promptIds;
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: constantPromptScores(promptIds, 10),
                b: constantPromptScores(promptIds, 0)
            }),
            preregistration: policy
        });
        const pair = comparison(result, 'a', 'b');

        expect(result.eligibleForDecision).toBe(true);
        expect(result.decision).toMatchObject({ outcome: 'winner', winner: 'a' });
        expect(result.reasons).not.toContain('degenerate_paired_variance');
        expect(pair).toMatchObject({
            n: promptIds.length,
            effect: 10,
            observedPairedStdDevMicros: 0,
            complete: true,
            strictSuperiority: true
        });
        expect(pair.confidenceRadius).toBeGreaterThan(0);
        expect(pair.lower).toBeGreaterThan(0.25);
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
        const policy = poweredPreregistration({ repeatCount: 3 });
        const promptIds = policy.promptIds;
        const repeated = values => Object.fromEntries(promptIds.map(promptId => [promptId, values]));
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: repeated([8, 9, 10]),
                b: repeated([0, 1, 2])
            }),
            preregistration: policy
        });
        const pair = comparison(result, 'a', 'b');

        expect(result.matrix).toMatchObject({ complete: true, repeatCountMismatches: [] });
        expect(result.candidateSummaries).toEqual(expect.arrayContaining([
            expect.objectContaining({ candidateId: 'a', totalRows: promptIds.length * 3, repetitionsBalanced: true }),
            expect.objectContaining({ candidateId: 'b', totalRows: promptIds.length * 3, repetitionsBalanced: true })
        ]));
        expect(pair.n).toBe(promptIds.length);
        expect(pair.effect).toBeCloseTo(8, 12);
        expect(pair.lower).toBeGreaterThan(0.25);
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

    test.each([
        [-Number.EPSILON, 'score_out_of_range'],
        [10 + (Number.EPSILON * 10), 'score_out_of_range'],
        [NaN, 'score_invalid'],
        ['5', 'score_invalid']
    ])('fails closed for an invalid or out-of-domain score %#', (score, reason) => {
        const rows = rowsFor({ a: { p1: 5, p2: 6, p3: 7 }, b: { p1: 2, p2: 3, p3: 4 } });
        rows[0].score = score;
        const result = evaluateBenchmarkTrustStatistics({ rows, preregistration: preregistration() });

        expect(result.eligibleForDecision).toBe(false);
        expect(result.matrix.invalidRows).toEqual([{ index: 0, reasons: [reason] }]);
        expect(result.reasons).toContain('invalid_rows');
        expect(result.decision.outcome).toBe('inconclusive');
    });

    test('compares every candidate against every competitor with one family adjustment', () => {
        const policy = poweredPreregistration({
            candidateIds: ['a', 'b', 'c'],
            ...variancePolicy(160000, 3)
        });
        const promptIds = policy.promptIds;
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: constantPromptScores(promptIds, 10),
                b: constantPromptScores(promptIds, 0.2),
                c: constantPromptScores(promptIds, 0)
            }),
            preregistration: policy
        });

        expect(result.method).toMatchObject({ familySize: 3, adjustedAlpha: 0.05 / 3 });
        expect(result.comparisons).toHaveLength(6);
        expect(result.comparisons.every(row => (
            row.n === promptIds.length && row.adjustedAlpha === 0.05 / 3
        ))).toBe(true);
        expect(result.decision).toMatchObject({
            outcome: 'winner',
            winner: 'a',
            equivalenceSet: []
        });
        expect(comparison(result, 'a', 'b').lower).toBeGreaterThan(0.25);
        expect(comparison(result, 'a', 'c').lower).toBeGreaterThan(0.25);
    });

    test('requires a strict lower-bound inequality at the MDE boundary', () => {
        const promptIds = makePromptIds(100);
        const rows = rowsFor({
            a: constantPromptScores(promptIds, 5),
            b: constantPromptScores(promptIds, 0)
        });
        const probe = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({
                mde: 1,
                poweredAlternativeEffect: 10,
                equivalenceMargin: 0.5,
                promptIds
            })
        });
        const boundary = comparison(probe, 'a', 'b').lower;
        const result = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({
                mde: boundary,
                poweredAlternativeEffect: 10,
                equivalenceMargin: 0.5,
                promptIds
            })
        });
        const pair = comparison(result, 'a', 'b');

        expect(pair.lower).toBeCloseTo(boundary, 12);
        expect(pair.strictSuperiority).toBe(false);
        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.decision.winner).toBeNull();
    });

    test('treats equality at both equivalence bounds as equivalent', () => {
        const promptIds = makePromptIds(500);
        const rows = rowsFor({
            a: constantPromptScores(promptIds, 5.5),
            b: constantPromptScores(promptIds, 5)
        });
        const probe = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({
                mde: 2,
                poweredAlternativeEffect: 10,
                equivalenceMargin: 2,
                promptIds
            })
        });
        const boundary = comparison(probe, 'a', 'b').upper;
        const result = evaluateBenchmarkTrustStatistics({
            rows,
            preregistration: preregistration({
                mde: 2,
                poweredAlternativeEffect: 10,
                equivalenceMargin: boundary,
                promptIds
            })
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
        const promptIds = makePromptIds(1000);
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({
                a: constantPromptScores(promptIds, 9),
                b: constantPromptScores(promptIds, 8.99),
                c: constantPromptScores(promptIds, 5)
            }),
            preregistration: preregistration({
                mde: 1,
                poweredAlternativeEffect: 10,
                equivalenceMargin: 1,
                candidateIds: ['a', 'b', 'c'],
                promptIds
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

    test('does not exclude an outsider unless every member of the equivalent top set dominates it', () => {
        const scores = { a: {}, b: {}, c: {} };
        for (let index = 0; index < 2500; index += 1) {
            const promptId = `p${String(index + 1).padStart(5, '0')}`;
            const aScore = 3 + (index % 2 === 0 ? 0.05 : -0.05);
            scores.a[promptId] = aScore;
            scores.b[promptId] = aScore - (0.5 + (index % 2 === 0 ? 1.5 : -1.5));
            scores.c[promptId] = 0;
        }
        const promptIds = Object.keys(scores.a);
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor(scores),
            preregistration: preregistration({
                mde: 2,
                poweredAlternativeEffect: 10,
                equivalenceMargin: 1.2,
                candidateIds: ['a', 'b', 'c'],
                promptIds,
                ...variancePolicy(1500000, 3)
            })
        });

        expect(comparison(result, 'a', 'b').equivalent).toBe(true);
        expect(comparison(result, 'a', 'c').strictSuperiority).toBe(true);
        expect(comparison(result, 'b', 'c').strictSuperiority).toBe(false);
        expect(result.decision).toMatchObject({
            outcome: 'inconclusive',
            winner: null,
            equivalenceSet: []
        });
    });

    test('returns inconclusive when evidence proves neither superiority nor equivalence', () => {
        const result = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ a: { p1: 6, p2: 7.1, p3: 7.9 }, b: { p1: 5, p2: 6, p3: 7 } }),
            preregistration: preregistration({ mde: 2, equivalenceMargin: 0.5 })
        });

        expect(result.decision.outcome).toBe('inconclusive');
        expect(result.decision.reasons).toContain('underpowered_prompt_count');
    });

    test('widens the same pair interval when a third candidate joins the simultaneous family', () => {
        const promptIds = makePromptIds(100);
        const common = {
            a: constantPromptScores(promptIds, 5),
            b: constantPromptScores(promptIds, 4)
        };
        const two = evaluateBenchmarkTrustStatistics({
            rows: rowsFor(common),
            preregistration: preregistration({ poweredAlternativeEffect: 10, promptIds })
        });
        const three = evaluateBenchmarkTrustStatistics({
            rows: rowsFor({ ...common, c: constantPromptScores(promptIds, 0) }),
            preregistration: preregistration({
                poweredAlternativeEffect: 10,
                candidateIds: ['a', 'b', 'c'],
                promptIds
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

    test('projects the decision into the exact v2 receipt statistical contract', () => {
        const candidateA = `candidate_${'a'.repeat(32)}`;
        const candidateB = `candidate_${'b'.repeat(32)}`;
        const policy = poweredPreregistration({
            candidateIds: [candidateA, candidateB],
            ...variancePolicy(39000)
        });
        const promptIds = policy.promptIds;
        const rows = rowsFor({
            [candidateA]: constantPromptScores(promptIds, 10),
            [candidateB]: constantPromptScores(promptIds, 0)
        });

        const projection = buildBenchmarkTrustStatisticsReceiptFields({ rows, preregistration: policy }, {
            analysisPlanFingerprint: 'a'.repeat(64),
            rankingPolicyFingerprint: 'b'.repeat(64)
        });

        expect(projection).toMatchObject({
            unit: 'prompt',
            method: 'paired-prompt-hoeffding-v1',
            alphaBasisPoints: 500,
            multiplicityCorrection: 'bonferroni',
            minimumEffectMicros: 250000,
            preregistration: {
                repeatCount: 1,
                poweredAlternativeEffectMicros: 10000000,
                requiredIndependentPromptCount: policy.requiredIndependentPromptCount,
                targetPowerBasisPoints: 8000,
                assumedMaxPairedStdDevMicros: policy.assumedMaxPairedStdDevMicros,
                varianceBasisFingerprint: policy.varianceBasisFingerprint,
                variancePilotAttestationId: policy.variancePilotAttestationId,
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
