'use strict';

const crypto = require('crypto');
const BenchmarkResult = require('../../../models/BenchmarkResult');
const { stableSerialize } = require('../../../../shared/artifactIdentity');
const { computeCandidateSetFingerprint } = require('../../../../shared/benchmarkTrustReceipt');
const { normalizeWorkerReceipt } = require('../../../../shared/workerContract');
const {
    buildBenchmarkTrustPowerAnalysisFields,
    evaluateBenchmarkTrustStatistics,
    buildBenchmarkTrustStatisticsReceiptFields
} = require('./benchmarkTrustStatistics');

const SOURCE_CONTEXT_SCHEMA = 'agentx.benchmark-trust-source-context/v1';
const RANKING_POLICY_SCHEMA = 'agentx.benchmark-trust-ranking-policy/v1';
const FRESHNESS_POLICY_SCHEMA = 'agentx.benchmark-trust-freshness-policy/v1';
const CANDIDATE_ID_PATTERN = /^candidate_[0-9a-f]{32}$/;
const PROMPT_ID_PATTERN = /^prompt_[0-9a-f]{32}$/;
const SOURCE_BATCH_ID_PATTERN = /^batch_[0-9a-f]{32}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;

const CONTEXT_KEYS = Object.freeze([
    'schema',
    'sourceBatchId',
    'claimScope',
    'product',
    'campaign',
    'inferenceProfile',
    'prompts',
    'candidates',
    'statistics',
    'judge',
    'scoreEvidence',
    'freshnessPolicy'
]);
const PRODUCT_KEYS = Object.freeze([
    'revision', 'coreImageDigest', 'benchmarkImageDigest', 'ragImageDigest'
]);
const CAMPAIGN_KEYS = Object.freeze(['campaignId', 'artifact']);
const INFERENCE_PROFILE_KEYS = Object.freeze(['artifact']);
const PROMPT_KEYS = Object.freeze(['promptId', 'fingerprint']);
const CANDIDATE_KEYS = Object.freeze(['candidateId', 'sourceIdentity']);
const SOURCE_IDENTITY_KEYS = Object.freeze([
    'model',
    'host',
    'modelDigest',
    'artifactDigest',
    'inferenceContractFingerprint',
    'executionTargetFingerprint',
    'workerIdentityFingerprint',
    'toolsFingerprint',
    'policiesFingerprint',
    'executionProfile',
    'envelopeSetFingerprint'
]);
const STATISTICS_KEYS = Object.freeze(['analysisPlan', 'analysisPlanFingerprint', 'rankingPolicy']);
const ANALYSIS_PLAN_KEYS = Object.freeze([
    'alpha',
    'mde',
    'equivalenceMargin',
    'repeatCount',
    'requiredIndependentPromptCount',
    'targetPowerBasisPoints',
    'assumedMaxPairedStdDevMicros',
    'powerAnalysisFingerprint',
    'candidateIds',
    'promptIds'
]);
const RANKING_POLICY_KEYS = Object.freeze(['schema', 'scoreField']);
const JUDGE_KEYS = Object.freeze([
    'qualificationReceiptId',
    'identityFingerprint',
    'rubricFingerprint',
    'corpusFingerprint',
    'holdoutFingerprint',
    'qualificationStatus',
    'validUntil'
]);
const SCORE_EVIDENCE_KEYS = Object.freeze([
    'judgeTargetFingerprint',
    'qualityCohortFingerprint',
    'scoringMethod',
    'scorerVersion',
    'workerIdentityFingerprint',
    'toolsFingerprint',
    'policiesFingerprint',
    'executionProfile',
    'envelopeFingerprint',
    'judgeBindingFingerprint'
]);
const FRESHNESS_POLICY_KEYS = Object.freeze([
    'schema', 'staleAfterSeconds', 'expiresAfterSeconds'
]);
const MINIMUM_STALE_AFTER_SECONDS = 60;
const MAXIMUM_STALE_AFTER_SECONDS = 30 * 24 * 60 * 60;
const MAXIMUM_EXPIRES_AFTER_SECONDS = 365 * 24 * 60 * 60;

function sourceError(code, message, statusCode = 409) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function requiredTimestampMillis(value) {
    return value == null ? Number.NaN : new Date(value).getTime();
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
    if (!isPlainObject(value)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', `${label} must be an object`);
    }
    const actual = Object.keys(value);
    const missing = expected.filter(key => !Object.prototype.hasOwnProperty.call(value, key));
    const extra = actual.filter(key => !expected.includes(key));
    if (missing.length > 0 || extra.length > 0) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
            `${label} must contain exactly ${expected.join(', ')}`
        );
    }
}

function assertCanonicalJson(value, label) {
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', `${label} must be finite`);
        }
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((entry, index) => assertCanonicalJson(entry, `${label}[${index}]`));
        return;
    }
    if (!isPlainObject(value)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', `${label} must be canonical JSON`);
    }
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) {
            throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', `${label}.${key} cannot be undefined`);
        }
        assertCanonicalJson(entry, `${label}.${key}`);
    }
}

function fingerprint(value) {
    assertCanonicalJson(value, 'fingerprinted value');
    return crypto.createHash('sha256').update(stableSerialize(value)).digest('hex');
}

function requireString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', `${label} must be a non-empty string`);
    }
    return value;
}

function requirePattern(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', `${label} is invalid`);
    }
    return value;
}

function requireCanonicalTimestamp(value, label) {
    if (typeof value !== 'string'
        || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
        || !Number.isFinite(Date.parse(value))
        || new Date(value).toISOString() !== value) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', `${label} must be a canonical UTC timestamp`);
    }
    return value;
}

function requireFinite(value, label) {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH', `${label} must be finite`);
    }
    return Object.is(value, -0) ? 0 : value;
}

function optionalFinite(value, label) {
    if (value == null) return null;
    return requireFinite(value, label);
}

