'use strict';

const crypto = require('crypto');
const path = require('path');

const {
    normalizeBenchmarkTarget
} = require('../../../../shared/benchmarkTargetContract');
const {
    fingerprint
} = require('../../../../shared/workerContract');
const {
    BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
    computeBenchmarkJudgeQualificationAttestationId,
    serializeBenchmarkJudgeQualificationAttestationSigningPayload
} = require('../../../../shared/benchmarkJudgeQualificationAttestation');
const {
    BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
    computeBenchmarkVariancePilotAttestationId,
    computeBenchmarkVariancePilotCohortFingerprint,
    serializeBenchmarkVariancePilotAttestationSigningPayload
} = require('../../../../shared/benchmarkVariancePilotAttestation');
const {
    MIN_REVOCATION_VERSION_ENV,
    REVOCATION_SNAPSHOT_ID_ENV,
    REVOCATIONS_ENV,
    REVOCATIONS_SCHEMA,
    TRUST_ROOTS_ENV,
    TRUST_ROOTS_SCHEMA
} = require('../../../src/services/benchmark/benchmarkJudgeQualificationAuthority');
const {
    CAMPAIGN_SPEC_SCHEMA,
    assertConfiguredProductManifest,
    assertRuntimeEnabled,
    buildCampaignPromptAuthority,
    buildJudgeRuntimeImplementationManifest,
    buildTrustSourceContext,
    computeJudgeRuntimeRubricFingerprint,
    loadCampaignSpec,
    normalizeCampaignSpec,
    resolveTrustCellIdentity
} = require('../../../src/services/benchmark/benchmarkTrustCampaignRuntime');
const {
    buildBenchmarkTrustVarianceBasis,
    computeBenchmarkTrustCandidateInferenceContractFingerprint,
    computeBenchmarkTrustVarianceCandidateSetFingerprint,
    computeBenchmarkTrustVariancePairFingerprints
} = require('../../../src/services/benchmark/benchmarkTrustStatistics');
const {
    buildBenchmarkTrustPromptSamplingPolicy
} = require('../../../src/services/benchmark/config');

