/**
 * Pure statistical decision support for Benchmark Trust receipts.
 *
 * The independent unit is a prompt. Repeated attempts are averaged inside
 * each candidate/prompt cell before any comparison is made. Candidate effects
 * are paired prompt-mean differences, with simultaneous two-sided Student-t
 * intervals protected by a deterministic Bonferroni family correction.
 *
 * This module intentionally has no persistence or route responsibilities.
 */

const crypto = require('crypto');
const { stableSerialize } = require('../../../../shared/artifactIdentity');

const STATISTICS_METHOD = Object.freeze({
    name: 'paired-prompt-t-v1',
    version: 'agentx.benchmark-trust-statistics/paired-prompt-bonferroni-t/v1',
    independentUnit: 'prompt',
    repeatAggregation: 'arithmetic_mean_per_candidate_prompt',
    interval: 'two_sided_student_t',
    multiplicity: 'bonferroni',
    multiplicityFamily: 'all_unordered_candidate_pairs'
});

const NUMERICAL_EPSILON = 1e-14;
const CONTINUED_FRACTION_FLOOR = 1e-300;
const MAX_CONTINUED_FRACTION_ITERATIONS = 240;

function compareText(left, right) {
    if (left === right) return 0;
    return left < right ? -1 : 1;
}

function normalizeId(value) {
    return typeof value === 'string' ? value.trim() : '';
}

function mean(values) {
    if (!Array.isArray(values) || values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sampleVariance(values, average) {
    if (!Array.isArray(values) || values.length < 2) return null;
    return values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
}

function cleanZero(value) {
    return Object.is(value, -0) ? 0 : value;
}

// Lanczos approximation, sufficient for the positive arguments used by the
// regularized incomplete beta function below.
function logGamma(value) {
    const coefficients = [
        676.5203681218851,
        -1259.1392167224028,
        771.32342877765313,
        -176.61502916214059,
        12.507343278686905,
        -0.13857109526572012,
        9.984369578019572e-6,
        1.5056327351493116e-7
    ];
    if (value < 0.5) {
        return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * value)) - logGamma(1 - value);
    }
    let adjusted = value - 1;
    let series = 0.9999999999998099;
    for (let index = 0; index < coefficients.length; index += 1) {
        series += coefficients[index] / (adjusted + index + 1);
    }
    const shifted = adjusted + coefficients.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI)
        + (adjusted + 0.5) * Math.log(shifted)
        - shifted
        + Math.log(series);
}

function betaContinuedFraction(a, b, x) {
    const qab = a + b;
    const qap = a + 1;
    const qam = a - 1;
    let c = 1;
    let d = 1 - (qab * x / qap);
    if (Math.abs(d) < CONTINUED_FRACTION_FLOOR) d = CONTINUED_FRACTION_FLOOR;
    d = 1 / d;
    let result = d;

    for (let iteration = 1; iteration <= MAX_CONTINUED_FRACTION_ITERATIONS; iteration += 1) {
        const evenStep = 2 * iteration;
        let coefficient = iteration * (b - iteration) * x
            / ((qam + evenStep) * (a + evenStep));
        d = 1 + coefficient * d;
        if (Math.abs(d) < CONTINUED_FRACTION_FLOOR) d = CONTINUED_FRACTION_FLOOR;
        c = 1 + coefficient / c;
        if (Math.abs(c) < CONTINUED_FRACTION_FLOOR) c = CONTINUED_FRACTION_FLOOR;
        d = 1 / d;
        result *= d * c;

        coefficient = -(a + iteration) * (qab + iteration) * x
            / ((a + evenStep) * (qap + evenStep));
        d = 1 + coefficient * d;
        if (Math.abs(d) < CONTINUED_FRACTION_FLOOR) d = CONTINUED_FRACTION_FLOOR;
        c = 1 + coefficient / c;
        if (Math.abs(c) < CONTINUED_FRACTION_FLOOR) c = CONTINUED_FRACTION_FLOOR;
        d = 1 / d;
        const delta = d * c;
        result *= delta;
        if (Math.abs(delta - 1) <= NUMERICAL_EPSILON) break;
    }
    return result;
}

function regularizedIncompleteBeta(x, a, b) {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    const front = Math.exp(
        logGamma(a + b) - logGamma(a) - logGamma(b)
        + a * Math.log(x) + b * Math.log1p(-x)
    );
    if (x < (a + 1) / (a + b + 2)) {
        return front * betaContinuedFraction(a, b, x) / a;
    }
    return 1 - (front * betaContinuedFraction(b, a, 1 - x) / b);
}