function compareText(left, right) {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sameValue(left, right) {
    return stableSerialize(left) === stableSerialize(right);
}

function requireSame(label, actual, expected) {
    if (!sameValue(actual, expected)) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH',
            `${label} does not match canonical source evidence`
        );
    }
}

function normalizeProduct(product) {
    assertExactKeys(product, PRODUCT_KEYS, 'context.product');
    requirePattern(product.revision, GIT_REVISION_PATTERN, 'context.product.revision');
    for (const key of PRODUCT_KEYS.filter(key => key !== 'revision')) {
        requirePattern(product[key], IMAGE_DIGEST_PATTERN, `context.product.${key}`);
    }
    return { ...product };
}

function normalizeJudge(judge) {
    assertExactKeys(judge, JUDGE_KEYS, 'context.judge');
    for (const key of JUDGE_KEYS.slice(0, 5)) {
        requirePattern(judge[key], FINGERPRINT_PATTERN, `context.judge.${key}`);
    }
    if (!['qualified', 'unqualified', 'expired'].includes(judge.qualificationStatus)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'context.judge.qualificationStatus is invalid');
    }
    return {
        qualificationReceiptId: judge.qualificationReceiptId,
        identityFingerprint: judge.identityFingerprint,
        rubricFingerprint: judge.rubricFingerprint,
        corpusFingerprint: judge.corpusFingerprint,
        holdoutFingerprint: judge.holdoutFingerprint,
        qualificationStatus: judge.qualificationStatus,
        validUntil: requireCanonicalTimestamp(judge.validUntil, 'context.judge.validUntil')
    };
}

function normalizeScoreEvidence(scoreEvidence) {
    assertExactKeys(scoreEvidence, SCORE_EVIDENCE_KEYS, 'context.scoreEvidence');
    return {
        judgeTargetFingerprint: requirePattern(
            scoreEvidence.judgeTargetFingerprint,
            FINGERPRINT_PATTERN,
            'context.scoreEvidence.judgeTargetFingerprint'
        ),
        qualityCohortFingerprint: requirePattern(
            scoreEvidence.qualityCohortFingerprint,
            FINGERPRINT_PATTERN,
            'context.scoreEvidence.qualityCohortFingerprint'
        ),
        scoringMethod: requireString(scoreEvidence.scoringMethod, 'context.scoreEvidence.scoringMethod'),
        scorerVersion: requireString(scoreEvidence.scorerVersion, 'context.scoreEvidence.scorerVersion'),
        workerIdentityFingerprint: requirePattern(
            scoreEvidence.workerIdentityFingerprint,
            FINGERPRINT_PATTERN,
            'context.scoreEvidence.workerIdentityFingerprint'
        ),
        toolsFingerprint: requirePattern(
            scoreEvidence.toolsFingerprint,
            FINGERPRINT_PATTERN,
            'context.scoreEvidence.toolsFingerprint'
        ),
        policiesFingerprint: requirePattern(
            scoreEvidence.policiesFingerprint,
            FINGERPRINT_PATTERN,
            'context.scoreEvidence.policiesFingerprint'
        ),
        executionProfile: ['portable', 'native-ceiling'].includes(scoreEvidence.executionProfile)
            ? scoreEvidence.executionProfile
            : (() => {
                throw sourceError(
                    'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
                    'context.scoreEvidence.executionProfile is invalid'
                );
            })(),
        envelopeFingerprint: requirePattern(
            scoreEvidence.envelopeFingerprint,
            FINGERPRINT_PATTERN,
            'context.scoreEvidence.envelopeFingerprint'
        ),
        judgeBindingFingerprint: requirePattern(
            scoreEvidence.judgeBindingFingerprint,
            FINGERPRINT_PATTERN,
            'context.scoreEvidence.judgeBindingFingerprint'
        )
    };
}

function computeBenchmarkTrustJudgeBindingFingerprint({ judge, scoreEvidence }) {
    return fingerprint({
        schema: 'agentx.benchmark-trust-judge-binding/v1',
        judge,
        judgeTargetFingerprint: scoreEvidence.judgeTargetFingerprint,
        qualityCohortFingerprint: scoreEvidence.qualityCohortFingerprint,
        scoringMethod: scoreEvidence.scoringMethod,
        scorerVersion: scoreEvidence.scorerVersion,
        workerIdentityFingerprint: scoreEvidence.workerIdentityFingerprint,
        toolsFingerprint: scoreEvidence.toolsFingerprint,
        policiesFingerprint: scoreEvidence.policiesFingerprint,
        executionProfile: scoreEvidence.executionProfile,
        envelopeFingerprint: scoreEvidence.envelopeFingerprint
    });
}

function normalizeFreshnessPolicy(freshnessPolicy) {
    assertExactKeys(freshnessPolicy, FRESHNESS_POLICY_KEYS, 'context.freshnessPolicy');
    if (freshnessPolicy.schema !== FRESHNESS_POLICY_SCHEMA) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
            `context.freshnessPolicy.schema must be ${FRESHNESS_POLICY_SCHEMA}`
        );
    }
    const { staleAfterSeconds, expiresAfterSeconds } = freshnessPolicy;
    if (!Number.isSafeInteger(staleAfterSeconds)
        || staleAfterSeconds < MINIMUM_STALE_AFTER_SECONDS
        || staleAfterSeconds > MAXIMUM_STALE_AFTER_SECONDS
        || !Number.isSafeInteger(expiresAfterSeconds)
        || expiresAfterSeconds <= staleAfterSeconds
        || expiresAfterSeconds > MAXIMUM_EXPIRES_AFTER_SECONDS) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
            'context freshness TTLs are invalid or outside Product bounds'
        );
    }
    return { schema: FRESHNESS_POLICY_SCHEMA, staleAfterSeconds, expiresAfterSeconds };
}

