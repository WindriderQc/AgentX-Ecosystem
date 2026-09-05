'use strict';

const crypto = require('crypto');
const { stableSerialize } = require('../../../../shared/artifactIdentity');
const {
    SOURCE_CONTEXT_SCHEMA,
    RANKING_POLICY_SCHEMA,
    FRESHNESS_POLICY_SCHEMA,
    buildBenchmarkTrustFreshnessProjection,
    buildBenchmarkTrustSourceProjection,
    computeBenchmarkTrustExecutionEnvelopeSetFingerprint,
    computeBenchmarkTrustJudgeBindingFingerprint,
    computePromptSourceFingerprint,
    normalizeSourceContext
} = require('../../../src/services/benchmark/benchmarkTrustSourceEvidence');
const {
    fingerprint: workerFingerprint,
    normalizeWorkerEnvelope,
    normalizeWorkerReceipt
} = require('../../../../shared/workerContract');
const { normalizeBenchmarkTarget } = require('../../../../shared/benchmarkTargetContract');
const {
    buildHarnessEnvelope,
    buildTrustJudgeCellId,
    normalizeHarnessInvocationParameters
} = require('../../../src/services/benchmark/harnessBrokerClient');
const {
    buildBenchmarkTrustPowerAnalysisFields,
    buildBenchmarkTrustVarianceBasis,
    computeBenchmarkTrustCandidateInferenceContractFingerprint,
    computeBenchmarkTrustVarianceCandidateSetFingerprint,
    computeBenchmarkTrustVariancePairFingerprints
} = require('../../../src/services/benchmark/benchmarkTrustStatistics');
const {
    buildBenchmarkTrustPromptSamplingPolicy
} = require('../../../src/services/benchmark/config');

