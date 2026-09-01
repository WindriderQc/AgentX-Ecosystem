/**
 * Pure statistical decision support for Benchmark Trust receipts.
 *
 * The independent unit is a prompt. Repeated attempts are averaged inside
 * each candidate/prompt cell before any comparison is made. Candidate effects
 * are paired prompt-mean differences in [-10, 10], with simultaneous
 * distribution-free Hoeffding intervals protected by a deterministic
 * Bonferroni family correction.
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
    name: 'paired-prompt-hoeffding-v1',
    version: 'agentx.benchmark-trust-statistics/paired-prompt-bonferroni-hoeffding/v1',
    independentUnit: 'prompt',
    repeatAggregation: 'arithmetic_mean_per_candidate_prompt',
    interval: 'two_sided_bounded_hoeffding',
    multiplicity: 'bonferroni',
    multiplicityFamily: 'all_unordered_candidate_pairs',
    powerAnalysis: 'bounded-hoeffding-superiority-power-v1'
});

const POWER_ANALYSIS_SCHEMA = 'agentx.benchmark-trust-power-analysis/bounded-hoeffding-superiority/v1';
const VARIANCE_BASIS_SCHEMA = 'agentx.benchmark-trust-variance-basis/independent-pilot-upper-bound/v1';
const VARIANCE_BASIS_METHOD = 'chi-square-one-sided-upper-confidence-bound-v1';
const VARIANCE_BASIS_PROVENANCE = 'independent_pilot';
const MINIMUM_VARIANCE_BASIS_PROMPT_COUNT = 30;
const MAXIMUM_POWER_PROMPT_COUNT = 100_000;
const MINIMUM_SCORE = 0;
const MAXIMUM_SCORE = 10;
const PAIRED_DIFFERENCE_RANGE = 2 * (MAXIMUM_SCORE - MINIMUM_SCORE);

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

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function buildBenchmarkTrustVarianceBasis(raw = {}) {
    const basis = {
        schema: raw.schema,
        provenance: raw.provenance,
        cohortFingerprint: raw.cohortFingerprint,
        candidateSetFingerprint: raw.candidateSetFingerprint,
        rubricFingerprint: raw.rubricFingerprint,
        repeatCount: raw.repeatCount,
        candidateInferenceContractFingerprint: raw.candidateInferenceContractFingerprint,
        promptSamplingPolicyFingerprint: raw.promptSamplingPolicyFingerprint,
        candidatePairCount: raw.candidatePairCount,
        pairwiseObservedStdDevs: raw.pairwiseObservedStdDevs,
        method: raw.method,
        independentPromptCount: raw.independentPromptCount,
        confidenceBasisPoints: raw.confidenceBasisPoints,
        observedPairedStdDevMicros: raw.observedPairedStdDevMicros
    };
    const allowedKeys = [...Object.keys(basis), 'upperConfidenceBoundMicros', 'artifactFingerprint'];
    if (!isPlainObject(raw)
        || Object.keys(raw).some(key => !allowedKeys.includes(key))
        || Object.keys(basis).some(key => !Object.prototype.hasOwnProperty.call(raw, key))
        || basis.schema !== VARIANCE_BASIS_SCHEMA
        || basis.provenance !== VARIANCE_BASIS_PROVENANCE
        || typeof basis.cohortFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(basis.cohortFingerprint)
        || typeof basis.candidateSetFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(basis.candidateSetFingerprint)
        || typeof basis.rubricFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(basis.rubricFingerprint)
        || !Number.isSafeInteger(basis.repeatCount)
        || basis.repeatCount < 1
        || basis.repeatCount > 5
        || typeof basis.candidateInferenceContractFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(basis.candidateInferenceContractFingerprint)
        || typeof basis.promptSamplingPolicyFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(basis.promptSamplingPolicyFingerprint)
        || !Number.isSafeInteger(basis.candidatePairCount)
        || basis.candidatePairCount < 1
        || !Array.isArray(basis.pairwiseObservedStdDevs)
        || basis.pairwiseObservedStdDevs.length !== basis.candidatePairCount
        || basis.method !== VARIANCE_BASIS_METHOD
        || !Number.isSafeInteger(basis.independentPromptCount)
        || basis.independentPromptCount < MINIMUM_VARIANCE_BASIS_PROMPT_COUNT
        || !Number.isSafeInteger(basis.confidenceBasisPoints)
        || basis.confidenceBasisPoints < 9500
        || basis.confidenceBasisPoints > 9999
        || !Number.isSafeInteger(basis.observedPairedStdDevMicros)
        || basis.observedPairedStdDevMicros <= 0) {
        throw new Error('variance basis must be an immutable independent-pilot upper-confidence-bound artifact');
    }
    const pairwiseObservedStdDevs = basis.pairwiseObservedStdDevs.map((entry) => {
        if (!isPlainObject(entry)
            || Object.keys(entry).length !== 2
            || !Object.prototype.hasOwnProperty.call(entry, 'pairFingerprint')
            || !Object.prototype.hasOwnProperty.call(entry, 'observedPairedStdDevMicros')
            || typeof entry.pairFingerprint !== 'string'
            || !/^[0-9a-f]{64}$/.test(entry.pairFingerprint)
            || !Number.isSafeInteger(entry.observedPairedStdDevMicros)
            || entry.observedPairedStdDevMicros <= 0) {
            throw new Error('variance basis pairwise deviation entry is invalid');
        }
        return { ...entry };
    });
    const pairFingerprints = pairwiseObservedStdDevs.map(entry => entry.pairFingerprint);
    if (new Set(pairFingerprints).size !== pairFingerprints.length
        || pairFingerprints.join('\n') !== [...pairFingerprints].sort(compareText).join('\n')
        || basis.observedPairedStdDevMicros !== Math.max(
            ...pairwiseObservedStdDevs.map(entry => entry.observedPairedStdDevMicros)
        )) {
        throw new Error('variance basis must contain the canonical complete pair family and its maximum deviation');
    }
    basis.pairwiseObservedStdDevs = pairwiseObservedStdDevs;
    const upperConfidenceBoundMicros = computePairedStdDevUpperConfidenceBoundMicros({
        observedPairedStdDevMicros: basis.observedPairedStdDevMicros,
        independentPromptCount: basis.independentPromptCount,
        confidenceBasisPoints: basis.confidenceBasisPoints
    });
    if (!Number.isSafeInteger(upperConfidenceBoundMicros)
        || upperConfidenceBoundMicros <= basis.observedPairedStdDevMicros
        || (Object.prototype.hasOwnProperty.call(raw, 'upperConfidenceBoundMicros')
            && raw.upperConfidenceBoundMicros !== upperConfidenceBoundMicros)) {
        throw new Error('variance basis upper confidence bound does not match the versioned chi-square calculation');
    }
    const body = { ...basis, upperConfidenceBoundMicros };
    const artifactFingerprint = crypto.createHash('sha256')
        .update(stableSerialize(body))
        .digest('hex');
    if (Object.prototype.hasOwnProperty.call(raw, 'artifactFingerprint')
        && raw.artifactFingerprint !== artifactFingerprint) {
        throw new Error('variance basis artifact fingerprint does not match its canonical body');
    }
    return { ...body, artifactFingerprint };
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

function sha256Stable(value) {
    return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function normalizeVarianceCandidateBindings(candidateBindings) {
    if (!Array.isArray(candidateBindings) || candidateBindings.length < 2) {
        throw new Error('variance basis requires at least two exact candidate bindings');
    }
    const normalized = candidateBindings.map((binding) => {
        if (!isPlainObject(binding)
            || typeof binding.targetFingerprint !== 'string'
            || !/^[0-9a-f]{64}$/.test(binding.targetFingerprint)
            || typeof binding.modelDigest !== 'string' || binding.modelDigest.trim() === ''
            || typeof binding.artifactDigest !== 'string' || binding.artifactDigest.trim() === ''
            || typeof binding.inferenceContractFingerprint !== 'string'
            || !/^[0-9a-f]{64}$/.test(binding.inferenceContractFingerprint)) {
            throw new Error('variance basis candidate binding is invalid');
        }
        return {
            targetFingerprint: binding.targetFingerprint,
            modelDigest: binding.modelDigest,
            artifactDigest: binding.artifactDigest,
            inferenceContractFingerprint: binding.inferenceContractFingerprint
        };
    }).sort((left, right) => compareText(left.targetFingerprint, right.targetFingerprint));
    if (new Set(normalized.map(binding => binding.targetFingerprint)).size !== normalized.length) {
        throw new Error('variance basis candidate bindings must be unique');
    }
    return normalized;
}

function computeBenchmarkTrustVarianceCandidateSetFingerprint(candidateBindings) {
    return sha256Stable(normalizeVarianceCandidateBindings(candidateBindings));
}

function computeBenchmarkTrustCandidateInferenceContractFingerprint({
    candidateBindings,
    repeatCount,
    parameters
} = {}) {
    if (!Number.isSafeInteger(repeatCount) || repeatCount < 1 || repeatCount > 5
        || !isPlainObject(parameters)
        || Object.keys(parameters).some(key => ![
            'temperature', 'topP', 'seed', 'maxTokens', 'timeoutMs'
        ].includes(key))
        || ['temperature', 'topP', 'seed', 'maxTokens', 'timeoutMs']
            .some(key => !Object.prototype.hasOwnProperty.call(parameters, key))
        || typeof parameters.temperature !== 'number'
        || !Number.isFinite(parameters.temperature)
        || parameters.temperature < 0
        || parameters.temperature > 2
        || typeof parameters.topP !== 'number'
        || !Number.isFinite(parameters.topP)
        || parameters.topP < 0
        || parameters.topP > 1
        || !(parameters.seed === null || Number.isSafeInteger(parameters.seed))
        || !Number.isSafeInteger(parameters.maxTokens)
        || parameters.maxTokens < 1
        || !Number.isSafeInteger(parameters.timeoutMs)
        || parameters.timeoutMs < 1) {
        throw new Error('variance basis inference contract is invalid');
    }
    return sha256Stable({
        schema: 'agentx.benchmark-trust-candidate-inference-contract/v1',
        repeatCount,
        parameters: {
            temperature: parameters.temperature,
            topP: parameters.topP,
            seed: parameters.seed,
            maxTokens: parameters.maxTokens,
            timeoutMs: parameters.timeoutMs
        },
        candidates: normalizeVarianceCandidateBindings(candidateBindings)
    });
}

function computeBenchmarkTrustVariancePairFingerprints(candidateBindings, rubricFingerprint) {
    const normalized = normalizeVarianceCandidateBindings(candidateBindings);
    if (typeof rubricFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(rubricFingerprint)) {
        throw new Error('variance basis rubric fingerprint is invalid');
    }
    const candidateFingerprints = normalized.map(binding => sha256Stable(binding));
    const pairs = [];
    for (let leftIndex = 0; leftIndex < candidateFingerprints.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < candidateFingerprints.length; rightIndex += 1) {
            pairs.push(sha256Stable({
                schema: 'agentx.benchmark-trust-variance-pair/v1',
                rubricFingerprint,
                candidateFingerprints: [
                    candidateFingerprints[leftIndex],
                    candidateFingerprints[rightIndex]
                ].sort(compareText)
            }));
        }
    }
    return pairs.sort(compareText);
}

function regularizedGammaP(shape, value) {
    if (!Number.isFinite(shape) || shape <= 0 || !Number.isFinite(value) || value < 0) return null;
    if (value === 0) return 0;
    const logScale = -value + (shape * Math.log(value)) - logGamma(shape);
    if (value < shape + 1) {
        let term = 1 / shape;
        let sum = term;
        let denominator = shape;
        for (let iteration = 1; iteration <= MAX_CONTINUED_FRACTION_ITERATIONS; iteration += 1) {
            denominator += 1;
            term *= value / denominator;
            sum += term;
            if (Math.abs(term) <= Math.abs(sum) * NUMERICAL_EPSILON) break;
        }
        return Math.max(0, Math.min(1, sum * Math.exp(logScale)));
    }

    let b = value + 1 - shape;
    let c = 1 / CONTINUED_FRACTION_FLOOR;
    let d = 1 / Math.max(b, CONTINUED_FRACTION_FLOOR);
    let fraction = d;
    for (let iteration = 1; iteration <= MAX_CONTINUED_FRACTION_ITERATIONS; iteration += 1) {
        const coefficient = -iteration * (iteration - shape);
        b += 2;
        d = (coefficient * d) + b;
        if (Math.abs(d) < CONTINUED_FRACTION_FLOOR) d = CONTINUED_FRACTION_FLOOR;
        c = b + (coefficient / c);
        if (Math.abs(c) < CONTINUED_FRACTION_FLOOR) c = CONTINUED_FRACTION_FLOOR;
        d = 1 / d;
        const delta = d * c;
        fraction *= delta;
        if (Math.abs(delta - 1) <= NUMERICAL_EPSILON) break;
    }
    const complement = Math.exp(logScale) * fraction;
    return Math.max(0, Math.min(1, 1 - complement));
}

function chiSquareQuantile(probability, degreesOfFreedom) {
    if (typeof probability !== 'number' || !Number.isFinite(probability)
        || probability <= 0 || probability >= 1
        || !Number.isSafeInteger(degreesOfFreedom) || degreesOfFreedom < 1) return null;
    let lower = 0;
    let upper = Math.max(1, degreesOfFreedom);
    while (regularizedGammaP(degreesOfFreedom / 2, upper / 2) < probability) {
        upper *= 2;
        if (!Number.isFinite(upper)) return null;
    }
    for (let iteration = 0; iteration < 200; iteration += 1) {
        const midpoint = (lower + upper) / 2;
        if (regularizedGammaP(degreesOfFreedom / 2, midpoint / 2) < probability) lower = midpoint;
        else upper = midpoint;
    }
    return (lower + upper) / 2;
}

function computePairedStdDevUpperConfidenceBoundMicros({
    observedPairedStdDevMicros,
    independentPromptCount,
    confidenceBasisPoints
} = {}) {
    if (!Number.isSafeInteger(observedPairedStdDevMicros) || observedPairedStdDevMicros <= 0
        || !Number.isSafeInteger(independentPromptCount)
        || independentPromptCount < MINIMUM_VARIANCE_BASIS_PROMPT_COUNT
        || !Number.isSafeInteger(confidenceBasisPoints)
        || confidenceBasisPoints < 9500 || confidenceBasisPoints > 9999) return null;
    const degreesOfFreedom = independentPromptCount - 1;
    const lowerTailProbability = 1 - (confidenceBasisPoints / 10_000);
    const lowerQuantile = chiSquareQuantile(lowerTailProbability, degreesOfFreedom);
    if (!Number.isFinite(lowerQuantile) || lowerQuantile <= 0) return null;
    const upper = observedPairedStdDevMicros * Math.sqrt(degreesOfFreedom / lowerQuantile);
    return Number.isFinite(upper) && upper <= Number.MAX_SAFE_INTEGER ? Math.ceil(upper) : null;
}

function boundedHoeffdingConfidenceRadius(count, alpha, familySize) {
    if (!Number.isSafeInteger(count) || count < 1
        || typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1
        || !Number.isSafeInteger(familySize) || familySize < 1) return null;
    return PAIRED_DIFFERENCE_RANGE * Math.sqrt(
        Math.log((2 * familySize) / alpha) / (2 * count)
    );
}

function boundedHoeffdingFamilyMissUpperBound(count, alpha, familySize, poweredExcessEffect) {
    const radius = boundedHoeffdingConfidenceRadius(count, alpha, familySize);
    if (!Number.isFinite(radius) || typeof poweredExcessEffect !== 'number'
        || !Number.isFinite(poweredExcessEffect) || poweredExcessEffect <= radius) return 1;
    const remainingSignal = poweredExcessEffect - radius;
    return Math.min(1, familySize * Math.exp(
        (-2 * count * remainingSignal * remainingSignal)
        / (PAIRED_DIFFERENCE_RANGE * PAIRED_DIFFERENCE_RANGE)
    ));
}

function requiredIndependentPromptCount({
    alpha,
    mde,
    poweredAlternativeEffect,
    candidateCount,
    targetPowerBasisPoints,
    assumedMaxPairedStdDevMicros
}) {
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) return null;
    if (typeof mde !== 'number' || !Number.isFinite(mde) || mde <= 0 || mde >= MAXIMUM_SCORE) return null;
    if (typeof poweredAlternativeEffect !== 'number'
        || !Number.isFinite(poweredAlternativeEffect)
        || poweredAlternativeEffect <= mde
        || poweredAlternativeEffect > MAXIMUM_SCORE) return null;
    if (!Number.isSafeInteger(candidateCount) || candidateCount < 2) return null;
    if (!Number.isSafeInteger(targetPowerBasisPoints)
        || targetPowerBasisPoints < MINIMUM_TARGET_POWER_BASIS_POINTS
        || targetPowerBasisPoints > MAXIMUM_TARGET_POWER_BASIS_POINTS) return null;
    if (!Number.isSafeInteger(assumedMaxPairedStdDevMicros)
        || assumedMaxPairedStdDevMicros <= 0) return null;

    const familySize = candidateCount * (candidateCount - 1) / 2;
    const poweredExcessEffect = poweredAlternativeEffect - mde;
    const targetPower = targetPowerBasisPoints / 10_000;
    const confidenceLog = Math.log((2 * familySize) / alpha);
    const powerLog = Math.log(familySize / (1 - targetPower));
    if (![poweredExcessEffect, confidenceLog, powerLog].every(Number.isFinite)
        || poweredExcessEffect <= 0 || confidenceLog <= 0 || powerLog <= 0) return null;

    // Every prompt-level paired difference lies in [-10, 10]. The simultaneous
    // confidence radius and the miss-probability bound therefore hold for any
    // score distribution; no normality or asymptotic approximation is assumed.
    const meetsBound = (count) => {
        const familyMissBound = boundedHoeffdingFamilyMissUpperBound(
            count,
            alpha,
            familySize,
            poweredExcessEffect
        );
        return Number.isFinite(familyMissBound)
            && familyMissBound <= 1 - targetPower;
    };

    const direct = Math.ceil((PAIRED_DIFFERENCE_RANGE * (
        Math.sqrt(confidenceLog / 2) + Math.sqrt(powerLog / 2)
    ) / poweredExcessEffect) ** 2);
    if (!Number.isSafeInteger(direct) || direct > MAXIMUM_POWER_PROMPT_COUNT) return null;
    let required = Math.max(MINIMUM_INDEPENDENT_PROMPT_COUNT, direct);
    while (required <= MAXIMUM_POWER_PROMPT_COUNT && !meetsBound(required)) required += 1;
    if (required > MAXIMUM_POWER_PROMPT_COUNT) return null;
    while (required > MINIMUM_INDEPENDENT_PROMPT_COUNT && meetsBound(required - 1)) required -= 1;
    return required;
}

function buildBenchmarkTrustPowerAnalysisFields({
    alpha,
    mde,
    poweredAlternativeEffect,
    candidateIds,
    targetPowerBasisPoints,
    assumedMaxPairedStdDevMicros,
    varianceBasis
} = {}) {
    const normalizedCandidateIds = Array.isArray(candidateIds)
        ? [...new Set(candidateIds.map(normalizeId).filter(Boolean))].sort(compareText)
        : [];
    const normalizedVarianceBasis = buildBenchmarkTrustVarianceBasis(varianceBasis);
    if (assumedMaxPairedStdDevMicros !== normalizedVarianceBasis.upperConfidenceBoundMicros) {
        throw new Error('assumed maximum paired standard deviation must equal the frozen variance upper bound');
    }
    const requiredCount = requiredIndependentPromptCount({
        alpha,
        mde,
        poweredAlternativeEffect,
        candidateCount: normalizedCandidateIds.length,
        targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros
    });
    if (requiredCount === null) {
        throw new Error('power analysis inputs cannot produce a bounded required independent prompt count');
    }
    const familySize = normalizedCandidateIds.length * (normalizedCandidateIds.length - 1) / 2;
    if (normalizedVarianceBasis.candidatePairCount !== familySize) {
        throw new Error('variance basis candidate pair family does not match the preregistered candidates');
    }
    const artifact = {
        schema: POWER_ANALYSIS_SCHEMA,
        statisticalMethod: STATISTICS_METHOD.name,
        multiplicityCorrection: STATISTICS_METHOD.multiplicity,
        alpha,
        superiorityMargin: mde,
        poweredAlternativeEffect,
        poweredExcessEffect: poweredAlternativeEffect - mde,
        candidateCount: normalizedCandidateIds.length,
        familySize,
        scoreMinimum: MINIMUM_SCORE,
        scoreMaximum: MAXIMUM_SCORE,
        pairedDifferenceRange: PAIRED_DIFFERENCE_RANGE,
        targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros,
        variancePilotUsedForPowerNarrowing: false,
        varianceBasisFingerprint: normalizedVarianceBasis.artifactFingerprint,
        requiredIndependentPromptCount: requiredCount
    };
    return {
        requiredIndependentPromptCount: requiredCount,
        targetPowerBasisPoints,
        poweredAlternativeEffect,
        assumedMaxPairedStdDevMicros,
        varianceBasis: normalizedVarianceBasis,
        varianceBasisFingerprint: normalizedVarianceBasis.artifactFingerprint,
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
    const poweredAlternativeEffect = source.poweredAlternativeEffect;
    const equivalenceMargin = source.equivalenceMargin;
    const repeatCount = source.repeatCount;
    const requiredPromptCount = source.requiredIndependentPromptCount;
    const targetPowerBasisPoints = source.targetPowerBasisPoints;
    const assumedMaxPairedStdDevMicros = source.assumedMaxPairedStdDevMicros;
    const varianceBasis = source.varianceBasis;
    const varianceBasisFingerprint = source.varianceBasisFingerprint;
    const variancePilotAttestationId = source.variancePilotAttestationId;
    const powerAnalysisFingerprint = source.powerAnalysisFingerprint;
    if (typeof alpha !== 'number' || !Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
        reasons.push('alpha_invalid');
    }
    if (typeof mde !== 'number' || !Number.isFinite(mde) || mde <= 0 || mde >= MAXIMUM_SCORE) {
        reasons.push('mde_invalid');
    }
    if (typeof poweredAlternativeEffect !== 'number'
        || !Number.isFinite(poweredAlternativeEffect)
        || !(poweredAlternativeEffect > mde)
        || poweredAlternativeEffect > MAXIMUM_SCORE) {
        reasons.push('powered_alternative_effect_invalid');
    }
    if (typeof equivalenceMargin !== 'number' || !Number.isFinite(equivalenceMargin)
        || equivalenceMargin < 0) {
        reasons.push('equivalence_margin_invalid');
    } else if (typeof mde === 'number' && Number.isFinite(mde) && equivalenceMargin > mde) {
        reasons.push('equivalence_margin_exceeds_mde');
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
    if (typeof varianceBasisFingerprint !== 'string'
        || !/^[0-9a-f]{64}$/.test(varianceBasisFingerprint)) {
        reasons.push('variance_basis_fingerprint_invalid');
    }
    if (typeof variancePilotAttestationId !== 'string'
        || !/^[0-9a-f]{64}$/.test(variancePilotAttestationId)) {
        reasons.push('variance_pilot_attestation_id_invalid');
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
            poweredAlternativeEffect,
            candidateIds: candidates.values,
            targetPowerBasisPoints,
            assumedMaxPairedStdDevMicros,
            varianceBasis
        });
    } catch (_error) {
        reasons.push('power_analysis_unavailable');
    }
    if (computedPower) {
        if (computedPower.varianceBasis.repeatCount !== repeatCount) {
            reasons.push('variance_basis_repeat_mismatch');
        }
        if (requiredPromptCount !== computedPower.requiredIndependentPromptCount) {
            reasons.push('required_prompt_count_mismatch');
        }
        if (powerAnalysisFingerprint !== computedPower.powerAnalysisFingerprint) {
            reasons.push('power_analysis_fingerprint_mismatch');
        }
        if (varianceBasisFingerprint !== computedPower.varianceBasisFingerprint) {
            reasons.push('variance_basis_fingerprint_mismatch');
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
            poweredAlternativeEffect: typeof poweredAlternativeEffect === 'number'
                && Number.isFinite(poweredAlternativeEffect)
                ? poweredAlternativeEffect
                : null,
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
            varianceBasis: computedPower?.varianceBasis || null,
            varianceBasisFingerprint: typeof varianceBasisFingerprint === 'string'
                ? varianceBasisFingerprint
                : null,
            variancePilotAttestationId: typeof variancePilotAttestationId === 'string'
                ? variancePilotAttestationId
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
        else if (score < MINIMUM_SCORE || score > MAXIMUM_SCORE) rowReasons.push('score_out_of_range');
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
    requiredPromptCount,
    assumedMaxPairedStdDevMicros
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

    let observedPairedStdDevMicros = null;
    let confidenceRadius = null;
    let lower = null;
    let upper = null;
    const variance = sampleVariance(differences, effect);
    if (Number.isFinite(variance) && variance >= 0) {
        observedPairedStdDevMicros = Math.round(Math.sqrt(variance) * 1_000_000);
        if (Number.isSafeInteger(assumedMaxPairedStdDevMicros)
            && observedPairedStdDevMicros > assumedMaxPairedStdDevMicros) {
            reasons.push('observed_variance_exceeds_preregistered_bound');
        }
    }
    if (reasons.length === 0) {
        confidenceRadius = boundedHoeffdingConfidenceRadius(
            differences.length,
            adjustedAlpha,
            1
        );
        if (!Number.isFinite(confidenceRadius)) {
            reasons.push('confidence_radius_unavailable');
            confidenceRadius = null;
        } else {
            lower = cleanZero(Math.max(-MAXIMUM_SCORE, effect - confidenceRadius));
            upper = cleanZero(Math.min(MAXIMUM_SCORE, effect + confidenceRadius));
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
        confidenceRadius,
        observedPairedStdDevMicros,
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
        confidenceRadius: base.confidenceRadius,
        observedPairedStdDevMicros: base.observedPairedStdDevMicros,
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

function isReceiptScaleRepresentable(value, factor) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    const scaled = value * factor;
    const rounded = Math.round(scaled);
    return Number.isSafeInteger(rounded) && Math.abs(scaled - rounded) <= 1e-8;
}

function exactScaledInteger(value, factor, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new Error(`${label} must be finite`);
    }
    const scaled = value * factor;
    const rounded = Math.round(scaled);
    if (!isReceiptScaleRepresentable(value, factor)) {
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
    const adjustedAlphaUsable = adjustedAlpha !== null
        && adjustedAlpha > 0
        && adjustedAlpha < 1;
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
                    requiredPromptCount: validation.values.requiredIndependentPromptCount,
                    assumedMaxPairedStdDevMicros: validation.values.assumedMaxPairedStdDevMicros
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
    if (comparisons.some(comparison => comparison.reasons
        .includes('observed_variance_exceeds_preregistered_bound'))) {
        reasons.push('observed_variance_exceeds_preregistered_bound');
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
            const outsidersDominatedBySet = outsiders.every(outsideId => survivors.every(candidateId => (
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
 * statistical fields of BenchmarkTrustReceipt v2. A caller cannot inject or
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
        throw new Error('evaluation method or preregistration is incompatible with BenchmarkTrustReceipt v2');
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
    const poweredAlternativeEffectMicros = exactScaledInteger(
        evaluation.preregistration.poweredAlternativeEffect,
        1_000_000,
        'poweredAlternativeEffect'
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
            poweredAlternativeEffectMicros,
            requiredIndependentPromptCount: evaluation.preregistration.requiredIndependentPromptCount,
            targetPowerBasisPoints: evaluation.preregistration.targetPowerBasisPoints,
            assumedMaxPairedStdDevMicros: evaluation.preregistration.assumedMaxPairedStdDevMicros,
            varianceBasisFingerprint: evaluation.preregistration.varianceBasisFingerprint,
            variancePilotAttestationId: evaluation.preregistration.variancePilotAttestationId,
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
    VARIANCE_BASIS_METHOD,
    VARIANCE_BASIS_PROVENANCE,
    VARIANCE_BASIS_SCHEMA,
    STATISTICS_METHOD,
    buildBenchmarkTrustVarianceBasis,
    buildBenchmarkTrustPowerAnalysisFields,
    boundedHoeffdingConfidenceRadius,
    boundedHoeffdingFamilyMissUpperBound,
    isReceiptScaleRepresentable,
    chiSquareQuantile,
    computeBenchmarkTrustVarianceCandidateSetFingerprint,
    computeBenchmarkTrustCandidateInferenceContractFingerprint,
    computeBenchmarkTrustVariancePairFingerprints,
    computePairedStdDevUpperConfidenceBoundMicros,
    validatePreregistration,
    aggregatePromptMeans,
    evaluateBenchmarkTrustStatistics,
    buildBenchmarkTrustStatisticsReceiptFields
};