function normalizeAnalysisPlan(plan) {
    assertExactKeys(plan, ANALYSIS_PLAN_KEYS, 'context.statistics.analysisPlan');
    const candidateIds = Array.isArray(plan.candidateIds) ? [...plan.candidateIds] : [];
    const promptIds = Array.isArray(plan.promptIds) ? [...plan.promptIds] : [];
    if (candidateIds.length < 2 || candidateIds.some(id => !CANDIDATE_ID_PATTERN.test(id))) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'analysisPlan requires portable candidateIds');
    }
    if (promptIds.length < 1 || promptIds.some(id => !PROMPT_ID_PATTERN.test(id))) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'analysisPlan requires portable promptIds');
    }
    if (new Set(candidateIds).size !== candidateIds.length
        || new Set(promptIds).size !== promptIds.length
        || candidateIds.join('\n') !== [...candidateIds].sort(compareText).join('\n')
        || promptIds.join('\n') !== [...promptIds].sort(compareText).join('\n')) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'analysisPlan ids must be unique and sorted');
    }
    if (typeof plan.alpha !== 'number' || !Number.isFinite(plan.alpha) || plan.alpha <= 0 || plan.alpha >= 1
        || typeof plan.mde !== 'number' || !Number.isFinite(plan.mde) || plan.mde < 0
        || typeof plan.equivalenceMargin !== 'number' || !Number.isFinite(plan.equivalenceMargin)
        || plan.equivalenceMargin < 0
        || !Number.isSafeInteger(plan.repeatCount) || plan.repeatCount < 1) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'analysisPlan numerical fields are invalid');
    }
    let expectedPowerFields;
    try {
        expectedPowerFields = buildBenchmarkTrustPowerAnalysisFields({
            alpha: plan.alpha,
            mde: plan.mde,
            candidateIds,
            targetPowerBasisPoints: plan.targetPowerBasisPoints,
            assumedMaxPairedStdDevMicros: plan.assumedMaxPairedStdDevMicros
        });
    } catch (_error) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'analysisPlan power analysis is invalid');
    }
    requireSame('analysisPlan power analysis', {
        requiredIndependentPromptCount: plan.requiredIndependentPromptCount,
        targetPowerBasisPoints: plan.targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros: plan.assumedMaxPairedStdDevMicros,
        powerAnalysisFingerprint: plan.powerAnalysisFingerprint
    }, expectedPowerFields);
    if (promptIds.length < expectedPowerFields.requiredIndependentPromptCount) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
            'analysisPlan prompt universe does not meet its preregistered power requirement'
        );
    }
    return {
        alpha: plan.alpha,
        mde: plan.mde,
        equivalenceMargin: plan.equivalenceMargin,
        repeatCount: plan.repeatCount,
        ...expectedPowerFields,
        candidateIds,
        promptIds
    };
}

