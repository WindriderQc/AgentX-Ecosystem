'use strict';

const crypto = require('crypto');
const fsSync = require('fs');
const fs = require('fs/promises');
const path = require('path');
const {
    fingerprint,
    normalizeWorkerEnvelope
} = require('../../../../shared/workerContract');
const {
    executionHost,
    normalizeBenchmarkTarget
} = require('../../../../shared/benchmarkTargetContract');
const {
    buildBenchmarkTrustPowerAnalysisFields,
    buildBenchmarkTrustVarianceBasis,
    computeBenchmarkTrustCandidateInferenceContractFingerprint,
    computeBenchmarkTrustVarianceCandidateSetFingerprint,
    computeBenchmarkTrustVariancePairFingerprints,
    isReceiptScaleRepresentable
} = require('./benchmarkTrustStatistics');
const {
    SOURCE_CONTEXT_SCHEMA,
    ANALYSIS_PLAN_SCHEMA,
    RANKING_POLICY_SCHEMA,
    FRESHNESS_POLICY_SCHEMA,
    computeBenchmarkTrustExecutionEnvelopeSetFingerprint,
    computeBenchmarkTrustJudgeBindingFingerprint,
    computePromptSourceFingerprint,
    normalizeSourceContext
} = require('./benchmarkTrustSourceEvidence');
const {
    buildHarnessEnvelope,
    normalizeHarnessInvocationParameters
} = require('./harnessBrokerClient');
const {
    buildBenchmarkTrustPromptSamplingPolicy,
    buildPromptHints,
    normalizeExecutionConfig
} = require('./config');
const {
    DEFAULT_SCORING_CATEGORY,
    ENHANCED_SCORING_CONFIGS,
    getScoringDimensions,
    normalizeScoringCategory
} = require('../scoring/scoringConfigs');
const { SCORER_VERSION, SCORER_COMPONENTS } = require('../scoring/scorerVersion');
const {
    buildDynamicJudgePrompt,
    parseJudgeJsonResponse
} = require('../scoring/judgeCall');
const {
    computeMonolithicJudgeScore,
    scoreResponse
} = require('../qualityScorer');
const { scoreFormatCompliance } = require('../scoring/formatComplianceScorer');
const { stripMarkdownCodeFences } = require('../scoring/jsonUtils');
const judgeConfidence = require('../judgeConfidence');
const { buildPromptData } = require('./judgeExecutor');
const {
    verifyJudgeQualificationAuthority,
    verifyVariancePilotAuthority
} = require('./benchmarkJudgeQualificationAuthority');

const CAMPAIGN_SPEC_SCHEMA = 'agentx.benchmark-trust-campaign-spec/v2';
const CAMPAIGN_SPEC_SCHEMA_VERSION = 2;
const JUDGE_RUNTIME_RUBRIC_SCHEMA = 'agentx.benchmark-trust-judge-runtime-rubric/v1';
const CAMPAIGN_SPEC_ID_PATTERN = /^[0-9a-f]{64}$/;
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const GIT_REVISION_PATTERN = /^[0-9a-f]{40}$/;
const MAX_CAMPAIGN_SPEC_BYTES = 1024 * 1024;
const MAX_CAMPAIGN_TARGETS = 16;
const MAX_CAMPAIGN_PROMPTS = 500;
const MAX_CAMPAIGN_CELLS = 10_000;
const MAX_CAMPAIGN_JSON_DEPTH = 32;
const MAX_CAMPAIGN_JSON_NODES = 100_000;
const PRODUCT_ENV = Object.freeze({
    revision: 'AGENTX_PRODUCT_REVISION',
    coreImageDigest: 'AGENTX_CORE_IMAGE_DIGEST',
    benchmarkImageDigest: 'AGENTX_BENCHMARK_IMAGE_DIGEST',
    ragImageDigest: 'AGENTX_RAG_IMAGE_DIGEST'
});
const RUBRIC_SOURCE_FILES = Object.freeze([
    ['benchmarkTrustCampaignRuntime', __filename],
    ['categories', path.resolve(__dirname, '../../../config/categories.js')],
    ['formatComplianceScorer', path.resolve(__dirname, '../scoring/formatComplianceScorer.js')],
    ['judgeCall', path.resolve(__dirname, '../scoring/judgeCall.js')],
    ['judgeConfidence', path.resolve(__dirname, '../judgeConfidence.js')],
    ['judgeExecutor', path.resolve(__dirname, './judgeExecutor.js')],
    ['jsonUtils', path.resolve(__dirname, '../scoring/jsonUtils.js')],
    ['qualityScorer', path.resolve(__dirname, '../qualityScorer.js')],
    ['scoringConfigs', path.resolve(__dirname, '../scoring/scoringConfigs.js')]
]);

function runtimeError(code, message, statusCode = 409) {
    const error = new Error(message);
    error.code = code;
    error.statusCode = statusCode;
    return error;
}

function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function assertExactKeys(value, expected, label) {
    if (!isPlainObject(value)) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', `${label} must be an object`, 422);
    }
    const actual = Object.keys(value);
    if (actual.some(key => !expected.includes(key)) || expected.some(key => !actual.includes(key))) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            `${label} must contain exactly ${expected.join(', ')}`,
            422
        );
    }
}

function requireString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', `${label} must be a non-empty string`, 422);
    }
    return value;
}

function requirePattern(value, pattern, label) {
    if (typeof value !== 'string' || !pattern.test(value)) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', `${label} is invalid`, 422);
    }
    return value;
}

function assertRuntimeEnabled(env = process.env) {
    if (env.BENCHMARK_TRUST_CAMPAIGNS_ENABLED !== 'true') {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGNS_DISABLED',
            'strict Benchmark Trust campaign execution is disabled',
            503
        );
    }
    if (String(env.AGENTX_PROFILE || '').trim().toLowerCase() !== 'full') {
        throw runtimeError(
            'BENCHMARK_TRUST_FULL_PROFILE_REQUIRED',
            'strict Benchmark Trust campaigns require the full Product profile with startup recovery',
            503
        );
    }
}

