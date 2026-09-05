'use strict';

process.env.MONGOMS_VERSION = '7.0.24';
jest.setTimeout(120_000);

const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkTimelineEntry = require('../../models/BenchmarkTimelineEntry');
const BenchmarkTrustReceipt = require('../../models/BenchmarkTrustReceipt');
const BenchmarkTrustEvidenceLock = require('../../models/BenchmarkTrustEvidenceLock');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const HISTORICAL_V1_RECEIPT = require('../../../shared/fixtures/benchmark-trust-receipt-v1-a51fcd1.json');
const {
    BENCHMARK_TRUST_RECEIPT_SCHEMA,
    BENCHMARK_TRUST_RECEIPT_SCHEMA_V1,
    buildBenchmarkTrustReceipt,
    computeCandidateSetFingerprint,
    serializeBenchmarkTrustReceipt
} = require('../../../shared/benchmarkTrustReceipt');
const {
    MAX_BATCH_READ_LIMIT,
    storeBenchmarkTrustReceipt,
    getBenchmarkTrustReceiptById,
    listBenchmarkTrustReceiptsBySourceBatch
} = require('../../src/services/benchmark/benchmarkTrustReceiptStore');
const { archiveOldResults } = require('../../src/services/benchmark/dataRetention');
const { clearResults, clearFailedResults } = require('../../src/services/benchmark/batches');
const {
    buildCourthouseGroundTruthCountQuery
} = require('../../src/services/benchmark/results');
const {
    acquireBenchmarkTrustEvidenceLock,
    releaseBenchmarkTrustEvidenceLock,
    withBenchmarkTrustEvidenceLock
} = require('../../src/services/benchmark/benchmarkTrustEvidenceLock');
const {
    SOURCE_CONTEXT_SCHEMA,
    RANKING_POLICY_SCHEMA,
    FRESHNESS_POLICY_SCHEMA,
    buildBenchmarkTrustFreshnessProjection,
    buildBenchmarkTrustSourceProjection,
    computeBenchmarkTrustExecutionEnvelopeSetFingerprint,
    computeBenchmarkTrustJudgeBindingFingerprint,
    computePromptSourceFingerprint
} = require('../../src/services/benchmark/benchmarkTrustSourceEvidence');
const {
    fingerprint: workerFingerprint,
    normalizeWorkerReceipt
} = require('../../../shared/workerContract');
const {
    BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA,
    computeBenchmarkHumanEvidenceAttestationId,
    computeBenchmarkHumanEvidenceSourceResultFingerprint,
    serializeBenchmarkHumanEvidenceAttestationSigningPayload
} = require('../../../shared/benchmarkHumanEvidenceAttestation');
const {
    HUMAN_EVIDENCE_SCOPE,
    MIN_REVOCATION_VERSION_ENV,
    REVOCATION_SNAPSHOT_ID_ENV,
    REVOCATIONS_ENV,
    REVOCATIONS_SCHEMA,
    TRUST_ROOTS_ENV,
    TRUST_ROOTS_SCHEMA,
    importAttestedHumanGroundTruth,
    verifyStoredAttestedHumanGroundTruth
} = require('../../src/services/benchmark/humanGroundTruthImport');
const {
    runWithPublicBenchmarkReadPrivacy
} = require('../../src/services/benchmark/publicReadPrivacy');
const {
    loadQualifiedHumanGroundTruth
} = require('../../src/services/benchmark/retroCalibration');
const crypto = require('crypto');
const { stableSerialize } = require('../../../shared/artifactIdentity');
const {
    buildBenchmarkTrustPowerAnalysisFields,
    buildBenchmarkTrustVarianceBasis,
    computeBenchmarkTrustCandidateInferenceContractFingerprint,
    computeBenchmarkTrustVarianceCandidateSetFingerprint,
    computeBenchmarkTrustVariancePairFingerprints
} = require('../../src/services/benchmark/benchmarkTrustStatistics');
const {
    buildBenchmarkTrustPromptSamplingPolicy
} = require('../../src/services/benchmark/config');
const campaignArtifact = Object.freeze({ schema: 'trust-test-campaign/v1', frozen: true });
const promptExecutionConfig = Object.freeze({
    repeats: 2,
    temperature: 0,
    top_p: 1,
    seed: 7,
    response_max_tokens: 1024,
    per_test_timeout_ms: 60000
});
const varianceBasis = ({ candidateBindings, rubricFingerprint, promptSamplingPolicy }) => {
    const candidateInferenceContractFingerprint =
        computeBenchmarkTrustCandidateInferenceContractFingerprint({
            candidateBindings,
            repeatCount: 2,
            parameters: {
                temperature: 0,
                topP: 1,
                seed: 7,
                maxTokens: 1024,
                timeoutMs: 60000
            }
        });
    const pairFingerprints = computeBenchmarkTrustVariancePairFingerprints(
        candidateBindings,
        rubricFingerprint
    );
    return buildBenchmarkTrustVarianceBasis({
    schema: 'agentx.benchmark-trust-variance-basis/independent-pilot-upper-bound/v1',
    provenance: 'independent_pilot',
    cohortFingerprint: 'e'.repeat(64),
    candidateSetFingerprint: computeBenchmarkTrustVarianceCandidateSetFingerprint(candidateBindings),
    rubricFingerprint,
    repeatCount: 2,
    candidateInferenceContractFingerprint,
    promptSamplingPolicyFingerprint: workerFingerprint(promptSamplingPolicy),
    candidatePairCount: pairFingerprints.length,
    pairwiseObservedStdDevs: pairFingerprints.map((pairFingerprint, index) => ({
        pairFingerprint,
        observedPairedStdDevMicros: 150000 - index
    })),
    method: 'chi-square-one-sided-upper-confidence-bound-v1',
    independentPromptCount: 30,
    confidenceBasisPoints: 9500,
    observedPairedStdDevMicros: 150000
    });
};
const {
    buildHarnessEnvelope,
    buildTrustJudgeCellId,
    normalizeHarnessInvocationParameters
} = require('../../src/services/benchmark/harnessBrokerClient');
const {
    normalizeBenchmarkTarget
} = require('../../../shared/benchmarkTargetContract');

const clone = (value) => JSON.parse(JSON.stringify(value));
const sourceBatchId = (character = 'd') => `batch_${character.repeat(32)}`;
const candidateId = (character) => `candidate_${character.repeat(32)}`;
const promptId = (character) => `prompt_${character.repeat(32)}`;
const TRUST_PROMPT_IDS = Object.freeze(Array.from(
    { length: 21 },
    (_, index) => `prompt_${(index + 1).toString(16).padStart(32, '0')}`
));
const sourceCompletionTimes = new Map();
const sourceEvidenceRows = new Map();

const PRODUCT = Object.freeze({
    revision: 'a'.repeat(40),
    coreImageDigest: `sha256:${'b'.repeat(64)}`,
    benchmarkImageDigest: `sha256:${'c'.repeat(64)}`,
    ragImageDigest: `sha256:${'d'.repeat(64)}`
});

function executionWorkerIdentity(model, digest, runtimeFingerprint, environmentFingerprint) {
    return {
        harness: { name: 'candidate-harness', version: '1.0.0' },
        adapter: { name: 'candidate-adapter', version: '1.0.0' },
        provider: { name: 'candidate-provider', version: '1.0.0' },
        model: {
            name: model,
            version: '1.0.0',
            digest,
            runtimeFingerprint
        },
        api: { name: 'candidate-api', version: '1.0.0' },
        environment: { id: 'candidate-env', version: '1.0.0', fingerprint: environmentFingerprint }
    };
}

const SOURCE_IDENTITIES = Object.freeze([
    {
        candidateId: candidateId('a'),
        sourceIdentity: {
            model: 'model-a',
            host: 'opaque-test-host',
            modelDigest: `sha256:${'1'.repeat(64)}`,
            artifactDigest: `sha256:${'2'.repeat(64)}`,
            inferenceContractFingerprint: '3'.repeat(64),
            executionTargetFingerprint: '4'.repeat(64),
            workerIdentityFingerprint: workerFingerprint(executionWorkerIdentity(
                'model-a',
                `sha256:${'1'.repeat(64)}`,
                '3'.repeat(64),
                '3'.repeat(64)
            )),
            toolsFingerprint: '1'.repeat(64),
            policiesFingerprint: '2'.repeat(64),
            executionProfile: 'portable',
            envelopeSetFingerprint: '0'.repeat(64)
        }
    },
    {
        candidateId: candidateId('b'),
        sourceIdentity: {
            model: 'model-b',
            host: 'opaque-test-host',
            modelDigest: `sha256:${'5'.repeat(64)}`,
            artifactDigest: `sha256:${'6'.repeat(64)}`,
            inferenceContractFingerprint: '7'.repeat(64),
            executionTargetFingerprint: '8'.repeat(64),
            workerIdentityFingerprint: workerFingerprint(executionWorkerIdentity(
                'model-b',
                `sha256:${'5'.repeat(64)}`,
                '7'.repeat(64),
                '7'.repeat(64)
            )),
            toolsFingerprint: '3'.repeat(64),
            policiesFingerprint: '4'.repeat(64),
            executionProfile: 'portable',
            envelopeSetFingerprint: '0'.repeat(64)
        }
    }
]);

const WORKER_JUDGE_IDENTITY = Object.freeze({
    harness: { name: 'judge-harness', version: '1.0.0' },
    adapter: { name: 'judge-adapter', version: '1.0.0' },
    provider: { name: 'judge-provider', version: '1.0.0' },
    model: {
        name: 'judge-model',
        version: '1.0.0',
        digest: `sha256:${'7'.repeat(64)}`,
        runtimeFingerprint: '8'.repeat(64)
    },
    api: { name: 'judge-api', version: '1.0.0' },
    environment: { id: 'judge-env', version: '1.0.0', fingerprint: '6'.repeat(64) }
});

const JUDGE_TARGET = Object.freeze(normalizeBenchmarkTarget({
    id: 'trust-integration-judge',
    label: 'Trust integration judge',
    executionKind: 'harness',
    mode: 'isolated_model',
    tier: 'free_cloud',
    provider: WORKER_JUDGE_IDENTITY.provider.name,
    model: WORKER_JUDGE_IDENTITY.model.name,
    modelVersion: WORKER_JUDGE_IDENTITY.model.version,
    harness: WORKER_JUDGE_IDENTITY.harness,
    adapter: WORKER_JUDGE_IDENTITY.adapter,
    profile: {
        id: WORKER_JUDGE_IDENTITY.environment.id,
        version: WORKER_JUDGE_IDENTITY.environment.version,
        fingerprint: WORKER_JUDGE_IDENTITY.environment.fingerprint
    },
    api: WORKER_JUDGE_IDENTITY.api,
    contextWindow: 131072,
    capabilities: { candidate: false, judge: true },
    pricing: {
        kind: 'free',
        currency: 'USD',
        source: 'integration-fixture',
        effectiveAt: null,
        inputNanodollarsPerMillion: 0,
        outputNanodollarsPerMillion: 0,
        callNanodollars: 0
    },
    available: true,
    observedAt: '2026-01-01T00:00:00.000Z',
    catalogFingerprint: '5'.repeat(64)
}));
const JUDGE_INVOCATION = Object.freeze(normalizeHarnessInvocationParameters({
    temperature: 0,
    seed: 7,
    maxTokens: 1024,
    timeoutMs: 60000
}, { role: 'judge' }));
const JUDGE_POLICY_ENVELOPE = buildHarnessEnvelope({
    batchId: 'fixture-batch',
    cellId: 'fixture-cell',
    target: JUDGE_TARGET,
    promptText: 'fixture-prompt',
    parameters: JUDGE_INVOCATION,
    role: 'judge'
});
const RUNTIME_RUBRIC = Object.freeze({
    schema: 'agentx.benchmark-trust-judge-runtime-rubric/v1',
    scoringMethod: 'llm_judge',
    scorerVersion: 'trust-test-v1',
    scorerComponents: { judge_prompt: 2, judge_parsing: 2 },
    promptContract: 'dynamic-judge-prompt',
    implementationManifest: {
        sourceFiles: [
            'benchmarkTrustCampaignRuntime', 'categories', 'formatComplianceScorer', 'judgeCall',
            'judgeConfidence', 'judgeExecutor', 'jsonUtils', 'qualityScorer', 'scoringConfigs'
        ].map((module, index) => ({ module, sha256: String(index + 1).padStart(64, '0') })),
        loadedFunctions: Object.fromEntries([
            'buildDynamicJudgePrompt', 'buildPromptData', 'computeMonolithicJudgeScore', 'getScoringDimensions',
            'judgeConfidenceAssess', 'parseJudgeJsonResponse', 'scoreFormatCompliance',
            'scoreResponse', 'stripMarkdownCodeFences'
        ].map((name, index) => [name, String(index + 11).padStart(64, '0')])),
        scoringConfigsFingerprint: 'f'.repeat(64)
    },
    resultContract: JUDGE_POLICY_ENVELOPE.resultContract,
    executionProfile: 'portable',
    toolsFingerprint: JUDGE_POLICY_ENVELOPE.tools.schemaFingerprint,
    policiesFingerprint: JUDGE_POLICY_ENVELOPE.policies.fingerprint,
    judgeInvocation: JUDGE_INVOCATION
});
const JUDGE = Object.freeze({
    qualificationReceiptId: '9'.repeat(64),
    identityFingerprint: workerFingerprint(WORKER_JUDGE_IDENTITY),
    rubricFingerprint: workerFingerprint(RUNTIME_RUBRIC),
    corpusFingerprint: 'c'.repeat(64),
    holdoutFingerprint: 'd'.repeat(64),
    qualificationStatus: 'qualified',
    validUntil: '2099-09-15T12:00:00.000Z'
});