function normalizeSourceContext(rawContext) {
    assertExactKeys(rawContext, CONTEXT_KEYS, 'context');
    if (rawContext.schema !== SOURCE_CONTEXT_SCHEMA) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', `context.schema must be ${SOURCE_CONTEXT_SCHEMA}`);
    }
    requirePattern(rawContext.sourceBatchId, SOURCE_BATCH_ID_PATTERN, 'context.sourceBatchId');
    if (!['capability', 'deployment_fit'].includes(rawContext.claimScope)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'context.claimScope is invalid');
    }

    assertExactKeys(rawContext.campaign, CAMPAIGN_KEYS, 'context.campaign');
    requirePattern(rawContext.campaign.campaignId, /^campaign_[0-9a-f]{32}$/, 'context.campaign.campaignId');
    assertCanonicalJson(rawContext.campaign.artifact, 'context.campaign.artifact');
    assertExactKeys(rawContext.inferenceProfile, INFERENCE_PROFILE_KEYS, 'context.inferenceProfile');
    assertCanonicalJson(rawContext.inferenceProfile.artifact, 'context.inferenceProfile.artifact');

    if (!Array.isArray(rawContext.prompts) || rawContext.prompts.length < 1) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'context.prompts must not be empty');
    }
    const prompts = rawContext.prompts.map((prompt, index) => {
        assertExactKeys(prompt, PROMPT_KEYS, `context.prompts[${index}]`);
        return {
            promptId: requirePattern(prompt.promptId, PROMPT_ID_PATTERN, `context.prompts[${index}].promptId`),
            fingerprint: requirePattern(prompt.fingerprint, FINGERPRINT_PATTERN, `context.prompts[${index}].fingerprint`)
        };
    }).sort((left, right) => compareText(left.promptId, right.promptId));
    if (new Set(prompts.map(prompt => prompt.promptId)).size !== prompts.length) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'context prompt ids must be unique');
    }

    if (!Array.isArray(rawContext.candidates) || rawContext.candidates.length < 2) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'context.candidates requires at least two candidates');
    }
    const candidates = rawContext.candidates.map((candidate, index) => {
        assertExactKeys(candidate, CANDIDATE_KEYS, `context.candidates[${index}]`);
        assertExactKeys(candidate.sourceIdentity, SOURCE_IDENTITY_KEYS, `context.candidates[${index}].sourceIdentity`);
        const sourceIdentity = {
            model: requireString(candidate.sourceIdentity.model, `context.candidates[${index}].sourceIdentity.model`),
            host: requireString(candidate.sourceIdentity.host, `context.candidates[${index}].sourceIdentity.host`),
            modelDigest: requireString(candidate.sourceIdentity.modelDigest, `context.candidates[${index}].sourceIdentity.modelDigest`),
            artifactDigest: requireString(candidate.sourceIdentity.artifactDigest, `context.candidates[${index}].sourceIdentity.artifactDigest`),
            inferenceContractFingerprint: requirePattern(
                candidate.sourceIdentity.inferenceContractFingerprint,
                FINGERPRINT_PATTERN,
                `context.candidates[${index}].sourceIdentity.inferenceContractFingerprint`
            ),
            executionTargetFingerprint: requirePattern(
                candidate.sourceIdentity.executionTargetFingerprint,
                FINGERPRINT_PATTERN,
                `context.candidates[${index}].sourceIdentity.executionTargetFingerprint`
            ),
            workerIdentityFingerprint: requirePattern(
                candidate.sourceIdentity.workerIdentityFingerprint,
                FINGERPRINT_PATTERN,
                `context.candidates[${index}].sourceIdentity.workerIdentityFingerprint`
            ),
            toolsFingerprint: requirePattern(
                candidate.sourceIdentity.toolsFingerprint,
                FINGERPRINT_PATTERN,
                `context.candidates[${index}].sourceIdentity.toolsFingerprint`
            ),
            policiesFingerprint: requirePattern(
                candidate.sourceIdentity.policiesFingerprint,
                FINGERPRINT_PATTERN,
                `context.candidates[${index}].sourceIdentity.policiesFingerprint`
            ),
            executionProfile: ['portable', 'native-ceiling'].includes(candidate.sourceIdentity.executionProfile)
                ? candidate.sourceIdentity.executionProfile
                : (() => {
                    throw sourceError(
                        'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
                        `context.candidates[${index}].sourceIdentity.executionProfile is invalid`
                    );
                })(),
            envelopeSetFingerprint: requirePattern(
                candidate.sourceIdentity.envelopeSetFingerprint,
                FINGERPRINT_PATTERN,
                `context.candidates[${index}].sourceIdentity.envelopeSetFingerprint`
            )
        };
        return {
            candidateId: requirePattern(candidate.candidateId, CANDIDATE_ID_PATTERN, `context.candidates[${index}].candidateId`),
            sourceIdentity
        };
    }).sort((left, right) => compareText(left.candidateId, right.candidateId));
    if (new Set(candidates.map(candidate => candidate.candidateId)).size !== candidates.length) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID', 'context candidate ids must be unique');
    }

    assertExactKeys(rawContext.statistics, STATISTICS_KEYS, 'context.statistics');
    const analysisPlan = normalizeAnalysisPlan(rawContext.statistics.analysisPlan);
    const analysisPlanFingerprint = fingerprint({
        schema: 'agentx.benchmark-trust-analysis-plan/v1',
        plan: analysisPlan
    });
    requirePattern(
        rawContext.statistics.analysisPlanFingerprint,
        FINGERPRINT_PATTERN,
        'context.statistics.analysisPlanFingerprint'
    );
    if (rawContext.statistics.analysisPlanFingerprint !== analysisPlanFingerprint) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
            'context.statistics.analysisPlanFingerprint does not match the frozen plan'
        );
    }
    assertExactKeys(rawContext.statistics.rankingPolicy, RANKING_POLICY_KEYS, 'context.statistics.rankingPolicy');
    if (rawContext.statistics.rankingPolicy.schema !== RANKING_POLICY_SCHEMA
        || rawContext.statistics.rankingPolicy.scoreField !== 'quality_score') {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
            `v1 ranking policy must be ${RANKING_POLICY_SCHEMA} over quality_score`
        );
    }
    const candidateIds = candidates.map(candidate => candidate.candidateId);
    const promptIds = prompts.map(prompt => prompt.promptId);
    requireSame('analysisPlan.candidateIds', analysisPlan.candidateIds, candidateIds);
    requireSame('analysisPlan.promptIds', analysisPlan.promptIds, promptIds);
    const judge = normalizeJudge(rawContext.judge);
    const scoreEvidence = normalizeScoreEvidence(rawContext.scoreEvidence);
    const judgeBindingFingerprint = computeBenchmarkTrustJudgeBindingFingerprint({ judge, scoreEvidence });
    if (scoreEvidence.judgeBindingFingerprint !== judgeBindingFingerprint) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
            'context.scoreEvidence.judgeBindingFingerprint does not bind the frozen judge and score policy'
        );
    }
    if (scoreEvidence.workerIdentityFingerprint !== judge.identityFingerprint
        || scoreEvidence.policiesFingerprint !== judge.rubricFingerprint) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
            'worker judge identity and policy must match the frozen receipt judge identity and rubric'
        );
    }

    return {
        schema: SOURCE_CONTEXT_SCHEMA,
        sourceBatchId: rawContext.sourceBatchId,
        claimScope: rawContext.claimScope,
        product: normalizeProduct(rawContext.product),
        campaign: {
            campaignId: rawContext.campaign.campaignId,
            artifact: rawContext.campaign.artifact
        },
        inferenceProfile: { artifact: rawContext.inferenceProfile.artifact },
        prompts,
        candidates,
        judge,
        scoreEvidence,
        freshnessPolicy: normalizeFreshnessPolicy(rawContext.freshnessPolicy),
        statistics: {
            analysisPlan,
            analysisPlanFingerprint,
            rankingPolicy: {
                schema: RANKING_POLICY_SCHEMA,
                scoreField: 'quality_score'
            }
        }
    };
}

function promptProjection(row) {
    return {
        prompt: requireString(row.prompt, 'result.prompt'),
        promptName: requireString(row.prompt_name, 'result.prompt_name'),
        level: row.prompt_level ?? null,
        category: row.prompt_category ?? null,
        expectedAnswer: row.expected_answer ?? null,
        scoringType: row.scoring_type ?? null,
        scoringPlan: row.scoring_plan ?? null,
        deterministicScoring: row.deterministic_scoring ?? null,
        scoringDimensions: row.scoring_dimensions ?? null,
        referenceAnswer: row.reference_answer ?? null,
        outputContract: row.output_contract ?? null,
        judgeCriteria: row.judge_criteria ?? null
    };
}

