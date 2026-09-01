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
    computeBenchmarkTrustExecutionResultFingerprint,
    computeBenchmarkTrustJudgeBindingFingerprint,
    computeBenchmarkTrustJudgeResultFingerprint,
    computePromptSourceFingerprint,
    normalizeSourceContext
} = require('../../../src/services/benchmark/benchmarkTrustSourceEvidence');
const {
    fingerprint: workerFingerprint,
    normalizeWorkerReceipt
} = require('../../../../shared/workerContract');
const {
    buildBenchmarkTrustPowerAnalysisFields
} = require('../../../src/services/benchmark/benchmarkTrustStatistics');

const clone = value => JSON.parse(JSON.stringify(value));
const candidateId = character => `candidate_${character.repeat(32)}`;
const promptId = character => `prompt_${character.repeat(32)}`;
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
const judge = Object.freeze({
    qualificationReceiptId: '9'.repeat(64),
    identityFingerprint: workerFingerprint(workerJudgeIdentity),
    rubricFingerprint: 'b'.repeat(64),
    corpusFingerprint: 'c'.repeat(64),
    holdoutFingerprint: 'd'.repeat(64),
    qualificationStatus: 'qualified',
    validUntil: '2099-09-15T12:00:00.000Z'
});
const scoreEvidenceBase = Object.freeze({
    judgeTargetFingerprint: 'e'.repeat(64),
    qualityCohortFingerprint: 'a'.repeat(64),
    scoringMethod: 'llm_judge',
    scorerVersion: 'source-evidence-test-v1',
    workerIdentityFingerprint: judge.identityFingerprint,
    toolsFingerprint: 'f'.repeat(64),
    policiesFingerprint: judge.rubricFingerprint,
    executionProfile: 'portable',
    envelopeFingerprint: '5'.repeat(64)
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
                environment: { ...workerJudgeIdentity.environment, fingerprint: '4'.repeat(64) }
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
                environment: { ...workerJudgeIdentity.environment, fingerprint: '8'.repeat(64) }
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
            fingerprint: candidate.sourceIdentity.executionTargetFingerprint
        }
    };
}