function studentTCdf(value, degreesOfFreedom) {
    const df = Number(degreesOfFreedom);
    if (!Number.isFinite(value) || !Number.isFinite(df) || df <= 0) return null;
    if (value === 0) return 0.5;
    const x = df / (df + value * value);
    const tail = 0.5 * regularizedIncompleteBeta(x, df / 2, 0.5);
    return value > 0 ? 1 - tail : tail;
}

/**
 * Deterministic inverse Student-t CDF using monotonic bracketing and bisection.
 */
function studentTQuantile(probability, degreesOfFreedom) {
    const p = Number(probability);
    const df = Number(degreesOfFreedom);
    if (!Number.isFinite(p) || p <= 0 || p >= 1 || !Number.isFinite(df) || df <= 0) return null;
    if (p === 0.5) return 0;
    if (p < 0.5) {
        const mirrored = studentTQuantile(1 - p, df);
        return mirrored === null ? null : -mirrored;
    }

    let lower = 0;
    let upper = 1;
    while (upper < 1e12 && studentTCdf(upper, df) < p) upper *= 2;
    if (studentTCdf(upper, df) < p) return null;

    for (let iteration = 0; iteration < 120; iteration += 1) {
        const midpoint = (lower + upper) / 2;
        if (studentTCdf(midpoint, df) < p) lower = midpoint;
        else upper = midpoint;
    }
    return (lower + upper) / 2;
}

function validatePreregistration(preregistration) {
    const reasons = [];
    const source = preregistration && typeof preregistration === 'object'
        && !Array.isArray(preregistration)
        ? preregistration
        : {};

    const alpha = source.alpha;
    const mde = source.mde;
    const equivalenceMargin = source.equivalenceMargin;
    const repeatCount = source.repeatCount;
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
        reasons.push('alpha_invalid');
    }
    if (typeof mde !== 'number' || !Number.isFinite(mde) || mde < 0) {
        reasons.push('mde_invalid');
    }
    if (typeof equivalenceMargin !== 'number' || !Number.isFinite(equivalenceMargin)
        || equivalenceMargin < 0) {
        reasons.push('equivalence_margin_invalid');
    }
    if (!Number.isSafeInteger(repeatCount) || repeatCount < 1) {
        reasons.push('repeat_count_invalid');
    }

    function declaredIds(field, label) {
        if (source[field] === undefined) return { supplied: false, values: [] };
        if (!Array.isArray(source[field])) {
            reasons.push(`${label}_scope_invalid`);
            return { supplied: true, values: [] };
        }
        const normalized = source[field].map(normalizeId);
        if (normalized.some(value => !value)) reasons.push(`${label}_scope_invalid`);
        const valid = normalized.filter(Boolean);
        if (new Set(valid).size !== valid.length) reasons.push(`${label}_scope_duplicate`);
        return { supplied: true, values: [...new Set(valid)].sort(compareText) };
    }

    const candidates = declaredIds('candidateIds', 'candidate');
    const prompts = declaredIds('promptIds', 'prompt');
    return {
        valid: reasons.length === 0,
        reasons,
        values: {
            alpha: typeof alpha === 'number' && Number.isFinite(alpha) ? alpha : null,
            mde: typeof mde === 'number' && Number.isFinite(mde) ? mde : null,
            equivalenceMargin: typeof equivalenceMargin === 'number' && Number.isFinite(equivalenceMargin)
                ? equivalenceMargin
                : null,
            repeatCount: Number.isSafeInteger(repeatCount) && repeatCount >= 1 ? repeatCount : null,
            candidateIds: candidates.supplied ? candidates.values : null,
            promptIds: prompts.supplied ? prompts.values : null
        },
        declaredCandidates: candidates,
        declaredPrompts: prompts
    };
}