function computePromptSourceFingerprint(row) {
    return fingerprint({
        schema: 'agentx.benchmark-trust-prompt-source/v1',
        prompt: promptProjection(row)
    });
}

function candidateReceiptIdentity(candidate) {
    const identity = candidate.sourceIdentity;
    return {
        candidateId: candidate.candidateId,
        artifactFingerprint: fingerprint({
            schema: 'agentx.benchmark-trust-artifact-source/v1',
            modelDigest: identity.modelDigest,
            artifactDigest: identity.artifactDigest
        }),
        runtimeFingerprint: fingerprint({
            schema: 'agentx.benchmark-trust-runtime-source/v1',
            inferenceContractFingerprint: identity.inferenceContractFingerprint
        }),
        environmentFingerprint: fingerprint({
            schema: 'agentx.benchmark-trust-environment-source/v1',
            host: identity.host,
            executionTargetFingerprint: identity.executionTargetFingerprint
        })
    };
}

function computeBenchmarkTrustJudgeResultFingerprint({
    candidateId,
    promptId,
    repeatIndex,
    response,
    qualityScore,
    rubricFingerprint,
    judgeIdentityFingerprint
}) {
    return fingerprint({
        schema: 'agentx.benchmark-trust-judge-result/v1',
        candidateId,
        promptId,
        repeatIndex,
        responseFingerprint: fingerprint(String(response ?? '')),
        qualityScore: requireFinite(qualityScore, 'judge result qualityScore'),
        rubricFingerprint,
        judgeIdentityFingerprint
    });
}

function computeBenchmarkTrustExecutionResultFingerprint({
    candidateId,
    promptId,
    repeatIndex,
    response,
    success
}) {
    return fingerprint({
        schema: 'agentx.benchmark-trust-execution-result/v1',
        candidateId,
        promptId,
        repeatIndex,
        responseFingerprint: fingerprint(String(response ?? '')),
        success: success === true
    });
}

function computeBenchmarkTrustExecutionEnvelopeSetFingerprint({ candidateId, entries }) {
    const normalizedEntries = (Array.isArray(entries) ? entries : []).map(entry => ({
        promptId: requirePattern(entry.promptId, PROMPT_ID_PATTERN, 'execution envelope promptId'),
        repeatIndex: Number.isSafeInteger(entry.repeatIndex) && entry.repeatIndex >= 0
            ? entry.repeatIndex
            : (() => {
                throw sourceError(
                    'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID',
                    'execution envelope repeatIndex is invalid'
                );
            })(),
        envelopeFingerprint: requirePattern(
            entry.envelopeFingerprint,
            FINGERPRINT_PATTERN,
            'execution envelope fingerprint'
        )
    })).sort((left, right) => compareText(stableSerialize(left), stableSerialize(right)));
    return fingerprint({
        schema: 'agentx.benchmark-trust-execution-envelope-set/v1',
        candidateId: requirePattern(candidateId, CANDIDATE_ID_PATTERN, 'execution envelope candidateId'),
        entries: normalizedEntries
    });
}

function normalizeBoundWorkerReceipt(rawReceipt, label) {
    if (!isPlainObject(rawReceipt)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH', `${label} is required`);
    }
    try {
        if (typeof rawReceipt.fingerprint !== 'string'
            || !FINGERPRINT_PATTERN.test(rawReceipt.fingerprint)) {
            throw new Error('missing or malformed receipt fingerprint');
        }
        return normalizeWorkerReceipt(rawReceipt);
    } catch (_error) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH',
            `${label} is not a valid WorkerReceipt v1`
        );
    }
}