function assertBoundedJsonShape(value) {
    const stack = [{ value, depth: 0 }];
    let nodes = 0;
    while (stack.length > 0) {
        const current = stack.pop();
        nodes += 1;
        if (nodes > MAX_CAMPAIGN_JSON_NODES || current.depth > MAX_CAMPAIGN_JSON_DEPTH) {
            throw runtimeError(
                'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
                'campaign spec structure exceeds Product bounds',
                422
            );
        }
        if (Array.isArray(current.value)) {
            for (const entry of current.value) stack.push({ value: entry, depth: current.depth + 1 });
        } else if (isPlainObject(current.value)) {
            for (const entry of Object.values(current.value)) {
                stack.push({ value: entry, depth: current.depth + 1 });
            }
        }
    }
}

function canonicalSpecBody(rawSpec) {
    const body = { ...rawSpec };
    delete body.specId;
    return body;
}

function assertWorkerAuthorityBound(authority, target, label) {
    const identity = authority.workerIdentity;
    const expected = {
        harness: target.harness,
        adapter: target.adapter,
        providerName: target.provider,
        modelName: target.model,
        modelVersion: target.modelVersion,
        modelDigest: authority.modelDigest,
        runtimeFingerprint: target.profile.fingerprint,
        api: target.api,
        environment: target.profile
    };
    const actual = {
        harness: identity?.harness,
        adapter: identity?.adapter,
        providerName: identity?.provider?.name,
        modelName: identity?.model?.name,
        modelVersion: identity?.model?.version,
        modelDigest: identity?.model?.digest,
        runtimeFingerprint: identity?.model?.runtimeFingerprint,
        api: identity?.api,
        environment: identity?.environment && {
            id: identity.environment.id,
            version: identity.environment.version,
            fingerprint: identity.environment.fingerprint
        }
    };
    if (fingerprint(actual) !== fingerprint(expected)) {
        throw runtimeError(
            'BENCHMARK_TRUST_RUNTIME_AUTHORITY_MISSING',
            `${label} Worker identity is not bound to its exact harness target`,
            503
        );
    }
}

function rawSha256(filePath) {
    return crypto.createHash('sha256').update(fsSync.readFileSync(filePath)).digest('hex');
}

function functionFingerprint(value) {
    return fingerprint(Function.prototype.toString.call(value));
}

function buildJudgeRuntimeImplementationManifest({
    scoringConfigs = ENHANCED_SCORING_CONFIGS,
    functions = {}
} = {}) {
    const loadedFunctions = {
        buildDynamicJudgePrompt: functions.buildDynamicJudgePrompt || buildDynamicJudgePrompt,
        buildPromptData: functions.buildPromptData || buildPromptData,
        computeMonolithicJudgeScore: functions.computeMonolithicJudgeScore || computeMonolithicJudgeScore,
        getScoringDimensions: functions.getScoringDimensions || getScoringDimensions,
        judgeConfidenceAssess: functions.judgeConfidenceAssess || judgeConfidence.assess,
        parseJudgeJsonResponse: functions.parseJudgeJsonResponse || parseJudgeJsonResponse,
        scoreFormatCompliance: functions.scoreFormatCompliance || scoreFormatCompliance,
        scoreResponse: functions.scoreResponse || scoreResponse,
        stripMarkdownCodeFences: functions.stripMarkdownCodeFences || stripMarkdownCodeFences
    };
    return {
        sourceFiles: RUBRIC_SOURCE_FILES.map(([module, filePath]) => ({
            module,
            sha256: rawSha256(filePath)
        })),
        loadedFunctions: Object.fromEntries(Object.entries(loadedFunctions).map(([name, value]) => [
            name,
            functionFingerprint(value)
        ])),
        scoringConfigsFingerprint: fingerprint(scoringConfigs)
    };
}

function buildJudgeRuntimeRubric({ judgeTarget, judgeConfig }) {
    const target = normalizeBenchmarkTarget(judgeTarget);
    const judgeInvocation = normalizeHarnessInvocationParameters({
        temperature: judgeConfig?.temperature,
        seed: judgeConfig?.seed,
        maxTokens: judgeConfig?.maxTokens,
        timeoutMs: judgeConfig?.timeoutMs
    }, { role: 'judge' });
    const envelope = normalizeWorkerEnvelope(buildHarnessEnvelope({
        batchId: 'benchmark-trust-rubric-template',
        cellId: 'benchmark-trust-rubric-template',
        target,
        promptText: 'benchmark-trust-judge-policy',
        parameters: judgeInvocation,
        role: 'judge'
    }));
    const artifact = {
        schema: JUDGE_RUNTIME_RUBRIC_SCHEMA,
        scoringMethod: 'llm_judge',
        scorerVersion: SCORER_VERSION,
        scorerComponents: SCORER_COMPONENTS,
        promptContract: 'dynamic-judge-prompt',
        implementationManifest: buildJudgeRuntimeImplementationManifest(),
        resultContract: envelope.resultContract,
        executionProfile: envelope.executionProfile,
        toolsFingerprint: envelope.tools.schemaFingerprint,
        policiesFingerprint: envelope.policies.fingerprint,
        judgeInvocation
    };
    return {
        artifact,
        fingerprint: fingerprint(artifact),
        judgeInvocation,
        envelope
    };
}

function computeJudgeRuntimeRubricFingerprint(options) {
    return buildJudgeRuntimeRubric(options).fingerprint;
}