function aggregatePromptMeans(rows, preregistration = {}) {
    const validation = validatePreregistration(preregistration);
    const inputRows = Array.isArray(rows) ? rows : [];
    const invalidRows = [];
    const observedCandidates = new Set();
    const observedPrompts = new Set();
    const cells = new Map();

    if (!Array.isArray(rows)) invalidRows.push({ index: null, reasons: ['rows_not_array'] });
    for (let index = 0; index < inputRows.length; index += 1) {
        const row = inputRows[index];
        const candidateId = normalizeId(row?.candidateId);
        const promptId = normalizeId(row?.promptId);
        const score = row?.score;
        const repeatIndex = row?.repeatIndex;
        const rowReasons = [];
        if (!candidateId) rowReasons.push('candidate_id_invalid');
        if (!promptId) rowReasons.push('prompt_id_invalid');
        if (typeof score !== 'number' || !Number.isFinite(score)) rowReasons.push('score_invalid');
        if (!Number.isSafeInteger(repeatIndex) || repeatIndex < 0) {
            rowReasons.push('repeat_index_invalid');
        }
        if (candidateId) observedCandidates.add(candidateId);
        if (promptId) observedPrompts.add(promptId);
        if (rowReasons.length > 0) {
            invalidRows.push({ index, reasons: rowReasons });
            continue;
        }
        const key = `${candidateId}\u0000${promptId}`;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push({ score, repeatIndex });
    }

    const candidateIds = [...new Set([
        ...validation.declaredCandidates.values,
        ...observedCandidates
    ])].sort(compareText);
    const promptIds = [...new Set([
        ...validation.declaredPrompts.values,
        ...observedPrompts
    ])].sort(compareText);
    const undeclaredCandidateIds = validation.declaredCandidates.supplied
        ? [...observedCandidates].filter(id => !validation.declaredCandidates.values.includes(id)).sort(compareText)
        : [];
    const undeclaredPromptIds = validation.declaredPrompts.supplied
        ? [...observedPrompts].filter(id => !validation.declaredPrompts.values.includes(id)).sort(compareText)
        : [];

    const missingCells = [];
    const repeatCountMismatches = [];
    const repeatIndexMismatches = [];
    const candidateSummaries = candidateIds.map((candidateId) => {
        const promptMeans = promptIds.map((promptId) => {
            const attempts = [...(cells.get(`${candidateId}\u0000${promptId}`) || [])]
                .sort((left, right) => left.repeatIndex - right.repeatIndex || left.score - right.score);
            const scores = attempts.map(attempt => attempt.score);
            if (validation.values.repeatCount !== null
                && scores.length !== validation.values.repeatCount) {
                repeatCountMismatches.push({
                    candidateId,
                    promptId,
                    expected: validation.values.repeatCount,
                    actual: scores.length
                });
            }
            if (validation.values.repeatCount !== null) {
                const expectedIndexes = Array.from(
                    { length: validation.values.repeatCount },
                    (_, repeatIndex) => repeatIndex
                );
                const actualIndexes = attempts.map(attempt => attempt.repeatIndex).sort((a, b) => a - b);
                if (actualIndexes.length !== expectedIndexes.length
                    || actualIndexes.some((repeatIndex, index) => repeatIndex !== expectedIndexes[index])) {
                    repeatIndexMismatches.push({
                        candidateId,
                        promptId,
                        expected: expectedIndexes,
                        actual: actualIndexes
                    });
                }
            }
            if (scores.length === 0) {
                missingCells.push({ candidateId, promptId });
                return { promptId, mean: null, repeatCount: 0 };
            }
            return { promptId, mean: cleanZero(mean(scores)), repeatCount: scores.length };
        });
        const measuredMeans = promptMeans.filter(row => row.mean !== null).map(row => row.mean);
        const repeatCounts = promptMeans.filter(row => row.repeatCount > 0).map(row => row.repeatCount);
        return {
            candidateId,
            promptCount: measuredMeans.length,
            overallMean: measuredMeans.length > 0 ? cleanZero(mean(measuredMeans)) : null,
            totalRows: repeatCounts.reduce((sum, count) => sum + count, 0),
            repetitionsBalanced: repeatCounts.length <= 1 || repeatCounts.every(count => count === repeatCounts[0]),
            promptMeans
        };
    });

    const complete = invalidRows.length === 0
        && missingCells.length === 0
        && repeatCountMismatches.length === 0
        && repeatIndexMismatches.length === 0
        && undeclaredCandidateIds.length === 0
        && undeclaredPromptIds.length === 0;
    return {
        validation,
        candidateIds,
        promptIds,
        candidateSummaries,
        matrix: {
            complete,
            candidateCount: candidateIds.length,
            promptCount: promptIds.length,
            expectedCellCount: candidateIds.length * promptIds.length,
            observedCellCount: (candidateIds.length * promptIds.length) - missingCells.length,
            missingCells,
            repeatCountMismatches,
            repeatIndexMismatches,
            invalidRows,
            undeclaredCandidateIds,
            undeclaredPromptIds
        }
    };
}