function assertRowIdentity(row, candidate, prompt, scoreEvidence, judge, score) {
    const identity = candidate.sourceIdentity;
    const actualIdentity = {
        model: row.model,
        host: row.host,
        modelDigest: row.model_digest,
        artifactDigest: row.execution_settings?.artifact_digest,
        inferenceContractFingerprint: row.execution_settings?.inference_contract_fingerprint,
        executionTargetFingerprint: row.execution_target?.fingerprint
    };
    requireSame(`candidate ${candidate.candidateId} source identity`, actualIdentity, {
        model: identity.model,
        host: identity.host,
        modelDigest: identity.modelDigest,
        artifactDigest: identity.artifactDigest,
        inferenceContractFingerprint: identity.inferenceContractFingerprint,
        executionTargetFingerprint: identity.executionTargetFingerprint
    });
    const promptFingerprint = computePromptSourceFingerprint(row);
    if (promptFingerprint !== prompt.fingerprint) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH',
            `prompt ${prompt.promptId} snapshot fingerprint does not match frozen context`
        );
    }
    const executionWorkerReceipt = normalizeBoundWorkerReceipt(
        row.execution_receipt,
        'result execution receipt'
    );
    const executionSucceeded = executionWorkerReceipt.finalState === 'succeeded'
        && executionWorkerReceipt.result.contractSatisfied === true;
    if (executionSucceeded !== (row.success === true)) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH',
            'result execution receipt final state does not match source success'
        );
    }
    requireSame('result execution worker identity', fingerprint(executionWorkerReceipt.identity), identity.workerIdentityFingerprint);
    requireSame('result execution worker/source identity agreement', {
        model: executionWorkerReceipt.identity.model.name,
        modelDigest: executionWorkerReceipt.identity.model.digest,
        runtimeFingerprint: executionWorkerReceipt.identity.model.runtimeFingerprint,
        environmentFingerprint: executionWorkerReceipt.identity.environment.fingerprint
    }, {
        model: identity.model,
        modelDigest: identity.modelDigest,
        runtimeFingerprint: identity.inferenceContractFingerprint,
        environmentFingerprint: identity.executionTargetFingerprint
    });
    requireSame('result execution tools fingerprint', executionWorkerReceipt.fingerprints.tools, identity.toolsFingerprint);
    requireSame('result execution policies fingerprint', executionWorkerReceipt.fingerprints.policies, identity.policiesFingerprint);
    requireSame('result execution profile', executionWorkerReceipt.executionProfile, identity.executionProfile);
    requireSame('result execution prompt fingerprint', executionWorkerReceipt.fingerprints.prompt, prompt.fingerprint);
    requireSame(
        'result execution result fingerprint',
        executionWorkerReceipt.result.fingerprint,
        computeBenchmarkTrustExecutionResultFingerprint({
            candidateId: candidate.candidateId,
            promptId: prompt.promptId,
            repeatIndex: row.repeat_index,
            response: row.response,
            success: row.success
        })
    );

    const workerReceipt = normalizeBoundWorkerReceipt(row.judge_receipt, 'result judge receipt');
    if (workerReceipt.finalState !== 'succeeded' || workerReceipt.result.contractSatisfied !== true) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH',
            'result judge receipt must prove a contract-satisfied success'
        );
    }
    requireSame('result score evidence', {
        judgeTargetFingerprint: row.judge_target?.fingerprint ?? null,
        qualityCohortFingerprint: row.quality_cohort_fingerprint ?? null,
        scoringMethod: row.scoring_method ?? null,
        scorerVersion: row.scorer_version ?? null,
        workerIdentityFingerprint: fingerprint(workerReceipt.identity),
        toolsFingerprint: workerReceipt.fingerprints.tools,
        policiesFingerprint: workerReceipt.fingerprints.policies,
        executionProfile: workerReceipt.executionProfile,
        envelopeFingerprint: workerReceipt.fingerprints.envelope,
        judgeBindingFingerprint: scoreEvidence.judgeBindingFingerprint
    }, scoreEvidence);
    requireSame('judge receipt prompt fingerprint', workerReceipt.fingerprints.prompt, prompt.fingerprint);
    const expectedJudgeResultFingerprint = computeBenchmarkTrustJudgeResultFingerprint({
        candidateId: candidate.candidateId,
        promptId: prompt.promptId,
        repeatIndex: row.repeat_index,
        response: row.response,
        qualityScore: score,
        rubricFingerprint: judge.rubricFingerprint,
        judgeIdentityFingerprint: judge.identityFingerprint
    });
    requireSame(
        'judge receipt result fingerprint',
        workerReceipt.result.fingerprint,
        expectedJudgeResultFingerprint
    );
    return {
        executionEnvelopeFingerprint: executionWorkerReceipt.fingerprints.envelope
    };
}

function resultProjection(row, candidateId, promptId, score) {
    const sourceCreatedAtMs = requiredTimestampMillis(row.timestamp);
    const sourceUpdatedAtMs = requiredTimestampMillis(row.updated_at);
    if (!Number.isFinite(sourceCreatedAtMs)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH', 'result durable creation time is required');
    }
    if (!Number.isFinite(sourceUpdatedAtMs) || sourceUpdatedAtMs < sourceCreatedAtMs) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH', 'result durable update time is invalid');
    }
    const sourceCreatedAt = new Date(sourceCreatedAtMs).toISOString();
    const sourceUpdatedAt = new Date(sourceUpdatedAtMs).toISOString();
    return {
        candidateId,
        promptId,
        repeatIndex: row.repeat_index,
        repeatTotal: row.repeat_total,
        success: row.success === true,
        score,
        excluded: row.excluded_from_leaderboard === true,
        sourceCreatedAt,
        sourceUpdatedAt,
        scoringMethod: row.scoring_method ?? null,
        scorerVersion: row.scorer_version ?? null,
        modelDigest: row.model_digest,
        artifactDigest: row.execution_settings?.artifact_digest,
        runtimeFingerprint: row.execution_settings?.inference_contract_fingerprint,
        executionTargetFingerprint: row.execution_target?.fingerprint,
        executionReceiptFingerprint: row.execution_receipt?.fingerprint ?? null,
        judgeTargetFingerprint: row.judge_target?.fingerprint ?? null,
        judgeReceiptFingerprint: row.judge_receipt?.fingerprint ?? null,
        qualityCohortFingerprint: row.quality_cohort_fingerprint ?? null,
        promptSourceFingerprint: computePromptSourceFingerprint(row),
        responseFingerprint: fingerprint(String(row.response ?? '')),
        compositeScore: optionalFinite(row.composite_score, 'result.composite_score'),
        subjectiveScore: optionalFinite(row.subjective_score, 'result.subjective_score'),
        deterministicScore: optionalFinite(row.deterministic_score, 'result.deterministic_score')
    };
}

