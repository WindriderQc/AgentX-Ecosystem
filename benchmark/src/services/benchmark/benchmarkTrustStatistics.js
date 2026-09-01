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
const {
    MAXIMUM_TARGET_POWER_BASIS_POINTS,
    MINIMUM_INDEPENDENT_PROMPT_COUNT,
    MINIMUM_TARGET_POWER_BASIS_POINTS
} = require('../../../../shared/benchmarkTrustReceipt');

const STATISTICS_METHOD = Object.freeze({
    name: 'paired-prompt-t-v1',
    version: 'agentx.benchmark-trust-statistics/paired-prompt-bonferroni-t/v1',
    independentUnit: 'prompt',
    repeatAggregation: 'arithmetic_mean_per_candidate_prompt',
    interval: 'two_sided_student_t',
    multiplicity: 'bonferroni',
    multiplicityFamily: 'all_unordered_candidate_pairs',
    powerAnalysis: 'student-t-critical-normal-shift-bound-v1'
});

const POWER_ANALYSIS_SCHEMA = 'agentx.benchmark-trust-power-analysis/student-t-critical-normal-shift-bound/v1';
const MAXIMUM_POWER_PROMPT_COUNT = 100_000;

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

/**
 * Acklam's deterministic inverse-normal approximation. The power planner uses
 * this only for the preregistered target-power margin; the reported interval
 * remains the exact Student-t interval above.
 */
function standardNormalQuantile(probability) {
    const p = Number(probability);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
    const a = [
        -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
        1.38357751867269e2, -3.066479806614716e1, 2.506628277459239
    ];
    const b = [
        -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
        6.680131188771972e1, -1.328068155288572e1
    ];
    const c = [
        -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
        -2.549732539343734, 4.374664141464968, 2.938163982698783
    ];
    const d = [
        7.784695709041462e-3, 3.224671290700398e-1,
        2.445134137142996, 3.754408661907416
    ];
    const lowerTail = 0.02425;
    const upperTail = 1 - lowerTail;
    if (p < lowerTail) {
        const q = Math.sqrt(-2 * Math.log(p));
        return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    if (p > upperTail) {
        const q = Math.sqrt(-2 * Math.log(1 - p));
        return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5])
            / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
    }
    const q = p - 0.5;
    const r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q
        / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

function requiredIndependentPromptCount({
    alpha,
    mde,
    candidateCount,
    targetPowerBasisPoints,
    assumedMaxPairedStdDevMicros
}) {
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) return null;
    if (typeof mde !== 'number' || !Number.isFinite(mde) || mde <= 0) return null;
    if (!Number.isSafeInteger(candidateCount) || candidateCount < 2) return null;
    if (!Number.isSafeInteger(targetPowerBasisPoints)
        || targetPowerBasisPoints < MINIMUM_TARGET_POWER_BASIS_POINTS
        || targetPowerBasisPoints > MAXIMUM_TARGET_POWER_BASIS_POINTS) return null;
    if (!Number.isSafeInteger(assumedMaxPairedStdDevMicros)
        || assumedMaxPairedStdDevMicros <= 0) return null;

    const familySize = candidateCount * (candidateCount - 1) / 2;
    const adjustedAlpha = alpha / familySize;
    const powerMargin = standardNormalQuantile(targetPowerBasisPoints / 10_000);
    const assumedStdDev = assumedMaxPairedStdDevMicros / 1_000_000;
    if (!Number.isFinite(adjustedAlpha) || adjustedAlpha <= 0 || adjustedAlpha >= 1
        || !Number.isFinite(powerMargin) || !Number.isFinite(assumedStdDev) || assumedStdDev <= 0) return null;

    // Conservative, explicitly versioned planning bound: require the signal at
    // the MDE to clear the finite-df Student-t critical value plus the target
    // standard-normal power margin. This never substitutes for the final t CI.
    const meetsBound = (count) => {
        const critical = studentTQuantile(1 - adjustedAlpha / 2, count - 1);
        return Number.isFinite(critical)
            && (mde * Math.sqrt(count) / assumedStdDev) >= critical + powerMargin;
    };

    if (meetsBound(MINIMUM_INDEPENDENT_PROMPT_COUNT)) return MINIMUM_INDEPENDENT_PROMPT_COUNT;
    let lower = MINIMUM_INDEPENDENT_PROMPT_COUNT;
    let upper = lower * 2;
    while (upper <= MAXIMUM_POWER_PROMPT_COUNT && !meetsBound(upper)) {
        lower = upper;
        upper *= 2;
    }
    if (upper > MAXIMUM_POWER_PROMPT_COUNT) {
        upper = MAXIMUM_POWER_PROMPT_COUNT;
        if (!meetsBound(upper)) return null;
    }
    while (lower + 1 < upper) {
        const midpoint = Math.floor((lower + upper) / 2);
        if (meetsBound(midpoint)) upper = midpoint;
        else lower = midpoint;
    }
    return upper;
}