function normalizeCampaignSpec(rawSpec, { now = Date.now(), env = process.env } = {}) {
    assertBoundedJsonShape(rawSpec);
    assertExactKeys(rawSpec, [
        'schema',
        'schemaVersion',
        'specId',
        'claimScope',
        'product',
        'campaignArtifact',
        'inferenceProfileArtifact',
        'launch',
        'promptAuthorities',
        'candidateAuthorities',
        'judgeAuthority',
        'statistics',
        'freshnessPolicy'
    ], 'campaign spec');
    if (rawSpec.schema !== CAMPAIGN_SPEC_SCHEMA || rawSpec.schemaVersion !== CAMPAIGN_SPEC_SCHEMA_VERSION) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            `campaign spec must be ${CAMPAIGN_SPEC_SCHEMA} schemaVersion ${CAMPAIGN_SPEC_SCHEMA_VERSION}`,
            422
        );
    }
    if (!CAMPAIGN_SPEC_ID_PATTERN.test(rawSpec.specId || '')
        || rawSpec.specId !== fingerprint(canonicalSpecBody(rawSpec))) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_FINGERPRINT_MISMATCH',
            'campaign spec id does not match its canonical body',
            422
        );
    }
    if (!['capability', 'deployment_fit'].includes(rawSpec.claimScope)) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'campaign claimScope is invalid', 422);
    }
    assertExactKeys(rawSpec.product, Object.keys(PRODUCT_ENV), 'campaign spec product');
    requirePattern(rawSpec.product.revision, GIT_REVISION_PATTERN, 'campaign spec product revision');
    for (const field of Object.keys(PRODUCT_ENV).filter(field => field !== 'revision')) {
        requirePattern(rawSpec.product[field], IMAGE_DIGEST_PATTERN, `campaign spec product ${field}`);
    }
    assertExactKeys(rawSpec.launch, [
        'targets',
        'promptIds',
        'judgeTarget',
        'judgeConfig',
        'executionConfig',
        'executionMode',
        'runName',
        'tags',
        'description',
        'campaignKind'
    ], 'campaign spec launch');
    if (!Array.isArray(rawSpec.launch.targets)
        || rawSpec.launch.targets.length < 2
        || rawSpec.launch.targets.length > MAX_CAMPAIGN_TARGETS) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'strict campaign requires at least two targets', 422);
    }
    if (!Array.isArray(rawSpec.launch.promptIds)
        || rawSpec.launch.promptIds.length < 1
        || rawSpec.launch.promptIds.length > MAX_CAMPAIGN_PROMPTS) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'strict campaign requires promptIds', 422);
    }
    if (rawSpec.launch.promptIds.some(id => typeof id !== 'string' || id.trim() === '')) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'strict campaign promptIds must be strings', 422);
    }
    if (!isPlainObject(rawSpec.launch.executionConfig)
        || !Array.isArray(rawSpec.launch.tags)
        || rawSpec.launch.tags.some(tag => typeof tag !== 'string')
        || typeof rawSpec.launch.runName !== 'string'
        || typeof rawSpec.launch.description !== 'string') {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'strict campaign launch metadata is invalid', 422);
    }
    if (rawSpec.launch.executionMode !== 'latency') {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'strict v2 campaign requires latency execution', 422);
    }
    if (rawSpec.launch.campaignKind !== 'model') {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'strict v2 campaignKind must be model', 422);
    }
    if (new Set(rawSpec.launch.promptIds.map(String)).size !== rawSpec.launch.promptIds.length) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'strict campaign promptIds must be unique', 422);
    }
    const rawExecution = rawSpec.launch.executionConfig;
    if (!Number.isSafeInteger(rawExecution.repeats)
        || rawExecution.repeats < 1
        || rawExecution.repeats > 5
        || !Number.isSafeInteger(rawExecution.response_max_tokens)
        || rawExecution.response_max_tokens < 1
        || rawExecution.response_max_tokens > 32_768
        || !Number.isSafeInteger(rawExecution.per_test_timeout_ms)
        || rawExecution.per_test_timeout_ms < 30_000
        || rawExecution.per_test_timeout_ms > 900_000
        || typeof rawExecution.temperature !== 'number'
        || !Number.isFinite(rawExecution.temperature)
        || rawExecution.temperature < 0
        || rawExecution.temperature > 2
        || typeof rawExecution.top_p !== 'number'
        || !Number.isFinite(rawExecution.top_p)
        || rawExecution.top_p < 0
        || rawExecution.top_p > 1
        || !(rawExecution.seed === null || Number.isSafeInteger(rawExecution.seed))
        || rawSpec.launch.targets.length * rawSpec.launch.promptIds.length * rawExecution.repeats
            > MAX_CAMPAIGN_CELLS) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            'strict campaign execution size or parameters exceed Product bounds',
            422
        );
    }
    assertExactKeys(rawSpec.launch.judgeConfig, [
        'temperature', 'seed', 'maxTokens', 'timeoutMs'
    ], 'campaign spec launch judgeConfig');
    if (typeof rawSpec.launch.judgeConfig.temperature !== 'number'
        || !Number.isFinite(rawSpec.launch.judgeConfig.temperature)
        || rawSpec.launch.judgeConfig.temperature < 0
        || rawSpec.launch.judgeConfig.temperature > 2
        || !(rawSpec.launch.judgeConfig.seed === null
            || Number.isSafeInteger(rawSpec.launch.judgeConfig.seed))
        || !Number.isSafeInteger(rawSpec.launch.judgeConfig.maxTokens)
        || rawSpec.launch.judgeConfig.maxTokens < 1
        || rawSpec.launch.judgeConfig.maxTokens > 50_000
        || !Number.isSafeInteger(rawSpec.launch.judgeConfig.timeoutMs)
        || rawSpec.launch.judgeConfig.timeoutMs < 30_000
        || rawSpec.launch.judgeConfig.timeoutMs > 3_600_000) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            'strict campaign judgeConfig is invalid or outside Product bounds',
            422
        );
    }
    if (!Array.isArray(rawSpec.promptAuthorities)
        || rawSpec.promptAuthorities.length !== rawSpec.launch.promptIds.length) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            'strict campaign requires one frozen prompt authority per prompt id',
            422
        );
    }
    const promptAuthorityIds = rawSpec.promptAuthorities.map((authority, index) => {
        assertExactKeys(authority, ['promptDocumentId', 'sourceFingerprint'], `promptAuthorities[${index}]`);
        const promptDocumentId = requireString(
            authority.promptDocumentId,
            `promptAuthorities[${index}].promptDocumentId`
        );
        requirePattern(
            authority.sourceFingerprint,
            FINGERPRINT_PATTERN,
            `promptAuthorities[${index}].sourceFingerprint`
        );
        return promptDocumentId;
    });
    const promptAuthorityFingerprints = rawSpec.promptAuthorities.map(authority => authority.sourceFingerprint);
    if (new Set(promptAuthorityIds).size !== promptAuthorityIds.length
        || new Set(promptAuthorityFingerprints).size !== promptAuthorityFingerprints.length
        || fingerprint([...promptAuthorityIds].sort())
            !== fingerprint([...rawSpec.launch.promptIds].map(String).sort())) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            'prompt authorities must map exactly to the frozen prompt ids',
            422
        );
    }
    const targets = rawSpec.launch.targets.map(target => normalizeBenchmarkTarget(target));
    const judgeTarget = normalizeBenchmarkTarget(rawSpec.launch.judgeTarget);
    if (targets.some(target => target.executionKind !== 'harness'
            || target.mode !== 'isolated_model'
            || target.capabilities.candidate !== true)
        || judgeTarget.executionKind !== 'harness'
        || judgeTarget.mode !== 'isolated_model'
        || judgeTarget.capabilities.judge !== true) {
        throw runtimeError(
            'BENCHMARK_TRUST_RUNTIME_AUTHORITY_MISSING',
            'strict campaigns require isolated harness candidates and an isolated harness judge',
            503
        );
    }
    if (targets.some(target => target.tier === 'paid_cloud') || judgeTarget.tier === 'paid_cloud') {
        throw runtimeError(
            'BENCHMARK_TRUST_PAID_LANE_UNSUPPORTED',
            'strict v2 campaign specs do not authorize paid execution',
            422
        );
    }
    const targetFingerprints = targets.map(target => target.fingerprint);
    if (new Set(targetFingerprints).size !== targetFingerprints.length) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'strict campaign targets must be unique', 422);
    }
    if (!Array.isArray(rawSpec.candidateAuthorities)
        || rawSpec.candidateAuthorities.length !== targets.length) {
        throw runtimeError(
            'BENCHMARK_TRUST_RUNTIME_AUTHORITY_MISSING',
            'strict campaign requires one exact Worker identity authority per candidate',
            503
        );
    }
    const authorityFingerprints = rawSpec.candidateAuthorities.map(authority => authority?.targetFingerprint);
    if (new Set(authorityFingerprints).size !== authorityFingerprints.length
        || authorityFingerprints.some(value => !targetFingerprints.includes(value))) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            'candidate authorities must map exactly to the frozen targets',
            422
        );
    }
    for (const [index, authority] of rawSpec.candidateAuthorities.entries()) {
        assertExactKeys(authority, [
            'targetFingerprint', 'workerIdentity', 'modelDigest', 'artifactDigest'
        ], `candidateAuthorities[${index}]`);
        if (!isPlainObject(authority.workerIdentity)) {
            throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'candidate Worker identity is required', 422);
        }
        requireString(authority.modelDigest, 'candidate modelDigest');
        requireString(authority.artifactDigest, 'candidate artifactDigest');
        if (authority.artifactDigest !== authority.modelDigest) {
            throw runtimeError(
                'BENCHMARK_TRUST_RUNTIME_AUTHORITY_MISSING',
                'strict v2 candidate artifactDigest must be the digest attested by its Worker identity',
                503
            );
        }
        const target = targets.find(entry => entry.fingerprint === authority.targetFingerprint);
        assertWorkerAuthorityBound(authority, target, `candidateAuthorities[${index}]`);
    }
    assertExactKeys(rawSpec.judgeAuthority, ['qualificationAttestation'], 'judgeAuthority');
    const qualificationAttestation = verifyJudgeQualificationAuthority(
        rawSpec.judgeAuthority.qualificationAttestation,
        { env, now: new Date(now) }
    );
    assertWorkerAuthorityBound({
        workerIdentity: qualificationAttestation.judge.workerIdentity,
        modelDigest: qualificationAttestation.judge.workerIdentity?.model?.digest
    }, judgeTarget, 'judgeAuthority');
    const runtimeRubricFingerprint = computeJudgeRuntimeRubricFingerprint({
        judgeTarget,
        judgeConfig: rawSpec.launch.judgeConfig
    });
    if (qualificationAttestation.judge.rubricFingerprint !== runtimeRubricFingerprint) {
        throw runtimeError(
            'BENCHMARK_TRUST_JUDGE_RUBRIC_MISMATCH',
            'signed judge qualification rubric does not match the exact Product scorer runtime',
            409
        );
    }
    assertExactKeys(rawSpec.statistics, [
        'alpha',
        'mde',
        'poweredAlternativeEffect',
        'equivalenceMargin',
        'targetPowerBasisPoints',
        'assumedMaxPairedStdDevMicros',
        'varianceBasis',
        'variancePilotAttestation'
    ], 'campaign statistics');
    assertExactKeys(rawSpec.statistics.varianceBasis, [
        'schema',
        'provenance',
        'cohortFingerprint',
        'candidateSetFingerprint',
        'rubricFingerprint',
        'repeatCount',
        'candidateInferenceContractFingerprint',
        'promptSamplingPolicyFingerprint',
        'candidatePairCount',
        'pairwiseObservedStdDevs',
        'method',
        'independentPromptCount',
        'confidenceBasisPoints',
        'observedPairedStdDevMicros',
        'upperConfidenceBoundMicros',
        'artifactFingerprint'
    ], 'campaign statistics varianceBasis');
    let varianceBasis;
    try {
        varianceBasis = buildBenchmarkTrustVarianceBasis(rawSpec.statistics.varianceBasis);
    } catch (_error) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            'campaign statistics variance basis is invalid',
            422
        );
    }
    const varianceCandidateBindings = rawSpec.candidateAuthorities.map(authority => ({
        targetFingerprint: authority.targetFingerprint,
        modelDigest: authority.modelDigest,
        artifactDigest: authority.artifactDigest,
        inferenceContractFingerprint: targets.find(
            target => target.fingerprint === authority.targetFingerprint
        ).profile.fingerprint
    }));
    const candidateInferenceParameters = {
        temperature: rawExecution.temperature,
        topP: rawExecution.top_p,
        seed: rawExecution.seed,
        maxTokens: rawExecution.response_max_tokens,
        timeoutMs: rawExecution.per_test_timeout_ms
    };
    const candidateInferenceContractFingerprint =
        computeBenchmarkTrustCandidateInferenceContractFingerprint({
            candidateBindings: varianceCandidateBindings,
            repeatCount: rawExecution.repeats,
            parameters: candidateInferenceParameters
        });
    const promptSamplingPolicy = buildBenchmarkTrustPromptSamplingPolicy(
        rawSpec.campaignArtifact,
        rawExecution,
        rawSpec.promptAuthorities.map(authority => authority.sourceFingerprint)
    );
    const promptSamplingPolicyFingerprint = fingerprint(promptSamplingPolicy);
    const variancePilotAttestation = verifyVariancePilotAuthority(
        rawSpec.statistics.variancePilotAttestation,
        { env, now: new Date(now) }
    );
    const expectedVariancePairFingerprints = computeBenchmarkTrustVariancePairFingerprints(
        varianceCandidateBindings,
        runtimeRubricFingerprint
    );
    if (rawSpec.statistics.assumedMaxPairedStdDevMicros !== varianceBasis.upperConfidenceBoundMicros
        || varianceBasis.candidateSetFingerprint
            !== computeBenchmarkTrustVarianceCandidateSetFingerprint(varianceCandidateBindings)
        || varianceBasis.rubricFingerprint !== runtimeRubricFingerprint
        || varianceBasis.repeatCount !== rawExecution.repeats
        || varianceBasis.candidateInferenceContractFingerprint !== candidateInferenceContractFingerprint
        || varianceBasis.promptSamplingPolicyFingerprint !== promptSamplingPolicyFingerprint
        || varianceBasis.candidatePairCount !== targets.length * (targets.length - 1) / 2
        || varianceBasis.pairwiseObservedStdDevs.map(entry => entry.pairFingerprint).join('\n')
            !== expectedVariancePairFingerprints.join('\n')
        || variancePilotAttestation.evidence.varianceBasisFingerprint !== varianceBasis.artifactFingerprint
        || variancePilotAttestation.evidence.cohortFingerprint !== varianceBasis.cohortFingerprint
        || variancePilotAttestation.evidence.promptFingerprints.length !== varianceBasis.independentPromptCount
        || variancePilotAttestation.evidence.repeatCount !== varianceBasis.repeatCount
        || variancePilotAttestation.evidence.candidateInferenceContractFingerprint
            !== varianceBasis.candidateInferenceContractFingerprint
        || variancePilotAttestation.evidence.promptSamplingPolicyFingerprint
            !== varianceBasis.promptSamplingPolicyFingerprint
        || typeof rawSpec.statistics.alpha !== 'number'
        || !Number.isFinite(rawSpec.statistics.alpha)
        || rawSpec.statistics.alpha <= 0
        || rawSpec.statistics.alpha >= 1
        || !isReceiptScaleRepresentable(rawSpec.statistics.alpha, 10_000)
        || typeof rawSpec.statistics.mde !== 'number'
        || !Number.isFinite(rawSpec.statistics.mde)
        || rawSpec.statistics.mde <= 0
        || rawSpec.statistics.mde >= 10
        || !isReceiptScaleRepresentable(rawSpec.statistics.mde, 1_000_000)
        || typeof rawSpec.statistics.poweredAlternativeEffect !== 'number'
        || !Number.isFinite(rawSpec.statistics.poweredAlternativeEffect)
        || rawSpec.statistics.poweredAlternativeEffect <= rawSpec.statistics.mde
        || rawSpec.statistics.poweredAlternativeEffect > 10
        || !isReceiptScaleRepresentable(rawSpec.statistics.poweredAlternativeEffect, 1_000_000)
        || typeof rawSpec.statistics.equivalenceMargin !== 'number'
        || !Number.isFinite(rawSpec.statistics.equivalenceMargin)
        || rawSpec.statistics.equivalenceMargin < 0
        || rawSpec.statistics.equivalenceMargin > rawSpec.statistics.mde
        || !Number.isSafeInteger(rawSpec.statistics.targetPowerBasisPoints)
        || rawSpec.statistics.targetPowerBasisPoints < 8000
        || rawSpec.statistics.targetPowerBasisPoints > 9999) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID',
            'campaign statistics are invalid or inconsistent with the frozen variance basis',
            422
        );
    }
    return {
        ...rawSpec,
        launch: {
            ...rawSpec.launch,
            targets,
            judgeTarget,
            promptIds: [...rawSpec.launch.promptIds].map(String),
            tags: Array.isArray(rawSpec.launch.tags) ? [...rawSpec.launch.tags] : []
        },
        promptAuthorities: rawSpec.promptAuthorities.map(authority => ({ ...authority })),
        candidateAuthorities: rawSpec.candidateAuthorities.map(authority => ({ ...authority })),
        judgeAuthority: { qualificationAttestation },
        statistics: { ...rawSpec.statistics, varianceBasis, variancePilotAttestation }
    };
}