function buildBaseComparison(leftSummary, rightSummary, promptIds, {
    adjustedAlpha,
    matrixComplete,
    preregistrationValid
}) {
    const leftByPrompt = new Map(leftSummary.promptMeans.map(row => [row.promptId, row.mean]));
    const rightByPrompt = new Map(rightSummary.promptMeans.map(row => [row.promptId, row.mean]));
    const paired = promptIds
        .map((promptId) => ({
            promptId,
            left: leftByPrompt.get(promptId),
            right: rightByPrompt.get(promptId)
        }))
        .filter(row => row.left !== null && row.right !== null);
    const differences = paired.map(row => row.left - row.right);
    const effect = differences.length > 0 ? cleanZero(mean(differences)) : null;
    const reasons = [];
    if (!matrixComplete) reasons.push('incomplete_matrix');
    if (!preregistrationValid) reasons.push('invalid_preregistration');
    if (paired.length !== promptIds.length) reasons.push('incomplete_pair');
    if (paired.length < 2) reasons.push('insufficient_independent_prompts');
    if (adjustedAlpha === null) reasons.push('adjusted_alpha_unavailable');

    let standardError = null;
    let criticalValue = null;
    let lower = null;
    let upper = null;
    if (reasons.length === 0) {
        const variance = sampleVariance(differences, effect);
        standardError = Math.sqrt(variance / differences.length);
        const probability = 1 - adjustedAlpha / 2;
        criticalValue = probability < 1
            ? studentTQuantile(probability, differences.length - 1)
            : null;
        if (criticalValue === null || !Number.isFinite(criticalValue)) {
            reasons.push('critical_value_unavailable');
            standardError = null;
            criticalValue = null;
        } else {
            const margin = criticalValue * standardError;
            lower = cleanZero(effect - margin);
            upper = cleanZero(effect + margin);
        }
    }

    return {
        leftCandidateId: leftSummary.candidateId,
        rightCandidateId: rightSummary.candidateId,
        n: paired.length,
        effect,
        adjustedAlpha,
        lower,
        upper,
        standardError,
        degreesOfFreedom: paired.length >= 2 ? paired.length - 1 : null,
        criticalValue,
        complete: reasons.length === 0,
        reasons
    };
}

function orientComparison(base, reverse, mde, equivalenceMargin) {
    const effect = reverse && base.effect !== null ? cleanZero(-base.effect) : base.effect;
    const lower = reverse && base.upper !== null ? cleanZero(-base.upper) : base.lower;
    const upper = reverse && base.lower !== null ? cleanZero(-base.lower) : base.upper;
    const leftCandidateId = reverse ? base.rightCandidateId : base.leftCandidateId;
    const rightCandidateId = reverse ? base.leftCandidateId : base.rightCandidateId;
    const intervalAvailable = lower !== null && upper !== null;
    return {
        leftCandidateId,
        rightCandidateId,
        n: base.n,
        effect,
        adjustedAlpha: base.adjustedAlpha,
        lower,
        upper,
        standardError: base.standardError,
        degreesOfFreedom: base.degreesOfFreedom,
        criticalValue: base.criticalValue,
        complete: base.complete,
        strictSuperiority: intervalAvailable && lower > mde,
        equivalent: intervalAvailable
            && lower >= -equivalenceMargin
            && upper <= equivalenceMargin,
        reasons: [...base.reasons]
    };
}

function uniqueReasons(reasons) {
    return [...new Set(reasons)];
}

function requireFingerprint(value, label) {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value)) {
        throw new Error(`${label} must be a lowercase SHA-256 fingerprint`);
    }
    return value;
}