const hex = character => character.repeat(64);
const now = Date.parse('2026-09-01T00:00:00.000Z');
const judgeQualificationKeyPair = crypto.generateKeyPairSync('ed25519');
const judgeQualificationPublicKeyPem = judgeQualificationKeyPair.publicKey.export({
    type: 'spki',
    format: 'pem'
});
const pilotPromptFingerprints = Array.from({ length: 30 }, (_, index) => (
    crypto.createHash('sha256').update(`runtime-pilot-prompt-${index}`).digest('hex')
)).sort();
const varianceBasis = (
    candidateAuthorities,
    rubricFingerprint,
    executionConfig,
    campaignArtifact,
    promptSourceFingerprints
) => {
    const candidateBindings = candidateAuthorities.map(authority => ({
        targetFingerprint: authority.targetFingerprint,
        modelDigest: authority.modelDigest,
        artifactDigest: authority.artifactDigest,
        inferenceContractFingerprint: authority.workerIdentity.model.runtimeFingerprint
    }));
    const candidateInferenceContractFingerprint =
        computeBenchmarkTrustCandidateInferenceContractFingerprint({
            candidateBindings,
            repeatCount: executionConfig.repeats,
            parameters: {
                temperature: executionConfig.temperature,
                topP: executionConfig.top_p,
                seed: executionConfig.seed,
                maxTokens: executionConfig.response_max_tokens,
                timeoutMs: executionConfig.per_test_timeout_ms
            }
        });
    const pairFingerprints = computeBenchmarkTrustVariancePairFingerprints(
        candidateBindings,
        rubricFingerprint
    );
    return buildBenchmarkTrustVarianceBasis({
    schema: 'agentx.benchmark-trust-variance-basis/independent-pilot-upper-bound/v1',
    provenance: 'independent_pilot',
    cohortFingerprint: computeBenchmarkVariancePilotCohortFingerprint(pilotPromptFingerprints),
    candidateSetFingerprint: computeBenchmarkTrustVarianceCandidateSetFingerprint(candidateBindings),
    rubricFingerprint,
    repeatCount: executionConfig.repeats,
    candidateInferenceContractFingerprint,
    promptSamplingPolicyFingerprint: fingerprint(
        buildBenchmarkTrustPromptSamplingPolicy(
            campaignArtifact,
            executionConfig,
            promptSourceFingerprints
        )
    ),
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

function variancePilotAttestation(basis) {
    const body = {
        schema: BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
        issuer: { issuerId: 'benchmark-review-board', keyId: 'judge-key-2026-01' },
        issuedAt: '2026-08-31T22:00:00.000Z',
        validUntil: '2026-10-01T00:00:00.000Z',
        nonce: 'variance-pilot-nonce-000000000001',
        evidence: {
            sourceReceiptId: hex('5'),
            resultInventoryFingerprint: hex('6'),
            varianceBasisFingerprint: basis.artifactFingerprint,
            cohortFingerprint: basis.cohortFingerprint,
            promptFingerprints: pilotPromptFingerprints,
            repeatCount: basis.repeatCount,
            candidateInferenceContractFingerprint: basis.candidateInferenceContractFingerprint,
            promptSamplingPolicyFingerprint: basis.promptSamplingPolicyFingerprint
        }
    };
    const attestationId = computeBenchmarkVariancePilotAttestationId(body);
    const signature = crypto.sign(
        null,
        Buffer.from(serializeBenchmarkVariancePilotAttestationSigningPayload(body, attestationId), 'utf8'),
        judgeQualificationKeyPair.privateKey
    ).toString('base64url');
    return { ...body, attestationId, signature };
}

function targetRaw(id, character, overrides = {}) {
    return {
        id,
        label: id,
        executionKind: 'harness',
        mode: 'isolated_model',
        tier: 'free_cloud',
        provider: `provider-${character}`,
        model: `model-${character}`,
        modelVersion: '1.0.0',
        harness: { name: 'benchmark-harness', version: '1.0.0' },
        adapter: { name: 'benchmark-adapter', version: '1.0.0' },
        profile: { id: `profile-${character}`, version: '1', fingerprint: hex(character) },
        api: { name: 'benchmark-api', version: '1.0.0' },
        contextWindow: 131072,
        capabilities: { candidate: true, judge: true },
        pricing: {
            kind: 'free',
            currency: 'USD',
            source: 'operator-declared-free',
            effectiveAt: null,
            inputNanodollarsPerMillion: 0,
            outputNanodollarsPerMillion: 0,
            callNanodollars: 0
        },
        available: true,
        observedAt: '2026-09-01T00:00:00.000Z',
        catalogFingerprint: hex(character === 'a' ? 'd' : character === 'b' ? 'e' : 'f'),
        ...overrides
    };
}

function workerIdentity(target, character) {
    return {
        harness: target.harness,
        adapter: target.adapter,
        provider: { name: target.provider, version: 'api-v1' },
        model: {
            name: target.model,
            version: target.modelVersion,
            digest: `sha256:${hex(character)}`,
            runtimeFingerprint: target.profile.fingerprint
        },
        api: target.api,
        environment: {
            id: target.profile.id,
            version: target.profile.version,
            fingerprint: target.profile.fingerprint
        }
    };
}

function qualificationAttestation(judgeIdentity, overrides = {}) {
    const { rubricFingerprint = hex('8'), ...bodyOverrides } = overrides;
    const body = {
        schema: BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
        issuer: { issuerId: 'benchmark-review-board', keyId: 'judge-key-2026-01' },
        issuedAt: '2026-08-31T23:00:00.000Z',
        validUntil: '2026-10-01T00:00:00.000Z',
        nonce: 'qualification-nonce-0000000000000001',
        judge: {
            identityFingerprint: fingerprint(judgeIdentity),
            rubricFingerprint,
            corpusFingerprint: hex('9'),
            holdoutFingerprint: hex('a'),
            workerIdentity: judgeIdentity
        },
        evidence: {
            status: 'qualified',
            validationSampleCount: 70,
            holdoutSampleCount: 105,
            overallMaeMicros: 900000,
            overallToleranceBasisPoints: 8700,
            reviewPrecisionBasisPoints: 8300,
            reviewRecallBasisPoints: 8400,
            spearmanBasisPoints: 8200,
            categoryMetrics: [
                'coding', 'creative', 'instruction', 'knowledge', 'math', 'reasoning', 'translation'
            ].map(category => ({
                category,
                validationSampleCount: 10,
                holdoutSampleCount: 15,
                maeMicros: 900000,
                toleranceBasisPoints: 8700,
                difficultyMetrics: [1, 2, 3, 4, 5].map(difficulty => ({
                    difficulty,
                    validationSampleCount: 2,
                    holdoutSampleCount: 3,
                    maeMicros: 900000,
                    toleranceBasisPoints: 8700
                }))
            }))
        },
        ...bodyOverrides
    };
    const attestationId = computeBenchmarkJudgeQualificationAttestationId(body);
    const signature = crypto.sign(
        null,
        Buffer.from(serializeBenchmarkJudgeQualificationAttestationSigningPayload(body, attestationId), 'utf8'),
        judgeQualificationKeyPair.privateKey
    ).toString('base64url');
    return { ...body, attestationId, signature };
}

function campaignSpecFixture(overrides = {}) {
    const first = normalizeBenchmarkTarget(targetRaw('candidate-a', 'a'));
    const second = normalizeBenchmarkTarget(targetRaw('candidate-b', 'b'));
    const judgeTarget = normalizeBenchmarkTarget(targetRaw('judge-c', 'c'));
    const judgeIdentity = workerIdentity(judgeTarget, 'c');
    const judgeConfig = { temperature: 0, seed: 7, maxTokens: 1024, timeoutMs: 60000 };
    const rubricFingerprint = computeJudgeRuntimeRubricFingerprint({ judgeTarget, judgeConfig });
    const promptIds = Array.from({ length: 26 }, (_, index) => (
        `507f1f77bcf86cd79943${(0x9011 + index).toString(16).padStart(4, '0')}`
    ));
    const executionConfig = {
        repeats: 2,
        response_max_tokens: 1024,
        per_test_timeout_ms: 60000,
        temperature: 0,
        top_p: 1,
        seed: 7
    };
    const fixturePrompts = promptIds.map((id, index) => ({
        _id: id,
        name: `prompt-${index}`,
        prompt: `Solve prompt ${index}`,
        level: 1,
        category: 'reasoning',
        scoring_type: 'reasoning',
        expected_answer: `answer-${index}`
    }));
    const candidateAuthorities = [
        {
            targetFingerprint: first.fingerprint,
            workerIdentity: workerIdentity(first, 'a'),
            modelDigest: `sha256:${hex('a')}`,
            artifactDigest: `sha256:${hex('a')}`
        },
        {
            targetFingerprint: second.fingerprint,
            workerIdentity: workerIdentity(second, 'b'),
            modelDigest: `sha256:${hex('b')}`,
            artifactDigest: `sha256:${hex('b')}`
        }
    ];
    const campaignArtifact = { schema: 'campaign-fixture/v1', frozen: true };
    const promptAuthorities = fixturePrompts.map(prompt => (
        buildCampaignPromptAuthority(prompt, executionConfig)
    ));
    const frozenVarianceBasis = varianceBasis(
        candidateAuthorities,
        rubricFingerprint,
        executionConfig,
        campaignArtifact,
        promptAuthorities.map(authority => authority.sourceFingerprint)
    );
    const body = {
        schema: CAMPAIGN_SPEC_SCHEMA,
        schemaVersion: 2,
        claimScope: 'capability',
        product: {
            revision: '1'.repeat(40),
            coreImageDigest: `sha256:${hex('2')}`,
            benchmarkImageDigest: `sha256:${hex('3')}`,
            ragImageDigest: `sha256:${hex('4')}`
        },
        campaignArtifact,
        inferenceProfileArtifact: { schema: 'profile-fixture/v1', frozen: true },
        launch: {
            targets: [first, second],
            promptIds,
            judgeTarget,
            judgeConfig,
            executionConfig,
            executionMode: 'latency',
            runName: 'Trust campaign fixture',
            tags: ['trust-v1'],
            description: 'content-addressed fixture',
            campaignKind: 'model'
        },
        promptAuthorities,
        candidateAuthorities,
        judgeAuthority: {
            qualificationAttestation: qualificationAttestation(judgeIdentity, { rubricFingerprint })
        },
        statistics: {
            alpha: 0.05,
            mde: 1,
            poweredAlternativeEffect: 10,
            equivalenceMargin: 0.1,
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: frozenVarianceBasis.upperConfidenceBoundMicros,
            varianceBasis: frozenVarianceBasis,
            variancePilotAttestation: variancePilotAttestation(frozenVarianceBasis)
        },
        freshnessPolicy: {
            staleAfterSeconds: 86400,
            expiresAfterSeconds: 604800
        },
        ...overrides
    };
    return { ...body, specId: fingerprint(body) };
}

function runtimeEnv(spec) {
    const revocations = {
        schema: REVOCATIONS_SCHEMA,
        version: 1,
        issuedAt: '2026-08-31T00:00:00.000Z',
        validUntil: '2026-10-01T00:00:00.000Z',
        revokedIssuerIds: [],
        revokedKeys: [],
        revokedAttestationIds: []
    };
    const snapshotId = fingerprint(revocations);
    return {
        BENCHMARK_TRUST_CAMPAIGNS_ENABLED: 'true',
        AGENTX_PROFILE: 'full',
        AGENTX_PRODUCT_REVISION: spec.product.revision,
        AGENTX_CORE_IMAGE_DIGEST: spec.product.coreImageDigest,
        AGENTX_BENCHMARK_IMAGE_DIGEST: spec.product.benchmarkImageDigest,
        AGENTX_RAG_IMAGE_DIGEST: spec.product.ragImageDigest,
        [TRUST_ROOTS_ENV]: JSON.stringify({
            schema: TRUST_ROOTS_SCHEMA,
            issuers: [{
                issuerId: 'benchmark-review-board',
                keys: [{
                    keyId: 'judge-key-2026-01',
                    publicKeyPem: judgeQualificationPublicKeyPem,
                    notBefore: '2026-01-01T00:00:00.000Z',
                    notAfter: '2027-01-01T00:00:00.000Z',
                    scopes: ['benchmark-judge-qualification-v1', 'benchmark-variance-pilot-v1']
                }]
            }]
        }),
        [REVOCATIONS_ENV]: JSON.stringify({
            ...revocations,
            snapshotId
        }),
        [MIN_REVOCATION_VERSION_ENV]: '1',
        [REVOCATION_SNAPSHOT_ID_ENV]: snapshotId
    };
}

test('fails closed outside the full profile that runs Trust crash recovery', () => {
    expect(() => assertRuntimeEnabled({
        BENCHMARK_TRUST_CAMPAIGNS_ENABLED: 'true',
        AGENTX_PROFILE: 'demo'
    })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_FULL_PROFILE_REQUIRED' }));
    expect(() => assertRuntimeEnabled({
        BENCHMARK_TRUST_CAMPAIGNS_ENABLED: 'true'
    })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_FULL_PROFILE_REQUIRED' }));
    expect(() => assertRuntimeEnabled({
        BENCHMARK_TRUST_CAMPAIGNS_ENABLED: 'true',
        AGENTX_PROFILE: ' full '
    })).not.toThrow();
});

test('content-addresses the loaded judge prompt code and scoring configuration', () => {
    const baseline = buildJudgeRuntimeImplementationManifest();
    const changedPrompt = buildJudgeRuntimeImplementationManifest({
        functions: {
            buildDynamicJudgePrompt() {
                return 'changed prompt implementation';
            }
        }
    });
    const changedConfig = buildJudgeRuntimeImplementationManifest({
        scoringConfigs: { reasoning: { core_dimensions: [{ name: 'accuracy', weight: 1 }] } }
    });
    const changedPromptProjection = buildJudgeRuntimeImplementationManifest({
        functions: {
            buildPromptData() {
                return { prompt: 'changed judge input projection' };
            }
        }
    });

    expect(changedPrompt.loadedFunctions.buildDynamicJudgePrompt)
        .not.toBe(baseline.loadedFunctions.buildDynamicJudgePrompt);
    expect(changedConfig.scoringConfigsFingerprint).not.toBe(baseline.scoringConfigsFingerprint);
    expect(changedPromptProjection.loadedFunctions.buildPromptData)
        .not.toBe(baseline.loadedFunctions.buildPromptData);
    expect(baseline.sourceFiles.map(entry => entry.module)).toEqual([
        'benchmarkTrustCampaignRuntime', 'categories', 'formatComplianceScorer', 'judgeCall',
        'judgeConfidence', 'judgeExecutor', 'jsonUtils', 'qualityScorer', 'scoringConfigs'
    ]);
});

function promptFixtures(spec) {
    return spec.launch.promptIds.map((id, index) => ({
        _id: id,
        name: `prompt-${index}`,
        prompt: `Solve prompt ${index}`,
        level: 1,
        category: 'reasoning',
        scoring_type: 'reasoning',
        expected_answer: `answer-${index}`
    }));
}

describe('benchmarkTrustCampaignRuntime', () => {
    test('loads only a feature-enabled, content-addressed server-side spec', async () => {
        const spec = campaignSpecFixture();
        const readFile = jest.fn().mockResolvedValue(Buffer.from(JSON.stringify(spec)));
        const directory = path.resolve('trust-specs');
        const loaded = await loadCampaignSpec(spec.specId, {
            directory,
            readFile,
            env: runtimeEnv(spec),
            now
        });
        expect(loaded.specId).toBe(spec.specId);
        expect(readFile).toHaveBeenCalledWith(path.join(directory, `${spec.specId}.json`));
        expect(() => assertConfiguredProductManifest(loaded, runtimeEnv(spec))).not.toThrow();

        await expect(loadCampaignSpec(spec.specId, {
            directory,
            readFile,
            env: {},
            now
        })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_CAMPAIGNS_DISABLED' });

        const tampered = { ...spec, claimScope: 'deployment_fit' };
        await expect(loadCampaignSpec(spec.specId, {
            directory,
            readFile: async () => Buffer.from(JSON.stringify(tampered)),
            env: runtimeEnv(spec),
            now
        })).rejects.toMatchObject({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_FINGERPRINT_MISMATCH' });
    });

    test('rejects native, non-candidate, paid, expired, or Product-mismatched authority', () => {
        const spec = campaignSpecFixture();
        expect(() => normalizeCampaignSpec(spec, { now, env: runtimeEnv(spec) })).not.toThrow();

        const legacyBody = { ...spec, schema: 'agentx.benchmark-trust-campaign-spec/v1', schemaVersion: 1 };
        delete legacyBody.specId;
        const legacySpec = { ...legacyBody, specId: fingerprint(legacyBody) };
        expect(() => normalizeCampaignSpec(legacySpec, { now, env: runtimeEnv(spec) }))
            .toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));

        const disabledCandidate = normalizeBenchmarkTarget(targetRaw('candidate-disabled', 'd', {
            capabilities: { candidate: false, judge: true }
        }));
        const badBody = {
            ...spec,
            launch: { ...spec.launch, targets: [disabledCandidate, spec.launch.targets[1]] },
            candidateAuthorities: [
                { ...spec.candidateAuthorities[0], targetFingerprint: disabledCandidate.fingerprint },
                spec.candidateAuthorities[1]
            ]
        };
        delete badBody.specId;
        expect(() => normalizeCampaignSpec(
            { ...badBody, specId: fingerprint(badBody) },
            { now, env: runtimeEnv(spec) }
        ))
            .toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_RUNTIME_AUTHORITY_MISSING' }));

        const expiredAttestationBody = {
            ...spec.judgeAuthority.qualificationAttestation,
            validUntil: '2026-08-31T00:00:00.000Z'
        };
        delete expiredAttestationBody.attestationId;
        delete expiredAttestationBody.signature;
        const judgeIdentity = spec.judgeAuthority.qualificationAttestation.judge.workerIdentity;
        const expiredBody = {
            ...spec,
            judgeAuthority: {
                qualificationAttestation: qualificationAttestation(judgeIdentity, {
                    issuedAt: '2026-08-30T00:00:00.000Z',
                    validUntil: '2026-08-31T00:00:00.000Z'
                })
            }
        };
        delete expiredBody.specId;
        expect(() => normalizeCampaignSpec(
            { ...expiredBody, specId: fingerprint(expiredBody) },
            { now, env: runtimeEnv(spec) }
        )).toThrow(expect.objectContaining({ code: 'JUDGE_QUALIFICATION_EXPIRED' }));

        expect(() => assertConfiguredProductManifest(spec, {
            ...runtimeEnv(spec),
            AGENTX_BENCHMARK_IMAGE_DIGEST: `sha256:${hex('f')}`
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_PRODUCT_MANIFEST_MISMATCH' }));
    });

    test('rejects a forged variance calculation or a pilot bound to another candidate set', () => {
        const spec = campaignSpecFixture();
        const invalidPoweredAlternative = {
            ...spec,
            statistics: {
                ...spec.statistics,
                poweredAlternativeEffect: spec.statistics.mde
            }
        };
        delete invalidPoweredAlternative.specId;
        expect(() => normalizeCampaignSpec(
            { ...invalidPoweredAlternative, specId: fingerprint(invalidPoweredAlternative) },
            { now, env: runtimeEnv(spec) }
        )).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));

        const impossiblePoweredAlternative = {
            ...spec,
            statistics: { ...spec.statistics, poweredAlternativeEffect: 10.1 }
        };
        delete impossiblePoweredAlternative.specId;
        expect(() => normalizeCampaignSpec(
            { ...impossiblePoweredAlternative, specId: fingerprint(impossiblePoweredAlternative) },
            { now, env: runtimeEnv(spec) }
        )).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));

        for (const [field, value] of [
            ['alpha', 0.05001],
            ['mde', 1.0000001],
            ['poweredAlternativeEffect', 9.9999999]
        ]) {
            const unrepresentableBody = {
                ...spec,
                statistics: { ...spec.statistics, [field]: value }
            };
            delete unrepresentableBody.specId;
            expect(() => normalizeCampaignSpec(
                { ...unrepresentableBody, specId: fingerprint(unrepresentableBody) },
                { now, env: runtimeEnv(spec) }
            )).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));
        }

        const malformedUpperBody = {
            ...spec,
            statistics: {
                ...spec.statistics,
                varianceBasis: {
                    ...spec.statistics.varianceBasis,
                    upperConfidenceBoundMicros:
                        spec.statistics.varianceBasis.upperConfidenceBoundMicros - 1
                }
            }
        };
        delete malformedUpperBody.specId;
        expect(() => normalizeCampaignSpec(
            { ...malformedUpperBody, specId: fingerprint(malformedUpperBody) },
            { now, env: runtimeEnv(spec) }
        )).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));

        const { artifactFingerprint: _artifactFingerprint, ...varianceBody } = spec.statistics.varianceBasis;
        const foreignVarianceBasis = buildBenchmarkTrustVarianceBasis({
            ...varianceBody,
            candidateSetFingerprint: hex('f')
        });
        const foreignCandidateBody = {
            ...spec,
            statistics: {
                ...spec.statistics,
                assumedMaxPairedStdDevMicros: foreignVarianceBasis.upperConfidenceBoundMicros,
                varianceBasis: foreignVarianceBasis
            }
        };
        delete foreignCandidateBody.specId;
        expect(() => normalizeCampaignSpec(
            { ...foreignCandidateBody, specId: fingerprint(foreignCandidateBody) },
            { now, env: runtimeEnv(spec) }
        )).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));
    });

    test('rejects unsigned or non-comparable pilots across repeats, inference and exact prompt policy', () => {
        const spec = campaignSpecFixture();
        const resignSpec = (mutated) => {
            const body = { ...mutated };
            delete body.specId;
            return { ...body, specId: fingerprint(body) };
        };
        const tamperedSignature = JSON.parse(JSON.stringify(spec));
        tamperedSignature.statistics.variancePilotAttestation.signature = `${
            tamperedSignature.statistics.variancePilotAttestation.signature.startsWith('A') ? 'B' : 'A'
        }${tamperedSignature.statistics.variancePilotAttestation.signature.slice(1)}`;
        expect(() => normalizeCampaignSpec(resignSpec(tamperedSignature), {
            now,
            env: runtimeEnv(spec)
        })).toThrow(expect.objectContaining({ code: 'VARIANCE_PILOT_SIGNATURE_INVALID' }));

        for (const mutated of [
            {
                ...spec,
                launch: {
                    ...spec.launch,
                    executionConfig: { ...spec.launch.executionConfig, repeats: 1 }
                }
            },
            {
                ...spec,
                launch: {
                    ...spec.launch,
                    executionConfig: { ...spec.launch.executionConfig, temperature: 0.7 }
                }
            },
            {
                ...spec,
                campaignArtifact: { schema: 'different-sampling-policy/v1', frozen: true }
            },
            {
                ...spec,
                launch: {
                    ...spec.launch,
                    executionConfig: {
                        ...spec.launch.executionConfig,
                        custom_hint: 'AUDIT-CONTEXT-CHANGED'
                    }
                },
                promptAuthorities: spec.promptAuthorities.map(authority => ({
                    ...authority,
                    sourceFingerprint: hex('f')
                }))
            },
            {
                ...spec,
                launch: {
                    ...spec.launch,
                    executionConfig: {
                        ...spec.launch.executionConfig,
                        answer_contract_template: 'Changed contract: {target}/{max}.'
                    }
                },
                promptAuthorities: spec.promptAuthorities.map(authority => ({
                    ...authority,
                    sourceFingerprint: hex('e')
                }))
            }
        ]) {
            expect(() => normalizeCampaignSpec(resignSpec(mutated), {
                now,
                env: runtimeEnv(spec)
            })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));
        }

        const unscopedEnv = runtimeEnv(spec);
        const roots = JSON.parse(unscopedEnv[TRUST_ROOTS_ENV]);
        roots.issuers[0].keys[0].scopes = ['benchmark-judge-qualification-v1'];
        unscopedEnv[TRUST_ROOTS_ENV] = JSON.stringify(roots);
        expect(() => normalizeCampaignSpec(spec, { now, env: unscopedEnv }))
            .toThrow(expect.objectContaining({ code: 'VARIANCE_PILOT_ISSUER_NOT_TRUSTED' }));
    });

    test('rejects pilot reuse after the executed prompt and prompt authorities are consistently changed', () => {
        const spec = campaignSpecFixture();
        const changedExecutionConfig = {
            ...spec.launch.executionConfig,
            custom_hint: 'AUDIT-CONTEXT-CHANGED'
        };
        const changedPrompts = spec.launch.promptIds.map((id, index) => ({
            _id: id,
            name: `prompt-${index}`,
            prompt: `Solve prompt ${index}`,
            level: 1,
            category: 'reasoning',
            scoring_type: 'reasoning',
            expected_answer: `answer-${index}`
        }));
        const changedBody = {
            ...spec,
            launch: { ...spec.launch, executionConfig: changedExecutionConfig },
            promptAuthorities: changedPrompts.map(prompt => (
                buildCampaignPromptAuthority(prompt, changedExecutionConfig)
            ))
        };
        delete changedBody.specId;
        const changedSpec = { ...changedBody, specId: fingerprint(changedBody) };

        expect(changedSpec.promptAuthorities).not.toEqual(spec.promptAuthorities);
        expect(() => normalizeCampaignSpec(changedSpec, {
            now,
            env: runtimeEnv(spec)
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));

        const replacementPrompt = {
            _id: '507f1f77bcf86cd799439099',
            name: 'replacement-prompt',
            prompt: 'A different prompt universe',
            level: 5,
            category: 'reasoning',
            scoring_type: 'reasoning',
            expected_answer: 'replacement-answer'
        };
        const replacementBody = {
            ...spec,
            launch: {
                ...spec.launch,
                promptIds: [replacementPrompt._id, ...spec.launch.promptIds.slice(1)]
            },
            promptAuthorities: [
                buildCampaignPromptAuthority(replacementPrompt, spec.launch.executionConfig),
                ...spec.promptAuthorities.slice(1)
            ]
        };
        delete replacementBody.specId;
        expect(() => normalizeCampaignSpec({
            ...replacementBody,
            specId: fingerprint(replacementBody)
        }, {
            now,
            env: runtimeEnv(spec)
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_CAMPAIGN_SPEC_INVALID' }));
    });

    test('rejects unsigned, revoked, unscoped, or rollback-prone judge authority', () => {
        const spec = campaignSpecFixture();
        const tamperedBody = {
            ...spec,
            judgeAuthority: {
                qualificationAttestation: {
                    ...spec.judgeAuthority.qualificationAttestation,
                    signature: `${
                        spec.judgeAuthority.qualificationAttestation.signature.startsWith('A') ? 'B' : 'A'
                    }${spec.judgeAuthority.qualificationAttestation.signature.slice(1)}`
                }
            }
        };
        delete tamperedBody.specId;
        expect(() => normalizeCampaignSpec(
            { ...tamperedBody, specId: fingerprint(tamperedBody) },
            { now, env: runtimeEnv(spec) }
        )).toThrow(expect.objectContaining({ code: 'JUDGE_QUALIFICATION_SIGNATURE_INVALID' }));

        const revokedEnv = runtimeEnv(spec);
        const revoked = JSON.parse(revokedEnv[REVOCATIONS_ENV]);
        delete revoked.snapshotId;
        revoked.revokedAttestationIds = [spec.judgeAuthority.qualificationAttestation.attestationId];
        revokedEnv[REVOCATIONS_ENV] = JSON.stringify({
            ...revoked,
            snapshotId: fingerprint(revoked)
        });
        revokedEnv[REVOCATION_SNAPSHOT_ID_ENV] = fingerprint(revoked);
        expect(() => normalizeCampaignSpec(spec, { now, env: revokedEnv }))
            .toThrow(expect.objectContaining({ code: 'JUDGE_QUALIFICATION_REVOKED' }));

        const rollbackEnv = runtimeEnv(spec);
        rollbackEnv[MIN_REVOCATION_VERSION_ENV] = '2';
        expect(() => normalizeCampaignSpec(spec, { now, env: rollbackEnv }))
            .toThrow(expect.objectContaining({ code: 'JUDGE_QUALIFICATION_REVOCATION_ROLLBACK' }));

        const unscopedEnv = runtimeEnv(spec);
        const roots = JSON.parse(unscopedEnv[TRUST_ROOTS_ENV]);
        roots.issuers[0].keys[0].scopes = ['different-scope'];
        unscopedEnv[TRUST_ROOTS_ENV] = JSON.stringify(roots);
        expect(() => normalizeCampaignSpec(spec, { now, env: unscopedEnv }))
            .toThrow(expect.objectContaining({ code: 'JUDGE_QUALIFICATION_ISSUER_NOT_TRUSTED' }));
    });

    test('rejects a validly signed qualification for a different runtime rubric', () => {
        const spec = campaignSpecFixture();
        const judgeIdentity = spec.judgeAuthority.qualificationAttestation.judge.workerIdentity;
        const mismatchedBody = {
            ...spec,
            judgeAuthority: {
                qualificationAttestation: qualificationAttestation(judgeIdentity, {
                    rubricFingerprint: hex('f')
                })
            }
        };
        delete mismatchedBody.specId;
        expect(() => normalizeCampaignSpec(
            { ...mismatchedBody, specId: fingerprint(mismatchedBody) },
            { now, env: runtimeEnv(spec) }
        )).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_JUDGE_RUBRIC_MISMATCH' }));
    });

    test('freezes opaque cell identities and the exact harness envelope set', () => {
        const rawSpec = campaignSpecFixture();
        const env = runtimeEnv(rawSpec);
        const spec = normalizeCampaignSpec(rawSpec, { now, env });
        const prompts = promptFixtures(spec);
        const batch = { _id: '507f1f77bcf86cd799439099', trust_batch_id: `batch_${'b'.repeat(32)}` };
        const executionConfig = require('../../../src/services/benchmark/config')
            .normalizeExecutionConfig(spec.launch.executionConfig);
        const context = buildTrustSourceContext({
            batch,
            targets: spec.launch.targets,
            prompts,
            judgeTarget: spec.launch.judgeTarget,
            executionConfig,
            qualityCohortFingerprint: hex('e'),
            campaignSpec: spec,
            env,
            now
        });

        expect(context.schema).toBe('agentx.benchmark-trust-source-context/v3');
        expect(context.statistics.analysisPlan).toMatchObject({
            repeatCount: 2,
            requiredIndependentPromptCount: 26,
            candidateIds: context.candidates.map(candidate => candidate.candidateId),
            promptIds: context.prompts.map(prompt => prompt.promptId)
        });
        expect(context.prompts).toHaveLength(26);
        expect(context.candidates).toHaveLength(2);
        expect(
            context.candidates.length
            * context.prompts.length
            * context.statistics.analysisPlan.repeatCount
        ).toBe(104);
        expect(context.candidates.every(candidate => /^[0-9a-f]{64}$/.test(
            candidate.sourceIdentity.envelopeSetFingerprint
        ))).toBe(true);
        expect(context.judge.rubricFingerprint).toBe(computeJudgeRuntimeRubricFingerprint({
            judgeTarget: spec.launch.judgeTarget,
            judgeConfig: spec.launch.judgeConfig
        }));

        const prompt = prompts[0];
        const promptText = require('../../../src/services/benchmark/config').buildPromptHints(
            prompt.prompt,
            null,
            executionConfig.response_max_tokens,
            executionConfig
        ).promptText;
        const cell = resolveTrustCellIdentity({
            context,
            executionTarget: spec.launch.targets[0],
            prompt,
            promptText
        });
        expect(context.candidates.map(candidate => candidate.candidateId)).toContain(cell.candidateId);
        expect(context.prompts.map(entry => entry.promptId)).toContain(cell.promptId);
        expect(() => resolveTrustCellIdentity({
            context,
            executionTarget: spec.launch.targets[0],
            prompt,
            promptText: `${promptText}\nmutated`
        })).toThrow(expect.objectContaining({ code: 'BENCHMARK_TRUST_RESULT_MAPPING_FAILED' }));
    });
});