function configuredProductManifest(env = process.env) {
    const manifest = {};
    for (const [field, variable] of Object.entries(PRODUCT_ENV)) {
        const value = env[variable];
        if (typeof value !== 'string' || value.trim() === '') {
            throw runtimeError(
                'BENCHMARK_TRUST_PRODUCT_MANIFEST_UNAVAILABLE',
                `strict campaign runtime requires ${variable}`,
                503
            );
        }
        manifest[field] = value.trim();
    }
    return manifest;
}

function assertConfiguredProductManifest(spec, env = process.env) {
    const configured = configuredProductManifest(env);
    if (fingerprint(configured) !== fingerprint(spec.product)) {
        throw runtimeError(
            'BENCHMARK_TRUST_PRODUCT_MANIFEST_MISMATCH',
            'campaign Product identity does not match the running immutable image set',
            409
        );
    }
    return configured;
}

async function loadCampaignSpec(specId, {
    directory = process.env.BENCHMARK_TRUST_CAMPAIGN_SPEC_DIR,
    readFile = fs.readFile,
    env = process.env,
    now = Date.now()
} = {}) {
    assertRuntimeEnabled(env);
    if (!CAMPAIGN_SPEC_ID_PATTERN.test(specId || '')) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_ID_INVALID', 'campaign spec id is invalid', 400);
    }
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SPEC_STORE_DISABLED',
            'strict campaign spec store is not configured',
            503
        );
    }
    const root = path.resolve(directory);
    const filePath = path.resolve(root, `${specId}.json`);
    if (path.dirname(filePath) !== root) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_ID_INVALID', 'campaign spec path escaped its store', 400);
    }
    let raw;
    try {
        raw = await readFile(filePath);
    } catch (error) {
        throw runtimeError(
            error?.code === 'ENOENT'
                ? 'BENCHMARK_TRUST_CAMPAIGN_SPEC_NOT_FOUND'
                : 'BENCHMARK_TRUST_CAMPAIGN_SPEC_READ_FAILED',
            error?.code === 'ENOENT'
                ? 'campaign spec was not found'
                : 'campaign spec could not be read',
            error?.code === 'ENOENT' ? 404 : 503
        );
    }
    if (!Buffer.isBuffer(raw)) raw = Buffer.from(raw);
    if (raw.length === 0 || raw.length > MAX_CAMPAIGN_SPEC_BYTES) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'campaign spec size is invalid', 422);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    } catch (_error) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID', 'campaign spec must be valid JSON', 422);
    }
    const spec = normalizeCampaignSpec(parsed, { now, env });
    if (spec.specId !== specId) {
        throw runtimeError('BENCHMARK_TRUST_CAMPAIGN_SPEC_FINGERPRINT_MISMATCH', 'campaign spec file identity mismatched', 409);
    }
    return spec;
}