function buildBenchmarkTrustPowerAnalysisFields({
    alpha,
    mde,
    candidateIds,
    targetPowerBasisPoints,
    assumedMaxPairedStdDevMicros
} = {}) {
    const normalizedCandidateIds = Array.isArray(candidateIds)
        ? [...new Set(candidateIds.map(normalizeId).filter(Boolean))].sort(compareText)
        : [];
    const requiredCount = requiredIndependentPromptCount({
        alpha,
        mde,
        candidateCount: normalizedCandidateIds.length,
        targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros
    });
    if (requiredCount === null) {
        throw new Error('power analysis inputs cannot produce a bounded required independent prompt count');
    }
    const familySize = normalizedCandidateIds.length * (normalizedCandidateIds.length - 1) / 2;
    const artifact = {
        schema: POWER_ANALYSIS_SCHEMA,
        statisticalMethod: STATISTICS_METHOD.name,
        multiplicityCorrection: STATISTICS_METHOD.multiplicity,
        alpha,
        minimumEffect: mde,
        candidateCount: normalizedCandidateIds.length,
        familySize,
        targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros,
        requiredIndependentPromptCount: requiredCount
    };
    return {
        requiredIndependentPromptCount: requiredCount,
        targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros,
        powerAnalysisFingerprint: crypto.createHash('sha256')
            .update(stableSerialize(artifact))
            .digest('hex')
    };
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
    const requiredPromptCount = source.requiredIndependentPromptCount;
    const targetPowerBasisPoints = source.targetPowerBasisPoints;
    const assumedMaxPairedStdDevMicros = source.assumedMaxPairedStdDevMicros;
    const powerAnalysisFingerprint = source.powerAnalysisFingerprint;
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
        reasons.push('alpha_invalid');
    }
    if (typeof mde !== 'number' || !Number.isFinite(mde) || mde <= 0) {
        reasons.push('mde_invalid');
    }
    if (typeof equivalenceMargin !== 'number' || !Number.isFinite(equivalenceMargin)
        || equivalenceMargin < 0) {
        reasons.push('equivalence_margin_invalid');
    }
    if (!Number.isSafeInteger(repeatCount) || repeatCount < 1) {
        reasons.push('repeat_count_invalid');
    }
    if (!Number.isSafeInteger(requiredPromptCount)
        || requiredPromptCount < MINIMUM_INDEPENDENT_PROMPT_COUNT) {
        reasons.push('required_prompt_count_invalid');
    }
    if (!Number.isSafeInteger(targetPowerBasisPoints)
        || targetPowerBasisPoints < MINIMUM_TARGET_POWER_BASIS_POINTS
        || targetPowerBasisPoints > MAXIMUM_TARGET_POWER_BASIS_POINTS) {
        reasons.push('target_power_invalid');
    }
    if (!Number.isSafeInteger(assumedMaxPairedStdDevMicros)
        || assumedMaxPairedStdDevMicros <= 0) {
        reasons.push('assumed_paired_stddev_invalid');
    }
    if (typeof powerAnalysisFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(powerAnalysisFingerprint)) {
        reasons.push('power_analysis_fingerprint_invalid');
    }

    function declaredIds(field, label) {
        if (source[field] === undefined) {
            reasons.push(`${label}_scope_missing`);
            return { supplied: false, values: [] };
        }
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
    let computedPower = null;
    try {
        computedPower = buildBenchmarkTrustPowerAnalysisFields({
            alpha,
            mde,
            candidateIds: candidates.values,
            targetPowerBasisPoints,
            assumedMaxPairedStdDevMicros
        });
    } catch (_error) {
        reasons.push('power_analysis_unavailable');
    }
    if (computedPower) {
        if (requiredPromptCount !== computedPower.requiredIndependentPromptCount) {
            reasons.push('required_prompt_count_mismatch');
        }
        if (powerAnalysisFingerprint !== computedPower.powerAnalysisFingerprint) {
            reasons.push('power_analysis_fingerprint_mismatch');
        }
        if (prompts.supplied && prompts.values.length < computedPower.requiredIndependentPromptCount) {
            reasons.push('underpowered_prompt_count');
        }
    }
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
            requiredIndependentPromptCount: Number.isSafeInteger(requiredPromptCount)
                && requiredPromptCount >= MINIMUM_INDEPENDENT_PROMPT_COUNT
                ? requiredPromptCount
                : null,
            targetPowerBasisPoints: Number.isSafeInteger(targetPowerBasisPoints)
                ? targetPowerBasisPoints
                : null,
            assumedMaxPairedStdDevMicros: Number.isSafeInteger(assumedMaxPairedStdDevMicros)
                ? assumedMaxPairedStdDevMicros
                : null,
            powerAnalysisFingerprint: typeof powerAnalysisFingerprint === 'string'
                ? powerAnalysisFingerprint
                : null,
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
    preregistrationValid,
    requiredPromptCount
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
    if (paired.length < MINIMUM_INDEPENDENT_PROMPT_COUNT) reasons.push('insufficient_independent_prompts');
    if (Number.isSafeInteger(requiredPromptCount) && paired.length < requiredPromptCount) {
        reasons.push('underpowered_prompt_count');
    }
    if (adjustedAlpha === null) reasons.push('adjusted_alpha_unavailable');

    let standardError = null;
    let criticalValue = null;
    let lower = null;
    let upper = null;
    if (reasons.length === 0) {
        const variance = sampleVariance(differences, effect);
        if (!Number.isFinite(variance) || variance <= 0) {
            reasons.push('degenerate_paired_variance');
        } else {
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
                    preregistrationValid: validation.valid,
                    requiredPromptCount: validation.values.requiredIndependentPromptCount
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
    else if (promptIds.length < MINIMUM_INDEPENDENT_PROMPT_COUNT) reasons.push('insufficient_independent_prompts');
    if (adjustedAlpha !== null && !adjustedAlphaUsable) reasons.push('adjusted_alpha_unrepresentable');
    if (comparisons.some(comparison => comparison.reasons.includes('degenerate_paired_variance'))) {
        reasons.push('degenerate_paired_variance');
    }

    let outcome = 'inconclusive';
    let winner = null;
    let equivalenceSet = [];
    const hasNoEligiblePopulation = candidateIds.length < 2 || promptIds.length === 0;
    const intervalsComplete = comparisons.length > 0
        && comparisons.every(comparison => comparison.complete);
    const eligibleForDecision = validation.valid
        && matrix.complete
        && candidateIds.length >= 2
        && promptIds.length >= MINIMUM_INDEPENDENT_PROMPT_COUNT
        && promptIds.length >= validation.values.requiredIndependentPromptCount
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
 * Evaluate raw rows and project the resulting decision into the exact
 * statistical fields of BenchmarkTrustReceipt v1. A caller cannot inject or
 * mutate a precomputed evaluation object: this boundary always re-evaluates.
 */
function buildBenchmarkTrustStatisticsReceiptFields(source, {
    analysisPlanFingerprint,
    rankingPolicyFingerprint
} = {}) {
    if (!source || typeof source !== 'object' || Array.isArray(source)
        || !Object.prototype.hasOwnProperty.call(source, 'rows')
        || !Array.isArray(source.rows)
        || !source.preregistration
        || typeof source.preregistration !== 'object'
        || Array.isArray(source.preregistration)) {
        throw new Error('source must contain raw rows and a Benchmark trust preregistration');
    }
    const preregistrationValidation = validatePreregistration(source.preregistration);
    const fatalPreregistrationReasons = preregistrationValidation.reasons
        .filter(reason => reason !== 'underpowered_prompt_count');
    if (fatalPreregistrationReasons.length > 0) {
        throw new Error(`source preregistration is not structurally valid: ${fatalPreregistrationReasons.join(', ')}`);
    }
    const evaluation = evaluateBenchmarkTrustStatistics({
        rows: source.rows,
        preregistration: source.preregistration
    });
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
    if ((winnerCandidateId !== null || equivalenceCandidateIds.length > 0)
        && evaluation.eligibleForDecision !== true) {
        throw new Error('evaluation decision is not supported by a complete powered comparison family');
    }

    return {
        unit: 'prompt',
        method: STATISTICS_METHOD.name,
        alphaBasisPoints,
        multiplicityCorrection: STATISTICS_METHOD.multiplicity,
        minimumEffectMicros,
        preregistration: {
            repeatCount: evaluation.preregistration.repeatCount,
            requiredIndependentPromptCount: evaluation.preregistration.requiredIndependentPromptCount,
            targetPowerBasisPoints: evaluation.preregistration.targetPowerBasisPoints,
            assumedMaxPairedStdDevMicros: evaluation.preregistration.assumedMaxPairedStdDevMicros,
            powerAnalysisFingerprint: evaluation.preregistration.powerAnalysisFingerprint,
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
    POWER_ANALYSIS_SCHEMA,
    STATISTICS_METHOD,
    buildBenchmarkTrustPowerAnalysisFields,
    studentTCdf,
    studentTQuantile,
    validatePreregistration,
    aggregatePromptMeans,
    evaluateBenchmarkTrustStatistics,
    buildBenchmarkTrustStatisticsReceiptFields
};