const SCORE_EVIDENCE_BASE = Object.freeze({
    judgeTargetFingerprint: JUDGE_TARGET.fingerprint,
    qualityCohortFingerprint: 'a'.repeat(64),
    scoringMethod: 'llm_judge',
    scorerVersion: 'trust-test-v1',
    workerIdentityFingerprint: JUDGE.identityFingerprint,
    toolsFingerprint: JUDGE_POLICY_ENVELOPE.tools.schemaFingerprint,
    policiesFingerprint: JUDGE_POLICY_ENVELOPE.policies.fingerprint,
    executionProfile: 'portable',
    judgeInvocation: JUDGE_INVOCATION,
    runtimeRubric: RUNTIME_RUBRIC
});
const SCORE_EVIDENCE = Object.freeze({
    ...SCORE_EVIDENCE_BASE,
    judgeBindingFingerprint: computeBenchmarkTrustJudgeBindingFingerprint({
        judge: JUDGE,
        scoreEvidence: SCORE_EVIDENCE_BASE
    })
});

const FRESHNESS_POLICY = Object.freeze({
    schema: FRESHNESS_POLICY_SCHEMA,
    staleAfterSeconds: 7 * 24 * 60 * 60,
    expiresAfterSeconds: 30 * 24 * 60 * 60
});

function sourceResultFixtures() {
    const rows = [];
    for (const [candidateIndex, candidate] of SOURCE_IDENTITIES.entries()) {
        for (const [promptIndex, exactPromptId] of TRUST_PROMPT_IDS.entries()) {
            for (let repeatIndex = 0; repeatIndex < 2; repeatIndex += 1) {
                const qualityScore = candidateIndex === 0
                    ? [9, 9.1, 8.9][promptIndex % 3]
                    : 1;
                const row = {
                    model: candidate.sourceIdentity.model,
                    model_digest: candidate.sourceIdentity.modelDigest,
                    host: candidate.sourceIdentity.host,
                    execution_target: { fingerprint: candidate.sourceIdentity.executionTargetFingerprint },
                    judge_target: clone(JUDGE_TARGET),
                    quality_cohort_fingerprint: SCORE_EVIDENCE.qualityCohortFingerprint,
                    prompt: `opaque-prompt-${promptIndex}`,
                    prompt_name: `prompt-${promptIndex}`,
                    prompt_level: 1,
                    prompt_category: 'reasoning',
                    scoring_type: 'reasoning',
                    scoring_plan: 'llm_judge',
                    response: `opaque-response-${candidateIndex}-${promptIndex}-${repeatIndex}`,
                    judge_prompt: `judge-prompt-${candidateIndex}-${promptIndex}-${repeatIndex}`,
                    judge_raw_response: JSON.stringify({ overall: qualityScore }),
                    success: true,
                    scoring_method: SCORE_EVIDENCE.scoringMethod,
                    scorer_version: SCORE_EVIDENCE.scorerVersion,
                    // Keep prompt-level paired differences non-constant while
                    // leaving a comfortably significant preregistered winner.
                    quality_score: qualityScore,
                    quality_breakdown: { overall: qualityScore },
                    judge_reported_overall: qualityScore,
                    format_score: null,
                    format_compliant: null,
                    composite_score: candidateIndex === 0
                        ? [90, 91, 89][promptIndex % 3]
                        : 10,
                    excluded_from_leaderboard: false,
                    execution_settings: {
                        artifact_digest: candidate.sourceIdentity.artifactDigest,
                        inference_contract_fingerprint: candidate.sourceIdentity.inferenceContractFingerprint
                    },
                    repeat_index: repeatIndex,
                    repeat_total: 2,
                    trust_candidate_id: candidate.candidateId,
                    trust_prompt_id: exactPromptId,
                    timestamp: new Date('2026-01-01T00:00:00.000Z'),
                    updated_at: new Date('2026-01-01T00:00:00.000Z')
                };
                row.trust_execution_receipt = normalizeWorkerReceipt({
                    schema: 'agentx.worker-receipt/v1',
                    schemaVersion: 1,
                    executionProfile: candidate.sourceIdentity.executionProfile,
                    identity: executionWorkerIdentity(
                        candidate.sourceIdentity.model,
                        candidate.sourceIdentity.modelDigest,
                        candidate.sourceIdentity.inferenceContractFingerprint,
                        candidate.sourceIdentity.inferenceContractFingerprint
                    ),
                    fingerprints: {
                        prompt: workerFingerprint(row.prompt),
                        tools: candidate.sourceIdentity.toolsFingerprint,
                        policies: candidate.sourceIdentity.policiesFingerprint,
                        envelope: workerFingerprint({
                            lane: 'benchmark-candidate-execution',
                            candidateId: candidate.candidateId,
                            promptId: exactPromptId,
                            repeatIndex,
                            response: row.response
                        })
                    },
                    finalState: 'succeeded',
                    failure: { classification: null, code: null },
                    usage: {
                        durationMs: 1,
                        inputTokens: 1,
                        outputTokens: 1,
                        totalTokens: 2,
                        costNanodollars: 0,
                        turns: 1,
                        toolCalls: 0
                    },
                    toolErrors: [],
                    humanInterventions: [],
                    evidence: { patches: [], artifacts: [], tests: [] },
                    violations: [],
                    result: {
                        contractSatisfied: true,
                        fingerprint: workerFingerprint(row.response)
                    }
                });
                row.trust_judge_receipt = normalizeWorkerReceipt({
                    schema: 'agentx.worker-receipt/v1',
                    schemaVersion: 1,
                    executionProfile: SCORE_EVIDENCE.executionProfile,
                    identity: clone(WORKER_JUDGE_IDENTITY),
                    fingerprints: {
                        prompt: workerFingerprint(row.judge_prompt),
                        tools: SCORE_EVIDENCE.toolsFingerprint,
                        policies: SCORE_EVIDENCE.policiesFingerprint,
                        envelope: buildHarnessEnvelope({
                            batchId: String(row.batch_id),
                            cellId: buildTrustJudgeCellId(row),
                            target: JUDGE_TARGET,
                            promptText: row.judge_prompt,
                            parameters: JUDGE_INVOCATION,
                            role: 'judge'
                        }).fingerprint
                    },
                    finalState: 'succeeded',
                    failure: { classification: null, code: null },
                    usage: {
                        durationMs: 1,
                        inputTokens: 1,
                        outputTokens: 1,
                        totalTokens: 2,
                        costNanodollars: 0,
                        turns: 1,
                        toolCalls: 0
                    },
                    toolErrors: [],
                    humanInterventions: [],
                    evidence: { patches: [], artifacts: [], tests: [] },
                    violations: [],
                    result: {
                        contractSatisfied: true,
                        fingerprint: workerFingerprint(row.judge_raw_response)
                    }
                });
                row.execution_receipt = clone(row.trust_execution_receipt);
                row.judge_receipt = clone(row.trust_judge_receipt);
                rows.push(row);
            }
        }
    }
    return rows;
}

const SOURCE_RESULT_COUNT = 84;

function sourceContextFixture(sourceId = sourceBatchId(), sourceResults = sourceResultFixtures()) {
    const firstByPrompt = new Map();
    for (const row of sourceResults) {
        if (!firstByPrompt.has(row.trust_prompt_id)) firstByPrompt.set(row.trust_prompt_id, row);
    }
    const candidateIds = SOURCE_IDENTITIES.map(candidate => candidate.candidateId);
    const promptIds = [...firstByPrompt.keys()].sort();
    const promptSamplingPolicy = buildBenchmarkTrustPromptSamplingPolicy(
        campaignArtifact,
        promptExecutionConfig,
        [...firstByPrompt.values()].map(row => computePromptSourceFingerprint(row))
    );
    const frozenVarianceBasis = varianceBasis({
        candidateBindings: SOURCE_IDENTITIES.map(candidate => ({
            targetFingerprint: candidate.sourceIdentity.executionTargetFingerprint,
            modelDigest: candidate.sourceIdentity.modelDigest,
            artifactDigest: candidate.sourceIdentity.artifactDigest,
            inferenceContractFingerprint: candidate.sourceIdentity.inferenceContractFingerprint
        })),
        rubricFingerprint: JUDGE.rubricFingerprint,
        promptSamplingPolicy
    });
    const powerFields = buildBenchmarkTrustPowerAnalysisFields({
        alpha: 0.05,
        mde: 0.1,
        poweredAlternativeEffect: 10,
        candidateIds,
        targetPowerBasisPoints: 8000,
        assumedMaxPairedStdDevMicros: frozenVarianceBasis.upperConfidenceBoundMicros,
        varianceBasis: frozenVarianceBasis
    });
    const analysisPlan = {
        alpha: 0.05,
        mde: 0.1,
        poweredAlternativeEffect: 10,
        equivalenceMargin: 0.1,
        repeatCount: 2,
        candidateInferenceParameters: {
            temperature: 0,
            topP: 1,
            seed: 7,
            maxTokens: 1024,
            timeoutMs: 60000
        },
        promptSamplingPolicy,
        variancePilotAttestationId: '7'.repeat(64),
        ...powerFields,
        candidateIds,
        promptIds
    };
    const analysisPlanFingerprint = crypto.createHash('sha256').update(stableSerialize({
        schema: 'agentx.benchmark-trust-analysis-plan/v2',
        plan: analysisPlan
    })).digest('hex');
    return {
        schema: SOURCE_CONTEXT_SCHEMA,
        sourceBatchId: sourceId,
        claimScope: 'capability',
        product: { ...PRODUCT },
        campaign: {
            campaignId: `campaign_${'c'.repeat(32)}`,
            artifact: campaignArtifact
        },
        inferenceProfile: {
            artifact: { schema: 'trust-test-inference-profile/v1', profile: 'controlled' }
        },
        prompts: [...firstByPrompt.entries()].map(([exactPromptId, row]) => ({
            promptId: exactPromptId,
            fingerprint: computePromptSourceFingerprint(row)
        })).sort((left, right) => left.promptId.localeCompare(right.promptId)),
        candidates: clone(SOURCE_IDENTITIES).map(candidate => ({
            ...candidate,
            sourceIdentity: {
                ...candidate.sourceIdentity,
                envelopeSetFingerprint: computeBenchmarkTrustExecutionEnvelopeSetFingerprint({
                    candidateId: candidate.candidateId,
                    entries: sourceResults
                        .filter(row => row.trust_candidate_id === candidate.candidateId)
                        .map(row => ({
                            promptId: row.trust_prompt_id,
                            repeatIndex: row.repeat_index,
                            envelopeFingerprint: row.trust_execution_receipt.fingerprints.envelope
                        }))
                })
            }
        })),
        judge: clone(JUDGE),
        scoreEvidence: clone(SCORE_EVIDENCE),
        freshnessPolicy: clone(FRESHNESS_POLICY),
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

function bodyFixture(options = {}) {
    const sourceId = options.sourceId || sourceBatchId();
    const sourceResults = options.sourceResults
        || sourceEvidenceRows.get(sourceId)
        || sourceResultFixtures();
    const sourceContext = options.sourceContext || sourceContextFixture(sourceId, sourceResults);
    const completedAt = options.completedAt || sourceCompletionTimes.get(sourceId) || new Date();
    const projection = buildBenchmarkTrustSourceProjection({
        context: sourceContext,
        results: sourceResults,
        sourceBatchId: sourceId
    });
    const freshness = buildBenchmarkTrustFreshnessProjection({
        freshnessPolicy: sourceContext.freshnessPolicy,
        completedAt,
        judgeValidUntil: sourceContext.judge.validUntil,
        now: new Date()
    });
    return {
        schema: BENCHMARK_TRUST_RECEIPT_SCHEMA,
        createdAt: freshness.createdAt,
        validUntil: freshness.validUntil,
        claimScope: projection.context.claimScope,
        product: projection.context.product,
        execution: projection.execution,
        judge: projection.judge,
        statistics: projection.statistics,
        axes: {
            evidenceStatus: projection.evidenceStatus,
            decisionOutcome: projection.decisionOutcome,
            freshnessStatus: freshness.freshnessStatus
        },
        privacy: {
            containsRawPrompts: false,
            containsRawResponses: false,
            containsPrivateEnvironmentIdentity: false,
            containsProviderPayloads: false,
            containsSecrets: false
        }
    };
}

async function createLinkedBatch(
    sourceId = sourceBatchId(),
    overrides = {},
    {
        seedEvidence = true,
        sourceResults = sourceResultFixtures(),
        sourceContext = sourceContextFixture(sourceId, sourceResults)
    } = {}
) {
    const desiredStatus = overrides.status || 'completed';
    const batch = await BenchmarkBatch.create({
        run_name: overrides.run_name || `trust-${sourceId}`,
        host: overrides.host || 'opaque-test-host',
        models: overrides.models || ['model-a', 'model-b'],
        levels: overrides.levels || [1],
        total_tests: sourceResults.length,
        completed: 0,
        status: 'pending',
        trust_batch_id: sourceId
    });
    let committedAt = null;
    if (sourceContext) {
        ({ committedAt } = await BenchmarkBatch.commitTrustEvidenceContext(batch._id, sourceContext));
    }
    const startTime = committedAt ? new Date(committedAt) : new Date();
    const evidenceTime = new Date(Math.max(Date.now(), startTime.getTime()));
    const terminalTrustBatch = sourceContext != null && desiredStatus !== 'pending';
    if (seedEvidence) {
        for (const row of sourceResults) {
            row.timestamp = new Date(evidenceTime);
            row.updated_at = new Date(evidenceTime);
        }
        const storedRows = sourceResults.map(row => ({
            ...runtimeTrustRow(row, batch._id),
            timestamp: new Date(evidenceTime),
            updated_at: new Date(evidenceTime),
            trust_evidence_sealed: terminalTrustBatch
        }));
        await BenchmarkResult.collection.insertMany(storedRows);
        sourceEvidenceRows.set(sourceId, clone(storedRows));
    }
    const completedAt = overrides.completed_at
        || (desiredStatus === 'pending' ? null : new Date(Math.max(Date.now(), evidenceTime.getTime())));
    const finalState = {
        ...overrides,
        status: desiredStatus,
        completed: overrides.completed ?? (seedEvidence ? sourceResults.length : 0),
        started_at: desiredStatus === 'pending' ? null : (overrides.started_at || startTime),
        execution_started_at: desiredStatus === 'pending'
            ? null
            : (overrides.execution_started_at || startTime),
        completed_at: completedAt,
        updated_at: completedAt,
        trust_evidence_sealed: terminalTrustBatch,
        trust_evidence_finalized_at: terminalTrustBatch ? completedAt : null
    };
    delete finalState.trust_evidence_context;
    delete finalState.trust_evidence_committed_at;
    await BenchmarkBatch.collection.updateOne({ _id: batch._id }, { $set: finalState });
    if (finalState.completed_at) sourceCompletionTimes.set(sourceId, new Date(finalState.completed_at));
    return BenchmarkBatch.findById(batch._id)
        .select('+trust_evidence_context +trust_evidence_committed_at +trust_evidence_finalized_at');
}

async function createRunningTrustBatch(
    sourceId = sourceBatchId(),
    sourceResults = sourceResultFixtures(),
    sourceContext = sourceContextFixture(sourceId, sourceResults)
) {
    const batch = await BenchmarkBatch.create({
        run_name: `running-trust-${sourceId}`,
        host: 'opaque-test-host',
        models: ['model-a', 'model-b'],
        levels: [1],
        total_tests: sourceResults.length,
        status: 'pending',
        trust_batch_id: sourceId
    });
    const { committedAt } = await BenchmarkBatch.commitTrustEvidenceContext(batch._id, sourceContext);
    await BenchmarkBatch.updateOne(
        { _id: batch._id },
        {
            $set: {
                status: 'running',
                started_at: committedAt,
                execution_started_at: committedAt
            }
        }
    );
    return {
        batch: await BenchmarkBatch.findById(batch._id)
            .select('+trust_evidence_context +trust_evidence_committed_at'),
        sourceResults,
        sourceContext
    };
}

function runtimeTrustRow(row, batchId) {
    const runtimeRow = { ...clone(row), batch_id: batchId };
    delete runtimeRow.timestamp;
    delete runtimeRow.updated_at;
    delete runtimeRow.trust_evidence_sealed;
    if (runtimeRow.trust_judge_receipt?.fingerprints) {
        const judgeEnvelope = buildHarnessEnvelope({
            batchId: String(batchId),
            cellId: buildTrustJudgeCellId(runtimeRow),
            target: runtimeRow.judge_target,
            promptText: runtimeRow.judge_prompt,
            parameters: JUDGE_INVOCATION,
            role: 'judge'
        });
        runtimeRow.trust_judge_receipt.fingerprints.envelope = judgeEnvelope.fingerprint;
        const { fingerprint: _previousJudgeReceiptFingerprint, ...judgeReceiptBody } =
            runtimeRow.trust_judge_receipt;
        runtimeRow.trust_judge_receipt = normalizeWorkerReceipt(judgeReceiptBody);
        runtimeRow.judge_receipt = clone(runtimeRow.trust_judge_receipt);
    }
    return runtimeRow;
}

function storeVerifiedReceipt(receipt, verifyExternalSourceEvidence = null) {
    return storeBenchmarkTrustReceipt(receipt, verifyExternalSourceEvidence
        ? { verifyExternalSourceEvidence }
        : {});
}

let mongoServer;

beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create({ binary: { version: '7.0.24' } });
    await mongoose.connect(mongoServer.getUri(), { dbName: 'benchmark_trust_receipt_store_test' });
    await Promise.all([BenchmarkBatch.init(), BenchmarkTrustReceipt.init(), JudgeGroundTruth.init()]);
});