function canonicalPromptField(value, label, seen = new Set()) {
    if (value === undefined || value === null) return null;
    if (typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw runtimeError(
                'BENCHMARK_TRUST_PROMPT_SOURCE_INVALID',
                `${label} must contain only finite canonical JSON values`,
                409
            );
        }
        return Object.is(value, -0) ? 0 : value;
    }
    if (value instanceof Date) return value.toISOString();
    if (typeof value?.toHexString === 'function') return value.toHexString();
    if (typeof value?.toObject === 'function') {
        if (seen.has(value)) {
            throw runtimeError(
                'BENCHMARK_TRUST_PROMPT_SOURCE_INVALID',
                `${label} contains a circular document value`,
                409
            );
        }
        seen.add(value);
        const normalized = canonicalPromptField(value.toObject({
            depopulate: true,
            flattenMaps: true,
            getters: false,
            virtuals: false,
            versionKey: false
        }), label, seen);
        seen.delete(value);
        return normalized;
    }
    if (seen.has(value)) {
        throw runtimeError(
            'BENCHMARK_TRUST_PROMPT_SOURCE_INVALID',
            `${label} contains a circular value`,
            409
        );
    }
    if (Array.isArray(value)) {
        seen.add(value);
        const normalized = value.map((entry, index) => canonicalPromptField(entry, `${label}[${index}]`, seen));
        seen.delete(value);
        return normalized;
    }
    if (value instanceof Map) {
        return canonicalPromptField(Object.fromEntries(value.entries()), label, seen);
    }
    if (isPlainObject(value)) {
        seen.add(value);
        const normalized = {};
        for (const [key, entry] of Object.entries(value)) {
            if (entry !== undefined) normalized[key] = canonicalPromptField(entry, `${label}.${key}`, seen);
        }
        seen.delete(value);
        return normalized;
    }
    throw runtimeError(
        'BENCHMARK_TRUST_PROMPT_SOURCE_INVALID',
        `${label} must be canonical JSON`,
        409
    );
}