function rowsFixture() {
    const rows = [];
    for (const [candidateIndex, candidate] of identities.entries()) {
        for (const [promptIndex, exactPromptId] of [promptId('1'), promptId('2'), promptId('3')].entries()) {
            for (const repeatIndex of [0, 1]) {
                const qualityScore = candidateIndex === 0 ? [9, 9.01, 8.99][promptIndex] : 7;
                const row = {
                model: candidate.sourceIdentity.model,
                model_digest: candidate.sourceIdentity.modelDigest,
                host: candidate.sourceIdentity.host,
                execution_target: { fingerprint: candidate.sourceIdentity.executionTargetFingerprint },
                judge_target: { fingerprint: scoreEvidence.judgeTargetFingerprint },
                quality_cohort_fingerprint: scoreEvidence.qualityCohortFingerprint,
                prompt: `opaque-prompt-${promptIndex}`,
                prompt_name: `prompt-${promptIndex}`,
                prompt_level: 1,
                prompt_category: 'reasoning',
                scoring_type: 'reasoning',
                scoring_plan: 'llm_judge',
                response: `opaque-response-${candidateIndex}-${promptIndex}-${repeatIndex}`,
                success: true,
                scoring_method: scoreEvidence.scoringMethod,
                scorer_version: scoreEvidence.scorerVersion,
                quality_score: qualityScore,
                composite_score: candidateIndex === 0 ? [90, 90.1, 89.9][promptIndex] : 70,
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
                const promptFingerprint = computePromptSourceFingerprint(row);
                row.execution_receipt = normalizeWorkerReceipt({
                    schema: 'agentx.worker-receipt/v1',
                    schemaVersion: 1,
                    executionProfile: candidate.sourceIdentity.executionProfile,
                    identity: executionWorkerIdentity(candidate),
                    fingerprints: {
                        prompt: promptFingerprint,
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
                        fingerprint: computeBenchmarkTrustExecutionResultFingerprint({
                            candidateId: candidate.candidateId,
                            promptId: exactPromptId,
                            repeatIndex,
                            response: row.response,
                            success: row.success
                        })
                    }
                });
                row.judge_receipt = normalizeWorkerReceipt({
                    schema: 'agentx.worker-receipt/v1',
                    schemaVersion: 1,
                    executionProfile: scoreEvidence.executionProfile,
                    identity: clone(workerJudgeIdentity),
                    fingerprints: {
                        prompt: promptFingerprint,
                        tools: scoreEvidence.toolsFingerprint,
                        policies: scoreEvidence.policiesFingerprint,
                        envelope: scoreEvidence.envelopeFingerprint
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
                        fingerprint: computeBenchmarkTrustJudgeResultFingerprint({
                            candidateId: candidate.candidateId,
                            promptId: exactPromptId,
                            repeatIndex,
                            response: row.response,
                            qualityScore,
                            rubricFingerprint: judge.rubricFingerprint,
                            judgeIdentityFingerprint: judge.identityFingerprint
                        })
                    }
                });
                rows.push(row);
            }
        }
    }
    return rows;
}

function contextFixture(rows = rowsFixture()) {
    const candidateIds = identities.map(candidate => candidate.candidateId);
    const promptIds = [promptId('1'), promptId('2'), promptId('3')];
    const powerFields = buildBenchmarkTrustPowerAnalysisFields({
        alpha: 0.05,
        mde: 1,
        candidateIds,
        targetPowerBasisPoints: 8000,
        assumedMaxPairedStdDevMicros: 50000
    });
    const analysisPlan = {
        alpha: 0.05,
        mde: 1,
        equivalenceMargin: 0.1,
        repeatCount: 2,
        ...powerFields,
        candidateIds,
        promptIds
    };
    const firstByPrompt = new Map();
    for (const row of rows) {
        if (!firstByPrompt.has(row.trust_prompt_id)) firstByPrompt.set(row.trust_prompt_id, row);
    }
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
            artifact: { schema: 'source-evidence-test-campaign/v1', frozen: true }
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
                            envelopeFingerprint: row.execution_receipt.fingerprints.envelope
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
                schema: 'agentx.benchmark-trust-analysis-plan/v1',
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
                expectedResultCount: 12,
                observedResultCount: 12,
                excludedResultCount: 0,
                promptCount: 3,
                cellInventory: {
                    cellCount: 6,
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
        missingJudgeReceipt[0].judge_receipt = null;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: missingJudgeReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const minimalFake = clone(rows);
        minimalFake[0].judge_receipt = { fingerprint: 'f'.repeat(64) };
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: minimalFake,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const reusedReceipt = clone(rows);
        reusedReceipt[1].judge_receipt = clone(reusedReceipt[0].judge_receipt);
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: reusedReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const mutatedReceipt = clone(rows);
        mutatedReceipt[0].judge_receipt.usage.durationMs += 1;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: mutatedReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const missingExecutionReceipt = clone(rows);
        missingExecutionReceipt[0].execution_receipt = null;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: missingExecutionReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const fakeExecutionReceipt = clone(rows);
        fakeExecutionReceipt[0].execution_receipt = { fingerprint: 'f'.repeat(64) };
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: fakeExecutionReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const reusedExecutionReceipt = clone(rows);
        reusedExecutionReceipt[1].execution_receipt = clone(reusedExecutionReceipt[0].execution_receipt);
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: reusedExecutionReceipt,
            sourceBatchId
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_SOURCE_EVIDENCE_MISMATCH' }));

        const mutatedExecutionReceipt = clone(rows);
        mutatedExecutionReceipt[0].execution_receipt.usage.durationMs += 1;
        expect(() => buildBenchmarkTrustSourceProjection({
            context,
            results: mutatedExecutionReceipt,
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
    });
});