beforeEach(async () => {
    // Raw collection cleanup is deliberately test-only. The receipt model API
    // rejects delete operations because production receipts are append-only.
    await BenchmarkTrustReceipt.collection.deleteMany({});
    await BenchmarkTrustEvidenceLock.collection.deleteMany({});
    await BenchmarkResult.collection.deleteMany({});
    await BenchmarkTimelineEntry.collection.deleteMany({});
    await BenchmarkBatch.collection.deleteMany({});
    await JudgeGroundTruth.collection.deleteMany({});
    delete process.env[TRUST_ROOTS_ENV];
    delete process.env[REVOCATIONS_ENV];
    delete process.env[MIN_REVOCATION_VERSION_ENV];
    delete process.env[REVOCATION_SNAPSHOT_ID_ENV];
    sourceCompletionTimes.clear();
    sourceEvidenceRows.clear();
});

afterAll(async () => {
    delete process.env[TRUST_ROOTS_ENV];
    delete process.env[REVOCATIONS_ENV];
    delete process.env[MIN_REVOCATION_VERSION_ENV];
    delete process.env[REVOCATION_SNAPSHOT_ID_ENV];
    await mongoose.disconnect();
    await mongoServer.stop();
});

describe('BenchmarkTrustReceipt append-only store', () => {
    test('rejects provenance update pipelines and provenance $setOnInsert bypasses', async () => {
        // Test-only historical evidence fixture. Qualified creation has no
        // ordinary Product write authority in the foundation candidate.
        const historical = {
            name: 'blind-human-proof',
            prompt: 'opaque prompt',
            response: 'opaque response',
            category: 'reasoning',
            expert_scores: { overall: 7 },
            expert_rationale: 'blind review',
            provenance_class: 'independent_human_score',
            review_protocol: 'blind_independent',
            active: true,
            createdAt: new Date(),
            updatedAt: new Date()
        };
        const inserted = await JudgeGroundTruth.collection.insertOne(historical);
        const row = { _id: inserted.insertedId };

        await expect(JudgeGroundTruth.updateOne(
            { _id: row._id },
            [{ $set: { review_protocol: 'judge_visible_single_review' } }]
        )).rejects.toThrow(/update pipelines are not allowed/);
        await expect(JudgeGroundTruth.updateOne(
            { name: 'upserted-human-proof' },
            { $setOnInsert: {
                provenance_class: 'independent_human_score',
                review_protocol: 'judge_visible_single_review'
            } },
            { upsert: true }
        )).rejects.toThrow(/cannot be changed through \$setOnInsert/);
        await expect(JudgeGroundTruth.updateOne(
            { name: 'contradictory-human-proof' },
            { $set: {
                prompt: 'opaque prompt',
                response: 'opaque response',
                category: 'reasoning',
                expert_scores: { overall: 7 },
                expert_rationale: 'not actually blind',
                provenance_class: 'independent_human_score',
                review_protocol: 'judge_visible_single_review'
            } },
            { upsert: true }
        )).rejects.toThrow(/complete, internally consistent review pair/);
        await expect(JudgeGroundTruth.bulkWrite([{
            updateOne: {
                filter: { _id: row._id },
                update: { $set: { review_protocol: 'judge_visible_single_review' } }
            }
        }])).rejects.toThrow(/bulkWrite is not allowed/);

        const concurrent = await Promise.allSettled([
            JudgeGroundTruth.updateOne(
                { _id: row._id },
                { $set: { provenance_class: 'independent_human_score' } }
            ),
            JudgeGroundTruth.updateOne(
                { _id: row._id },
                { $set: { review_protocol: 'judge_visible_single_review' } }
            )
        ]);
        expect(concurrent.map(result => result.status)).toEqual(['rejected', 'rejected']);

        await expect(JudgeGroundTruth.findById(row._id).lean()).resolves.toMatchObject({
            provenance_class: 'independent_human_score',
            review_protocol: 'blind_independent'
        });
        await expect(JudgeGroundTruth.countDocuments({ name: 'upserted-human-proof' })).resolves.toBe(0);
        await expect(JudgeGroundTruth.countDocuments({ name: 'contradictory-human-proof' })).resolves.toBe(0);
    });

    test('mutex is owner-bound, fail-closed when busy, and released after task failure', async () => {
        const ownerToken = await acquireBenchmarkTrustEvidenceLock('integration-lock-owner');
        await expect(acquireBenchmarkTrustEvidenceLock('integration-lock-contender', { waitMs: 0 }))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_MUTATION_BUSY' });
        await expect(releaseBenchmarkTrustEvidenceLock('0'.repeat(64)))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_LOCK_LOST' });
        await expect(BenchmarkTrustEvidenceLock.countDocuments({})).resolves.toBe(1);
        await releaseBenchmarkTrustEvidenceLock(ownerToken);
        await expect(BenchmarkTrustEvidenceLock.countDocuments({})).resolves.toBe(0);

        const taskError = new Error('expected task failure');
        await expect(withBenchmarkTrustEvidenceLock(
            'integration-lock-error-release',
            async () => { throw taskError; }
        )).rejects.toBe(taskError);
        await expect(BenchmarkTrustEvidenceLock.countDocuments({})).resolves.toBe(0);

        await expect(withBenchmarkTrustEvidenceLock(
            'integration-lock-release-loss',
            async () => {
                await BenchmarkTrustEvidenceLock.collection.deleteMany({});
            }
        )).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_EVIDENCE_LOCK_LOST' });
    });

    test('creates durable source-batch and append-only receipt indexes', async () => {
        const [receiptIndexes, batchIndexes] = await Promise.all([
            BenchmarkTrustReceipt.collection.indexes(),
            BenchmarkBatch.collection.indexes()
        ]);
        const receipts = new Map(receiptIndexes.map((index) => [index.name, index]));
        const batches = new Map(batchIndexes.map((index) => [index.name, index]));

        expect(receipts.get('uniq_benchmark_trust_receipt_id')).toMatchObject({
            key: { receiptId: 1 },
            unique: true
        });
        expect(receipts.get('benchmark_trust_receipt_source_batch_read').key)
            .toEqual({ sourceBatchId: 1, issuedAt: -1, receiptId: 1 });
        expect(receipts.get('benchmark_trust_receipt_decision_read').key)
            .toEqual({ decisionFingerprint: 1, issuedAt: -1 });
        expect(receipts.get('benchmark_trust_receipt_status_read').key).toEqual({
            evidenceStatus: 1,
            freshnessStatus: 1,
            decisionOutcome: 1,
            issuedAt: -1
        });
        expect(batches.get('uniq_benchmark_batch_trust_batch_id')).toMatchObject({
            key: { trust_batch_id: 1 },
            unique: true
        });
        expect(batches.get('uniq_benchmark_batch_trust_campaign_spec_id')).toMatchObject({
            key: { trust_campaign_spec_id: 1 },
            unique: true
        });
    });

    test('consumes every strict CampaignSpec id at most once', async () => {
        const specId = 'f'.repeat(64);
        const first = await BenchmarkBatch.create({
            run_name: 'strict-campaign-reservation',
            host: 'harness',
            models: ['model-a'],
            levels: [1],
            total_tests: 1,
            status: 'failed',
            trust_campaign_spec_id: specId
        });

        await expect(BenchmarkBatch.create({
            run_name: 'strict-campaign-replay',
            host: 'harness',
            models: ['model-a'],
            levels: [1],
            total_tests: 1,
            status: 'pending',
            trust_campaign_spec_id: specId
        })).rejects.toMatchObject({ code: 11000 });

        await expect(BenchmarkBatch.deleteOne({ _id: first._id }))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_IMMUTABLE' });
    });

    test('marks an abandoned one-shot reservation failed without making it replayable', async () => {
        const specId = 'e'.repeat(64);
        const reserved = await BenchmarkBatch.create({
            run_name: 'abandoned-strict-campaign-reservation',
            host: 'harness',
            models: ['model-a'],
            levels: [1],
            total_tests: 1,
            status: 'pending',
            trust_campaign_spec_id: specId
        });
        await BenchmarkBatch.collection.updateOne(
            { _id: reserved._id },
            { $set: { created_at: new Date(Date.now() - 60_000) } }
        );

        await BenchmarkBatch.cleanupStale(1);
        await expect(BenchmarkBatch.findById(reserved._id).lean()).resolves.toMatchObject({
            status: 'failed',
            failure_reason: 'trust_preregistration_abandoned'
        });
        await expect(BenchmarkBatch.create({
            run_name: 'abandoned-strict-campaign-replay',
            host: 'harness',
            models: ['model-a'],
            levels: [1],
            total_tests: 1,
            status: 'pending',
            trust_campaign_spec_id: specId
        })).rejects.toMatchObject({ code: 11000 });
    });

    test('stores only a strictly verified payload linked to a durable opaque batch', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        expect(receipt.axes).toMatchObject({
            evidenceStatus: 'complete',
            decisionOutcome: 'winner'
        });
        const stored = await storeVerifiedReceipt(receipt);

        expect(stored).toEqual({ created: true, receipt });
        const raw = await BenchmarkTrustReceipt.findOne({ receiptId: receipt.receiptId }).lean();
        expect(raw.canonicalPayload).toBe(serializeBenchmarkTrustReceipt(receipt));
        expect(raw.sourceBatchId).toBe(sourceId);
        expect(raw).not.toHaveProperty('batchId');
        await expect(getBenchmarkTrustReceiptById(receipt.receiptId)).resolves.toEqual(receipt);

        const unlinked = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: sourceBatchId('e'),
            campaignCharacter: 'e'
        }));
        await expect(storeVerifiedReceipt(unlinked)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_BATCH_NOT_FOUND'
        });
    });

    test('commits trust context with server time only before start and makes it immutable', async () => {
        const sourceId = sourceBatchId('0');
        const context = sourceContextFixture(sourceId);
        const batch = await BenchmarkBatch.create({
            run_name: 'context-commit',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: SOURCE_RESULT_COUNT,
            status: 'pending',
            trust_batch_id: sourceId
        });

        const before = Date.now();
        const committed = await BenchmarkBatch.commitTrustEvidenceContext(batch._id, context);
        const after = Date.now();
        expect(committed.committedAt).toBeInstanceOf(Date);
        expect(committed.committedAt.getTime()).toBeGreaterThanOrEqual(before);
        expect(committed.committedAt.getTime()).toBeLessThanOrEqual(after);
        await expect(BenchmarkBatch.findById(batch._id)
            .select('+trust_evidence_context +trust_evidence_committed_at')
            .lean()).resolves.toMatchObject({
            trust_evidence_context: context,
            trust_evidence_committed_at: committed.committedAt
        });

        const immutable = { code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE };
        await expect(BenchmarkBatch.commitTrustEvidenceContext(batch._id, context))
            .rejects.toMatchObject(immutable);
        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            { $set: { 'trust_evidence_context.claimScope': 'deployment_fit' } }
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkBatch.findOneAndUpdate(
            { _id: batch._id },
            { $set: { trust_evidence_committed_at: new Date(0) } }
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            { $rename: { run_name: 'trust_evidence_context' } }
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            [{ $set: { trust_evidence_context: { backdated: true } } }]
        )).rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            [{
                $replaceWith: {
                    $setField: {
                        field: { $concat: ['trust_', 'evidence_context'] },
                        input: '$$ROOT',
                        value: { backdated: true }
                    }
                }
            }]
        )).rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkBatch.bulkWrite([{
            updateOne: {
                filter: { _id: batch._id },
                update: { $set: { trust_evidence_context: { backdated: true } } }
            }
        }])).rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE });

        const document = await BenchmarkBatch.findById(batch._id)
            .select('+trust_evidence_context +trust_evidence_committed_at');
        document.trust_evidence_context = { backdated: true };
        await expect(document.save()).rejects.toMatchObject(immutable);

        await expect(BenchmarkBatch.create({
            run_name: 'caller-backdated-context',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: SOURCE_RESULT_COUNT,
            status: 'pending',
            trust_batch_id: sourceBatchId('1'),
            trust_evidence_context: context,
            trust_evidence_committed_at: new Date(0)
        })).rejects.toMatchObject(immutable);

        const started = await BenchmarkBatch.create({
            run_name: 'already-started-context',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: SOURCE_RESULT_COUNT,
            status: 'pending',
            trust_batch_id: sourceBatchId('2')
        });
        await BenchmarkBatch.collection.updateOne(
            { _id: started._id },
            { $set: { started_at: new Date() } }
        );
        await expect(BenchmarkBatch.commitTrustEvidenceContext(
            started._id,
            sourceContextFixture(sourceBatchId('2'))
        )).rejects.toMatchObject(immutable);
    });

    test('atomically refuses a legacy terminal update when Trust context wins after the precheck', async () => {
        const sourceId = sourceBatchId('a');
        const context = sourceContextFixture(sourceId);
        const batch = await BenchmarkBatch.create({
            run_name: 'terminal-context-race',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: SOURCE_RESULT_COUNT,
            status: 'pending',
            trust_batch_id: sourceId
        });
        const originalExists = BenchmarkBatch.exists.bind(BenchmarkBatch);
        const existsSpy = jest.spyOn(BenchmarkBatch, 'exists')
            .mockImplementationOnce(async () => {
                await BenchmarkBatch.collection.updateOne(
                    { _id: batch._id },
                    {
                        $set: {
                            trust_evidence_context: context,
                            trust_evidence_committed_at: new Date()
                        }
                    }
                );
                return null;
            })
            .mockImplementation((...args) => originalExists(...args));

        try {
            const update = await BenchmarkBatch.updateOne(
                { _id: batch._id },
                { $set: { status: 'failed', completed_at: new Date() } }
            );
            expect(update.matchedCount).toBe(0);
        } finally {
            existsSpy.mockRestore();
        }
        await expect(BenchmarkBatch.findById(batch._id)
            .select('+trust_evidence_context')
            .lean()).resolves.toMatchObject({
            status: 'pending',
            trust_evidence_context: context,
            completed_at: null
        });
    });

    test('atomically refuses a legacy terminal document save when Trust context wins after the precheck', async () => {
        const sourceId = sourceBatchId('b');
        const context = sourceContextFixture(sourceId);
        const batch = await BenchmarkBatch.create({
            run_name: 'terminal-document-context-race',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: SOURCE_RESULT_COUNT,
            status: 'pending',
            trust_batch_id: sourceId
        });
        const document = await BenchmarkBatch.findById(batch._id);
        document.status = 'failed';
        document.completed_at = new Date();

        const originalExists = BenchmarkBatch.exists.bind(BenchmarkBatch);
        const existsSpy = jest.spyOn(BenchmarkBatch, 'exists')
            .mockImplementationOnce(async () => {
                await BenchmarkBatch.collection.updateOne(
                    { _id: batch._id },
                    {
                        $set: {
                            trust_evidence_context: context,
                            trust_evidence_committed_at: new Date()
                        }
                    }
                );
                return null;
            })
            .mockImplementation((...args) => originalExists(...args));

        try {
            await expect(document.save()).rejects.toMatchObject({
                name: 'DocumentNotFoundError'
            });
        } finally {
            existsSpy.mockRestore();
        }
        await expect(BenchmarkBatch.findById(batch._id)
            .select('+trust_evidence_context')
            .lean()).resolves.toMatchObject({
            status: 'pending',
            trust_evidence_context: context,
            completed_at: null
        });
    });

    test('atomically refuses deletion when a CampaignSpec reservation wins after the precheck', async () => {
        const batch = await BenchmarkBatch.create({
            run_name: 'delete-spec-race',
            host: 'opaque-test-host',
            models: ['model-a'],
            levels: [1],
            total_tests: 1,
            status: 'pending'
        });
        const specId = '9'.repeat(64);
        const originalExists = BenchmarkBatch.exists.bind(BenchmarkBatch);
        const existsSpy = jest.spyOn(BenchmarkBatch, 'exists')
            .mockImplementationOnce(async () => {
                await BenchmarkBatch.collection.updateOne(
                    { _id: batch._id },
                    { $set: { trust_campaign_spec_id: specId } }
                );
                return null;
            })
            .mockImplementation((...args) => originalExists(...args));

        try {
            const deletion = await BenchmarkBatch.deleteOne({ _id: batch._id });
            expect(deletion.deletedCount).toBe(0);
        } finally {
            existsSpy.mockRestore();
        }
        await expect(BenchmarkBatch.findById(batch._id).lean()).resolves.toMatchObject({
            trust_campaign_spec_id: specId
        });
    });

    test('rejects missing or post-start server commitment timestamps at receipt verification', async () => {
        const missingCommitSourceId = sourceBatchId('5');
        const missingCommitBatch = await createLinkedBatch(missingCommitSourceId);
        await BenchmarkBatch.collection.updateOne(
            { _id: missingCommitBatch._id },
            { $unset: { trust_evidence_committed_at: '' } }
        );
        await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: missingCommitSourceId,
            campaignCharacter: '5'
        })))).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_ANTERIORITY_UNPROVEN'
        });
        await expect(BenchmarkResult.countDocuments({
            batch_id: missingCommitBatch._id,
            trust_evidence_sealed: true
        })).resolves.toBe(SOURCE_RESULT_COUNT);

        const postStartSourceId = sourceBatchId('6');
        const postStartBatch = await createLinkedBatch(postStartSourceId);
        await BenchmarkBatch.collection.updateOne(
            { _id: postStartBatch._id },
            { $set: { trust_evidence_committed_at: new Date('2099-01-01T00:00:00.000Z') } }
        );
        await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: postStartSourceId,
            campaignCharacter: '6'
        })))).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_COMMITTED_AFTER_START'
        });
        await expect(BenchmarkResult.countDocuments({
            batch_id: postStartBatch._id,
            trust_evidence_sealed: true
        })).resolves.toBe(SOURCE_RESULT_COUNT);
    });

    test('keeps preregistered result identities immutable before and after sealing', async () => {
        const sourceId = sourceBatchId('0');
        const batch = await createLinkedBatch(sourceId);
        const row = await BenchmarkResult.findOne({ batch_id: batch._id });
        const immutable = { code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE };

        await expect(BenchmarkResult.updateOne(
            { _id: row._id },
            { $set: { trust_candidate_id: candidateId('f') } }
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkResult.findOneAndUpdate(
            { _id: row._id },
            { $rename: { trust_prompt_id: 'renamed_prompt_id' } }
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkResult.updateOne(
            { _id: row._id },
            [{ $set: { trust_prompt_id: promptId('f') } }]
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkResult.bulkWrite([{
            updateOne: {
                filter: { _id: row._id },
                update: { $set: { trust_candidate_id: candidateId('f') } }
            }
        }])).rejects.toMatchObject(immutable);
        row.trust_prompt_id = promptId('f');
        await expect(row.save()).rejects.toMatchObject(immutable);

        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        await storeBenchmarkTrustReceipt(receipt);
        await expect(BenchmarkResult.updateOne(
            { _id: row._id },
            { $set: { trust_prompt_id: promptId('e') } }
        )).rejects.toMatchObject(immutable);
    });

    test('blocks forged insertMany context and recursive aggregate write stages', async () => {
        const forgedContext = sourceContextFixture(sourceBatchId('1'));
        await expect(BenchmarkBatch.insertMany([{
            run_name: 'forged-context',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: SOURCE_RESULT_COUNT,
            status: 'pending',
            trust_batch_id: forgedContext.sourceBatchId,
            trust_evidence_context: forgedContext,
            trust_evidence_committed_at: new Date('2020-01-01T00:00:00.000Z')
        }])).rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });
        await expect(BenchmarkBatch.updateOne(
            {
                trust_batch_id: sourceBatchId('f'),
                trust_evidence_context: forgedContext,
                trust_evidence_finalized_at: new Date('2020-01-01T00:00:00.000Z')
            },
            { $setOnInsert: { status: 'completed', completed_at: new Date() } },
            { upsert: true }
        )).rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });
        await expect(BenchmarkBatch.aggregate([{
            $facet: { bypass: [{ $merge: 'benchmarkbatches' }] }
        }])).rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.aggregate([{
            $facet: { bypass: [{ $out: 'benchmarkresults' }] }
        }])).rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkBatch.countDocuments({ run_name: 'forged-context' })).resolves.toBe(0);
        await expect(BenchmarkBatch.countDocuments({ trust_batch_id: sourceBatchId('f') })).resolves.toBe(0);
        const legacySealedRow = {
            model: 'legacy-caller-sealed',
            host: 'opaque-test-host',
            prompt: 'legacy-caller-sealed',
            success: true,
            trust_evidence_sealed: true
        };
        await expect(BenchmarkResult.create(legacySealedRow))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.insertMany([legacySealedRow]))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.countDocuments({ model: 'legacy-caller-sealed' })).resolves.toBe(0);
    });

    test('creates Trust result times server-side only after durable execution start', async () => {
        const preStartSourceId = sourceBatchId('1');
        const preStartRows = sourceResultFixtures();
        const preStartBatch = await BenchmarkBatch.create({
            run_name: 'pre-start-trust-results',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: preStartRows.length,
            status: 'pending',
            trust_batch_id: preStartSourceId
        });
        await BenchmarkBatch.commitTrustEvidenceContext(
            preStartBatch._id,
            sourceContextFixture(preStartSourceId, preStartRows)
        );
        await expect(BenchmarkResult.create(runtimeTrustRow(preStartRows[0], preStartBatch._id)))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.insertMany([runtimeTrustRow(preStartRows[0], preStartBatch._id)]))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });

        const { batch, sourceResults } = await createRunningTrustBatch(sourceBatchId('6'));
        const callerTimed = runtimeTrustRow(sourceResults[0], batch._id);
        callerTimed.timestamp = new Date('2020-01-01T00:00:00.000Z');
        await expect(BenchmarkResult.create(callerTimed))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.insertMany([callerTimed]))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        const callerSealed = runtimeTrustRow(sourceResults[0], batch._id);
        callerSealed.trust_evidence_sealed = true;
        await expect(BenchmarkResult.create(callerSealed))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        const created = await BenchmarkResult.create(runtimeTrustRow(sourceResults[0], batch._id));
        expect(created.timestamp.getTime()).toBeGreaterThanOrEqual(batch.started_at.getTime());
        expect(created.updated_at.getTime()).toBeGreaterThanOrEqual(created.timestamp.getTime());
        await expect(BenchmarkResult.updateOne(
            { _id: created._id },
            { $set: { timestamp: new Date('2020-01-01T00:00:00.000Z') } }
        )).rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.updateOne(
            { _id: created._id },
            { $set: { trust_evidence_sealed: true } }
        )).rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            { $set: { trust_evidence_sealed: true } }
        )).rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkBatch.deleteOne({ _id: batch._id }))
            .rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });
        created.timestamp = new Date('2020-01-01T00:00:00.000Z');
        await expect(created.save())
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });

        const [inserted] = await BenchmarkResult.insertMany([
            runtimeTrustRow(sourceResults[1], batch._id)
        ]);
        expect(inserted.timestamp.getTime()).toBeGreaterThanOrEqual(batch.execution_started_at.getTime());
        expect(inserted.updated_at.getTime()).toBeGreaterThanOrEqual(inserted.timestamp.getTime());
    });

    test('atomically commits the source context with server start time and keeps private receipts private', async () => {
        const sourceId = sourceBatchId('f');
        const sourceResults = sourceResultFixtures();
        const batch = await BenchmarkBatch.create({
            run_name: 'atomic-trust-start',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: sourceResults.length,
            status: 'pending',
            trust_batch_id: sourceId
        });
        const committed = await BenchmarkBatch.commitAndStartTrustEvidenceBatch(
            batch._id,
            sourceContextFixture(sourceId, sourceResults)
        );
        const started = await BenchmarkBatch.findById(batch._id)
            .select('+trust_evidence_context +trust_evidence_committed_at')
            .lean();
        expect(started).toMatchObject({ status: 'running', execution_started_at: null });
        expect(started.started_at).toEqual(committed.committedAt);
        expect(started.trust_evidence_committed_at).toEqual(committed.committedAt);

        await expect(BenchmarkResult.create(runtimeTrustRow(sourceResults[0], batch._id)))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        const executionStartedAt = new Date();
        await BenchmarkBatch.updateOne(
            { _id: batch._id, execution_started_at: null },
            { $set: { execution_started_at: executionStartedAt, execution_pid: 1234 } }
        );
        const created = await BenchmarkResult.create(runtimeTrustRow(sourceResults[0], batch._id));
        const publicRow = await BenchmarkResult.findById(created._id).lean();
        expect(publicRow).not.toHaveProperty('trust_execution_receipt');
        expect(publicRow).not.toHaveProperty('trust_judge_receipt');
        const privateRow = await BenchmarkResult.findById(created._id)
            .select('+trust_execution_receipt +trust_judge_receipt')
            .lean();
        expect(privateRow.trust_execution_receipt.fingerprint)
            .toBe(sourceResults[0].trust_execution_receipt.fingerprint);
        expect(privateRow.trust_judge_receipt.fingerprint)
            .toBe(runtimeTrustRow(sourceResults[0], batch._id).trust_judge_receipt.fingerprint);
    });

    test('maps an interrupted pre-execution Trust finalization to a stopped judge state', async () => {
        const sourceId = sourceBatchId('4');
        const sourceResults = sourceResultFixtures();
        const batch = await BenchmarkBatch.create({
            run_name: 'interrupted-before-execution-lock',
            host: 'opaque-test-host',
            models: ['model-a', 'model-b'],
            levels: [1],
            total_tests: sourceResults.length,
            status: 'pending',
            trust_batch_id: sourceId
        });
        await BenchmarkBatch.commitAndStartTrustEvidenceBatch(
            batch._id,
            sourceContextFixture(sourceId, sourceResults)
        );
        const finalized = await BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id, {
            status: 'interrupted',
            failureReason: 'process_shutdown',
            allowUnstarted: true
        });
        expect(finalized).toMatchObject({
            status: 'interrupted',
            judge_status: 'stopped',
            completed: 0,
            failed: 0,
            trust_evidence_sealed: true
        });
    });

    test('sets the private judge WorkerReceipt once and closes concurrent replacement races', async () => {
        const { batch, sourceResults } = await createRunningTrustBatch(sourceBatchId('5'));
        const row = runtimeTrustRow(sourceResults[0], batch._id);
        const judgeReceipt = clone(row.trust_judge_receipt);
        row.trust_judge_receipt = null;
        row.judge_receipt = null;
        const created = await BenchmarkResult.create(row);

        const attempts = await Promise.all([
            BenchmarkResult.updateOne(
                { _id: created._id },
                { $set: { trust_judge_receipt: judgeReceipt, judge_receipt: judgeReceipt } }
            ),
            BenchmarkResult.updateOne(
                { _id: created._id },
                { $set: { trust_judge_receipt: judgeReceipt, judge_receipt: judgeReceipt } }
            )
        ]);
        expect(attempts.reduce((sum, result) => sum + result.matchedCount, 0)).toBe(1);
        await expect(BenchmarkResult.updateOne(
            { _id: created._id },
            { $set: { trust_judge_receipt: judgeReceipt } }
        )).rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
    });

    test('only the locked Trust finalizer may terminate a context batch and no result can follow it', async () => {
        const { batch, sourceResults } = await createRunningTrustBatch(sourceBatchId('2'));
        const row = runtimeTrustRow(sourceResults[0], batch._id);
        await BenchmarkResult.create(row);

        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            { $set: { status: 'completed', completed_at: new Date() } }
        )).rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });
        for (const unsafeUpdate of [
            { $min: { completed_at: new Date(0) } },
            { $unset: { completed_at: '' } },
            { $min: { status: 'completed' } }
        ]) {
            await expect(BenchmarkBatch.updateOne({ _id: batch._id }, unsafeUpdate))
                .rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });
        }
        const document = await BenchmarkBatch.findById(batch._id);
        await expect(document.markAsCompleted('completed'))
            .rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });

        const finalized = await BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id, {
            status: 'interrupted',
            failureReason: 'bounded-test-interruption'
        });
        expect(finalized).toMatchObject({ status: 'interrupted', completed: 1, failed: 0 });
        expect(finalized.trust_evidence_finalized_at).toEqual(finalized.completed_at);
        expect(finalized.updated_at).toEqual(finalized.completed_at);
        const finalizedRow = await BenchmarkResult.findOne({ batch_id: batch._id });
        expect(finalizedRow.trust_evidence_sealed).toBe(true);
        await expect(BenchmarkResult.updateOne(
            { _id: finalizedRow._id },
            { $set: { quality_score: 1 } }
        )).rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.findOneAndUpdate(
            { _id: finalizedRow._id },
            { $set: { quality_score: 1 } }
        )).rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.deleteOne({ _id: finalizedRow._id }))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        finalizedRow.quality_score = 1;
        await expect(finalizedRow.save())
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.create(runtimeTrustRow(sourceResults[1], batch._id)))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.insertMany([runtimeTrustRow(sourceResults[1], batch._id)]))
            .rejects.toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        await expect(BenchmarkResult.countDocuments({ batch_id: batch._id })).resolves.toBe(1);

        const legacy = await BenchmarkBatch.create({
            run_name: 'legacy-terminal-transition',
            host: 'opaque-test-host',
            models: ['model-a'],
            levels: [1],
            total_tests: 0,
            status: 'pending',
            trust_batch_id: sourceBatchId('e')
        });
        await expect(BenchmarkBatch.updateOne(
            { _id: legacy._id },
            { $set: { status: 'completed', completed_at: new Date() } }
        )).resolves.toMatchObject({ matchedCount: 1 });
    });

    test('serializes Trust finalization against result insertion under one evidence lock', async () => {
        const { batch, sourceResults } = await createRunningTrustBatch(sourceBatchId('3'));
        const insertion = BenchmarkResult.create(runtimeTrustRow(sourceResults[0], batch._id));
        const finalization = BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id, {
            status: 'interrupted',
            failureReason: 'concurrent-test-interruption'
        });
        const outcomes = await Promise.allSettled([insertion, finalization]);
        const currentBatch = await BenchmarkBatch.findById(batch._id).lean();
        const currentRows = await BenchmarkResult.find({ batch_id: batch._id }).lean();

        expect(currentBatch.status).toBe('interrupted');
        expect(currentRows).toHaveLength(outcomes[0].status === 'fulfilled' ? 1 : 0);
        expect(currentBatch.completed).toBe(currentRows.length);
        expect(currentRows.every(row => row.timestamp <= currentBatch.completed_at)).toBe(true);
        if (outcomes[0].status === 'rejected') {
            expect(outcomes[0].reason).toMatchObject({ code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE });
        }
        expect(outcomes[1].status).toBe('fulfilled');
    });

    test('freezes result success before deriving Trust final counters', async () => {
        const { batch, sourceResults } = await createRunningTrustBatch(sourceBatchId('a'));
        const row = await BenchmarkResult.create(runtimeTrustRow(sourceResults[0], batch._id));
        await Promise.allSettled([
            BenchmarkResult.updateOne({ _id: row._id }, { $set: { success: false } }),
            BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id, {
                status: 'interrupted',
                failureReason: 'mutation-test-interruption'
            })
        ]);

        const [currentBatch, currentRow] = await Promise.all([
            BenchmarkBatch.findById(batch._id).select('+trust_evidence_finalized_at').lean(),
            BenchmarkResult.findById(row._id).lean()
        ]);
        expect(currentBatch.status).toBe('interrupted');
        expect(currentRow.trust_evidence_sealed).toBe(true);
        expect(currentBatch.completed).toBe(1);
        expect(currentBatch.failed).toBe(currentRow.success === true ? 0 : 1);
    });

    test('keeps an immutable legacy v1 receipt readable under the v2 reader', async () => {
        const sourceId = sourceBatchId('1');
        await createLinkedBatch(sourceId);
        const legacyBody = bodyFixture({ sourceId, campaignCharacter: '1' });
        legacyBody.schema = BENCHMARK_TRUST_RECEIPT_SCHEMA_V1;
        legacyBody.statistics.method = 'paired-prompt-t-v1';
        delete legacyBody.statistics.preregistration.poweredAlternativeEffectMicros;
        delete legacyBody.statistics.preregistration.varianceBasisFingerprint;
        delete legacyBody.statistics.preregistration.variancePilotAttestationId;
        const legacyReceipt = buildBenchmarkTrustReceipt(legacyBody);

        await BenchmarkTrustReceipt.create(
            BenchmarkTrustReceipt.buildStoredRecord(legacyReceipt)
        );
        const stored = await BenchmarkTrustReceipt.findOne({
            receiptId: legacyReceipt.receiptId
        }).lean();

        expect(BenchmarkTrustReceipt.verifyStoredRecord(stored)).toEqual(legacyReceipt);
        await expect(getBenchmarkTrustReceiptById(legacyReceipt.receiptId))
            .resolves.toEqual(legacyReceipt);
    });

    test('verifies and retains evidence referenced by the literal a51fcd1 v1 receipt', async () => {
        const historicalReceipt = clone(HISTORICAL_V1_RECEIPT);
        const batch = await BenchmarkBatch.create({
            run_name: 'historical-v1-retention',
            host: 'opaque-test-host',
            models: ['historical-model'],
            levels: [1],
            total_tests: 1,
            completed: 1,
            status: 'completed',
            completed_at: new Date(0),
            trust_batch_id: historicalReceipt.execution.sourceBatchId
        });
        await BenchmarkResult.collection.insertOne({
            batch_id: batch._id,
            model: 'historical-model',
            marker: 'historical-v1-protected'
        });
        await BenchmarkTrustReceipt.create(
            BenchmarkTrustReceipt.buildStoredRecord(historicalReceipt)
        );

        const stored = await BenchmarkTrustReceipt.findOne({
            receiptId: historicalReceipt.receiptId
        }).lean();
        expect(BenchmarkTrustReceipt.verifyStoredRecord(stored)).toEqual(historicalReceipt);

        const outcome = await archiveOldResults(-1, false);
        expect(outcome.protectedSourceBatchIds).toContain(historicalReceipt.execution.sourceBatchId);
        await expect(BenchmarkResult.collection.countDocuments({ batch_id: batch._id }))
            .resolves.toBe(1);
    });

    test('courthouse counts legacy human rows but excludes complete and partial attestation markers', async () => {
        const query = buildCourthouseGroundTruthCountQuery();
        const before = await JudgeGroundTruth.countDocuments(query);
        await JudgeGroundTruth.collection.insertMany([
            {
                name: 'dashboard-visible-human',
                active: true,
                created_by: 'human-reviewer',
                source: 'courthouse-review'
            },
            {
                name: 'dashboard-private-attested',
                active: true,
                created_by: 'attested:issuer',
                source: 'attested-human-evidence-v1'
            },
            {
                name: 'dashboard-private-partial-marker',
                active: true,
                created_by: 'human-reviewer',
                source: 'courthouse-review',
                human_attestation_fingerprint: 'a'.repeat(64)
            }
        ]);

        await expect(JudgeGroundTruth.countDocuments(query)).resolves.toBe(before + 1);
    });

    test('fails closed if source evidence changes between validation and result sealing', async () => {
        const { batch, sourceResults } = await createRunningTrustBatch(sourceBatchId('d'));
        await BenchmarkResult.insertMany(
            sourceResults.map(row => runtimeTrustRow(row, batch._id))
        );
        const originalUpdateMany = BenchmarkResult.collection.updateMany.bind(BenchmarkResult.collection);
        BenchmarkResult.collection.updateMany = async (...args) => {
            await BenchmarkResult.collection.updateOne(
                { batch_id: batch._id, trust_candidate_id: sourceResults[0].trust_candidate_id },
                { $set: { response: 'tampered-between-validation-and-seal' } }
            );
            return originalUpdateMany(...args);
        };

        try {
            await expect(BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id))
                .rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });
        } finally {
            BenchmarkResult.collection.updateMany = originalUpdateMany;
        }

        const [currentBatch, currentRows] = await Promise.all([
            BenchmarkBatch.findById(batch._id).select('+trust_evidence_finalized_at').lean(),
            BenchmarkResult.find({ batch_id: batch._id }).lean()
        ]);
        expect(currentBatch).toMatchObject({
            status: 'failed',
            judge_status: 'failed',
            failure_reason: 'trust_evidence_changed_during_finalization',
            trust_evidence_sealed: true
        });
        expect(currentBatch.trust_evidence_finalized_at).toEqual(currentBatch.completed_at);
        expect(currentRows).toHaveLength(SOURCE_RESULT_COUNT);
        expect(currentRows.every(row => row.trust_evidence_sealed === true)).toBe(true);
    });

    test('Trust finalization cannot be stranded by a concurrent nonterminal status update', async () => {
        const { batch } = await createRunningTrustBatch(sourceBatchId('c'));
        const outcomes = await Promise.allSettled([
            BenchmarkBatch.updateOne({ _id: batch._id }, { $set: { status: 'judging' } }),
            BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id, {
                status: 'interrupted',
                failureReason: 'status-race-test-interruption'
            })
        ]);
        const current = await BenchmarkBatch.findById(batch._id)
            .select('+trust_evidence_finalized_at')
            .lean();

        expect(outcomes[1].status).toBe('fulfilled');
        expect(current).toMatchObject({
            status: 'interrupted',
            trust_evidence_sealed: true
        });
        expect(current.trust_evidence_finalized_at).toEqual(current.completed_at);
    });

    test('stores a complete winner produced through the canonical Trust lifecycle', async () => {
        const sourceId = sourceBatchId('b');
        const { batch, sourceResults, sourceContext } = await createRunningTrustBatch(sourceId);
        await BenchmarkResult.insertMany(
            sourceResults.map(row => runtimeTrustRow(row, batch._id))
        );
        const finalized = await BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id);
        const durableRows = await BenchmarkResult.find({ batch_id: batch._id })
            .select('+trust_execution_receipt +trust_judge_receipt')
            .lean();
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            sourceResults: durableRows,
            sourceContext,
            completedAt: finalized.completed_at
        }));

        expect(receipt.axes).toMatchObject({
            evidenceStatus: 'complete',
            decisionOutcome: 'winner',
            freshnessStatus: 'fresh'
        });
        await expect(storeBenchmarkTrustReceipt(receipt))
            .resolves.toMatchObject({ created: true, receipt });
        await expect(BenchmarkResult.countDocuments({
            batch_id: batch._id,
            trust_evidence_sealed: true
        })).resolves.toBe(SOURCE_RESULT_COUNT);
    });

    test('resumes finalization after result sealing and is idempotent after completion', async () => {
        const sourceId = sourceBatchId('f');
        const { batch, sourceResults } = await createRunningTrustBatch(sourceId);
        await BenchmarkResult.insertMany(
            sourceResults.map(row => runtimeTrustRow(row, batch._id))
        );
        await BenchmarkResult.collection.updateMany(
            { batch_id: batch._id },
            { $set: { trust_evidence_sealed: true } }
        );

        const finalized = await BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id);
        expect(finalized).toMatchObject({
            status: 'completed',
            trust_evidence_sealed: true,
            completed: SOURCE_RESULT_COUNT
        });
        const repeated = await BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id);
        expect(repeated.completed_at).toEqual(finalized.completed_at);
        expect(repeated.trust_evidence_finalized_at).toEqual(finalized.trust_evidence_finalized_at);
    });

    test('cannot report completed when any strict judge receipt is missing', async () => {
        const sourceId = sourceBatchId('8');
        const { batch, sourceResults } = await createRunningTrustBatch(sourceId);
        const rows = sourceResults.map(row => runtimeTrustRow(row, batch._id));
        rows[0].trust_judge_receipt = null;
        rows[0].judge_receipt = null;
        await BenchmarkResult.insertMany(rows);

        await expect(BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id))
            .rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });
        const failed = await BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id, {
            status: 'failed',
            failureReason: 'missing_strict_judge_receipt'
        });
        expect(failed).toMatchObject({
            status: 'failed',
            judge_status: 'failed',
            trust_evidence_sealed: true
        });
    });

    test('cannot seal a duplicated candidate x prompt x repeat inventory as completed', async () => {
        const sourceId = sourceBatchId('6');
        const { batch, sourceResults } = await createRunningTrustBatch(sourceId);
        const duplicatedRows = sourceResults.map(row => runtimeTrustRow(row, batch._id));
        duplicatedRows[1] = clone(duplicatedRows[0]);
        await BenchmarkResult.insertMany(duplicatedRows);

        await expect(BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id))
            .rejects.toMatchObject({ code: BenchmarkBatch.PROTECTED_CONTEXT_ERROR_CODE });

        const [currentBatch, currentRows] = await Promise.all([
            BenchmarkBatch.findById(batch._id).lean(),
            BenchmarkResult.find({ batch_id: batch._id }).lean()
        ]);
        expect(currentBatch.status).toBe('running');
        expect(currentBatch.trust_evidence_sealed).not.toBe(true);
        expect(currentRows).toHaveLength(SOURCE_RESULT_COUNT);
        expect(currentRows.every(row => row.trust_evidence_sealed !== true)).toBe(true);
    });

    test('imports and re-verifies signed human evidence from one real sealed Trust result', async () => {
        const sourceId = sourceBatchId('9');
        const { batch, sourceResults } = await createRunningTrustBatch(sourceId);
        await BenchmarkResult.insertMany(
            sourceResults.map(row => runtimeTrustRow(row, batch._id))
        );
        await BenchmarkBatch.finalizeTrustEvidenceBatch(batch._id);
        const sourceResult = await BenchmarkResult.findOne({
            batch_id: batch._id,
            trust_candidate_id: sourceResults[0].trust_candidate_id,
            trust_prompt_id: sourceResults[0].trust_prompt_id,
            repeat_index: 0
        }).select('+trust_execution_receipt +trust_judge_receipt').lean();
        const judgeReceipt = normalizeWorkerReceipt(sourceResult.trust_judge_receipt);
        const sealedBatch = await BenchmarkBatch.findById(batch._id)
            .select('+trust_evidence_finalized_at')
            .lean();
        const sourceProjection = {
            sourceResultId: String(sourceResult._id),
            sourceBatchId: sourceId,
            candidateId: sourceResult.trust_candidate_id,
            promptId: sourceResult.trust_prompt_id,
            repeatIndex: sourceResult.repeat_index,
            repeatTotal: sourceResult.repeat_total,
            model: sourceResult.model,
            host: sourceResult.host,
            modelDigest: sourceResult.model_digest,
            promptFingerprint: computePromptSourceFingerprint(sourceResult),
            responseFingerprint: workerFingerprint(String(sourceResult.response)),
            category: sourceResult.prompt_category,
            judgeIdentityFingerprint: workerFingerprint(judgeReceipt.identity),
            judgeScoreMicros: Math.round(sourceResult.quality_score * 1_000_000),
            judgeReceiptFingerprint: judgeReceipt.fingerprint,
            executionReceiptFingerprint: sourceResult.trust_execution_receipt.fingerprint,
            sourceCreatedAt: sourceResult.timestamp.toISOString(),
            sourceUpdatedAt: sourceResult.updated_at.toISOString()
        };
        const reviewedAt = new Date(sealedBatch.trust_evidence_finalized_at);
        const issuedAt = new Date(Math.max(Date.now(), reviewedAt.getTime()));
        const validUntil = new Date(issuedAt.getTime() + 24 * 60 * 60 * 1000);
        const body = {
            schema: BENCHMARK_HUMAN_EVIDENCE_ATTESTATION_SCHEMA,
            issuer: { issuerId: 'integration-review-board', keyId: 'ed25519-2026-09' },
            issuedAt: issuedAt.toISOString(),
            validUntil: validUntil.toISOString(),
            nonce: 'integration-human-review-nonce-000000000001',
            source: {
                sourceResultId: sourceProjection.sourceResultId,
                sourceBatchId: sourceProjection.sourceBatchId,
                sourceResultFingerprint: computeBenchmarkHumanEvidenceSourceResultFingerprint(sourceProjection),
                promptFingerprint: sourceProjection.promptFingerprint,
                responseFingerprint: sourceProjection.responseFingerprint,
                category: sourceProjection.category,
                judgeIdentityFingerprint: sourceProjection.judgeIdentityFingerprint,
                judgeScoreMicros: sourceProjection.judgeScoreMicros
            },
            human: {
                provenanceClass: 'independent_human_score',
                reviewProtocol: 'blind_independent',
                expertScoreMicros: 8_000_000,
                dimensionScores: [{ dimension: 'correctness', scoreMicros: 8_000_000 }],
                expertRationale: 'Two independent reviewers agreed on the sealed result.',
                reviewerId: 'reviewer-pseudonym-integration',
                reviewedAt: reviewedAt.toISOString()
            }
        };
        const attestationId = computeBenchmarkHumanEvidenceAttestationId(body);
        const signingPayload = serializeBenchmarkHumanEvidenceAttestationSigningPayload(body, attestationId);
        const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
        const attestation = {
            ...body,
            attestationId,
            signature: crypto.sign(null, Buffer.from(signingPayload), privateKey).toString('base64url')
        };
        process.env[TRUST_ROOTS_ENV] = JSON.stringify({
            schema: TRUST_ROOTS_SCHEMA,
            issuers: [{
                issuerId: body.issuer.issuerId,
                keys: [{
                    keyId: body.issuer.keyId,
                    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }),
                    notBefore: '2026-01-01T00:00:00.000Z',
                    notAfter: '2027-01-01T00:00:00.000Z',
                    scopes: [HUMAN_EVIDENCE_SCOPE]
                }]
            }]
        });
        const revocations = {
            schema: REVOCATIONS_SCHEMA,
            version: 1,
            issuedAt: new Date(issuedAt.getTime() - 60_000).toISOString(),
            validUntil: validUntil.toISOString(),
            revokedIssuerIds: [],
            revokedKeys: [],
            revokedAttestationIds: []
        };
        const revocationSnapshotId = workerFingerprint(revocations);
        process.env[REVOCATIONS_ENV] = JSON.stringify({
            ...revocations,
            snapshotId: revocationSnapshotId
        });
        process.env[MIN_REVOCATION_VERSION_ENV] = '1';
        process.env[REVOCATION_SNAPSHOT_ID_ENV] = revocationSnapshotId;

        await expect(importAttestedHumanGroundTruth(attestation))
            .resolves.toMatchObject({ imported: true });
        const qualified = await loadQualifiedHumanGroundTruth();
        expect(qualified).toHaveLength(1);
        expect(qualified[0]).toMatchObject({
            source: 'attested-human-evidence-v1',
            source_result_id: sourceResult._id,
            provenance_class: 'independent_human_score',
            review_protocol: 'blind_independent'
        });
        expect(qualified[0]).not.toHaveProperty('human_attestation');
        const storedHumanEvidence = await JudgeGroundTruth.findOne({
            human_attestation_fingerprint: attestation.attestationId
        }).select('+human_attestation').lean();
        await expect(runWithPublicBenchmarkReadPrivacy(() => (
            verifyStoredAttestedHumanGroundTruth(storedHumanEvidence)
        ))).resolves.toEqual(attestation);
    });

    test('canonical verification rejects forged source and decision fingerprints before any external verifier', async () => {
        const sourceId = sourceBatchId('0');
        const batch = await createLinkedBatch(sourceId);
        const forgedBody = bodyFixture({ sourceId, campaignCharacter: '0' });
        forgedBody.execution.candidates[0].resultSetFingerprint = 'f'.repeat(64);
        forgedBody.statistics.decisionFingerprint = 'f'.repeat(64);
        const forgedReceipt = buildBenchmarkTrustReceipt(forgedBody);
        const externalVerifier = jest.fn(() => true);

        await expect(storeBenchmarkTrustReceipt(forgedReceipt, {
            verifyExternalSourceEvidence: externalVerifier
        })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' });
        expect(externalVerifier).not.toHaveBeenCalled();
        await expect(BenchmarkTrustReceipt.countDocuments({})).resolves.toBe(0);
        await expect(BenchmarkResult.countDocuments({
            batch_id: batch._id,
            trust_evidence_sealed: true
        })).resolves.toBe(SOURCE_RESULT_COUNT);
    });

    test('rejects a receipt judge or source-row judge that diverges from the frozen score evidence', async () => {
        const forgedJudgeSourceId = sourceBatchId('7');
        await createLinkedBatch(forgedJudgeSourceId);
        const forgedJudgeBody = bodyFixture({ sourceId: forgedJudgeSourceId });
        forgedJudgeBody.judge.identityFingerprint = 'f'.repeat(64);
        await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(forgedJudgeBody)))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' });

        const wrongRowJudgeSourceId = sourceBatchId('8');
        const canonicalRows = sourceResultFixtures();
        const frozenContext = sourceContextFixture(wrongRowJudgeSourceId, canonicalRows);
        const storedRows = clone(canonicalRows);
        storedRows[1].trust_judge_receipt = clone(storedRows[0].trust_judge_receipt);
        const wrongRowJudgeBatch = await createLinkedBatch(
            wrongRowJudgeSourceId,
            {},
            { sourceResults: storedRows, sourceContext: frozenContext }
        );
        const canonicalBody = bodyFixture({
            sourceId: wrongRowJudgeSourceId,
            sourceResults: canonicalRows,
            sourceContext: frozenContext
        });
        await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(canonicalBody)))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' });
        await expect(BenchmarkResult.countDocuments({
            batch_id: wrongRowJudgeBatch._id,
            trust_evidence_sealed: true
        })).resolves.toBe(SOURCE_RESULT_COUNT);
    });

    test('rejects fake and cryptographically mutated per-row WorkerReceipts', async () => {
        for (const [character, mutate] of [
            ['4', rows => { rows[0].trust_judge_receipt = { fingerprint: 'f'.repeat(64) }; }],
            ['5', rows => { rows[0].trust_judge_receipt.usage.durationMs += 1; }],
            ['6', rows => { rows[0].trust_execution_receipt = { fingerprint: 'f'.repeat(64) }; }],
            ['7', rows => { rows[1].trust_execution_receipt = clone(rows[0].trust_execution_receipt); }],
            ['8', rows => { rows[0].trust_execution_receipt.usage.durationMs += 1; }]
        ]) {
            const sourceId = sourceBatchId(character);
            const canonicalRows = sourceResultFixtures();
            const sourceContext = sourceContextFixture(sourceId, canonicalRows);
            const storedRows = clone(canonicalRows);
            mutate(storedRows);
            const batch = await createLinkedBatch(sourceId, {}, {
                sourceResults: storedRows,
                sourceContext
            });
            const canonicalBody = bodyFixture({
                sourceId,
                sourceResults: canonicalRows,
                sourceContext
            });
            await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(canonicalBody)))
                .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' });
            await expect(BenchmarkResult.countDocuments({
                batch_id: batch._id,
                trust_evidence_sealed: true
            })).resolves.toBe(SOURCE_RESULT_COUNT);
        }
    });

    test('rejects caller-forged creation, TTL, and current freshness fields', async () => {
        const forgedCreatedSourceId = sourceBatchId('9');
        await createLinkedBatch(forgedCreatedSourceId);
        const forgedCreatedBody = bodyFixture({ sourceId: forgedCreatedSourceId });
        forgedCreatedBody.createdAt = new Date(Date.parse(forgedCreatedBody.createdAt) + 1000).toISOString();
        await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(forgedCreatedBody)))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' });

        const forgedTtlSourceId = sourceBatchId('a');
        await createLinkedBatch(forgedTtlSourceId);
        const forgedTtlBody = bodyFixture({ sourceId: forgedTtlSourceId });
        forgedTtlBody.validUntil = new Date(Date.parse(forgedTtlBody.validUntil) + 1000).toISOString();
        await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(forgedTtlBody)))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' });

        const forgedStatusSourceId = sourceBatchId('b');
        await createLinkedBatch(forgedStatusSourceId);
        const forgedStatusBody = bodyFixture({ sourceId: forgedStatusSourceId });
        forgedStatusBody.axes.freshnessStatus = 'stale';
        await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(forgedStatusBody)))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' });

        const futureSourceId = sourceBatchId('c');
        const futureCompletedAt = new Date(Date.now() + 60_000);
        await createLinkedBatch(futureSourceId, { completed_at: futureCompletedAt });
        const futureBody = bodyFixture({ sourceId: futureSourceId, completedAt: futureCompletedAt });
        await expect(storeBenchmarkTrustReceipt(buildBenchmarkTrustReceipt(futureBody)))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_COMPLETION_INVALID' });
    });

    test('rejects altered result and finalization times after the Trust finalizer', async () => {
        const resultTimeSourceId = sourceBatchId('d');
        const resultTimeBatch = await createLinkedBatch(resultTimeSourceId);
        const resultTimeReceipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: resultTimeSourceId }));
        await BenchmarkResult.collection.updateOne(
            { batch_id: resultTimeBatch._id },
            { $set: { updated_at: new Date(resultTimeBatch.completed_at.getTime() + 1000) } }
        );
        await expect(storeBenchmarkTrustReceipt(resultTimeReceipt))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_RESULT_AFTER_COMPLETION' });

        const finalizationSourceId = sourceBatchId('e');
        const finalizationBatch = await createLinkedBatch(finalizationSourceId);
        const finalizationReceipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: finalizationSourceId }));
        await BenchmarkBatch.collection.updateOne(
            { _id: finalizationBatch._id },
            { $set: { trust_evidence_finalized_at: new Date(finalizationBatch.completed_at.getTime() - 1) } }
        );
        await expect(storeBenchmarkTrustReceipt(finalizationReceipt))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_COMPLETION_INVALID' });

        const missingStartSourceId = sourceBatchId('f');
        const missingStartBatch = await createLinkedBatch(missingStartSourceId);
        const missingStartReceipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: missingStartSourceId }));
        await BenchmarkBatch.collection.updateOne(
            { _id: missingStartBatch._id },
            { $set: { execution_started_at: null } }
        );
        await expect(storeBenchmarkTrustReceipt(missingStartReceipt))
            .rejects.toMatchObject({ code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_ANTERIORITY_UNPROVEN' });
    });

    test('keeps the opaque source-batch link immutable across query bypass surfaces', async () => {
        const sourceId = sourceBatchId('c');
        const batch = await createLinkedBatch(sourceId);
        const sealed = { code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE };

        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            [{ $set: { trust_batch_id: sourceBatchId('f') } }]
        )).rejects.toMatchObject(sealed);
        await expect(BenchmarkBatch.replaceOne(
            { _id: batch._id },
            { trust_batch_id: sourceBatchId('f'), status: 'completed' }
        )).rejects.toMatchObject(sealed);
        await expect(BenchmarkBatch.findById(batch._id).lean()).resolves.toMatchObject({
            trust_batch_id: sourceId
        });
    });

    test('requires terminal, complete source evidence and canonical context verification', async () => {
        const pendingSourceId = sourceBatchId('1');
        await createLinkedBatch(pendingSourceId, { status: 'pending', completed: 0 });
        const pendingReceipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: pendingSourceId,
            campaignCharacter: '1'
        }));
        await expect(storeVerifiedReceipt(pendingReceipt)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_BATCH_NOT_TERMINAL'
        });

        const incompleteSourceId = sourceBatchId('2');
        const incompleteBatch = await createLinkedBatch(
            incompleteSourceId,
            {},
            { seedEvidence: false }
        );
        await BenchmarkResult.collection.insertOne({
            batch_id: incompleteBatch._id,
            model: 'model-a',
            host: 'opaque-test-host',
            prompt: 'only-one-result',
            success: true
        });
        const incompleteReceipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: incompleteSourceId,
            campaignCharacter: '2'
        }));
        await expect(storeVerifiedReceipt(incompleteReceipt)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_RESULTS_MISMATCH'
        });

        const unverifiedSourceId = sourceBatchId('3');
        await createLinkedBatch(unverifiedSourceId);
        const unverifiedReceipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: unverifiedSourceId,
            campaignCharacter: '3'
        }));
        await expect(storeBenchmarkTrustReceipt(unverifiedReceipt, {
            verifySourceEvidence: () => true
        })).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_LEGACY_SOURCE_VERIFIER_FORBIDDEN'
        });
        await expect(storeVerifiedReceipt(unverifiedReceipt, () => false)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_EXTERNAL_SOURCE_EVIDENCE_NOT_VERIFIED'
        });
        await expect(BenchmarkResult.countDocuments({
            batch_id: (await BenchmarkBatch.findOne({ trust_batch_id: unverifiedSourceId }))._id,
            trust_evidence_sealed: true
        })).resolves.toBe(SOURCE_RESULT_COUNT);

        const legacySourceId = sourceBatchId('4');
        await createLinkedBatch(legacySourceId, {}, { sourceContext: null });
        const legacyReceipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: legacySourceId,
            campaignCharacter: '4'
        }));
        await expect(storeBenchmarkTrustReceipt(legacyReceipt)).rejects.toMatchObject({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_MISSING'
        });
    });

    test('retains and seals excluded rows as part of the complete source inventory', async () => {
        const sourceId = sourceBatchId('a');
        const sourceResults = sourceResultFixtures();
        sourceResults[0].excluded_from_leaderboard = true;
        const sourceContext = sourceContextFixture(sourceId, sourceResults);
        const batch = await createLinkedBatch(sourceId, {}, { sourceResults, sourceContext });
        const body = bodyFixture({
            sourceId,
            campaignCharacter: 'a',
            sourceResults: sourceEvidenceRows.get(sourceId),
            sourceContext
        });
        const receipt = buildBenchmarkTrustReceipt(body);

        await expect(storeVerifiedReceipt(receipt)).resolves.toMatchObject({
            created: true,
            receipt: { receiptId: receipt.receiptId }
        });
        await expect(BenchmarkResult.countDocuments({
            batch_id: batch._id,
            trust_evidence_sealed: true
        })).resolves.toBe(SOURCE_RESULT_COUNT);
    });

    test('makes concurrent creation idempotent through insert then duplicate-read/compare', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        const attempts = await Promise.all(
            Array.from({ length: 12 }, () => storeVerifiedReceipt(clone(receipt)))
        );

        expect(attempts.filter((attempt) => attempt.created)).toHaveLength(1);
        expect(attempts.filter((attempt) => !attempt.created)).toHaveLength(11);
        expect(attempts.every((attempt) => attempt.receipt.receiptId === receipt.receiptId)).toBe(true);
        await expect(BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId })).resolves.toBe(1);
    });

    test('fails closed when stored payload, projections, or canonical content are tampered', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        await storeVerifiedReceipt(receipt);

        await BenchmarkTrustReceipt.collection.updateOne(
            { receiptId: receipt.receiptId },
            { $set: { 'payload.statistics.minimumEffectMicros': 1 } }
        );
        await expect(getBenchmarkTrustReceiptById(receipt.receiptId)).rejects.toMatchObject({
            code: BenchmarkTrustReceipt.TAMPER_ERROR_CODE
        });

        await BenchmarkTrustReceipt.collection.updateOne(
            { receiptId: receipt.receiptId },
            {
                $set: {
                    payload: clone(receipt),
                    sourceBatchId: sourceBatchId('f'),
                    canonicalPayload: serializeBenchmarkTrustReceipt(receipt)
                }
            }
        );
        await expect(getBenchmarkTrustReceiptById(receipt.receiptId)).rejects.toMatchObject({
            code: BenchmarkTrustReceipt.TAMPER_ERROR_CODE
        });
    });

    test('rejects update, replace and delete operations at the model boundary', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        await storeVerifiedReceipt(receipt);

        const immutable = { code: BenchmarkTrustReceipt.IMMUTABLE_ERROR_CODE };
        await expect(BenchmarkTrustReceipt.updateOne(
            { receiptId: receipt.receiptId },
            { $set: { evidenceStatus: 'invalid' } }
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkTrustReceipt.replaceOne(
            { receiptId: receipt.receiptId },
            BenchmarkTrustReceipt.buildStoredRecord(receipt)
        )).rejects.toMatchObject(immutable);
        await expect(BenchmarkTrustReceipt.deleteOne({ receiptId: receipt.receiptId }))
            .rejects.toMatchObject(immutable);
        await expect(BenchmarkTrustReceipt.deleteMany({ sourceBatchId: sourceId }))
            .rejects.toMatchObject(immutable);
        await expect(BenchmarkTrustReceipt.bulkWrite([{
            deleteOne: { filter: { receiptId: receipt.receiptId } }
        }])).rejects.toMatchObject(immutable);

        const document = await BenchmarkTrustReceipt.findOne({ receiptId: receipt.receiptId });
        document.campaignId = `campaign_${'f'.repeat(32)}`;
        await expect(document.save()).rejects.toThrow(/immutable/);
        await expect(document.deleteOne()).rejects.toMatchObject(immutable);
    });

    test('bounds exact receipt and source-batch reads without exposing Mongo ids', async () => {
        const sourceId = sourceBatchId();
        await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        await storeVerifiedReceipt(receipt);

        const listed = await listBenchmarkTrustReceiptsBySourceBatch(sourceId, { limit: 2 });
        expect(listed).toEqual([receipt]);
        await expect(getBenchmarkTrustReceiptById('not-a-receipt')).rejects.toMatchObject({
            code: 'INVALID_RECEIPT_ID'
        });
        await expect(listBenchmarkTrustReceiptsBySourceBatch(sourceId, {
            limit: MAX_BATCH_READ_LIMIT + 1
        })).rejects.toMatchObject({ code: 'INVALID_READ_LIMIT' });
        await expect(listBenchmarkTrustReceiptsBySourceBatch('507f1f77bcf86cd799439011'))
            .rejects.toMatchObject({ code: 'INVALID_SOURCE_BATCH_ID' });
    });

    test('resolves opaque receipt ids back to exact Mongo evidence during retention', async () => {
        const protectedSourceId = sourceBatchId('d');
        const protectedBatch = await createLinkedBatch(protectedSourceId, {
            run_name: 'protected-batch',
            status: 'completed',
            description: 'protected'
        });
        const openBatch = await createLinkedBatch(sourceBatchId('e'), {
            run_name: 'open-batch',
            status: 'completed',
            description: 'open'
        }, { seedEvidence: false, sourceContext: null });
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: protectedSourceId }));
        await storeVerifiedReceipt(receipt);

        await BenchmarkResult.collection.insertOne({
            batch_id: openBatch._id,
            model: 'model-a',
            marker: 'open'
        });
        await BenchmarkTimelineEntry.collection.insertMany([
            { batchId: protectedBatch._id, event: 'protected-event' },
            { batchId: openBatch._id, event: 'open-event' }
        ]);

        const result = await archiveOldResults(-1, false);

        expect(result).toMatchObject({
            batchesProcessed: 1,
            resultsDeleted: 1,
            protectedBatches: 1,
            protectedResults: SOURCE_RESULT_COUNT,
            protectedSourceBatchIds: [protectedSourceId]
        });
        await expect(BenchmarkResult.collection.countDocuments({ batch_id: protectedBatch._id }))
            .resolves.toBe(SOURCE_RESULT_COUNT);
        await expect(BenchmarkResult.collection.countDocuments({ batch_id: openBatch._id }))
            .resolves.toBe(0);
        await expect(BenchmarkTimelineEntry.collection.countDocuments({ batchId: protectedBatch._id }))
            .resolves.toBe(1);
        await expect(BenchmarkTimelineEntry.collection.countDocuments({ batchId: openBatch._id }))
            .resolves.toBe(0);
        const [protectedAfter, openAfter] = await Promise.all([
            BenchmarkBatch.findById(protectedBatch._id).lean(),
            BenchmarkBatch.findById(openBatch._id).lean()
        ]);
        expect(protectedAfter.description).toBe('protected');
        expect(openAfter.description).toBe('open [archived]');
    });

    test('global and failed-result cleanup preserve exactly receipted batches', async () => {
        const protectedSourceId = sourceBatchId('d');
        const protectedBatch = await createLinkedBatch(protectedSourceId, {
            run_name: 'protected-cleanup'
        });
        const openBatch = await createLinkedBatch(sourceBatchId('e'), {
            run_name: 'open-cleanup'
        }, { seedEvidence: false, sourceContext: null });
        await storeVerifiedReceipt(buildBenchmarkTrustReceipt(bodyFixture({
            sourceId: protectedSourceId
        })));
        await BenchmarkResult.collection.insertOne({
            batch_id: openBatch._id,
            model: 'open',
            success: false
        });

        await expect(clearFailedResults()).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(SOURCE_RESULT_COUNT);
        await expect(BenchmarkResult.countDocuments({ batch_id: openBatch._id })).resolves.toBe(0);

        await BenchmarkResult.collection.insertOne({
            batch_id: openBatch._id,
            model: 'open-success',
            success: true
        });
        await expect(clearResults()).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(SOURCE_RESULT_COUNT);
        await expect(BenchmarkResult.countDocuments({ batch_id: openBatch._id })).resolves.toBe(0);
    });

    test('global cleanup fails closed when a receipt is hidden by a tampered source projection', async () => {
        const protectedSourceId = sourceBatchId('d');
        const protectedBatch = await createLinkedBatch(protectedSourceId, {
            run_name: 'tampered-cleanup'
        });
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId: protectedSourceId }));
        await storeVerifiedReceipt(receipt);
        await BenchmarkTrustReceipt.collection.updateOne(
            { receiptId: receipt.receiptId },
            { $set: { sourceBatchId: sourceBatchId('f') } }
        );
        await BenchmarkResult.collection.insertOne({
            model: 'unprotected-failed-row',
            host: 'unprotected',
            prompt: 'unprotected',
            success: false
        });

        const tampered = { code: BenchmarkTrustReceipt.TAMPER_ERROR_CODE };
        await expect(clearFailedResults()).resolves.toBe(1);
        await expect(clearResults()).rejects.toMatchObject(tampered);
        await expect(BenchmarkResult.countDocuments({ batch_id: protectedBatch._id })).resolves.toBe(SOURCE_RESULT_COUNT);
    });

    test('global cleanup preserves partially sealed crash-recovery states without a receipt', async () => {
        const batchSealed = await createLinkedBatch(sourceBatchId('2'));
        const resultsSealed = await createLinkedBatch(sourceBatchId('3'));
        await BenchmarkBatch.collection.updateOne(
            { _id: batchSealed._id },
            { $set: { trust_evidence_sealed: true } }
        );
        await BenchmarkResult.collection.updateMany(
            { batch_id: resultsSealed._id },
            { $set: { trust_evidence_sealed: true } }
        );

        await expect(clearResults()).resolves.toBe(0);
        await expect(BenchmarkResult.countDocuments({
            batch_id: { $in: [batchSealed._id, resultsSealed._id] }
        })).resolves.toBe(SOURCE_RESULT_COUNT * 2);
    });

    test('sealed source results reject score, exclusion, delete, save and bulk-write mutations', async () => {
        const sourceId = sourceBatchId('4');
        const batch = await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            campaignCharacter: '4'
        }));
        await storeVerifiedReceipt(receipt);

        const original = await BenchmarkResult.findOne({ batch_id: batch._id }).lean();
        const sealed = { code: BenchmarkResult.PROTECTED_EVIDENCE_ERROR_CODE };
        const sealedBatch = { code: BenchmarkBatch.PROTECTED_EVIDENCE_ERROR_CODE };
        await expect(BenchmarkResult.updateOne(
            { _id: original._id },
            { $set: { quality_score: 1, composite_score: 1, excluded_from_leaderboard: true } }
        )).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.deleteOne({ _id: original._id })).rejects.toMatchObject(sealed);

        const document = await BenchmarkResult.findById(original._id);
        document.quality_score = 1;
        await expect(document.save()).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.bulkWrite([{
            updateOne: { filter: { _id: original._id }, update: { $set: { quality_score: 1 } } }
        }])).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.create({
            batch_id: batch._id,
            model: 'late-model',
            host: 'opaque-test-host',
            prompt: 'late-result',
            success: true
        })).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.updateOne(
            { model: 'late-upsert-model' },
            {
                $set: { host: 'opaque-test-host', prompt: 'late-upsert-result', success: true },
                $setOnInsert: { batch_id: batch._id }
            },
            { upsert: true }
        )).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.countDocuments({ batch_id: batch._id })).resolves.toBe(SOURCE_RESULT_COUNT);

        const openBatch = await createLinkedBatch(sourceBatchId('e'));
        const openResult = await BenchmarkResult.findOne({ batch_id: openBatch._id });
        await expect(BenchmarkResult.updateOne(
            { _id: openResult._id },
            { $set: { batch_id: batch._id } }
        )).rejects.toMatchObject(sealed);
        openResult.batch_id = batch._id;
        await expect(openResult.save()).rejects.toMatchObject(sealed);
        await expect(BenchmarkResult.countDocuments({ batch_id: batch._id })).resolves.toBe(SOURCE_RESULT_COUNT);
        await expect(BenchmarkResult.findById(openResult._id).lean()).resolves.toMatchObject({
            batch_id: openBatch._id
        });
        await expect(BenchmarkBatch.updateOne(
            { _id: batch._id },
            { $set: { description: 'rewritten evidence' } }
        )).rejects.toMatchObject(sealedBatch);

        const after = await BenchmarkResult.findById(original._id).lean();
        expect(after).toMatchObject({
            quality_score: original.quality_score,
            excluded_from_leaderboard: false,
            trust_evidence_sealed: true
        });
        await expect(BenchmarkBatch.findById(batch._id).lean()).resolves.toMatchObject({
            description: '',
            trust_evidence_sealed: true
        });
    });

    test('concurrent receipt issuance and global cleanup never leave an orphaned receipt', async () => {
        for (const character of ['5', '6', '7', '8']) {
            const sourceId = sourceBatchId(character);
            const batch = await createLinkedBatch(sourceId);
            const receipt = buildBenchmarkTrustReceipt(bodyFixture({
                sourceId,
                campaignCharacter: character
            }));

            await Promise.allSettled([
                storeVerifiedReceipt(receipt),
                clearResults()
            ]);

            const [receiptCount, resultCount] = await Promise.all([
                BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId }),
                BenchmarkResult.countDocuments({ batch_id: batch._id })
            ]);
            expect([0, 1]).toContain(receiptCount);
            expect(resultCount).toBe(receiptCount === 1 ? SOURCE_RESULT_COUNT : 0);
        }
    });

    test('concurrent completion timestamp mutation and issuance cannot verify a stale batch snapshot', async () => {
        const sourceId = sourceBatchId('7');
        const batch = await createLinkedBatch(sourceId);
        const originalCompletedAt = new Date(batch.completed_at);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({ sourceId }));
        batch.completed_at = new Date(originalCompletedAt.getTime() + 1000);

        await Promise.allSettled([
            storeBenchmarkTrustReceipt(receipt),
            batch.save()
        ]);

        const [receiptCount, current] = await Promise.all([
            BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId }),
            BenchmarkBatch.findById(batch._id).lean()
        ]);
        if (receiptCount === 1) {
            expect(current.completed_at).toEqual(originalCompletedAt);
            expect(current.trust_evidence_sealed).toBe(true);
        } else {
            expect(receiptCount).toBe(0);
            expect(current.completed_at).toEqual(batch.completed_at);
            expect(current.trust_evidence_sealed).not.toBe(true);
        }
    });

    test('concurrent result save and issuance never produce a receipt over changed evidence', async () => {
        const sourceId = sourceBatchId('a');
        const batch = await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            campaignCharacter: 'a'
        }));
        const result = await BenchmarkResult.findOne({ batch_id: batch._id });
        const originalScore = result.quality_score;
        result.quality_score = 1;

        await Promise.allSettled([
            storeBenchmarkTrustReceipt(receipt),
            result.save()
        ]);

        const [receiptCount, current] = await Promise.all([
            BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId }),
            BenchmarkResult.findById(result._id).lean()
        ]);
        if (receiptCount === 1) {
            expect(current).toMatchObject({ quality_score: originalScore, trust_evidence_sealed: true });
        } else {
            expect(receiptCount).toBe(0);
            expect(current.quality_score).toBe(1);
            expect(current.trust_evidence_sealed).not.toBe(true);
        }
    });

    test('concurrent result creation and issuance never add a row behind a receipt', async () => {
        const sourceId = sourceBatchId('b');
        const batch = await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            campaignCharacter: 'b'
        }));

        await Promise.allSettled([
            storeVerifiedReceipt(receipt),
            BenchmarkResult.create({
                batch_id: batch._id,
                model: 'concurrent-late-model',
                host: 'opaque-test-host',
                prompt: 'concurrent-late-result',
                success: true
            })
        ]);

        const [receiptCount, resultCount] = await Promise.all([
            BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId }),
            BenchmarkResult.countDocuments({ batch_id: batch._id })
        ]);
        if (receiptCount === 1) {
            expect(resultCount).toBe(SOURCE_RESULT_COUNT);
        } else {
            expect(receiptCount).toBe(0);
            expect(resultCount).toBe(SOURCE_RESULT_COUNT);
        }
    });

    test('Trust finalization protects evidence before receipt issuance', async () => {
        const sourceId = sourceBatchId('9');
        const batch = await createLinkedBatch(sourceId);
        const receipt = buildBenchmarkTrustReceipt(bodyFixture({
            sourceId,
            campaignCharacter: '9'
        }));

        await expect(clearResults()).resolves.toBe(0);
        await expect(storeVerifiedReceipt(receipt)).resolves.toMatchObject({ created: true });
        await expect(BenchmarkTrustReceipt.countDocuments({ receiptId: receipt.receiptId })).resolves.toBe(1);
        await expect(BenchmarkResult.countDocuments({ batch_id: batch._id })).resolves.toBe(SOURCE_RESULT_COUNT);
    });
});