const clone = value => JSON.parse(JSON.stringify(value));
const campaignArtifact = Object.freeze({
    schema: 'source-evidence-test-campaign/v1', frozen: true
});
const executionConfig = Object.freeze({
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
const candidateId = character => `candidate_${character.repeat(32)}`;
const promptId = character => `prompt_${character.repeat(32)}`;
const poweredPromptIds = Object.freeze(Array.from(
    { length: 30 },
    (_, index) => `prompt_${(index + 1).toString(16).padStart(32, '0')}`
));
const sourceBatchId = `batch_${'d'.repeat(32)}`;
const workerJudgeIdentity = Object.freeze({
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
const judgeTarget = normalizeBenchmarkTarget({
    id: 'source-test-judge',
    label: 'source-test-judge',
    executionKind: 'harness',
    mode: 'isolated_model',
    tier: 'free_cloud',
    provider: 'judge-provider',
    model: 'judge-model',
    modelVersion: '1.0.0',
    harness: { name: 'judge-harness', version: '1.0.0' },
    adapter: { name: 'judge-adapter', version: '1.0.0' },
    profile: { id: 'judge-env', version: '1.0.0', fingerprint: '6'.repeat(64) },
    api: { name: 'judge-api', version: '1.0.0' },
    contextWindow: 131072,
    capabilities: { candidate: false, judge: true },
    pricing: {
        kind: 'free',
        currency: 'USD',
        source: 'test',
        effectiveAt: null,
        inputNanodollarsPerMillion: 0,
        outputNanodollarsPerMillion: 0,
        callNanodollars: 0
    },
    available: true,
    observedAt: '2026-01-01T00:00:00.000Z',
    catalogFingerprint: '5'.repeat(64)
});
const judgeInvocation = Object.freeze(normalizeHarnessInvocationParameters({
    temperature: 0,
    seed: 7,
    maxTokens: 1024,
    timeoutMs: 60000
}, { role: 'judge' }));
const representativeJudgeEnvelope = normalizeWorkerEnvelope(buildHarnessEnvelope({
    batchId: '507f1f77bcf86cd799439099',
    cellId: `trust-judge:${candidateId('a')}:${promptId('1')}:0`,
    target: judgeTarget,
    promptText: 'representative judge prompt',
    parameters: judgeInvocation,
    role: 'judge'
}));
const runtimeRubric = Object.freeze({
    schema: 'agentx.benchmark-trust-judge-runtime-rubric/v1',
    scoringMethod: 'llm_judge',
    scorerVersion: 'source-evidence-test-v1',
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
    resultContract: representativeJudgeEnvelope.resultContract,
    executionProfile: representativeJudgeEnvelope.executionProfile,
    toolsFingerprint: representativeJudgeEnvelope.tools.schemaFingerprint,
    policiesFingerprint: representativeJudgeEnvelope.policies.fingerprint,
    judgeInvocation
});
const judge = Object.freeze({
    qualificationReceiptId: '9'.repeat(64),
    identityFingerprint: workerFingerprint(workerJudgeIdentity),
    rubricFingerprint: workerFingerprint(runtimeRubric),
    corpusFingerprint: 'c'.repeat(64),
    holdoutFingerprint: 'd'.repeat(64),
    qualificationStatus: 'qualified',
    validUntil: '2099-09-15T12:00:00.000Z'
});
const scoreEvidenceBase = Object.freeze({
    judgeTargetFingerprint: judgeTarget.fingerprint,
    qualityCohortFingerprint: 'a'.repeat(64),
    scoringMethod: 'llm_judge',
    scorerVersion: 'source-evidence-test-v1',
    workerIdentityFingerprint: judge.identityFingerprint,
    toolsFingerprint: representativeJudgeEnvelope.tools.schemaFingerprint,
    policiesFingerprint: representativeJudgeEnvelope.policies.fingerprint,
    executionProfile: representativeJudgeEnvelope.executionProfile,
    judgeInvocation,
    runtimeRubric
});
const scoreEvidence = Object.freeze({
    ...scoreEvidenceBase,
    judgeBindingFingerprint: computeBenchmarkTrustJudgeBindingFingerprint({
        judge,
        scoreEvidence: scoreEvidenceBase
    })
});

const identities = [
    {
        candidateId: candidateId('a'),
        sourceIdentity: {
            model: 'model-a',
            host: 'test-host',
            modelDigest: `sha256:${'1'.repeat(64)}`,
            artifactDigest: `sha256:${'2'.repeat(64)}`,
            inferenceContractFingerprint: '3'.repeat(64),
            executionTargetFingerprint: '4'.repeat(64),
            workerIdentityFingerprint: workerFingerprint({
                ...workerJudgeIdentity,
                model: {
                    ...workerJudgeIdentity.model,
                    name: 'model-a',
                    digest: `sha256:${'1'.repeat(64)}`,
                    runtimeFingerprint: '3'.repeat(64)
                },
                environment: { ...workerJudgeIdentity.environment, fingerprint: '3'.repeat(64) }
            }),
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
            host: 'test-host',
            modelDigest: `sha256:${'5'.repeat(64)}`,
            artifactDigest: `sha256:${'6'.repeat(64)}`,
            inferenceContractFingerprint: '7'.repeat(64),
            executionTargetFingerprint: '8'.repeat(64),
            workerIdentityFingerprint: workerFingerprint({
                ...workerJudgeIdentity,
                model: {
                    ...workerJudgeIdentity.model,
                    name: 'model-b',
                    digest: `sha256:${'5'.repeat(64)}`,
                    runtimeFingerprint: '7'.repeat(64)
                },
                environment: { ...workerJudgeIdentity.environment, fingerprint: '7'.repeat(64) }
            }),
            toolsFingerprint: '3'.repeat(64),
            policiesFingerprint: '4'.repeat(64),
            executionProfile: 'portable',
            envelopeSetFingerprint: '0'.repeat(64)
        }
    }
];

function executionWorkerIdentity(candidate) {
    return {
        ...clone(workerJudgeIdentity),
        model: {
            ...clone(workerJudgeIdentity.model),
            name: candidate.sourceIdentity.model,
            digest: candidate.sourceIdentity.modelDigest,
            runtimeFingerprint: candidate.sourceIdentity.inferenceContractFingerprint
        },
        environment: {
            ...clone(workerJudgeIdentity.environment),
            fingerprint: candidate.sourceIdentity.inferenceContractFingerprint
        }
    };
}

function rowsFixture() {
    const rows = [];
    for (const [candidateIndex, candidate] of identities.entries()) {
        for (const [promptIndex, exactPromptId] of poweredPromptIds.entries()) {
            for (const repeatIndex of [0, 1]) {
                const qualityScore = candidateIndex === 0 ? 10 : 0;
                const row = {
                batch_id: '507f1f77bcf86cd799439099',
                model: candidate.sourceIdentity.model,
                model_digest: candidate.sourceIdentity.modelDigest,
                host: candidate.sourceIdentity.host,
                execution_target: { fingerprint: candidate.sourceIdentity.executionTargetFingerprint },
                judge_target: clone(judgeTarget),
                quality_cohort_fingerprint: scoreEvidence.qualityCohortFingerprint,
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
                scoring_method: scoreEvidence.scoringMethod,
                scorer_version: scoreEvidence.scorerVersion,
                quality_score: qualityScore,
                quality_breakdown: { overall: qualityScore },
                judge_reported_overall: qualityScore,
                format_score: null,
                format_compliant: null,
                composite_score: candidateIndex === 0 ? 100 : 0,
                excluded_from_leaderboard: false,
                execution_settings: {
                    artifact_digest: candidate.sourceIdentity.artifactDigest,
                    inference_contract_fingerprint: candidate.sourceIdentity.inferenceContractFingerprint
                },
                repeat_index: repeatIndex,
                repeat_total: 2,
                trust_candidate_id: candidate.candidateId,
                trust_prompt_id: exactPromptId,
                timestamp: '2026-01-01T00:00:00.000Z',
                updated_at: '2026-01-01T00:00:00.000Z'
                };
                row.trust_execution_receipt = normalizeWorkerReceipt({
                    schema: 'agentx.worker-receipt/v1',
                    schemaVersion: 1,
                    executionProfile: candidate.sourceIdentity.executionProfile,
                    identity: executionWorkerIdentity(candidate),
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
                const judgeEnvelope = normalizeWorkerEnvelope(buildHarnessEnvelope({
                    batchId: row.batch_id,
                    cellId: buildTrustJudgeCellId(row),
                    target: row.judge_target,
                    promptText: row.judge_prompt,
                    parameters: scoreEvidence.judgeInvocation,
                    role: 'judge'
                }));
                row.trust_judge_receipt = normalizeWorkerReceipt({
                    schema: 'agentx.worker-receipt/v1',
                    schemaVersion: 1,
                    executionProfile: scoreEvidence.executionProfile,
                    identity: clone(workerJudgeIdentity),
                    fingerprints: {
                        prompt: workerFingerprint(row.judge_prompt),
                        tools: scoreEvidence.toolsFingerprint,
                        policies: scoreEvidence.policiesFingerprint,
                        envelope: judgeEnvelope.fingerprint
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

function contextFixture(rows = rowsFixture()) {
    const candidateIds = identities.map(candidate => candidate.candidateId);
    const promptIds = [...poweredPromptIds];
    const firstByPrompt = new Map();
    for (const row of rows) {
        if (!firstByPrompt.has(row.trust_prompt_id)) firstByPrompt.set(row.trust_prompt_id, row);
    }
    const promptSamplingPolicy = buildBenchmarkTrustPromptSamplingPolicy(
        campaignArtifact,
        executionConfig,
        [...firstByPrompt.values()].map(row => computePromptSourceFingerprint(row))
    );
    const frozenVarianceBasis = varianceBasis({
        candidateBindings: identities.map(candidate => ({
            targetFingerprint: candidate.sourceIdentity.executionTargetFingerprint,
            modelDigest: candidate.sourceIdentity.modelDigest,
            artifactDigest: candidate.sourceIdentity.artifactDigest,
            inferenceContractFingerprint: candidate.sourceIdentity.inferenceContractFingerprint
        })),
        rubricFingerprint: judge.rubricFingerprint,
        promptSamplingPolicy
    });
    const powerFields = buildBenchmarkTrustPowerAnalysisFields({
        alpha: 0.05,
        mde: 1,
        poweredAlternativeEffect: 10,
        candidateIds,
        targetPowerBasisPoints: 8000,
        assumedMaxPairedStdDevMicros: frozenVarianceBasis.upperConfidenceBoundMicros,
        varianceBasis: frozenVarianceBasis
    });
    const analysisPlan = {
        alpha: 0.05,
        mde: 1,
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
    return {
        schema: SOURCE_CONTEXT_SCHEMA,
        sourceBatchId,
        claimScope: 'capability',
        product: {
            revision: 'a'.repeat(40),
            coreImageDigest: `sha256:${'b'.repeat(64)}`,
            benchmarkImageDigest: `sha256:${'c'.repeat(64)}`,
            ragImageDigest: `sha256:${'d'.repeat(64)}`
        },
        campaign: {
            campaignId: `campaign_${'c'.repeat(32)}`,
            artifact: campaignArtifact
        },
        inferenceProfile: {
            artifact: { schema: 'source-evidence-test-profile/v1', profile: 'controlled' }
        },
        prompts: [...firstByPrompt.entries()].map(([exactPromptId, row]) => ({
            promptId: exactPromptId,
            fingerprint: computePromptSourceFingerprint(row)
        })).sort((left, right) => left.promptId.localeCompare(right.promptId)),
        candidates: clone(identities).map(candidate => ({
            ...candidate,
            sourceIdentity: {
                ...candidate.sourceIdentity,
                envelopeSetFingerprint: computeBenchmarkTrustExecutionEnvelopeSetFingerprint({
                    candidateId: candidate.candidateId,
                    entries: rows
                        .filter(row => row.trust_candidate_id === candidate.candidateId)
                        .map(row => ({
                            promptId: row.trust_prompt_id,
                            repeatIndex: row.repeat_index,
                            envelopeFingerprint: row.trust_execution_receipt.fingerprints.envelope
                        }))
                })
            }
        })),
        judge: clone(judge),
        scoreEvidence: clone(scoreEvidence),
        freshnessPolicy: {
            schema: FRESHNESS_POLICY_SCHEMA,
            staleAfterSeconds: 7 * 24 * 60 * 60,
            expiresAfterSeconds: 30 * 24 * 60 * 60
        },
        statistics: {
            analysisPlan,
            analysisPlanFingerprint: crypto.createHash('sha256').update(stableSerialize({
                schema: 'agentx.benchmark-trust-analysis-plan/v2',
                plan: analysisPlan
            })).digest('hex'),
            rankingPolicy: {
                schema: RANKING_POLICY_SCHEMA,
                scoreField: 'quality_score'
            }
        }
    };
}

describe('benchmarkTrustSourceEvidence', () => {
    test('recomputes one deterministic complete winner from frozen raw source rows', () => {
        const rows = rowsFixture();
        const context = contextFixture(rows);
        const projection = buildBenchmarkTrustSourceProjection({ context, results: rows, sourceBatchId });
        const reversed = buildBenchmarkTrustSourceProjection({
            context,
            results: [...rows].reverse(),
            sourceBatchId
        });

        expect(projection).toEqual(reversed);
        expect(projection).toMatchObject({
            evidenceStatus: 'complete',
            decisionOutcome: 'winner',
            execution: {
                expectedResultCount: 120,
                observedResultCount: 120,
                excludedResultCount: 0,
                promptCount: 30,
                cellInventory: {
                    cellCount: 60,
                    minimumRepeatCount: 2,
                    maximumRepeatCount: 2
                }
            }
        });
        expect(projection.execution.candidates).toHaveLength(2);
        expect(projection.judge).toEqual(judge);
        expect(projection.statistics.decisionFingerprint).toMatch(/^[0-9a-f]{64}$/);
    });

    test('rejects null, fake, reused, mutated, or mixed execution and judge receipts', () => {
        const rows = rowsFixture();
        const context = contextFixture(rows);
        const mixedJudge = clone(rows);
        mixedJudge[0].judge_target.fingerprint = 'f'.repeat(64);
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: mixedJudge,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const missingJudgeReceipt = clone(rows);
        missingJudgeReceipt[0].trust_judge_receipt = null;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: missingJudgeReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const minimalFake = clone(rows);
        minimalFake[0].trust_judge_receipt = { fingerprint: 'f'.repeat(64) };
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: minimalFake,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const reusedReceipt = clone(rows);
        reusedReceipt[1].trust_judge_receipt = clone(reusedReceipt[0].trust_judge_receipt);
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: reusedReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const mutatedReceipt = clone(rows);
        mutatedReceipt[0].trust_judge_receipt.usage.durationMs += 1;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: mutatedReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const missingExecutionReceipt = clone(rows);
        missingExecutionReceipt[0].trust_execution_receipt = null;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: missingExecutionReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const fakeExecutionReceipt = clone(rows);
        fakeExecutionReceipt[0].trust_execution_receipt = { fingerprint: 'f'.repeat(64) };
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: fakeExecutionReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const reusedExecutionReceipt = clone(rows);
        reusedExecutionReceipt[1].trust_execution_receipt = clone(reusedExecutionReceipt[0].trust_execution_receipt);
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: reusedExecutionReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const mutatedExecutionReceipt = clone(rows);
        mutatedExecutionReceipt[0].trust_execution_receipt.usage.durationMs += 1;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: mutatedExecutionReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const intervenedReceipt = clone(rows);
        delete intervenedReceipt[0].trust_judge_receipt.fingerprint;
        intervenedReceipt[0].trust_judge_receipt.humanInterventions = [
            { kind: 'human_override', count: 1 }
        ];
        intervenedReceipt[0].trust_judge_receipt = normalizeWorkerReceipt(
            intervenedReceipt[0].trust_judge_receipt
        );
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: intervenedReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const humanOverride = clone(rows);
        humanOverride[0].quality_score = 10;
        humanOverride[0].human_review_status = 'overridden';
        humanOverride[0].human_score = 10;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: humanOverride,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));
    });

    test('derives fresh, stale, and expired states only from the bounded frozen policy', () => {
        const policy = contextFixture().freshnessPolicy;
        const completedAt = '2026-01-01T00:00:00.000Z';
        const fresh = buildBenchmarkTrustFreshnessProjection({
            freshnessPolicy: policy,
            completedAt,
            now: '2026-01-02T00:00:00.000Z'
        });
        expect(fresh).toMatchObject({
            freshnessStatus: 'fresh',
            validUntil: '2026-01-08T00:00:00.000Z'
        });
        expect(buildBenchmarkTrustFreshnessProjection({
            freshnessPolicy: policy,
            completedAt,
            judgeValidUntil: '2026-01-04T00:00:00.000Z',
            now: '2026-01-02T00:00:00.000Z'
        }).validUntil).toBe('2026-01-04T00:00:00.000Z');
        expect(buildBenchmarkTrustFreshnessProjection({
            freshnessPolicy: policy,
            completedAt,
            judgeValidUntil: '2026-01-04T00:00:00.000Z',
            now: '2026-01-05T00:00:00.000Z'
        }).freshnessStatus).toBe('stale');
        expect(buildBenchmarkTrustFreshnessProjection({
            freshnessPolicy: policy,
            completedAt,
            now: '2026-01-10T00:00:00.000Z'
        }).freshnessStatus).toBe('stale');
        expect(buildBenchmarkTrustFreshnessProjection({
            freshnessPolicy: policy,
            completedAt,
            now: '2026-02-01T00:00:00.000Z'
        }).freshnessStatus).toBe('expired');

        expect(() => buildBenchmarkTrustFreshnessProjection({
            freshnessPolicy: { ...policy, staleAfterSeconds: 0 },
            completedAt,
            now: completedAt
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID' }));
    });

    test('rejects source rows that diverge from prompt identity or preregistered repeats', () => {
        const rows = rowsFixture();
        const context = contextFixture(rows);
        const changedPrompt = clone(rows);
        changedPrompt[0].prompt = 'mutated-after-preregistration';
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: changedPrompt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const duplicateRepeat = clone(rows);
        duplicateRepeat[0].repeat_index = 1;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: duplicateRepeat,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const missingDurableUpdate = clone(rows);
        missingDurableUpdate[0].updated_at = null;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: missingDurableUpdate,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const contradictoryContext = clone(context);
        contradictoryContext.candidates[0].sourceIdentity.model = 'contradictory-model';
        const contradictoryRows = clone(rows);
        contradictoryRows
            .filter(row => row.trust_candidate_id === contradictoryContext.candidates[0].candidateId)
            .forEach((row) => { row.model = 'contradictory-model'; });
        expect(() => buildBenchmarkTrustSourceProjection({
            context: contradictoryContext,
            results: contradictoryRows,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));
    });

    test('rejects legacy, extensible, or underpowered source contexts', () => {
        const context = contextFixture();
        const legacyV2 = clone(context);
        legacyV2.schema = 'agentx.benchmark-trust-source-context/v2';
        expect(() => normalizeSourceContext(legacyV2)).toThrow(expect.objectContaining({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID'
        }));

        const missing = clone(context);
        delete missing.statistics.analysisPlanFingerprint;
        expect(() => normalizeSourceContext(missing)).toThrow(expect.objectContaining({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID'
        }));

        const extra = clone(context);
        extra.callerCommittedAt = '1970-01-01T00:00:00.000Z';
        expect(() => normalizeSourceContext(extra)).toThrow(expect.objectContaining({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID'
        }));

        const underpowered = clone(context);
        underpowered.statistics.analysisPlan.requiredIndependentPromptCount += 1;
        expect(() => normalizeSourceContext(underpowered)).toThrow(expect.objectContaining({
            code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH'
        }));

        const changedPoweredAlternative = clone(context);
        changedPoweredAlternative.statistics.analysisPlan.poweredAlternativeEffect -= 0.25;
        expect(() => normalizeSourceContext(changedPoweredAlternative)).toThrow(expect.objectContaining({
            code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH'
        }));

        const impossiblePoweredAlternative = clone(context);
        impossiblePoweredAlternative.statistics.analysisPlan.poweredAlternativeEffect = 10.1;
        expect(() => normalizeSourceContext(impossiblePoweredAlternative)).toThrow(expect.objectContaining({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID'
        }));

        const changedPromptPolicy = clone(context);
        changedPromptPolicy.statistics.analysisPlan.promptSamplingPolicy
            .promptTransformation.executionConfig.custom_hint = 'changed-after-launch';
        changedPromptPolicy.statistics.analysisPlanFingerprint = crypto
            .createHash('sha256')
            .update(stableSerialize({
                schema: 'agentx.benchmark-trust-analysis-plan/v2',
                plan: changedPromptPolicy.statistics.analysisPlan
            }))
            .digest('hex');
        expect(() => normalizeSourceContext(changedPromptPolicy)).toThrow(expect.objectContaining({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID'
        }));

        const differentRuntimeRubric = clone(context);
        differentRuntimeRubric.scoreEvidence.runtimeRubric.promptContract = 'different-judge-prompt';
        differentRuntimeRubric.scoreEvidence.judgeBindingFingerprint = computeBenchmarkTrustJudgeBindingFingerprint({
            judge: differentRuntimeRubric.judge,
            scoreEvidence: differentRuntimeRubric.scoreEvidence
        });
        expect(() => normalizeSourceContext(differentRuntimeRubric)).toThrow(expect.objectContaining({
            code: 'BENCHMARK_TRUST_SOURCE_CONTEXT_INVALID'
        }));
    });
});