function buildBenchmarkTrustSourceProjection({ context: rawContext, results, sourceBatchId }) {
    const context = normalizeSourceContext(rawContext);
    if (context.sourceBatchId !== sourceBatchId) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH', 'source context is linked to a different batch');
    }
    if (!Array.isArray(results)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH', 'source results must be an array');
    }

    const plan = context.statistics.analysisPlan;
    const candidateById = new Map(context.candidates.map(candidate => [candidate.candidateId, candidate]));
    const promptById = new Map(context.prompts.map(prompt => [prompt.promptId, prompt]));
    const expectedResultCount = context.candidates.length * context.prompts.length * plan.repeatCount;
    if (results.length !== expectedResultCount) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_RESULTS_MISMATCH', 'source result count does not match frozen context');
    }

    const cells = new Map();
    const candidateRows = new Map(context.candidates.map(candidate => [candidate.candidateId, []]));
    const statisticalRows = [];
    let excludedResultCount = 0;

    for (const [index, row] of results.entries()) {
        const candidateId = row?.trust_candidate_id;
        const promptId = row?.trust_prompt_id;
        const candidate = candidateById.get(candidateId);
        const prompt = promptById.get(promptId);
        if (!candidate || !prompt) {
            throw sourceError(
                'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH',
                `result ${index} lacks a preregistered candidate/prompt identity`
            );
        }
        if (!Number.isSafeInteger(row.repeat_index) || row.repeat_index < 0
            || row.repeat_total !== plan.repeatCount) {
            throw sourceError(
                'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH',
                `result ${index} repeat identity does not match preregistration`
            );
        }
        const excluded = row.excluded_from_leaderboard === true;
        const score = requireFinite(row.quality_score, `result ${index} quality_score`);
        const rowIdentity = assertRowIdentity(
            row,
            candidate,
            prompt,
            context.scoreEvidence,
            context.judge,
            score
        );
        if (!excluded && row.success !== true) {
            throw sourceError(
                'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH',
                `result ${index} cannot be observed when execution was not successful`
            );
        }

        const cellKey = `${candidateId}\u0000${promptId}`;
        if (!cells.has(cellKey)) cells.set(cellKey, []);
        cells.get(cellKey).push(row.repeat_index);
        const projection = resultProjection(row, candidateId, promptId, score);
        const resultFingerprint = fingerprint({
            schema: 'agentx.benchmark-trust-source-result/v1',
            result: projection
        });
        candidateRows.get(candidateId).push({
            projection,
            resultFingerprint,
            envelopeEntry: {
                promptId,
                repeatIndex: row.repeat_index,
                envelopeFingerprint: rowIdentity.executionEnvelopeFingerprint
            }
        });
        if (excluded) {
            excludedResultCount += 1;
        } else {
            statisticalRows.push({
                candidateId,
                promptId,
                repeatIndex: row.repeat_index,
                score
            });
        }
    }

    const canonicalCells = [];
    for (const candidateId of plan.candidateIds) {
        for (const promptId of plan.promptIds) {
            const repeatIndexes = [...(cells.get(`${candidateId}\u0000${promptId}`) || [])].sort((a, b) => a - b);
            const expectedIndexes = Array.from({ length: plan.repeatCount }, (_, repeatIndex) => repeatIndex);
            requireSame(`cell ${candidateId}/${promptId} repeat indexes`, repeatIndexes, expectedIndexes);
            canonicalCells.push({ candidateId, promptId, repeatIndexes });
        }
    }

    const receiptCandidates = context.candidates.map((candidate) => {
        const identity = candidateReceiptIdentity(candidate);
        const rows = candidateRows.get(candidate.candidateId);
        const resultFingerprints = rows
            .map(row => row.resultFingerprint)
            .sort(compareText);
        requireSame(
            `candidate ${candidate.candidateId} execution envelope set`,
            computeBenchmarkTrustExecutionEnvelopeSetFingerprint({
                candidateId: candidate.candidateId,
                entries: rows.map(row => row.envelopeEntry)
            }),
            candidate.sourceIdentity.envelopeSetFingerprint
        );
        return {
            ...identity,
            resultSetFingerprint: fingerprint({
                schema: 'agentx.benchmark-trust-candidate-result-set/v1',
                candidateId: candidate.candidateId,
                resultFingerprints
            })
        };
    });

    const excludedResultFingerprints = [...candidateRows.values()]
        .flat()
        .filter(row => row.projection.excluded)
        .map(row => row.resultFingerprint)
        .sort(compareText);
    const evaluation = evaluateBenchmarkTrustStatistics({
        rows: statisticalRows,
        preregistration: plan
    });
    const analysisPlanFingerprint = context.statistics.analysisPlanFingerprint;
    const rankingPolicyFingerprint = fingerprint(context.statistics.rankingPolicy);
    const statistics = buildBenchmarkTrustStatisticsReceiptFields({
        rows: statisticalRows,
        preregistration: plan
    }, {
        analysisPlanFingerprint,
        rankingPolicyFingerprint
    });

    return {
        context,
        judge: context.judge,
        execution: {
            campaignId: context.campaign.campaignId,
            sourceBatchId,
            campaignFingerprint: fingerprint({
                schema: 'agentx.benchmark-trust-campaign-source/v1',
                campaignId: context.campaign.campaignId,
                artifact: context.campaign.artifact
            }),
            inferenceProfileFingerprint: fingerprint({
                schema: 'agentx.benchmark-trust-inference-profile-source/v1',
                artifact: context.inferenceProfile.artifact
            }),
            promptCatalogFingerprint: fingerprint({
                schema: 'agentx.benchmark-trust-prompt-catalog/v1',
                prompts: context.prompts
            }),
            candidateSetFingerprint: computeCandidateSetFingerprint(receiptCandidates),
            cellInventory: {
                fingerprint: fingerprint({
                    schema: 'agentx.benchmark-trust-cell-inventory/v1',
                    cells: canonicalCells
                }),
                cellCount: canonicalCells.length,
                minimumRepeatCount: plan.repeatCount,
                maximumRepeatCount: plan.repeatCount
            },
            promptCount: context.prompts.length,
            expectedResultCount,
            observedResultCount: expectedResultCount - excludedResultCount,
            excludedResultCount,
            exclusionManifestFingerprint: excludedResultCount === 0
                ? null
                : fingerprint({
                    schema: 'agentx.benchmark-trust-exclusion-manifest/v1',
                    excludedResultFingerprints
                }),
            candidates: receiptCandidates
        },
        statistics,
        evidenceStatus: excludedResultCount === 0 ? 'complete' : 'incomplete',
        decisionOutcome: evaluation.decision.outcome,
        resultCount: results.length
    };
}

