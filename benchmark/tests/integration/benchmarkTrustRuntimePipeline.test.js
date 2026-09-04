'use strict';

jest.setTimeout(120000);

const crypto = require('crypto');
const fs = require('fs/promises');
const os = require('os');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const express = require('express');
const request = require('supertest');

const mockBrokerFetch = jest.fn();
jest.mock('node-fetch', () => (...args) => mockBrokerFetch(...args));
jest.mock('../../src/helpers/outboundHttpTransport', () => {
    const { CONNECT_TIME_PEER_VERIFICATION } = jest.requireActual('../../../shared/outboundHttpExecutor');
    return {
        createNodeFetchPeerTransport: () => async ({ fetchImpl, init, target }) => ({
            response: await fetchImpl(target, init),
            peerVerification: CONNECT_TIME_PEER_VERIFICATION
        })
    };
});
jest.mock('../../src/clients/buddyEventClient', () => ({
    emitBuddyEvent: jest.fn()
}));
jest.mock('../../src/clients/coreApiClient', () => {
    const actual = jest.requireActual('../../src/clients/coreApiClient');
    return {
        ...actual,
        acquireWorkloadAdmission: jest.fn(async (workloadId, options = {}) => ({
            acquired: true,
            admissionId: `admission-${workloadId}`,
            generation: `generation-${workloadId}`,
            principal: 'benchmark-service',
            requestId: options.requestId || `benchmark:${workloadId}`,
            workloadId,
            kind: options.kind || 'benchmark',
            batchId: options.batchId || null
        })),
        heartbeatWorkloadAdmission: jest.fn(async () => ({ heartbeat: true })),
        releaseWorkloadAdmission: jest.fn(async () => ({ released: true })),
        getWorkloadRecoveryIdentity: jest.fn(workloadId => ({
            recoveryId: `recovery-${workloadId}`,
            recoveryRequestId: `recovery-request-${workloadId}`,
            admissionId: `admission-${workloadId}`,
            generation: `generation-${workloadId}`,
            principal: 'benchmark-service'
        })),
        claimHostForBenchmark: jest.fn(async () => ({ claimed: true })),
        heartbeatBenchmarkClaim: jest.fn(async () => ({ heartbeat: true })),
        releaseBenchmarkClaim: jest.fn(async () => ({ released: true })),
        getBenchmarkClaimIdentity: jest.fn((_host, batchId) => ({
            claimBatchId: batchId,
            claimGeneration: `generation-${batchId}`
        }))
    };
});

const BenchmarkBatch = require('../../models/BenchmarkBatch');
const BenchmarkPrompt = require('../../models/BenchmarkPrompt');
const BenchmarkResult = require('../../models/BenchmarkResult');
const BenchmarkTimelineEntry = require('../../models/BenchmarkTimelineEntry');
const JudgeGroundTruth = require('../../models/JudgeGroundTruth');
const JudgeQueueEntry = require('../../models/JudgeQueueEntry');
const {
    clearActiveBatch,
    executeBatch,
    startTrustBatch
} = require('../../src/services/benchmark/execution');
const { getBatch } = require('../../src/services/benchmark/batches');
const {
    clearHarnessCatalogCache
} = require('../../src/services/benchmark/harnessBrokerClient');
const {
    CAMPAIGN_SPEC_SCHEMA,
    buildCampaignPromptAuthority,
    computeJudgeRuntimeRubricFingerprint
} = require('../../src/services/benchmark/benchmarkTrustCampaignRuntime');
const {
    buildBenchmarkTrustSourceProjection
} = require('../../src/services/benchmark/benchmarkTrustSourceEvidence');
const {
    buildBenchmarkTrustVarianceBasis,
    computeBenchmarkTrustCandidateInferenceContractFingerprint,
    computeBenchmarkTrustVarianceCandidateSetFingerprint,
    computeBenchmarkTrustVariancePairFingerprints
} = require('../../src/services/benchmark/benchmarkTrustStatistics');
const {
    buildBenchmarkTrustPromptSamplingPolicy
} = require('../../src/services/benchmark/config');
const {
    MIN_REVOCATION_VERSION_ENV,
    REVOCATION_SNAPSHOT_ID_ENV,
    REVOCATIONS_ENV,
    REVOCATIONS_SCHEMA,
    TRUST_ROOTS_ENV,
    TRUST_ROOTS_SCHEMA
} = require('../../src/services/benchmark/benchmarkJudgeQualificationAuthority');
const {
    BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
    computeBenchmarkJudgeQualificationAttestationId,
    serializeBenchmarkJudgeQualificationAttestationSigningPayload
} = require('../../../shared/benchmarkJudgeQualificationAttestation');
const {
    BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
    computeBenchmarkVariancePilotAttestationId,
    computeBenchmarkVariancePilotCohortFingerprint,
    serializeBenchmarkVariancePilotAttestationSigningPayload
} = require('../../../shared/benchmarkVariancePilotAttestation');
const {
    normalizeBenchmarkTarget
} = require('../../../shared/benchmarkTargetContract');
const {
    fingerprint,
    normalizeWorkerReceipt
} = require('../../../shared/workerContract');