function promptEvidenceRow(prompt, promptText) {
    return {
        prompt: promptText,
        prompt_name: prompt.name,
        prompt_level: prompt.level ?? null,
        prompt_category: prompt.category ?? null,
        expected_answer: canonicalPromptField(prompt.expected_answer, 'prompt.expected_answer'),
        scoring_type: normalizeScoringCategory(
            prompt.scoring_type || prompt.category,
            DEFAULT_SCORING_CATEGORY
        ),
        scoring_plan: canonicalPromptField(prompt.scoring_plan, 'prompt.scoring_plan'),
        deterministic_scoring: canonicalPromptField(
            prompt.deterministic_scoring,
            'prompt.deterministic_scoring'
        ),
        scoring_dimensions: canonicalPromptField(prompt.scoring_dimensions, 'prompt.scoring_dimensions'),
        reference_answer: canonicalPromptField(prompt.reference_answer, 'prompt.reference_answer'),
        output_contract: canonicalPromptField(prompt.output_contract, 'prompt.output_contract'),
        judge_criteria: canonicalPromptField(prompt.judge_criteria, 'prompt.judge_criteria')
    };
}

function opaqueId(prefix, specId, value) {
    return `${prefix}_${fingerprint({ specId, value }).slice(0, 32)}`;
}

function exactPromptText(prompt, executionConfig) {
    const numPredict = executionConfig.response_max_tokens || 32000;
    return buildPromptHints(
        prompt.prompt,
        prompt.expected_tokens || null,
        numPredict,
        executionConfig
    ).promptText;
}

function buildCampaignPromptAuthority(prompt, executionConfig) {
    const promptText = exactPromptText(prompt, executionConfig);
    return {
        promptDocumentId: String(prompt._id),
        sourceFingerprint: computePromptSourceFingerprint(promptEvidenceRow(prompt, promptText))
    };
}