function buildBenchmarkTrustFreshnessProjection({
    freshnessPolicy: rawPolicy,
    completedAt,
    judgeValidUntil = null,
    now = new Date()
}) {
    const freshnessPolicy = normalizeFreshnessPolicy(rawPolicy);
    const completedAtMs = requiredTimestampMillis(completedAt);
    const verificationTimeMs = requiredTimestampMillis(now);
    if (!Number.isFinite(completedAtMs) || !Number.isFinite(verificationTimeMs)) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_FRESHNESS_UNPROVEN',
            'durable completion and verification timestamps are required'
        );
    }
    const staleAtMs = completedAtMs + freshnessPolicy.staleAfterSeconds * 1000;
    const expiresAtMs = completedAtMs + freshnessPolicy.expiresAfterSeconds * 1000;
    const judgeValidUntilMs = judgeValidUntil == null ? null : new Date(judgeValidUntil).getTime();
    if (judgeValidUntil != null && !Number.isFinite(judgeValidUntilMs)) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_FRESHNESS_UNPROVEN', 'judge validity timestamp is invalid');
    }
    const qualificationCutoffMs = judgeValidUntilMs == null
        ? staleAtMs
        : Math.min(staleAtMs, judgeValidUntilMs);
    return {
        createdAt: new Date(completedAtMs).toISOString(),
        validUntil: new Date(qualificationCutoffMs).toISOString(),
        freshnessStatus: verificationTimeMs > expiresAtMs
            ? 'expired'
            : verificationTimeMs > qualificationCutoffMs
                ? 'stale'
                : 'fresh'
    };
}

async function verifyBenchmarkTrustSourceEvidence({ receipt, batch, now = new Date() }) {
    if (!receipt || !batch?._id) {
        throw sourceError('BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH', 'receipt and durable source batch are required');
    }
    if (!batch.trust_evidence_context) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_MISSING',
            'source batch has no frozen trust evidence context'
        );
    }
    const contextCommittedAt = requiredTimestampMillis(batch.trust_evidence_committed_at);
    const startTimes = [batch.started_at, batch.execution_started_at]
        .map(requiredTimestampMillis);
    if (!Number.isFinite(contextCommittedAt) || startTimes.some(value => !Number.isFinite(value))) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_ANTERIORITY_UNPROVEN',
            'source context requires a canonical commit time and durable batch start time'
        );
    }
    if (startTimes.some(startedAt => contextCommittedAt > startedAt)) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_CONTEXT_COMMITTED_AFTER_START',
            'source context was committed after batch execution began'
        );
    }
    const completedAt = requiredTimestampMillis(batch.completed_at);
    const finalizedAt = requiredTimestampMillis(batch.trust_evidence_finalized_at);
    const batchUpdatedAt = requiredTimestampMillis(batch.updated_at);
    const verificationTime = requiredTimestampMillis(now);
    if (!Number.isFinite(completedAt)
        || !Number.isFinite(finalizedAt)
        || !Number.isFinite(batchUpdatedAt)
        || !Number.isFinite(verificationTime)
        || completedAt < contextCommittedAt
        || completedAt > verificationTime
        || finalizedAt !== completedAt
        || batchUpdatedAt !== completedAt
        || startTimes.some(startedAt => completedAt < startedAt)) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_COMPLETION_INVALID',
            'source batch requires one untouched server finalization timestamp after context commit and execution start'
        );
    }
    const results = await BenchmarkResult.find({
        batch_id: batch._id,
        trust_evidence_sealed: true
    }).lean();
    if (results.some(row => {
        const createdAt = requiredTimestampMillis(row.timestamp);
        const updatedAt = requiredTimestampMillis(row.updated_at);
        const earliestStart = Math.max(contextCommittedAt, ...startTimes);
        return !Number.isFinite(createdAt)
            || !Number.isFinite(updatedAt)
            || createdAt < earliestStart
            || updatedAt < createdAt
            || updatedAt > completedAt
            || createdAt > completedAt;
    })) {
        throw sourceError(
            'BENCHMARK_TRUST_SOURCE_RESULT_AFTER_COMPLETION',
            'every source result must be server-created during execution and untouched after finalization'
        );
    }
    const projection = buildBenchmarkTrustSourceProjection({
        context: batch.trust_evidence_context,
        results,
        sourceBatchId: batch.trust_batch_id
    });

    requireSame('receipt.claimScope', receipt.claimScope, projection.context.claimScope);
    requireSame('receipt.product', receipt.product, projection.context.product);
    requireSame('receipt.judge', receipt.judge, projection.judge);
    requireSame('receipt.execution', receipt.execution, projection.execution);
    requireSame('receipt.statistics', receipt.statistics, projection.statistics);
    requireSame('receipt.axes.evidenceStatus', receipt.axes?.evidenceStatus, projection.evidenceStatus);
    requireSame('receipt.axes.decisionOutcome', receipt.axes?.decisionOutcome, projection.decisionOutcome);
    const freshness = buildBenchmarkTrustFreshnessProjection({
        freshnessPolicy: projection.context.freshnessPolicy,
        completedAt: batch.completed_at,
        judgeValidUntil: projection.context.judge.validUntil,
        now
    });
    requireSame('receipt.createdAt', receipt.createdAt, freshness.createdAt);
    requireSame('receipt.validUntil', receipt.validUntil, freshness.validUntil);
    requireSame('receipt.axes.freshnessStatus', receipt.axes?.freshnessStatus, freshness.freshnessStatus);

    return {
        resultCount: projection.resultCount,
        execution: projection.execution,
        statistics: projection.statistics,
        evidenceStatus: projection.evidenceStatus,
        decisionOutcome: projection.decisionOutcome,
        freshness
    };
}

module.exports = {
    SOURCE_CONTEXT_SCHEMA,
    RANKING_POLICY_SCHEMA,
    FRESHNESS_POLICY_SCHEMA,
    computeBenchmarkTrustJudgeBindingFingerprint,
    computeBenchmarkTrustJudgeResultFingerprint,
    computeBenchmarkTrustExecutionResultFingerprint,
    computeBenchmarkTrustExecutionEnvelopeSetFingerprint,
    buildBenchmarkTrustFreshnessProjection,
    buildBenchmarkTrustSourceProjection,
    computePromptSourceFingerprint,
    normalizeSourceContext,
    verifyBenchmarkTrustSourceEvidence
};