function createPublicReadApp() {
    const app = express();
    app.use(express.json());
    app.use('/api/benchmark', require('../../routes/benchmark'));
    return app;
}

const HEX = character => character.repeat(64);
const PRODUCT = Object.freeze({
    revision: '1'.repeat(40),
    coreImageDigest: `sha256:${HEX('2')}`,
    benchmarkImageDigest: `sha256:${HEX('3')}`,
    ragImageDigest: `sha256:${HEX('4')}`
});
const judgeQualificationKeyPair = crypto.generateKeyPairSync('ed25519');
const judgeQualificationPublicKeyPem = judgeQualificationKeyPair.publicKey.export({
    type: 'spki',
    format: 'pem'
});
const pilotPromptFingerprints = Array.from({ length: 30 }, (_, index) => (
    crypto.createHash('sha256').update(`integration-pilot-prompt-${index}`).digest('hex')
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

function variancePilotAttestation(basis, now) {
    const body = {
        schema: BENCHMARK_VARIANCE_PILOT_ATTESTATION_SCHEMA,
        issuer: { issuerId: 'benchmark-review-board', keyId: 'judge-key-integration' },
        issuedAt: new Date(now.getTime() - 120000).toISOString(),
        validUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        nonce: 'variance-pilot-integration-000001',
        evidence: {
            sourceReceiptId: HEX('5'),
            resultInventoryFingerprint: HEX('6'),
            varianceBasisFingerprint: basis.artifactFingerprint,
            cohortFingerprint: basis.cohortFingerprint,
            promptFingerprints: pilotPromptFingerprints,
            repeatCount: basis.repeatCount,
            candidateInferenceContractFingerprint: basis.candidateInferenceContractFingerprint,
            promptSamplingPolicyFingerprint: basis.promptSamplingPolicyFingerprint
        }
    };
    const attestationId = computeBenchmarkVariancePilotAttestationId(body);
    return {
        ...body,
        attestationId,
        signature: crypto.sign(
            null,
            Buffer.from(serializeBenchmarkVariancePilotAttestationSigningPayload(body, attestationId), 'utf8'),
            judgeQualificationKeyPair.privateKey
        ).toString('base64url')
    };
}

function jsonResponse(status, payload) {
    const raw = Buffer.from(JSON.stringify(payload), 'utf8');
    return {
        status,
        redirected: false,
        url: '',
        headers: {
            get: name => String(name).toLowerCase() === 'content-type'
                ? 'application/json'
                : null
        },
        body: {
            async *[Symbol.asyncIterator]() { yield raw; },
            destroy: jest.fn()
        }
    };
}

function targetRaw(id, character, capabilities) {
    return {
        id,
        label: id,
        executionKind: 'harness',
        mode: 'isolated_model',
        tier: 'free_cloud',
        provider: `provider-${character}`,
        model: `model-${character}`,
        modelVersion: '1.0.0',
        harness: { name: 'trust-integration-harness', version: '1.0.0' },
        adapter: { name: 'trust-integration-adapter', version: '1.0.0' },
        profile: { id: `profile-${character}`, version: '1', fingerprint: HEX(character) },
        api: { name: 'trust-integration-api', version: '1.0.0' },
        contextWindow: 131072,
        capabilities,
        pricing: {
            kind: 'free',
            currency: 'USD',
            source: 'integration-fixture-free',
            effectiveAt: null,
            inputNanodollarsPerMillion: 0,
            outputNanodollarsPerMillion: 0,
            callNanodollars: 0
        },
        available: true,
        observedAt: new Date().toISOString(),
        catalogFingerprint: HEX(character === 'a' ? 'd' : character === 'b' ? 'e' : 'f')
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
            digest: `sha256:${HEX(character)}`,
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

function qualificationAttestation(judgeIdentity, rubricFingerprint, now) {
    const issuedAt = new Date(now.getTime() - 60_000).toISOString();
    const validUntil = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
    const body = {
        schema: BENCHMARK_JUDGE_QUALIFICATION_ATTESTATION_SCHEMA,
        issuer: { issuerId: 'benchmark-review-board', keyId: 'judge-key-integration' },
        issuedAt,
        validUntil,
        nonce: 'runtime-integration-qualification-nonce',
        judge: {
            identityFingerprint: fingerprint(judgeIdentity),
            rubricFingerprint,
            corpusFingerprint: HEX('9'),
            holdoutFingerprint: HEX('a'),
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
        }
    };
    const attestationId = computeBenchmarkJudgeQualificationAttestationId(body);
    const signature = crypto.sign(
        null,
        Buffer.from(serializeBenchmarkJudgeQualificationAttestationSigningPayload(body, attestationId), 'utf8'),
        judgeQualificationKeyPair.privateKey
    ).toString('base64url');
    return { ...body, attestationId, signature };
}

function runtimeEnv(spec, now) {
    const revocations = {
        schema: REVOCATIONS_SCHEMA,
        version: 1,
        issuedAt: new Date(now.getTime() - 60_000).toISOString(),
        validUntil: new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString(),
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
                    keyId: 'judge-key-integration',
                    publicKeyPem: judgeQualificationPublicKeyPem,
                    notBefore: new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
                    notAfter: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
                    scopes: ['benchmark-judge-qualification-v1', 'benchmark-variance-pilot-v1']
                }]
            }]
        }),
        [REVOCATIONS_ENV]: JSON.stringify({ ...revocations, snapshotId }),
        [MIN_REVOCATION_VERSION_ENV]: '1',
        [REVOCATION_SNAPSHOT_ID_ENV]: snapshotId
    };
}