function exactScaledInteger(value, factor, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be finite`);
    }
    const scaled = value * factor;
    const rounded = Math.round(scaled);
    if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-8) {
        throw new Error(`${label} is not exactly representable at the receipt scale`);
    }
    return rounded;
}

function evaluateBenchmarkTrustStatistics({ rows = [], preregistration = {} } = {}) {
    const aggregation = aggregatePromptMeans(rows, preregistration);
    const {
        validation,
        candidateIds,
        promptIds,
        candidateSummaries,
        matrix
    } = aggregation;
    const familySize = candidateIds.length >= 2
        ? candidateIds.length * (candidateIds.length - 1) / 2
        : 0;
    const alpha = validation.values.alpha;
    const adjustedAlpha = validation.valid && familySize > 0
        ? alpha / familySize
        : null;
    const probability = adjustedAlpha === null ? null : 1 - adjustedAlpha / 2;
    const adjustedAlphaUsable = adjustedAlpha !== null && adjustedAlpha > 0 && probability < 1;
    const effectiveAdjustedAlpha = adjustedAlphaUsable ? adjustedAlpha : null;

    const summariesById = new Map(candidateSummaries.map(summary => [summary.candidateId, summary]));
    const baseComparisons = [];
    for (let leftIndex = 0; leftIndex < candidateIds.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < candidateIds.length; rightIndex += 1) {
            baseComparisons.push(buildBaseComparison(
                summariesById.get(candidateIds[leftIndex]),
                summariesById.get(candidateIds[rightIndex]),
                promptIds,
                {
                    adjustedAlpha: effectiveAdjustedAlpha,
                    matrixComplete: matrix.complete,
                    preregistrationValid: validation.valid
                }
            ));
        }
    }

    const comparisons = baseComparisons.flatMap(base => [
        orientComparison(base, false, validation.values.mde, validation.values.equivalenceMargin),
        orientComparison(base, true, validation.values.mde, validation.values.equivalenceMargin)
    ]).sort((left, right) => (
        compareText(left.leftCandidateId, right.leftCandidateId)
        || compareText(left.rightCandidateId, right.rightCandidateId)
    ));
    const comparisonByDirection = new Map(comparisons.map(comparison => [
        `${comparison.leftCandidateId}\u0000${comparison.rightCandidateId}`,
        comparison
    ]));

    const reasons = [...validation.reasons];
    if (matrix.invalidRows.length > 0) reasons.push('invalid_rows');
    if (matrix.undeclaredCandidateIds.length > 0) reasons.push('undeclared_candidates');
    if (matrix.undeclaredPromptIds.length > 0) reasons.push('undeclared_prompts');
    if (matrix.missingCells.length > 0) reasons.push('incomplete_matrix');
    if (matrix.repeatCountMismatches.length > 0) reasons.push('repeat_count_mismatch');
    if (matrix.repeatIndexMismatches.length > 0) reasons.push('repeat_index_mismatch');
    if (candidateIds.length === 0) reasons.push('no_candidates');
    else if (candidateIds.length === 1) reasons.push('insufficient_candidates');
    if (promptIds.length === 0) reasons.push('no_prompts');
    else if (promptIds.length === 1) reasons.push('insufficient_independent_prompts');
    if (adjustedAlpha !== null && !adjustedAlphaUsable) reasons.push('adjusted_alpha_unrepresentable');

    let outcome = 'inconclusive';
    let winner = null;
    let equivalenceSet = [];
    const hasNoEligiblePopulation = candidateIds.length < 2 || promptIds.length === 0;
    const intervalsComplete = comparisons.length > 0
        && comparisons.every(comparison => comparison.complete);
    const eligibleForDecision = validation.valid
        && matrix.complete
        && candidateIds.length >= 2
        && promptIds.length >= 2
        && adjustedAlphaUsable
        && intervalsComplete;

    if (hasNoEligiblePopulation) {
        outcome = 'not_evaluated';
    } else if (eligibleForDecision) {
        const strictWinners = candidateIds.filter(candidateId => candidateIds
            .filter(otherId => otherId !== candidateId)
            .every(otherId => comparisonByDirection
                .get(`${candidateId}\u0000${otherId}`)?.strictSuperiority === true));
        if (strictWinners.length === 1) {
            outcome = 'winner';
            [winner] = strictWinners;
        } else if (strictWinners.length > 1) {
            reasons.push('multiple_strict_winners');
        } else {
            const survivors = candidateIds.filter(candidateId => !candidateIds
                .filter(otherId => otherId !== candidateId)
                .some(otherId => comparisonByDirection
                    .get(`${otherId}\u0000${candidateId}`)?.strictSuperiority === true));
            const survivorPairsEquivalent = survivors.length >= 2 && survivors.every((candidateId, index) => (
                survivors.slice(index + 1).every(otherId => comparisonByDirection
                    .get(`${candidateId}\u0000${otherId}`)?.equivalent === true)
            ));
            const outsiders = candidateIds.filter(candidateId => !survivors.includes(candidateId));
            const outsidersDominatedBySet = outsiders.every(outsideId => survivors.some(candidateId => (
                comparisonByDirection.get(`${candidateId}\u0000${outsideId}`)?.strictSuperiority === true
            )));
            if (survivorPairsEquivalent && outsidersDominatedBySet) {
                outcome = 'equivalence_set';
                equivalenceSet = [...survivors].sort(compareText);
            } else {
                reasons.push('no_strict_winner_or_equivalence');
            }
        }
    }

    return {
        method: {
            ...STATISTICS_METHOD,
            familySize,
            adjustedAlpha: effectiveAdjustedAlpha
        },
        preregistration: validation.values,
        matrix,
        candidateSummaries,
        comparisons,
        eligibleForDecision,
        decision: {
            outcome,
            winner,
            equivalenceSet,
            reasons: uniqueReasons(reasons)
        },
        reasons: uniqueReasons(reasons)
    };
}

/**
 * Project a completed pure evaluation into the exact statistical fields of
 * BenchmarkTrustReceipt v1. The decision fingerprint is derived here from the
 * normalized decision artifact; callers cannot provide a mismatched digest.
 */
function buildBenchmarkTrustStatisticsReceiptFields(evaluation, {
    analysisPlanFingerprint,
    rankingPolicyFingerprint
} = {}) {
    if (!evaluation || typeof evaluation !== 'object' || Array.isArray(evaluation)) {
        throw new Error('evaluation must be a Benchmark trust statistical result');
    }
    if (evaluation.method?.name !== STATISTICS_METHOD.name
        || evaluation.method?.multiplicity !== STATISTICS_METHOD.multiplicity
        || evaluation.preregistration?.repeatCount === null) {
        throw new Error('evaluation method or preregistration is incompatible with BenchmarkTrustReceipt v1');
    }
    const receiptCandidatePattern = /^candidate_[0-9a-f]{32}$/;
    if (!Array.isArray(evaluation.candidateSummaries)
        || evaluation.candidateSummaries.some(summary => (
            !receiptCandidatePattern.test(summary?.candidateId || '')
        ))) {
        throw new Error('evaluation candidate identifiers are not portable BenchmarkTrustReceipt ids');
    }
    const alphaBasisPoints = exactScaledInteger(
        evaluation.preregistration.alpha,
        10_000,
        'alpha'
    );
    const minimumEffectMicros = exactScaledInteger(
        evaluation.preregistration.mde,
        1_000_000,
        'mde'
    );
    const decisionArtifact = {
        method: evaluation.method,
        preregistration: evaluation.preregistration,
        matrix: evaluation.matrix,
        candidateSummaries: evaluation.candidateSummaries,
        comparisons: evaluation.comparisons,
        eligibleForDecision: evaluation.eligibleForDecision,
        decision: evaluation.decision
    };
    const decisionFingerprint = crypto.createHash('sha256')
        .update(stableSerialize(decisionArtifact))
        .digest('hex');
    const winnerCandidateId = evaluation.decision.outcome === 'winner'
        ? evaluation.decision.winner
        : null;
    const equivalenceCandidateIds = evaluation.decision.outcome === 'equivalence_set'
        ? [...evaluation.decision.equivalenceSet]
        : [];
    if ((winnerCandidateId !== null && !receiptCandidatePattern.test(winnerCandidateId))
        || equivalenceCandidateIds.some(candidateId => !receiptCandidatePattern.test(candidateId))) {
        throw new Error('evaluation decision references a non-portable candidate identifier');
    }

    return {
        unit: 'prompt',
        method: STATISTICS_METHOD.name,
        alphaBasisPoints,
        multiplicityCorrection: STATISTICS_METHOD.multiplicity,
        minimumEffectMicros,
        preregistration: {
            repeatCount: evaluation.preregistration.repeatCount,
            analysisPlanFingerprint: requireFingerprint(
                analysisPlanFingerprint,
                'analysisPlanFingerprint'
            )
        },
        rankingPolicyFingerprint: requireFingerprint(
            rankingPolicyFingerprint,
            'rankingPolicyFingerprint'
        ),
        decisionFingerprint,
        winnerCandidateId,
        equivalenceCandidateIds
    };
}

module.exports = {
    STATISTICS_METHOD,
    studentTCdf,
    studentTQuantile,
    validatePreregistration,
    aggregatePromptMeans,
    evaluateBenchmarkTrustStatistics,
    buildBenchmarkTrustStatisticsReceiptFields
};