function buildTrustSourceContext({
    batch,
    targets,
    prompts,
    judgeTarget,
    executionConfig,
    spendGrant = null,
    qualityCohortFingerprint,
    campaignSpec,
    env = process.env,
    now = Date.now()
}) {
    const spec = normalizeCampaignSpec(campaignSpec, { env, now });
    const normalizedSpecExecutionConfig = normalizeExecutionConfig(spec.launch.executionConfig);
    if (fingerprint(executionConfig) !== fingerprint(normalizedSpecExecutionConfig)) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SELECTION_MISMATCH',
            'runtime execution configuration does not match the immutable campaign spec',
            409
        );
    }
    const configuredTargets = targets.map(target => normalizeBenchmarkTarget(target));
    const configuredJudge = normalizeBenchmarkTarget(judgeTarget);
    const actualTargetFingerprints = configuredTargets.map(target => target.fingerprint).sort();
    const expectedTargetFingerprints = spec.launch.targets.map(target => target.fingerprint).sort();
    if (fingerprint(actualTargetFingerprints) !== fingerprint(expectedTargetFingerprints)
        || configuredJudge.fingerprint !== spec.launch.judgeTarget.fingerprint) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SELECTION_MISMATCH',
            'runtime targets do not match the immutable campaign spec',
            409
        );
    }
    const promptDocumentIds = prompts.map(prompt => String(prompt._id));
    if (fingerprint([...promptDocumentIds].sort()) !== fingerprint([...spec.launch.promptIds].sort())) {
        throw runtimeError(
            'BENCHMARK_TRUST_CAMPAIGN_SELECTION_MISMATCH',
            'runtime prompts do not match the immutable campaign spec',
            409
        );
    }
    const repeatCount = Math.max(1, Math.min(5, Number(executionConfig.repeats) || 1));
    const promptEntries = prompts.map(prompt => {
        const promptText = exactPromptText(prompt, executionConfig);
        const sourceFingerprint = computePromptSourceFingerprint(promptEvidenceRow(prompt, promptText));
        const authority = spec.promptAuthorities.find(entry => (
            entry.promptDocumentId === String(prompt._id)
        ));
        if (!authority || authority.sourceFingerprint !== sourceFingerprint) {
            throw runtimeError(
                'BENCHMARK_TRUST_CAMPAIGN_PROMPT_DRIFT',
                'runtime prompt content does not match its preregistered source fingerprint',
                409
            );
        }
        return {
            internalId: String(prompt._id),
            promptText,
            promptId: opaqueId('prompt', spec.specId, sourceFingerprint),
            fingerprint: sourceFingerprint
        };
    });
    const candidates = configuredTargets.map(target => {
        const authority = spec.candidateAuthorities.find(entry => entry.targetFingerprint === target.fingerprint);
        if (!authority) {
            throw runtimeError('BENCHMARK_TRUST_RUNTIME_AUTHORITY_MISSING', 'candidate Worker authority is missing', 503);
        }
        const candidateId = opaqueId('candidate', spec.specId, target.fingerprint);
        const envelopes = [];
        for (const promptEntry of promptEntries) {
            const prompt = prompts.find(entry => String(entry._id) === promptEntry.internalId);
            for (let repeatIndex = 0; repeatIndex < repeatCount; repeatIndex += 1) {
                const envelope = normalizeWorkerEnvelope(buildHarnessEnvelope({
                    batchId: String(batch._id),
                    cellId: `${target.id}:${prompt._id || prompt.name}:${repeatIndex}`,
                    target,
                    promptText: promptEntry.promptText,
                    parameters: {
                        temperature: executionConfig.temperature,
                        topP: executionConfig.top_p,
                        seed: executionConfig.seed,
                        maxTokens: executionConfig.response_max_tokens || 32000,
                        timeoutMs: executionConfig.per_test_timeout_ms || 600000
                    },
                    maxCostNanodollars: spendGrant?.maxCostNanodollars || 0,
                    role: 'candidate'
                }));
                envelopes.push({
                    promptId: promptEntry.promptId,
                    repeatIndex,
                    envelopeFingerprint: envelope.fingerprint
                });
            }
        }
        const representative = normalizeWorkerEnvelope(buildHarnessEnvelope({
            batchId: String(batch._id),
            cellId: `${target.id}:trust-policy`,
            target,
            promptText: 'benchmark-trust-policy',
            parameters: {
                temperature: executionConfig.temperature,
                topP: executionConfig.top_p,
                seed: executionConfig.seed,
                maxTokens: executionConfig.response_max_tokens || 32000,
                timeoutMs: executionConfig.per_test_timeout_ms || 600000
            },
            role: 'candidate'
        }));
        return {
            candidateId,
            sourceIdentity: {
                model: target.model,
                host: executionHost(target),
                modelDigest: authority.modelDigest,
                artifactDigest: authority.artifactDigest,
                inferenceContractFingerprint: target.profile.fingerprint,
                executionTargetFingerprint: target.fingerprint,
                workerIdentityFingerprint: fingerprint(authority.workerIdentity),
                toolsFingerprint: representative.tools.schemaFingerprint,
                policiesFingerprint: representative.policies.fingerprint,
                executionProfile: representative.executionProfile,
                envelopeSetFingerprint: computeBenchmarkTrustExecutionEnvelopeSetFingerprint({
                    candidateId,
                    entries: envelopes
                })
            }
        };
    }).sort((left, right) => left.candidateId.localeCompare(right.candidateId));
    const normalizedPrompts = promptEntries
        .map(({ promptId, fingerprint: promptFingerprint }) => ({ promptId, fingerprint: promptFingerprint }))
        .sort((left, right) => left.promptId.localeCompare(right.promptId));
    const qualification = spec.judgeAuthority.qualificationAttestation;
    const runtimeRubric = buildJudgeRuntimeRubric({
        judgeTarget: configuredJudge,
        judgeConfig: spec.launch.judgeConfig
    });
    if (qualification.judge.rubricFingerprint !== runtimeRubric.fingerprint) {
        throw runtimeError(
            'BENCHMARK_TRUST_JUDGE_RUBRIC_MISMATCH',
            'signed judge qualification rubric no longer matches the exact Product scorer runtime',
            409
        );
    }
    const { judgeInvocation, envelope: judgeEnvelope } = runtimeRubric;
    const judge = {
        qualificationReceiptId: qualification.attestationId,
        identityFingerprint: qualification.judge.identityFingerprint,
        rubricFingerprint: runtimeRubric.fingerprint,
        corpusFingerprint: qualification.judge.corpusFingerprint,
        holdoutFingerprint: qualification.judge.holdoutFingerprint,
        qualificationStatus: qualification.evidence.status,
        validUntil: new Date(qualification.validUntil).toISOString()
    };
    const scoreEvidence = {
        judgeTargetFingerprint: configuredJudge.fingerprint,
        qualityCohortFingerprint,
        scoringMethod: 'llm_judge',
        scorerVersion: SCORER_VERSION,
        workerIdentityFingerprint: fingerprint(qualification.judge.workerIdentity),
        toolsFingerprint: judgeEnvelope.tools.schemaFingerprint,
        policiesFingerprint: judgeEnvelope.policies.fingerprint,
        executionProfile: judgeEnvelope.executionProfile,
        judgeInvocation,
        runtimeRubric: runtimeRubric.artifact
    };
    scoreEvidence.judgeBindingFingerprint = computeBenchmarkTrustJudgeBindingFingerprint({
        judge,
        scoreEvidence
    });
    const candidateIds = candidates.map(candidate => candidate.candidateId);
    const promptIds = normalizedPrompts.map(prompt => prompt.promptId);
    const powerFields = buildBenchmarkTrustPowerAnalysisFields({
        alpha: spec.statistics.alpha,
        mde: spec.statistics.mde,
        poweredAlternativeEffect: spec.statistics.poweredAlternativeEffect,
        candidateIds,
        targetPowerBasisPoints: spec.statistics.targetPowerBasisPoints,
        assumedMaxPairedStdDevMicros: spec.statistics.assumedMaxPairedStdDevMicros,
        varianceBasis: spec.statistics.varianceBasis
    });
    const analysisPlan = {
        alpha: spec.statistics.alpha,
        mde: spec.statistics.mde,
        poweredAlternativeEffect: spec.statistics.poweredAlternativeEffect,
        equivalenceMargin: spec.statistics.equivalenceMargin,
        repeatCount,
        candidateInferenceParameters: {
            temperature: executionConfig.temperature,
            topP: executionConfig.top_p,
            seed: executionConfig.seed,
            maxTokens: executionConfig.response_max_tokens,
            timeoutMs: executionConfig.per_test_timeout_ms
        },
        promptSamplingPolicy: buildBenchmarkTrustPromptSamplingPolicy(
            spec.campaignArtifact,
            executionConfig,
            promptEntries.map(prompt => prompt.fingerprint)
        ),
        variancePilotAttestationId: spec.statistics.variancePilotAttestation.attestationId,
        ...powerFields,
        candidateIds,
        promptIds
    };
    const context = {
        schema: SOURCE_CONTEXT_SCHEMA,
        sourceBatchId: batch.trust_batch_id,
        claimScope: spec.claimScope,
        product: spec.product,
        campaign: {
            campaignId: `campaign_${spec.specId.slice(0, 32)}`,
            artifact: spec.campaignArtifact
        },
        inferenceProfile: { artifact: spec.inferenceProfileArtifact },
        prompts: normalizedPrompts,
        candidates,
        statistics: {
            analysisPlan,
            analysisPlanFingerprint: fingerprint({
                schema: ANALYSIS_PLAN_SCHEMA,
                plan: analysisPlan
            }),
            rankingPolicy: {
                schema: RANKING_POLICY_SCHEMA,
                scoreField: 'quality_score'
            }
        },
        judge,
        scoreEvidence,
        freshnessPolicy: {
            schema: FRESHNESS_POLICY_SCHEMA,
            staleAfterSeconds: spec.freshnessPolicy.staleAfterSeconds,
            expiresAfterSeconds: spec.freshnessPolicy.expiresAfterSeconds
        }
    };
    return normalizeSourceContext(context);
}