function buildCampaignSpec(prompts, now) {
    const first = normalizeBenchmarkTarget(targetRaw(
        'candidate-a',
        'a',
        { candidate: true, judge: false }
    ));
    const second = normalizeBenchmarkTarget(targetRaw(
        'candidate-b',
        'b',
        { candidate: true, judge: false }
    ));
    const judgeTarget = normalizeBenchmarkTarget(targetRaw(
        'judge-c',
        'c',
        { candidate: false, judge: true }
    ));
    const judgeIdentity = workerIdentity(judgeTarget, 'c');
    const judgeConfig = { temperature: 0, seed: 7, maxTokens: 256, timeoutMs: 30000 };
    const executionConfig = {
        repeats: 1,
        response_max_tokens: 128,
        per_test_timeout_ms: 30000,
        temperature: 0,
        top_p: 1,
        seed: 7,
        custom_hint: 'PRIVATE-TRUST-CAMPAIGN-HINT'
    };
    const rubricFingerprint = computeJudgeRuntimeRubricFingerprint({ judgeTarget, judgeConfig });
    const candidateAuthorities = [
        {
            targetFingerprint: first.fingerprint,
            workerIdentity: workerIdentity(first, 'a'),
            modelDigest: `sha256:${HEX('a')}`,
            artifactDigest: `sha256:${HEX('a')}`
        },
        {
            targetFingerprint: second.fingerprint,
            workerIdentity: workerIdentity(second, 'b'),
            modelDigest: `sha256:${HEX('b')}`,
            artifactDigest: `sha256:${HEX('b')}`
        }
    ];
    const campaignArtifact = { schema: 'runtime-integration-campaign/v1', frozen: true };
    const promptAuthorities = prompts.map(prompt => buildCampaignPromptAuthority(
        prompt.toObject({ flattenMaps: true }),
        executionConfig
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
        product: PRODUCT,
        campaignArtifact,
        inferenceProfileArtifact: { schema: 'runtime-integration-profile/v1', frozen: true },
        launch: {
            targets: [first, second],
            promptIds: prompts.map(prompt => prompt._id.toString()),
            judgeTarget,
            judgeConfig,
            executionConfig,
            executionMode: 'latency',
            runName: 'Trust composed runtime integration',
            tags: ['trust-v1', 'composed-integration'],
            description: 'Exercises the complete strict Trust runtime path',
            campaignKind: 'model'
        },
        promptAuthorities,
        candidateAuthorities,
        judgeAuthority: {
            qualificationAttestation: qualificationAttestation(judgeIdentity, rubricFingerprint, now)
        },
        statistics: {
            alpha: 0.05,
            mde: 1,
            poweredAlternativeEffect: 10,
            equivalenceMargin: 0.1,
            targetPowerBasisPoints: 8000,
            assumedMaxPairedStdDevMicros: frozenVarianceBasis.upperConfidenceBoundMicros,
            varianceBasis: frozenVarianceBasis,
            variancePilotAttestation: variancePilotAttestation(frozenVarianceBasis, now)
        },
        freshnessPolicy: {
            staleAfterSeconds: 86400,
            expiresAfterSeconds: 604800
        }
    };
    return {
        spec: { ...body, specId: fingerprint(body) },
        receiptIdentityByTargetId: new Map([
            [first.id, workerIdentity(first, 'a')],
            [second.id, workerIdentity(second, 'b')],
            [judgeTarget.id, judgeIdentity]
        ])
    };
}

function receiptFor(request, output, identityByTargetId) {
    const envelope = request.envelope;
    const identity = identityByTargetId.get(request.target.id);
    if (!identity) throw new Error(`missing receipt identity for ${request.target.id}`);
    return normalizeWorkerReceipt({
        schema: 'agentx.worker-receipt/v1',
        schemaVersion: 1,
        executionProfile: envelope.executionProfile,
        identity,
        fingerprints: {
            prompt: envelope.prompt.fingerprint,
            tools: envelope.tools.schemaFingerprint,
            policies: envelope.policies.fingerprint,
            envelope: envelope.fingerprint
        },
        finalState: 'succeeded',
        failure: { classification: null, code: null },
        usage: {
            durationMs: 25,
            inputTokens: 12,
            outputTokens: 6,
            totalTokens: 18,
            costNanodollars: 0,
            turns: 1,
            toolCalls: 0
        },
        toolErrors: [],
        humanInterventions: [],
        evidence: { patches: [], artifacts: [], tests: [] },
        violations: [],
        result: { contractSatisfied: true, fingerprint: fingerprint(output) }
    }, { envelope });
}

describe('Benchmark Trust composed runtime pipeline', () => {
    let mongoServer;
    let specDirectory;
    let prompts;
    let spec;
    let env;
    let receiptIdentityByTargetId;
    let executionRequests;
    let now;

    beforeAll(async () => {
        process.env.BENCHMARK_HARNESS_ENABLED = 'true';
        process.env.AGENTX_BENCHMARK_HARNESS_URL = 'http://broker.test';
        process.env.AGENTX_BENCHMARK_HARNESS_TOKEN = 'integration-service-token';

        now = new Date();
        mongoServer = await MongoMemoryServer.create({
            binary: { version: process.env.MONGOMS_VERSION || '7.0.24' }
        });
        await mongoose.connect(mongoServer.getUri());
        await Promise.all([
            BenchmarkBatch.init(),
            BenchmarkPrompt.init(),
            BenchmarkResult.init(),
            JudgeGroundTruth.init(),
            JudgeQueueEntry.init()
        ]);
        const promptFixtureNonce = Date.now();
        prompts = await BenchmarkPrompt.create(Array.from({ length: 26 }, (_, index) => ({
            name: `trust-runtime-integration-${index + 1}-${promptFixtureNonce}`,
            prompt: `Explain why preregistered independent measurement ${index + 1} improves confidence.`,
            level: index % 2 === 0 ? 4 : 5,
            category: 'reasoning',
            scoring_type: 'reasoning',
            expected_answer: 'Independent preregistered measurements reduce random error and selection bias.'
        })));
        ({ spec, receiptIdentityByTargetId } = buildCampaignSpec(prompts, now));
        env = runtimeEnv(spec, now);
        specDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'agentx-trust-runtime-'));
        await fs.writeFile(
            path.join(specDirectory, `${spec.specId}.json`),
            JSON.stringify(spec),
            'utf8'
        );
    }, 30000);

    afterAll(async () => {
        clearActiveBatch();
        clearHarnessCatalogCache();
        if (mongoose.connection.readyState !== 0) {
            await mongoose.connection.dropDatabase();
            await mongoose.disconnect();
        }
        if (mongoServer) await mongoServer.stop();
        if (specDirectory) await fs.rm(specDirectory, { recursive: true, force: true });
        delete process.env.BENCHMARK_HARNESS_ENABLED;
        delete process.env.AGENTX_BENCHMARK_HARNESS_URL;
        delete process.env.AGENTX_BENCHMARK_HARNESS_TOKEN;
    });

    beforeEach(() => {
        executionRequests = [];
        clearActiveBatch();
        clearHarnessCatalogCache();
        mockBrokerFetch.mockReset();
        mockBrokerFetch.mockImplementation(async (urlValue, options = {}) => {
            const url = String(urlValue);
            const authorization = Object.entries(options.headers || {})
                .find(([name]) => name.toLowerCase() === 'authorization')?.[1];
            expect(authorization).toBe('Bearer integration-service-token');

            if (options.method !== 'POST' && url.endsWith('/v1/benchmark/targets')) {
                return jsonResponse(200, {
                    status: 'success',
                    data: {
                        targets: [...spec.launch.targets, spec.launch.judgeTarget],
                        observedAt: new Date().toISOString(),
                        expiresAt: new Date(Date.now() + 60_000).toISOString(),
                        broker: { name: 'integration-broker', version: '1' }
                    }
                });
            }

            if (options.method === 'POST' && url.endsWith('/v1/benchmark/execute')) {
                const request = JSON.parse(options.body);
                executionRequests.push(request);
                const judgeScore = request.input?.prompt?.includes('candidate response from candidate-a')
                    ? 10
                    : 0;
                const output = request.role === 'judge'
                    ? JSON.stringify({ overall: judgeScore, explanation: 'The score follows the frozen integration fixture.' })
                    : `candidate response from ${request.target.id}`;
                return jsonResponse(200, {
                    status: 'success',
                    data: {
                        schema: 'agentx.harness-execution/v1',
                        schemaVersion: 1,
                        output,
                        finishReason: 'stop',
                        fallbackUsed: false,
                        receipt: receiptFor(request, output, receiptIdentityByTargetId)
                    }
                });
            }

            return jsonResponse(404, { status: 'error', error: 'unexpected broker request' });
        });
    });

    test('launches, executes, strictly judges, persists and seals the exact CampaignSpec', async () => {
        const launched = await startTrustBatch(spec.specId, {
            directory: specDirectory,
            env,
            now: now.getTime()
        });

        const committedBatch = await BenchmarkBatch.findById(launched.batch_id)
            .select('+trust_evidence_context +trust_evidence_committed_at');
        expect(committedBatch).toMatchObject({
            status: 'running',
            trust_campaign_spec_id: spec.specId,
            completed: 0,
            failed: 0
        });
        expect(committedBatch.trust_evidence_context).toBeTruthy();
        expect(committedBatch.trust_evidence_committed_at).toBeInstanceOf(Date);
        expect(launched.trust_source_batch_id).toBe(committedBatch.trust_batch_id);

        const frozenPrompts = await BenchmarkPrompt.find({
            _id: { $in: committedBatch.prompt_ids }
        });
        await executeBatch(
            committedBatch._id.toString(),
            committedBatch.host,
            committedBatch.models,
            frozenPrompts,
            {
                targets: committedBatch.targets,
                spend_grant: committedBatch.spend_grant,
                quality_cohort_fingerprint: committedBatch.quality_cohort_fingerprint,
                batch_contract_fingerprint: committedBatch.batch_contract_fingerprint,
                judge_config: committedBatch.judge_config,
                execution_config: committedBatch.execution_config,
                execution_mode: committedBatch.execution_mode,
                trust_evidence_context: committedBatch.trust_evidence_context
            }
        );

        const finalBatch = await BenchmarkBatch.findById(committedBatch._id)
            .select('+trust_evidence_context +trust_evidence_committed_at +trust_evidence_finalized_at')
            .lean();
        const results = await BenchmarkResult.find({ batch_id: committedBatch._id })
            .select('+trust_execution_receipt +trust_judge_receipt')
            .sort({ trust_candidate_id: 1 })
            .lean();

        expect(finalBatch).toMatchObject({
            status: 'completed',
            completed: 52,
            failed: 0,
            judge_status: 'completed',
            judge_completed: 52,
            judge_failed: 0,
            trust_evidence_sealed: true,
            active_slot: null
        });
        expect(finalBatch.trust_evidence_finalized_at).toEqual(finalBatch.completed_at);
        expect(finalBatch.updated_at).toEqual(finalBatch.completed_at);
        expect(results).toHaveLength(52);
        expect(new Set(results.map(row => row.trust_candidate_id))).toHaveProperty('size', 2);
        expect(new Set(results.map(row => row.trust_prompt_id))).toHaveProperty('size', 26);
        for (const row of results) {
            expect(row).toMatchObject({
                success: true,
                scoring_method: 'llm_judge',
                repeat_index: 0,
                repeat_total: 1,
                trust_evidence_sealed: true
            });
            expect(row.trust_execution_receipt?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
            expect(row.trust_judge_receipt?.fingerprint).toMatch(/^[0-9a-f]{64}$/);
            expect([0, 10]).toContain(row.quality_score);
            expect(row.judge_raw_response).toContain(`"overall":${row.quality_score}`);
        }
        expect(results.filter(row => row.quality_score === 10)).toHaveLength(26);
        expect(results.filter(row => row.quality_score === 0)).toHaveLength(26);

        const publicView = await getBatch(committedBatch._id.toString(), {
            includeHeavyPayload: true,
            includeFullText: true,
            includeAllResults: true
        });
        const publicBytes = JSON.stringify(publicView);
        expect(publicView).toMatchObject({
            trust_campaign_spec_id: spec.specId,
            privacy_redacted: true,
            status: 'completed'
        });
        expect(publicView).not.toHaveProperty('execution_config');
        expect(publicView).not.toHaveProperty('targets');
        expect(publicView).not.toHaveProperty('models');
        expect(publicView).not.toHaveProperty('judge_config');
        expect(publicView.results).toHaveLength(52);
        expect(publicView.results.every(row => row.privacy_redacted === true)).toBe(true);
        expect(publicView.results.every(row => row.candidate_id && row.prompt_id)).toBe(true);
        for (const forbidden of [
            'PRIVATE-TRUST-CAMPAIGN-HINT',
            'candidate response from',
            'The response addresses',
            'candidate-a',
            'judge-c',
            'provider-a'
        ]) {
            expect(publicBytes).not.toContain(forbidden);
        }

        const publicReadApp = createPublicReadApp();
        const activeTrustBatchId = new mongoose.Types.ObjectId();
        const recoverableTrustBatchId = new mongoose.Types.ObjectId();
        const legacyRegressionBatchIds = [
            new mongoose.Types.ObjectId(),
            new mongoose.Types.ObjectId()
        ];
        await BenchmarkResult.collection.insertOne({
            model: 'legacy-public-model',
            host: 'legacy-public-host',
            prompt: 'legacy public prompt',
            response: 'legacy public response',
            success: true,
            timestamp: new Date(),
            updated_at: new Date(),
            trust_candidate_id: null,
            trust_prompt_id: null,
            trust_evidence_sealed: false
        });
        await BenchmarkBatch.collection.insertOne({
            _id: activeTrustBatchId,
            trust_batch_id: `batch_${'e'.repeat(32)}`,
            trust_campaign_spec_id: 'e'.repeat(64),
            status: 'running',
            run_name: 'PRIVATE-TRUST-RUN',
            host: 'http://private-trust-host:11434',
            models: ['private-trust-model'],
            levels: [1],
            tags: ['PRIVATE-TRUST-TAG'],
            total_tests: 1,
            completed: 0,
            progress: 0,
            started_at: new Date(),
            created_at: new Date(),
            updated_at: new Date()
        });
        await BenchmarkBatch.collection.insertMany([
            {
                _id: recoverableTrustBatchId,
                trust_batch_id: `batch_${'d'.repeat(32)}`,
                trust_campaign_spec_id: null,
                trust_evidence_context: {
                    schema: 'agentx.benchmark-trust-source-context/v3'
                },
                status: 'running',
                run_name: 'PRIVATE-TRUST-RECOVERY-RUN',
                host: 'http://private-recovery-host:11434',
                models: ['private-recovery-model'],
                levels: [1],
                tags: ['PRIVATE-TRUST-RECOVERY-TAG'],
                total_tests: 1,
                completed: 0,
                progress: 0,
                started_at: new Date(),
                created_at: new Date(),
                updated_at: new Date()
            },
            {
                _id: legacyRegressionBatchIds[0],
                status: 'completed',
                run_name: 'legacy-regression-older',
                completed_at: new Date(Date.now() - 120_000),
                created_at: new Date(Date.now() - 180_000),
                updated_at: new Date(Date.now() - 120_000)
            },
            {
                _id: legacyRegressionBatchIds[1],
                status: 'completed',
                run_name: 'legacy-regression-newer',
                completed_at: new Date(Date.now() - 60_000),
                created_at: new Date(Date.now() - 90_000),
                updated_at: new Date(Date.now() - 60_000)
            }
        ]);
        await BenchmarkTimelineEntry.collection.insertOne({
            batchId: recoverableTrustBatchId,
            timestamp: new Date(),
            event: 'test_complete',
            model: 'PRIVATE-CONTEXT-ONLY-MODEL',
            host: 'PRIVATE-CONTEXT-ONLY-HOST',
            details: { prompt: 'PRIVATE-CONTEXT-ONLY-PROMPT' },
            success: true
        });
        await JudgeGroundTruth.collection.insertOne({
            name: 'PRIVATE-ATTESTED-GROUND-TRUTH-NAME',
            prompt: 'PRIVATE-ATTESTED-GROUND-TRUTH-PROMPT',
            response: 'PRIVATE-ATTESTED-GROUND-TRUTH-RESPONSE',
            expected_answer: 'PRIVATE-ATTESTED-GROUND-TRUTH-EXPECTED',
            expert_rationale: 'PRIVATE-ATTESTED-GROUND-TRUTH-RATIONALE',
            expert_scores: { overall: 8, dimensions: {} },
            category: 'reasoning',
            source: 'attested-human-evidence-v1',
            created_by: 'attested:private-review-board',
            human_attestation_fingerprint: 'f'.repeat(64),
            human_attestation_issuer_id: null,
            active: true,
            validation_stats: { total_runs: 1, avg_deviation: 3 },
            createdAt: new Date(),
            updatedAt: new Date()
        });

        const genericResults = await request(publicReadApp).get('/api/benchmark/results');
        expect(genericResults.status).toBe(200);
        expect(genericResults.body.data.results).toHaveLength(1);
        expect(genericResults.body.data.results[0].model).toBe('legacy-public-model');

        const advancedResults = await request(publicReadApp)
            .get(`/api/benchmark/results/advanced?includeFacets=true&batchId=${committedBatch._id}`);
        expect(advancedResults.status).toBe(200);
        expect(advancedResults.body.data).toMatchObject({ total: 0, returned: 0 });

        const reviewResults = await request(publicReadApp)
            .get(`/api/benchmark/results/needs-review?batch_id=${committedBatch._id}`);
        expect(reviewResults.status).toBe(200);
        expect(reviewResults.body.data.results).toHaveLength(0);

        const detailResult = await request(publicReadApp)
            .get(`/api/benchmark/results/${results[0]._id}`);
        expect(detailResult.status).toBe(404);
        const headDetailResult = await request(publicReadApp)
            .head(`/api/benchmark/results/${results[0]._id}`);
        expect(headDetailResult.status).toBe(404);

        const strictComparison = await request(publicReadApp)
            .post('/api/benchmark/compare-batches')
            .send({ batch_ids: [committedBatch._id.toString()] });
        expect(strictComparison.status).toBe(409);
        expect(strictComparison.body.code).toBe('BENCHMARK_TRUST_GENERIC_COMPARISON_FORBIDDEN');

        const strictRegression = await request(publicReadApp)
            .post('/api/benchmark/regression/compare')
            .send({
                current_batch_id: committedBatch._id.toString(),
                previous_batch_id: legacyRegressionBatchIds[1].toString()
            });
        expect(strictRegression.status).toBe(409);
        expect(strictRegression.body.code).toBe('BENCHMARK_TRUST_GENERIC_REGRESSION_FORBIDDEN');

        const latestRegression = await request(publicReadApp).get('/api/benchmark/regression');
        expect(latestRegression.status).toBe(200);
        expect(JSON.stringify(latestRegression.body)).toContain('legacy-regression-newer');
        expect(JSON.stringify(latestRegression.body)).not.toMatch(/PRIVATE-TRUST-RUN|PRIVATE-TRUST-CAMPAIGN/);

        const strictQualityBreakdown = await request(publicReadApp)
            .post('/api/benchmark/quality-breakdown/batch')
            .send({ pairs: [{ model: results[0].model, host: results[0].host }] });
        expect(strictQualityBreakdown.status).toBe(200);
        expect(strictQualityBreakdown.body.data.results[0].breakdown).toMatchObject({
            overall: [],
            by_category: {},
            by_level: {}
        });
        const strictQualityBreakdownTrailingSlash = await request(publicReadApp)
            .post('/api/benchmark/quality-breakdown/batch/')
            .send({ pairs: [{ model: results[0].model, host: results[0].host }] });
        expect(strictQualityBreakdownTrailingSlash.status).toBe(200);
        expect(strictQualityBreakdownTrailingSlash.body.data.results[0].breakdown).toMatchObject({
            overall: [],
            by_category: {},
            by_level: {}
        });

        const [groundTruthList, problematicGroundTruth, groundTruthSummary] = await Promise.all([
            request(publicReadApp).get('/api/benchmark/judge/ground-truth'),
            request(publicReadApp).get('/api/benchmark/judge/ground-truth/problematic'),
            request(publicReadApp).get('/api/benchmark/judge/ground-truth/summary')
        ]);
        expect(groundTruthList.status).toBe(200);
        expect(problematicGroundTruth.status).toBe(200);
        expect(groundTruthSummary.status).toBe(200);
        expect(groundTruthSummary.body.data.overall).toMatchObject({
            total_entries: 0,
            validated_entries: 0,
            total_runs: 0
        });
        expect(JSON.stringify({
            groundTruthList: groundTruthList.body,
            problematicGroundTruth: problematicGroundTruth.body,
            groundTruthSummary: groundTruthSummary.body
        })).not.toContain('PRIVATE-ATTESTED-GROUND-TRUTH');
        await expect(JudgeGroundTruth.getForValidation()).resolves.toHaveLength(0);
        const legacyMatrix = await request(publicReadApp)
            .post('/api/benchmark/judge/matrix-calibrate')
            .send({
                judge_model: 'legacy-judge',
                judge_host: 'http://legacy-judge',
                reference_model: 'legacy-reference',
                reference_host: 'http://legacy-reference'
            });
        expect(legacyMatrix.status).toBe(400);
        expect(legacyMatrix.body.error).toMatch(/No ground truth entries/);

        for (const [path, code] of [
            ['judge/retro-calibrate', 'BENCHMARK_TRUST_RETRO_CALIBRATION_FORBIDDEN'],
            ['judge/governance-run', 'BENCHMARK_TRUST_GOVERNANCE_BATCH_FORBIDDEN']
        ]) {
            const blockedLegacyJudgeOperation = await request(publicReadApp)
                .post(`/api/benchmark/${path}`)
                .send({
                    batch_id: committedBatch._id.toString(),
                    reference_model: 'private-reference',
                    reference_host: 'http://private-reference'
                });
            expect(blockedLegacyJudgeOperation.status).toBe(409);
            expect(blockedLegacyJudgeOperation.body.code).toBe(code);
        }

        const activeStats = await request(publicReadApp).get('/api/benchmark/active-stats');
        const tagStats = await request(publicReadApp).get('/api/benchmark/stats-by-tag');
        expect(activeStats.status).toBe(200);
        expect(tagStats.status).toBe(200);
        expect(JSON.stringify({
            genericResults: genericResults.body,
            advancedResults: advancedResults.body,
            reviewResults: reviewResults.body,
            detailResult: detailResult.body,
            activeStats: activeStats.body,
            tagStats: tagStats.body
        })).not.toMatch(/PRIVATE-TRUST|candidate response from|candidate-a|judge-c|provider-a/);

        const contextOnlyDetail = await request(publicReadApp)
            .get(`/api/benchmark/BATCH/${recoverableTrustBatchId}`);
        expect(contextOnlyDetail.status).toBe(200);
        expect(contextOnlyDetail.body.data).toMatchObject({ privacy_redacted: true });
        expect(JSON.stringify(contextOnlyDetail.body)).not.toMatch(/PRIVATE-TRUST-RECOVERY|private-recovery/);

        const contextOnlyTimeline = await request(publicReadApp)
            .get(`/api/benchmark/batch/${recoverableTrustBatchId}/timeline/`);
        expect(contextOnlyTimeline.status).toBe(200);
        expect(contextOnlyTimeline.body.data.timeline[0]).toMatchObject({ privacy_redacted: true });
        expect(JSON.stringify(contextOnlyTimeline.body)).not.toContain('PRIVATE-CONTEXT-ONLY');

        const contextOnlyTemplate = await request(publicReadApp)
            .post('/api/benchmark/templates')
            .send({ name: 'context-only-export', source_batch_id: recoverableTrustBatchId.toString() });
        expect(contextOnlyTemplate.status).toBe(409);
        expect(contextOnlyTemplate.body.code).toBe('BENCHMARK_TRUST_TEMPLATE_EXPORT_FORBIDDEN');

        const contextOnlyRerun = await request(publicReadApp)
            .post(`/api/benchmark/batch/${recoverableTrustBatchId}/rerun-invalid`)
            .send({ launch: false });
        expect(contextOnlyRerun.status).toBe(409);
        expect(contextOnlyRerun.body.code).toBe('BENCHMARK_TRUST_LEGACY_RERUN_FORBIDDEN');

        const activeConflict = await request(publicReadApp)
            .post('/api/benchmark/batch')
            .send({
                targets: [spec.launch.targets[0]],
                levels: [1],
                judge_config: { target: spec.launch.judgeTarget }
            });
        expect(activeConflict.status).toBe(409);
        expect(activeConflict.body.active_batch).toMatchObject({ privacy_redacted: true });
        expect(JSON.stringify(activeConflict.body)).not.toMatch(/PRIVATE-TRUST-RUN|private-trust-host/);

        const legacyRerun = await request(publicReadApp)
            .post(`/api/benchmark/batch/${committedBatch._id}/rerun-invalid`)
            .send({ launch: false });
        expect(legacyRerun.status).toBe(409);
        expect(legacyRerun.body.code).toBe('BENCHMARK_TRUST_LEGACY_RERUN_FORBIDDEN');
        expect(JSON.stringify(legacyRerun.body)).not.toContain('PRIVATE-TRUST-CAMPAIGN-HINT');

        for (const mutationPath of [
            'resume',
            'rejudge-pending',
            'judge',
            'judge/stop'
        ]) {
            const mutation = await request(publicReadApp)
                .post(`/api/benchmark/batch/${committedBatch._id}/${mutationPath}`)
                .send({});
            expect(mutation.status).toBe(409);
            expect(JSON.stringify(mutation.body)).not.toMatch(/PRIVATE-TRUST|candidate-a|judge-c|provider-a/);
        }

        const stopped = await request(publicReadApp)
            .post(`/api/benchmark/batch/${activeTrustBatchId}/stop`)
            .send({});
        expect(stopped.status).toBe(200);
        expect(stopped.body.data).toMatchObject({ privacy_redacted: true, status: 'stopped' });
        expect(stopped.body.data).not.toHaveProperty('claim_release_hosts');
        expect(JSON.stringify(stopped.body)).not.toMatch(/PRIVATE-TRUST-RUN|private-trust-host/);

        const recovered = await request(publicReadApp)
            .post(`/api/benchmark/batch/${recoverableTrustBatchId}/recover`)
            .send({});
        expect(recovered.status).toBe(409);
        expect(recovered.body.code).toBe('BENCHMARK_TRUST_RECOVER_FORBIDDEN');
        expect(JSON.stringify(recovered.body)).not.toMatch(/PRIVATE-TRUST-RECOVERY-RUN|PRIVATE-TRUST-RECOVERY-TAG/);

        expect(executionRequests.filter(request => request.role === 'candidate')).toHaveLength(52);
        expect(executionRequests.filter(request => request.role === 'judge')).toHaveLength(52);
        expect(executionRequests.filter(request => request.role === 'candidate'))
            .toEqual(expect.arrayContaining([
                expect.objectContaining({
                    parameters: expect.objectContaining({
                        maxTokens: 128,
                        timeoutMs: 30000,
                        responseFormat: 'text'
                    })
                })
            ]));
        for (const request of executionRequests.filter(entry => entry.role === 'judge')) {
            expect(request.parameters).toMatchObject({
                temperature: 0,
                seed: 7,
                maxTokens: 256,
                timeoutMs: 30000,
                responseFormat: 'json'
            });
            expect(request.envelope.work.reference).toBe('benchmark.judge.cell');
        }

        const projection = buildBenchmarkTrustSourceProjection({
            context: finalBatch.trust_evidence_context,
            results,
            sourceBatchId: finalBatch.trust_batch_id
        });
        expect(projection).toMatchObject({
            resultCount: 52,
            evidenceStatus: 'complete',
            decisionOutcome: 'winner',
            execution: {
                expectedResultCount: 52,
                observedResultCount: 52,
                excludedResultCount: 0,
                promptCount: 26,
                cellInventory: {
                    cellCount: 52,
                    minimumRepeatCount: 1,
                    maximumRepeatCount: 1
                }
            }
        });
    }, 60000);
});