function resolveTrustCellIdentity({ context, executionTarget, prompt, promptText }) {
    if (!context) return { candidateId: null, promptId: null };
    const target = normalizeBenchmarkTarget(executionTarget);
    const candidateMatches = context.candidates.filter(candidate => (
        candidate.sourceIdentity.executionTargetFingerprint === target.fingerprint
    ));
    const promptFingerprint = computePromptSourceFingerprint(promptEvidenceRow(prompt, promptText));
    const promptMatches = context.prompts.filter(entry => entry.fingerprint === promptFingerprint);
    if (candidateMatches.length !== 1 || promptMatches.length !== 1) {
        throw runtimeError(
            'BENCHMARK_TRUST_RESULT_MAPPING_FAILED',
            'result target or prompt does not map uniquely to the frozen Trust context',
            409
        );
    }
    return {
        candidateId: candidateMatches[0].candidateId,
        promptId: promptMatches[0].promptId
    };
}

module.exports = {
    CAMPAIGN_SPEC_SCHEMA,
    CAMPAIGN_SPEC_SCHEMA_VERSION,
    JUDGE_RUNTIME_RUBRIC_SCHEMA,
    PRODUCT_ENV,
    assertRuntimeEnabled,
    assertConfiguredProductManifest,
    buildCampaignPromptAuthority,
    buildJudgeRuntimeImplementationManifest,
    buildTrustSourceContext,
    computeJudgeRuntimeRubricFingerprint,
    configuredProductManifest,
    loadCampaignSpec,
    normalizeCampaignSpec,
    promptEvidenceRow,
    resolveTrustCellIdentity
};
